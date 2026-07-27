// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The wire shapes of MCP: JSON-RPC 2.0 plus the few Model Context Protocol
 * result types this server produces.
 *
 * This is data, not transport. The server turns one request message into one
 * response message (or none, for a notification); a product carries the bytes
 * over stdio, HTTP or anything else. Keeping the protocol here — hand-written,
 * no dependency — is the same call the connectors make with `fetch`: the
 * surface is small and stable enough that a library would only add a version to
 * track.
 */

export const JSONRPC_VERSION = '2.0';
/** The MCP protocol revision this server speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  /** Absent (or null) marks a notification — no response is sent. */
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: string | number | null;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: string | number | null;
  readonly error: JsonRpcErrorObject;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

/** The standard JSON-RPC error codes this server uses. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** One piece of an MCP tool result. This server only emits text. */
export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

/** The result of `tools/call`: content, plus a flag for a failed tool run. */
export interface McpToolResult {
  readonly content: readonly McpTextContent[];
  readonly isError?: boolean;
}

/** How a tool is advertised in `tools/list`. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
  };
}

export function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/** A tool result carrying text, marked ok or error. */
export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}
