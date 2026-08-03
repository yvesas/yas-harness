// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP over Streamable HTTP — the transport a server-side product actually uses.
 *
 * Written against `fetch`, like the connectors are, so it adds no dependency.
 * It carries one JSON-RPC message and reads one back; the client above decides
 * what to say.
 *
 * **stdio is not here, on purpose.** It means spawning a child process, and a
 * multi-tenant service that spawns one per tenant has turned a connection into
 * an execution surface — with that process inheriting an environment nobody
 * audited. A product running a local server writes that transport in a dozen
 * lines against `McpTransport` and owns the decision, which is where it belongs.
 *
 * The reply may be JSON or an SSE stream, because the specification allows a
 * server to choose. Only the first `message` event is read: one request, one
 * response — this client sends nothing that streams.
 */

import { ErrorCode, type JsonRpcRequest, type JsonRpcResponse } from './protocol.js';
import type { McpCallContext, McpTransport, McpTransportResponse } from './mcp-client.js';

export interface HttpMcpTransportOptions {
  /** The server's MCP endpoint. */
  readonly url: string;
  /** Sent on every request, under the connection's credential. Default `Bearer`. */
  readonly authorization?: (credential: unknown) => Record<string, string>;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Longest reply this transport will read. Default 8 MiB.
   *
   * A server is not trusted to be reasonable about size; without a ceiling one
   * answer can exhaust the process. Reached, the call fails — a truncated
   * JSON-RPC frame cannot be parsed anyway.
   */
  readonly maxResponseBytes?: number;
  /** Injectable for tests; defaults to global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** A response always carries an id, even when the request that caused it did not. */
type ResponseId = string | number | null;

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SESSION_HEADER = 'mcp-session-id';

/**
 * The default: a bearer token, which is what an OAuth connection resolves to.
 *
 * A credential that is not a string sends no header rather than a guess — a
 * malformed `Authorization` is worse than none, because the server's answer
 * then describes the wrong problem.
 */
function bearer(credential: unknown): Record<string, string> {
  if (typeof credential === 'string' && credential.length > 0) {
    return { authorization: `Bearer ${credential}` };
  }
  const token = (credential as { accessToken?: unknown } | null)?.accessToken;
  return typeof token === 'string' && token.length > 0 ? { authorization: `Bearer ${token}` } : {};
}

export class HttpMcpTransport implements McpTransport {
  readonly #options: HttpMcpTransportOptions;

  constructor(options: HttpMcpTransportOptions) {
    this.#options = options;
  }

  async send(request: JsonRpcRequest, context: McpCallContext): Promise<McpTransportResponse> {
    const reply = await this.#post(request, context);
    const body = await this.#body(reply);

    // Read before parsing: the session id arrives on the initialize reply and
    // the client needs it even when it is the only useful thing in the frame.
    const sessionId = reply.headers.get(SESSION_HEADER) ?? undefined;

    if (!reply.ok) {
      // An HTTP-level failure is not a JSON-RPC error object, so it is turned
      // into one — the client above should have a single failure shape to read.
      return {
        response: httpError(request.id ?? null, reply.status, body),
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    }

    return {
      response: parse(request.id ?? null, body, reply.headers.get('content-type') ?? ''),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  async notify(request: Omit<JsonRpcRequest, 'id'>, context: McpCallContext): Promise<void> {
    // A notification takes no reply, and a server is allowed to answer 202 with
    // nothing at all. Whatever comes back is discarded.
    const reply = await this.#post(request, context);
    await reply.text().catch(() => '');
  }

  async #post(request: JsonRpcRequest, context: McpCallContext): Promise<Response> {
    const authorize = this.#options.authorization ?? bearer;
    const send = this.#options.fetch ?? globalThis.fetch;
    return send(this.#options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Both, because the specification lets the server pick either.
        accept: 'application/json, text/event-stream',
        ...this.#options.headers,
        ...authorize(context.credential),
        ...(context.sessionId === undefined ? {} : { 'mcp-session-id': context.sessionId }),
      },
      body: JSON.stringify(request),
      ...(context.signal ? { signal: context.signal } : {}),
    });
  }

  async #body(reply: Response): Promise<string> {
    const max = this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const declared = Number(reply.headers.get('content-length') ?? '0');
    if (declared > max) {
      // Refused before it is read: the point of the cap is not to hold it.
      await reply.body?.cancel();
      throw new Error(`MCP server answered with ${String(declared)} bytes, over the ${max} cap`);
    }

    const text = await reply.text();
    if (text.length > max) {
      throw new Error(`MCP server answered over the ${max} byte cap`);
    }
    return text;
  }
}

/** SSE or plain JSON — the server chooses, so both are read. */
function parse(id: ResponseId, body: string, contentType: string): JsonRpcResponse {
  const payload = contentType.includes('text/event-stream') ? firstEventData(body) : body;
  try {
    return JSON.parse(payload) as JsonRpcResponse;
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: ErrorCode.ParseError,
        message: `MCP server answered with something that is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
}

/**
 * The `data:` of the first SSE event.
 *
 * Only the first: one request gets one response, and this client sends nothing
 * that streams. A server that sends more is answering a question nobody asked.
 */
function firstEventData(body: string): string {
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) {
      lines.push(line.slice('data:'.length).trimStart());
      continue;
    }
    if (lines.length > 0 && line.trim() === '') {
      break; // blank line ends the event
    }
  }
  return lines.join('\n');
}

function httpError(id: ResponseId, status: number, body: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: ErrorCode.InternalError,
      message: `MCP server answered HTTP ${String(status)}`,
      // Capped: a server's error page is not something to carry around whole.
      data: body.slice(0, 500),
    },
  };
}
