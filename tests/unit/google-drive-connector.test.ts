// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Google Drive connector, driven by a stub of the Drive API. The
 * translation is the point: files and folders to resources, the best-effort
 * text body (export a Google Doc, download a text file, null for a folder or a
 * binary), the `q` filters for listing and searching, and the metadata-then-
 * media path for writing content.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
import { GoogleDriveConnector } from '../../src/connections/connectors/google-drive-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'g-token',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const BASE = 'https://api.test';

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  contentType: string | null;
  body: string | undefined;
}

function file(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    mimeType: 'text/plain',
    parents: ['folder-1'],
    webViewLink: `https://drive.google.com/file/d/${id}`,
    size: '128',
    createdTime: '2026-07-01T00:00:00.000Z',
    modifiedTime: '2026-07-02T00:00:00.000Z',
    ...extra,
  };
}

/**
 * A Drive stub. The handler returns an object (a JSON response), a string (a
 * text/plain body, for export and media download), or undefined (a 404).
 */
function fakeDrive(
  handler: (req: {
    method: string;
    path: string;
    query: URLSearchParams;
    body: string | undefined;
    contentType: string | null;
  }) => unknown,
) {
  const calls: Recorded[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : (init.body as string);
    const headers = new Headers(init?.headers);
    const contentType = headers.get('content-type');
    calls.push({ method, path: u.pathname, query: u.searchParams, contentType, body });

    const result = handler({ method, path: u.pathname, query: u.searchParams, body, contentType });
    if (result === undefined) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    }
    if (typeof result === 'string') {
      return Promise.resolve(
        new Response(result, { status: 200, headers: { 'content-type': 'text/plain' } }),
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
let connector: GoogleDriveConnector;

function connect(handler: Parameters<typeof fakeDrive>[0]) {
  const fake = fakeDrive(handler);
  calls = fake.calls;
  connector = new GoogleDriveConnector({ fetch: fake.fetch, baseUrl: BASE });
}

describe('GoogleDriveConnector', () => {
  it('declares the full contract', () => {
    connect(() => ({ files: [] }));
    expect(connector.capabilities).toEqual([
      'list',
      'read',
      'search',
      'create',
      'update',
      'delete',
    ]);
  });

  it('lists everything reachable, dropping trashed files, and carries the page token', async () => {
    connect(({ path, query }) => {
      if (path !== '/drive/v3/files') return undefined;
      expect(query.get('q')).toBe('trashed = false');
      return {
        files: [
          file('f1', 'Notes.txt'),
          file('d1', 'Reports', { mimeType: 'application/vnd.google-apps.folder' }),
        ],
        nextPageToken: 'PAGE2',
      };
    });

    const listed = await connector.list(ctx);

    expect(listed.resources.map((r) => [r.id, r.type])).toEqual([
      ['f1', 'file'],
      ['d1', 'folder'],
    ]);
    expect(listed.resources[0]).toMatchObject({
      title: 'Notes.txt',
      content: null,
      parentId: 'folder-1',
    });
    expect(listed.nextCursor).toBe('PAGE2');
  });

  it('lists a folder’s children by filtering on the parent', async () => {
    connect(({ query }) => {
      expect(query.get('q')).toBe("'folder-1' in parents and trashed = false");
      return { files: [file('f2', 'child.txt')] };
    });

    const listed = await connector.list(ctx, { parentId: 'folder-1' });

    expect(listed.resources[0]).toMatchObject({ id: 'f2' });
    expect(listed.nextCursor).toBeNull();
  });

  it('reads a text file, downloading its body via alt=media', async () => {
    connect(({ path, query }) => {
      if (path === '/drive/v3/files/f1' && query.get('alt') === 'media') return 'the body text';
      if (path === '/drive/v3/files/f1') return file('f1', 'Notes.txt');
      return undefined;
    });

    const resource = await connector.read(ctx, 'f1');

    expect(resource).toMatchObject({
      id: 'f1',
      type: 'file',
      title: 'Notes.txt',
      content: 'the body text',
      mimeType: 'text/plain',
      parentId: 'folder-1',
      metadata: { size: 128, parents: ['folder-1'] },
    });
  });

  it('reads a Google Doc by exporting it to text', async () => {
    connect(({ path, query }) => {
      if (path === '/drive/v3/files/doc1/export') {
        expect(query.get('mimeType')).toBe('text/plain');
        return '# Exported doc';
      }
      if (path === '/drive/v3/files/doc1') {
        return file('doc1', 'Design', { mimeType: 'application/vnd.google-apps.document' });
      }
      return undefined;
    });

    const resource = await connector.read(ctx, 'doc1');

    expect(resource.content).toBe('# Exported doc');
    // The resource keeps the editor mime type; the body is the export.
    expect(resource.mimeType).toBe('application/vnd.google-apps.document');
  });

  it('reads a spreadsheet by exporting to csv', async () => {
    connect(({ path, query }) => {
      if (path === '/drive/v3/files/sh1/export') {
        expect(query.get('mimeType')).toBe('text/csv');
        return 'a,b\n1,2';
      }
      if (path === '/drive/v3/files/sh1') {
        return file('sh1', 'Budget', { mimeType: 'application/vnd.google-apps.spreadsheet' });
      }
      return undefined;
    });

    const resource = await connector.read(ctx, 'sh1');

    expect(resource.content).toBe('a,b\n1,2');
  });

  it('reads a folder with no body, fetching no content', async () => {
    connect(({ path }) =>
      path === '/drive/v3/files/d1'
        ? file('d1', 'Reports', { mimeType: 'application/vnd.google-apps.folder' })
        : undefined,
    );

    const resource = await connector.read(ctx, 'd1');

    expect(resource).toMatchObject({ type: 'folder', content: null });
    expect(calls).toHaveLength(1); // metadata only, no export/download
  });

  it('gives a binary file a null body', async () => {
    connect(({ path }) =>
      path === '/drive/v3/files/img1'
        ? file('img1', 'photo.png', { mimeType: 'image/png' })
        : undefined,
    );

    const resource = await connector.read(ctx, 'img1');

    expect(resource.content).toBeNull();
    expect(calls).toHaveLength(1); // no media fetch for a binary
  });

  it('maps a missing file to ResourceNotFoundError', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'gone')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('searches on full text, escaping quotes in the query', async () => {
    connect(({ query }) => {
      expect(query.get('q')).toBe("fullText contains 'it\\'s here' and trashed = false");
      return { files: [file('f9', 'hit.txt')] };
    });

    const found = await connector.search(ctx, "it's here");

    expect(found.resources[0]).toMatchObject({ id: 'f9' });
  });

  it('creates a file, then uploads its body against the same id', async () => {
    connect(({ method, path, body, contentType }) => {
      if (method === 'POST' && path === '/drive/v3/files') {
        expect(body).toBe(
          JSON.stringify({ name: 'plan.md', parents: ['folder-1'], mimeType: 'text/markdown' }),
        );
        return file('new1', 'plan.md', { mimeType: 'text/markdown' });
      }
      if (method === 'PATCH' && path === '/upload/drive/v3/files/new1') {
        expect(body).toBe('## the plan');
        expect(contentType).toBe('text/markdown');
        return file('new1', 'plan.md', { mimeType: 'text/markdown' });
      }
      return undefined;
    });

    const created = await connector.create(ctx, {
      title: 'plan.md',
      content: '## the plan',
      parentId: 'folder-1',
      metadata: { mimeType: 'text/markdown' },
    });

    expect(created.id).toBe('new1');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /drive/v3/files',
      'PATCH /upload/drive/v3/files/new1',
    ]);
  });

  it('creates a folder without uploading a body', async () => {
    connect(({ method, path }) =>
      method === 'POST' && path === '/drive/v3/files'
        ? file('fold', 'New folder', { mimeType: 'application/vnd.google-apps.folder' })
        : undefined,
    );

    await connector.create(ctx, {
      title: 'New folder',
      content: 'ignored for a folder',
      metadata: { mimeType: 'application/vnd.google-apps.folder' },
    });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /drive/v3/files']);
  });

  it('creates an empty file with a single call when no content is given', async () => {
    connect(({ method, path }) =>
      method === 'POST' && path === '/drive/v3/files' ? file('e1', 'empty.txt') : undefined,
    );

    await connector.create(ctx, { title: 'empty.txt' });

    expect(calls).toHaveLength(1);
  });

  it('updates a title with a metadata patch and content with a media upload', async () => {
    connect(({ method, path, body }) => {
      if (method === 'PATCH' && path === '/drive/v3/files/f1') {
        expect(body).toBe(JSON.stringify({ name: 'Renamed.txt' }));
        return file('f1', 'Renamed.txt');
      }
      if (method === 'PATCH' && path === '/upload/drive/v3/files/f1') {
        expect(body).toBe('new content');
        return file('f1', 'Renamed.txt');
      }
      return undefined;
    });

    const updated = await connector.update(ctx, 'f1', {
      title: 'Renamed.txt',
      content: 'new content',
    });

    expect(updated.title).toBe('Renamed.txt');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PATCH /drive/v3/files/f1',
      'PATCH /upload/drive/v3/files/f1',
    ]);
  });

  it('updates content only, reading the file first to return it', async () => {
    connect(({ method, path }) => {
      if (method === 'GET' && path === '/drive/v3/files/f1') return file('f1', 'Notes.txt');
      if (method === 'PATCH' && path === '/upload/drive/v3/files/f1')
        return file('f1', 'Notes.txt');
      return undefined;
    });

    await connector.update(ctx, 'f1', { content: 'just the body' });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /drive/v3/files/f1',
      'PATCH /upload/drive/v3/files/f1',
    ]);
  });

  it('deletes a file', async () => {
    connect(({ method, path }) =>
      method === 'DELETE' && path === '/drive/v3/files/f1' ? {} : undefined,
    );

    await connector.delete(ctx, 'f1');

    expect(calls).toEqual([
      expect.objectContaining({ method: 'DELETE', path: '/drive/v3/files/f1' }),
    ]);
  });

  it('fails when the credential is not an OAuth token', async () => {
    connect(() => ({ files: [] }));
    const bad: ConnectorContext = { ...ctx, credential: { apiKey: 'nope' } };

    await expect(connector.read(bad, 'f1')).rejects.toBeInstanceOf(ConnectorError);
  });
});
