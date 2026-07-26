// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The code side of the GitHub connector, driven by a stub of the REST contents
 * API. What is tested is the translation: repository contents to file/dir
 * resources with a `code:owner/repo:path` id, browsing a directory (root and a
 * subdirectory), reading a file's base64 body into text, the mime guess from
 * the extension, path encoding, and the missing-file mapping. Code is read-only.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ResourceNotFoundError } from '../../src/connections/connector.js';
import { GitHubConnector } from '../../src/connections/connectors/github-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'gh-token',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const BASE = 'https://api.test';

interface Recorded {
  method: string;
  url: string;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function fileEntry(path: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'file',
    name: basename(path),
    path,
    sha: `sha_${basename(path)}`,
    size: 42,
    html_url: `https://github.com/acme/widgets/blob/main/${path}`,
    ...extra,
  };
}

function dirEntry(path: string) {
  return {
    type: 'dir',
    name: basename(path),
    path,
    sha: `sha_${basename(path)}`,
    size: 0,
    html_url: `https://github.com/acme/widgets/tree/main/${path}`,
  };
}

/** A single-file read: the entry plus its base64 body, as the contents API returns. */
function fileRead(path: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    ...fileEntry(path, extra),
    content: Buffer.from(text, 'utf-8').toString('base64'),
    encoding: 'base64',
  };
}

function fakeGitHub(handler: (req: { method: string; path: string }) => unknown) {
  const calls: Recorded[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const method = init?.method ?? 'GET';
    calls.push({ method, url: u.pathname + u.search });

    const result = handler({ method, path: u.pathname });
    if (result === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, calls };
}

let calls: Recorded[];
let connector: GitHubConnector;

function connect(handler: Parameters<typeof fakeGitHub>[0]) {
  const fake = fakeGitHub(handler);
  calls = fake.calls;
  connector = new GitHubConnector({ fetch: fake.fetch, baseUrl: BASE });
}

describe('GitHubConnector — code', () => {
  it('browses a repo root, mapping files and directories, prefixing the id', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/contents'
        ? [dirEntry('src'), fileEntry('README.md')]
        : undefined,
    );

    const listed = await connector.list(ctx, { type: 'code', parentId: 'acme/widgets' });

    expect(listed.resources.map((r) => r.id)).toEqual([
      'code:acme/widgets:src',
      'code:acme/widgets:README.md',
    ]);
    expect(listed.resources[0]).toMatchObject({
      type: 'dir',
      title: 'src',
      content: null,
      mimeType: null,
      parentId: 'acme/widgets',
    });
    expect(listed.resources[1]).toMatchObject({
      type: 'file',
      title: 'README.md',
      content: null, // body is not fetched in a listing
      mimeType: 'text/markdown',
    });
    expect(listed.nextCursor).toBeNull();
  });

  it('browses a subdirectory addressed by a code id, parenting the entries to it', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/contents/src' ? [fileEntry('src/index.ts')] : undefined,
    );

    const listed = await connector.list(ctx, { type: 'code', parentId: 'code:acme/widgets:src' });

    expect(listed.resources[0]).toMatchObject({
      id: 'code:acme/widgets:src/index.ts',
      type: 'file',
      parentId: 'code:acme/widgets:src',
    });
  });

  it('needs a parent to browse code', async () => {
    connect(() => undefined);

    await expect(connector.list(ctx, { type: 'code' })).rejects.toThrowError(/needs a parent/);
  });

  it('reads a file, decoding the base64 body and parenting it to its directory', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/contents/src/index.ts'
        ? fileRead('src/index.ts', 'export const x = 1;\n')
        : undefined,
    );

    const resource = await connector.read(ctx, 'code:acme/widgets:src/index.ts');

    expect(resource).toMatchObject({
      id: 'code:acme/widgets:src/index.ts',
      type: 'file',
      title: 'index.ts',
      content: 'export const x = 1;\n',
      mimeType: 'text/plain',
      parentId: 'code:acme/widgets:src',
      metadata: { path: 'src/index.ts', repo: 'acme/widgets', kind: 'file' },
    });
  });

  it('parents a top-level file to the repo, not a directory', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/contents/README.md'
        ? fileRead('README.md', '# Title')
        : undefined,
    );

    const resource = await connector.read(ctx, 'code:acme/widgets:README.md');

    expect(resource).toMatchObject({ parentId: 'acme/widgets', content: '# Title' });
  });

  it('guesses the mime type from the extension', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/contents/data.json' ? fileRead('data.json', '{}') : undefined,
    );

    const resource = await connector.read(ctx, 'code:acme/widgets:data.json');

    expect(resource.mimeType).toBe('application/json');
  });

  it('reads a directory id as a dir resource, not a file', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/contents/src' ? [fileEntry('src/index.ts')] : undefined,
    );

    const resource = await connector.read(ctx, 'code:acme/widgets:src');

    expect(resource).toMatchObject({
      id: 'code:acme/widgets:src',
      type: 'dir',
      title: 'src',
      content: null,
      parentId: 'acme/widgets',
    });
  });

  it('url-encodes path segments in the request', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/contents/docs/my%20file.md'
        ? fileRead('docs/my file.md', 'x')
        : undefined,
    );

    const resource = await connector.read(ctx, 'code:acme/widgets:docs/my file.md');

    expect(resource.title).toBe('my file.md');
    expect(calls.every((c) => c.url.includes('my%20file.md'))).toBe(true);
  });

  it('trims leading and trailing slashes from the path', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/contents/src/index.ts'
        ? fileRead('src/index.ts', 'ok')
        : undefined,
    );

    const resource = await connector.read(ctx, 'code:acme/widgets:/src/index.ts/');

    expect(resource.content).toBe('ok');
    expect(calls.every((c) => c.url.endsWith('/contents/src/index.ts'))).toBe(true);
  });

  it('maps a missing file to ResourceNotFoundError', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'code:acme/widgets:nope.ts')).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('rejects a malformed code id', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'code:acme')).rejects.toThrowError(
      /expected "code:owner\/repo:path"/,
    );
  });

  it('routes code ids to the contents API, not the issues endpoint', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/contents/a.txt' ? fileRead('a.txt', 'hi') : undefined,
    );

    await connector.read(ctx, 'code:acme/widgets:a.txt');

    expect(calls.every((c) => c.url.includes('/contents/'))).toBe(true);
  });
});
