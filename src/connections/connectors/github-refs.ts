// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Decoding the ids and repo names GitHub resources are addressed by.
 *
 * Shared because the same `owner/repo` shows up in an issue id, a discussion
 * id, a REST path and a GraphQL variable, and a repo that is valid in one of
 * them is valid in all four — one place to be strict is one place to be wrong.
 */

import { ConnectorError } from '../connector.js';

/** A resource addressed by a repository and a number: an issue or a discussion. */
export interface RepoNumberRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const REF = /^([^/]+)\/([^/#]+)#(\d+)$/;

/**
 * Decode an `owner/repo#number` id, with `prefix` stripped first.
 *
 * The message names both accepted forms rather than only the one this kind
 * wanted: a caller who wrote `acme/widgets#3` when they meant the discussion is
 * looking at an id that is *almost* right, and the fix is the prefix.
 */
export function parseRepoNumberRef(id: string, prefix: string, connectorId: string): RepoNumberRef {
  const match = REF.exec(id.slice(prefix.length));
  if (!match) {
    throw new ConnectorError(
      `invalid GitHub id "${id}"; expected "owner/repo#number" or "discussion:owner/repo#number"`,
      connectorId,
    );
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** Validate and return `owner/repo` for use in a REST path. */
export function repoPath(repo: string, connectorId: string): string {
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new ConnectorError(`invalid repo "${repo}"; expected "owner/repo"`, connectorId);
  }
  return repo;
}

/** Split `owner/repo` into its two halves, refusing anything else. */
export function splitRepo(repo: string, connectorId: string): [string, string] {
  const [owner, name] = repo.split('/');
  if (!owner || !name || name.includes('/')) {
    throw new ConnectorError(`invalid repo "${repo}"; expected "owner/repo"`, connectorId);
  }
  return [owner, name];
}

/** Recover `owner/repo` from an issue's html_url, for search/user-issue results. */
export function repoFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = /github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}
