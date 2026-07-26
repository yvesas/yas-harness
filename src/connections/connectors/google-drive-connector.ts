// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for Google Drive (and the Google editors: Docs, Sheets, Slides).
 *
 * Another real source behind the generic contract, and a different shape from
 * the Atlassian and GitHub ones: Drive is a tree of files and folders. A file
 * becomes a resource, a folder becomes a resource you can browse into, and the
 * body is a best-effort text rendering — a Google Doc is exported to text, a
 * text file is downloaded, and a binary (an image, a PDF) has no text body so
 * its content stays null. Metadata lives in one host (`/drive/v3`) and uploads
 * in another (`/upload/drive/v3`); both are reached through one base.
 *
 * Nothing product-domain here: a Drive file is a document, the same in a
 * language tutor and a CRM. Written against `fetch`; no dependency. The
 * connection layer resolves the credential per call, so the connector only ever
 * receives a working token and never sees a key.
 */

import type {
  Connector,
  ConnectorCapability,
  ConnectorContext,
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePage,
  ResourcePatch,
  SearchOptions,
} from '../connector.js';
import { ConnectorError, ResourceNotFoundError } from '../connector.js';
import { isOAuthToken } from '../oauth.js';

const CONNECTOR_ID = 'google-drive';
const GOOGLE_API = 'https://www.googleapis.com';
const DEFAULT_LIMIT = 25;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// The fields Drive should return; the API omits everything not asked for.
const FILE_FIELDS = 'id,name,mimeType,parents,webViewLink,size,createdTime,modifiedTime';

export interface GoogleDriveConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the Google API base; only for tests. */
  readonly baseUrl?: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  webViewLink?: string;
  size?: string; // Drive returns byte counts as strings
  createdTime?: string;
  modifiedTime?: string;
}

