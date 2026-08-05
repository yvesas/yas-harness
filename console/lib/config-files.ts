// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading and writing the harness's configuration **files**.
 *
 * The rule this whole page rests on, from doc 21 §5:
 *
 * > **The console edits files. It does not replace files with a database.**
 *
 * Configuration lives in `config/*.json`, versioned in Git. Moving it into a
 * table would cost the history, the code review of a price change, the fork
 * model, and a reproducible deploy — and would buy a form. So the console is an
 * editor and a validator over the files, and never becomes the only way in:
 * whoever prefers `vim` keeps working.
 *
 * Two things it will not do.
 *
 * **It does not resolve secrets.** `config/connectors.json` holds
 * `${GOOGLE_CLIENT_SECRET}` placeholders, and they are written back exactly as
 * they came. Resolving one to display it would put a client secret on a web
 * page; resolving one on save would write it into a file that goes to Git.
 *
 * **It validates before it writes, with the harness's own parsers.** Not a
 * second schema that agrees today and drifts by Christmas — the same
 * `parseModelConfig` the harness boots with. A file that would stop the harness
 * starting is rejected while it is still only text in a form.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseModelConfig, parsePersona } from 'yas-harness';

import { EDITABLE, type ConfigFile } from './config-shape';

export interface ConfigDocument {
  readonly file: ConfigFile;
  readonly text: string;
  /** False when the file is not there — `connectors.json` usually is not. */
  readonly exists: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function configDir(): string {
  return process.env['CONFIG_DIR'] ?? join(process.cwd(), 'config');
}

export function editable(): readonly ConfigFile[] {
  return EDITABLE;
}

/** Refuse anything not on the list, whatever a form said. */
export function asConfigFile(value: string): ConfigFile {
  const found = EDITABLE.find((file) => file === value);
  if (!found) {
    // A path from a form is input. Without this, `../../.env` is a readable
    // file and the console is a secret viewer.
    throw new ConfigError(`"${value}" is not an editable configuration file`);
  }
  return found;
}

export async function read(file: ConfigFile): Promise<ConfigDocument> {
  try {
    return { file, text: await readFile(join(configDir(), file), 'utf8'), exists: true };
  } catch {
    return { file, text: '', exists: false };
  }
}

/**
 * Check a candidate the way the harness will, and say what is wrong.
 *
 * Returns the complaint, or null when it would load. Deliberately not throwing:
 * an invalid draft is the normal state of a form somebody is halfway through.
 */
export function validate(file: ConfigFile, text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    if (file === 'models.json') {
      parseModelConfig(parsed, file);
    } else if (file === 'personas/default.json') {
      parsePersona(parsed, file);
    } else {
      // `connectors.json` is checked as a shape here rather than with
      // `loadConnectorsConfig`, which resolves `${VAR}` placeholders against
      // the environment: a secret that is not set on this machine is not a
      // reason to refuse somebody's edit.
      shapeOfConnectors(parsed);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Validate, then write. A file that would not load never reaches the disk. */
export async function save(file: ConfigFile, text: string): Promise<void> {
  const complaint = validate(file, text);
  if (complaint !== null) {
    throw new ConfigError(complaint);
  }
  // Trailing newline: these files are read by people in a diff, and a missing
  // one makes every future change show as touching the last line.
  await writeFile(join(configDir(), file), text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

/**
 * The shape of `connectors.json`, without resolving anything.
 *
 * Hand-checked rather than reusing the harness's loader, because that loader
 * reads the environment — and refusing an edit because a colleague's client
 * secret is not exported on this machine would be checking the wrong thing.
 */
function shapeOfConnectors(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('connectors.json must be an object keyed by connector id');
  }
  for (const [connectorId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new ConfigError(`"${connectorId}" must be an object`);
    }
    for (const field of ['authorizationEndpoint', 'tokenEndpoint', 'clientId', 'clientSecretEnv']) {
      if (typeof (value as Record<string, unknown>)[field] !== 'string') {
        throw new ConfigError(`"${connectorId}" is missing "${field}"`);
      }
    }
    if ('clientSecret' in (value as Record<string, unknown>)) {
      // The single most damaging thing somebody could put in this file, and an
      // easy mistake: `clientSecretEnv` names a variable, it does not hold the
      // secret. Refusing here is the last point before it reaches Git.
      throw new ConfigError(
        `"${connectorId}" has a "clientSecret" field. Secrets do not go in this file — ` +
          'name the environment variable in "clientSecretEnv" instead.',
      );
    }
  }
}
