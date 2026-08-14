// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Repository contents, over GitHub's REST API — the `code:owner/repo:path` kind.
 *
 * `list` browses a directory and `read` fetches a file's text. That is the
 * whole kind: writing code means commits, branches and pull requests, which is
 * a different shape from "edit this resource" and is left out rather than
 * approximated. It declares only what it does, and the connector turns a write
 * against a `code:` id into `refusal` below instead of a message about issue
 * ids — the id was right, the operation is not.
 */

import type {
  ConnectorCapability,
  ConnectorContext,
  ListOptions,
  Resource,
  ResourcePage,
} from '../connector.js';
import { ConnectorError } from '../connector.js';

import type { GitHubApi } from './github-api.js';
import type { GitHubKind } from './github-kind.js';
import { CONNECTOR_ID } from './github-kind.js';
import { splitRepo } from './github-refs.js';

export const CODE_PREFIX = 'code:';

const SLASH = '/'.charCodeAt(0);

/** One entry from the repository contents API — a file or a directory. */
export interface GitHubContent {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string | null;
  /** Base64 body, present only when reading a single file. */
  content?: string;
  encoding?: string;
}

/** A code id decoded into its repo and a path within it (empty = repo root). */
interface CodeRef {
  readonly owner: string;
  readonly repo: string;
  readonly path: string;
}

export class CodeKind implements GitHubKind {
  readonly name = 'code';
  readonly prefix = CODE_PREFIX;
  readonly capabilities: readonly ConnectorCapability[] = ['list', 'read'];
  readonly refusal =
    'GitHub code is read-only here: it can be listed and read, but changing it means commits and pull requests, which this connector does not cover';

  readonly #api: GitHubApi;

  constructor(api: GitHubApi) {
    this.#api = api;
  }

  async list(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const container = options.parentId;
    if (!container) {
      throw new ConnectorError(
        'listing GitHub code needs a parent (a repo "owner/repo" or a directory id)',
        CONNECTOR_ID,
      );
    }
    const ref = container.startsWith(CODE_PREFIX)
      ? parseCodeRef(container)
      : codeRootRef(container);

    const body = await this.#api.rest<GitHubContent[] | GitHubContent>(
      context,
      'GET',
      contentsPath(ref),
    );
    // A directory comes back as an array; a file path would return one object,
    // but a list is a directory browse, so anything else is an empty page. The
    // contents API returns a directory's entries in one unpaginated shot.
    const entries = Array.isArray(body) ? body : [];
    return {
      resources: entries.map((entry) => contentToResource(entry, ref.owner, ref.repo, container)),
      nextCursor: null,
    };
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = parseCodeRef(id);
    const body = await this.#api.rest<GitHubContent[] | GitHubContent>(
      context,
      'GET',
      contentsPath(ref),
    );
    const parentId = parentContainerId(ref.owner, ref.repo, ref.path);
    // A directory path comes back as an array; represent it as a dir resource —
    // its children come from `list`, not from a single read.
    if (Array.isArray(body)) {
      return dirToResource(ref, parentId);
    }
    return contentToResource(body, ref.owner, ref.repo, parentId);
  }
}

// --- id helpers -------------------------------------------------------------

/**
 * Decode a `code:owner/repo:path` id. The first colon after the prefix splits
 * the repo from the path; the path may be empty (the repo root) or hold further
 * slashes. `code:owner/repo` with no path names the root too.
 */
function parseCodeRef(id: string): CodeRef {
  const rest = id.slice(CODE_PREFIX.length);
  const colon = rest.indexOf(':');
  const repoPart = colon === -1 ? rest : rest.slice(0, colon);
  const path = colon === -1 ? '' : rest.slice(colon + 1);
  const [owner, repo] = repoPart.split('/');
  if (!owner || !repo || repo.includes('/')) {
    throw new ConnectorError(
      `invalid GitHub code id "${id}"; expected "code:owner/repo:path"`,
      CONNECTOR_ID,
    );
  }
  return { owner, repo, path: trimSlashes(path) };
}

/** Strip leading and trailing slashes in linear time (no backtracking regex). */
function trimSlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path.charCodeAt(start) === SLASH) start++;
  while (end > start && path.charCodeAt(end - 1) === SLASH) end--;
  return path.slice(start, end);
}

/** A bare `owner/repo` container as a code ref at the repo root. */
function codeRootRef(repo: string): CodeRef {
  const [owner, name] = splitRepo(repo, CONNECTOR_ID);
  return { owner, repo: name, path: '' };
}

/** The REST contents path for a code ref, url-encoding each path segment. */
function contentsPath(ref: CodeRef): string {
  const encoded =
    ref.path === '' ? '' : `/${ref.path.split('/').map(encodeURIComponent).join('/')}`;
  return `/repos/${ref.owner}/${ref.repo}/contents${encoded}`;
}

/** The container id for the directory holding `path` — the repo root if top-level. */
function parentContainerId(owner: string, repo: string, path: string): string {
  const slash = path.lastIndexOf('/');
  const parentPath = slash === -1 ? '' : path.slice(0, slash);
  return parentPath === '' ? `${owner}/${repo}` : `${CODE_PREFIX}${owner}/${repo}:${parentPath}`;
}

// --- translation ------------------------------------------------------------

export function contentToResource(
  entry: GitHubContent,
  owner: string,
  repo: string,
  parentId: string,
): Resource {
  const isDir = entry.type === 'dir';
  // The body arrives base64 only when a single file is read; in a listing it is
  // absent, so content stays null there, as the contract asks.
  const content =
    entry.type === 'file' && entry.content !== undefined && entry.encoding === 'base64'
      ? decodeBase64(entry.content)
      : null;
  return {
    id: `${CODE_PREFIX}${owner}/${repo}:${entry.path}`,
    type: isDir ? 'dir' : 'file',
    title: entry.name,
    content,
    mimeType: isDir ? null : guessMimeType(entry.name),
    parentId,
    url: entry.html_url,
    metadata: {
      path: entry.path,
      repo: `${owner}/${repo}`,
      sha: entry.sha,
      size: entry.size,
      kind: entry.type,
    },
    createdAt: null,
    updatedAt: null,
  };
}

function dirToResource(ref: CodeRef, parentId: string): Resource {
  const name = ref.path === '' ? ref.repo : ref.path.slice(ref.path.lastIndexOf('/') + 1);
  return {
    id: `${CODE_PREFIX}${ref.owner}/${ref.repo}:${ref.path}`,
    type: 'dir',
    title: name,
    content: null,
    mimeType: null,
    parentId,
    url: null,
    metadata: { path: ref.path, repo: `${ref.owner}/${ref.repo}`, kind: 'dir' },
    createdAt: null,
    updatedAt: null,
  };
}

/** GitHub returns file bodies as base64 (with newlines); decode to text. */
function decodeBase64(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/** A best-effort mime type from a file's extension; text/plain otherwise. */
function guessMimeType(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'css':
      return 'text/css';
    case 'csv':
      return 'text/csv';
    case 'xml':
      return 'application/xml';
    case 'yml':
    case 'yaml':
      return 'application/yaml';
    default:
      return 'text/plain';
  }
}