export class GoogleDriveConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'Google Drive files and folders, including Docs, Sheets and Slides.';
  readonly capabilities: readonly ConnectorCapability[] = [
    'list',
    'read',
    'search',
    'create',
    'update',
    'delete',
  ];

  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;

  constructor(options: GoogleDriveConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? GOOGLE_API;
  }

  async list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    // A parent narrows to that folder's children; otherwise, every file the
    // grant can see. Trashed files are left out either way.
    const q = options.parentId
      ? `'${escapeQuery(options.parentId)}' in parents and trashed = false`
      : 'trashed = false';
    const params = new URLSearchParams({
      q,
      pageSize: String(options.limit ?? DEFAULT_LIMIT),
      fields: `nextPageToken, files(${FILE_FIELDS})`,
    });
    if (options.cursor) {
      params.set('pageToken', options.cursor);
    }

    const body = await this.#json<{ files?: DriveFile[]; nextPageToken?: string }>(
      context,
      'GET',
      `/drive/v3/files?${params.toString()}`,
    );
    return {
      resources: (body.files ?? []).map((file) => toResource(file)),
      nextCursor: body.nextPageToken ?? null,
    };
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const file = await this.#file(context, id);
    return toResource(file, await this.#content(context, file));
  }

  async search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<ResourcePage> {
    const params = new URLSearchParams({
      q: `fullText contains '${escapeQuery(query)}' and trashed = false`,
      pageSize: String(options.limit ?? DEFAULT_LIMIT),
      fields: `nextPageToken, files(${FILE_FIELDS})`,
    });
    if (options.cursor) {
      params.set('pageToken', options.cursor);
    }

    const body = await this.#json<{ files?: DriveFile[]; nextPageToken?: string }>(
      context,
      'GET',
      `/drive/v3/files?${params.toString()}`,
    );
    return {
      resources: (body.files ?? []).map((file) => toResource(file)),
      nextCursor: body.nextPageToken ?? null,
    };
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const metadata: Record<string, unknown> = { name: draft.title };
    if (draft.parentId) {
      metadata['parents'] = [draft.parentId];
    }
    const mimeType = draftMimeType(draft);
    if (mimeType) {
      metadata['mimeType'] = mimeType;
    }

    const created = await this.#json<DriveFile>(
      context,
      'POST',
      `/drive/v3/files?fields=${FILE_FIELDS}`,
      metadata,
    );

    // Drive creates the file from metadata only; a body is a second, media
    // upload against the same id — so create honours `content`, like edit does.
    if (draft.content !== undefined && draft.content !== '' && !isFolder(created)) {
      return toResource(await this.#uploadContent(context, created.id, draft.content, mimeType));
    }
    return toResource(created);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    let file: DriveFile;
    // A title change is a metadata patch; if there is none, read the file so we
    // still return it (and know its type) when only the content changes.
    if (patch.title !== undefined) {
      file = await this.#json<DriveFile>(
        context,
        'PATCH',
        `/drive/v3/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`,
        { name: patch.title },
      );
    } else {
      file = await this.#file(context, id);
    }

    if (patch.content !== undefined) {
      file = await this.#uploadContent(context, id, patch.content, undefined);
    }
    return toResource(file);
  }

  async delete(context: ConnectorContext, id: string): Promise<void> {
    // Drive's DELETE is permanent (it skips the trash), matching the contract's
    // delete. Destructive actions are gated by human approval a layer above.
    await this.#call(context, 'DELETE', `/drive/v3/files/${encodeURIComponent(id)}`);
  }

  // --- content --------------------------------------------------------------

  async #file(context: ConnectorContext, id: string): Promise<DriveFile> {
    return this.#json<DriveFile>(
      context,
      'GET',
      `/drive/v3/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`,
    );
  }

  /** A best-effort text body: export a Google editor file, download a text file, else null. */
  async #content(context: ConnectorContext, file: DriveFile): Promise<string | null> {
    if (isFolder(file)) {
      return null;
    }
    const exportType = googleExportType(file.mimeType);
    if (exportType) {
      return this.#text(
        context,
        `/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportType)}`,
      );
    }
    if (isTextual(file.mimeType)) {
      return this.#text(context, `/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
    }
    // A binary file (image, PDF, …) has no text body to give.
    return null;
  }

  /** Upload raw content to an existing file via the media endpoint (no multipart). */
  async #uploadContent(
    context: ConnectorContext,
    id: string,
    content: string,
    mimeType: string | undefined,
  ): Promise<DriveFile> {
    const response = await this.#call(
      context,
      'PATCH',
      `/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=${FILE_FIELDS}`,
      { body: content, contentType: mimeType ?? 'text/plain' },
    );
    return (await response.json()) as DriveFile;
  }

  // --- transport ------------------------------------------------------------

  async #json<T>(
    context: ConnectorContext,
    method: string,
    path: string,
    jsonBody?: unknown,
  ): Promise<T> {
    const response = await this.#call(
      context,
      method,
      path,
      jsonBody === undefined
        ? undefined
        : { body: JSON.stringify(jsonBody), contentType: 'application/json' },
    );
    return (await response.json()) as T;
  }

  async #text(context: ConnectorContext, path: string): Promise<string> {
    const response = await this.#call(context, 'GET', path);
    return response.text();
  }

  async #call(
    context: ConnectorContext,
    method: string,
    path: string,
    payload?: { body: string; contentType: string },
  ): Promise<Response> {
    const token = this.#accessToken(context);
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': payload.contentType } : {}),
      },
      ...(payload ? { body: payload.body } : {}),
    });

    if (response.status === 404) {
      throw new ResourceNotFoundError(this.id, path);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ConnectorError(
        `google drive responded ${response.status}: ${text.slice(0, 500)}`,
        this.id,
      );
    }
    return response;
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('google-drive connection has no OAuth token', this.id);
    }
    return context.credential.accessToken;
  }
}

// --- translation ------------------------------------------------------------

function toResource(file: DriveFile, content: string | null = null): Resource {
  return {
    id: file.id,
    type: isFolder(file) ? 'folder' : 'file',
    title: file.name,
    content,
    // The file's own Drive type; a Google editor file reports its editor type
    // even though its `content` is the exported text.
    mimeType: file.mimeType ?? null,
    parentId: file.parents?.[0] ?? null,
    url: file.webViewLink ?? null,
    metadata: {
      ...(file.size ? { size: Number(file.size) } : {}),
      ...(file.parents ? { parents: file.parents } : {}),
    },
    createdAt: file.createdTime ? new Date(file.createdTime) : null,
    updatedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
  };
}

// --- helpers ----------------------------------------------------------------

function isFolder(file: DriveFile): boolean {
  return file.mimeType === FOLDER_MIME;
}

function isTextual(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  );
}

/** The text export type for a Google editor file, or null if it has none. */
function googleExportType(mimeType: string | undefined): string | null {
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
      return 'text/plain';
    case 'application/vnd.google-apps.spreadsheet':
      return 'text/csv';
    case 'application/vnd.google-apps.presentation':
      return 'text/plain';
    default:
      return null;
  }
}

/** A create's chosen Drive mime type, from metadata or the draft, if any. */
function draftMimeType(draft: ResourceDraft): string | undefined {
  const fromMetadata = draft.metadata?.['mimeType'];
  if (typeof fromMetadata === 'string') {
    return fromMetadata;
  }
  return draft.mimeType;
}

/**
 * Escape a value for a Drive `q` string literal, which is single-quoted. Only a
 * backslash and a single quote are special; both get a backslash. Plain global
 * character replaces — no backtracking.
 */
function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
