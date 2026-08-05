// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The console edits files, and validates them the way the harness will.
 *
 * Two of these are security cases rather than correctness ones: a file name
 * arriving from a form is input, and a client secret must not make a round trip
 * through a web page on its way back to disk.
 *
 * It exercises `yas-harness` **as built**, not as source — the console imports
 * the package by name. So `npm run check` compiles before it tests: without
 * that, a change to a parser passes here against yesterday's `dist/` and fails
 * in CI, which is exactly how this file first went green on a rule it was
 * breaking.
 *
 * It lives in `console/` rather than `tests/` because the code it exercises
 * does. Those files are compiled by the console's tsconfig — bundler
 * resolution, extensionless imports — and the harness's uses NodeNext, where
 * the same imports are an error. One file cannot satisfy both, so the test goes
 * where the code is and vitest picks it up from there.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asConfigFile, ConfigError, read, save, validate } from '../lib/config-files';
import { diff } from '../lib/config-shape';

/**
 * `sensitive` routes to the premium model, and it has to: the harness refuses a
 * config that sends a sensitive task to a cheap one, on the grounds that
 * getting such an answer wrong costs more than the tokens saved. Writing this
 * fixture wrong the first time is how that rule got demonstrated.
 */
const VALID_MODELS = {
  providers: {
    fast: {
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      apiKeyEnv: 'FAST_MODEL_API_KEY',
    },
    premium: { kind: 'anthropic', apiKeyEnv: 'PREMIUM_MODEL_API_KEY' },
  },
  models: {
    cheap: {
      provider: 'fast',
      model: 'llama',
      tier: 'cheap',
      price: { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.5 },
    },
    good: {
      provider: 'premium',
      model: 'opus',
      tier: 'premium',
      price: { inputPerMTok: 10, outputPerMTok: 20, cachedInputPerMTok: 1 },
    },
  },
  routes: { routing: ['cheap'], simple: ['cheap'], reasoning: ['good'], sensitive: ['good'] },
};

let dir: string;
let previous: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yas-config-'));
  previous = process.env['CONFIG_DIR'];
  process.env['CONFIG_DIR'] = dir;
});

afterEach(() => {
  if (previous === undefined) {
    delete process.env['CONFIG_DIR'];
  } else {
    process.env['CONFIG_DIR'] = previous;
  }
});

describe('which files may be touched', () => {
  it('refuses a name that is not on the list', () => {
    // A path from a form is input. Without this, `../../.env` is readable and
    // the console is a secret viewer.
    expect(() => asConfigFile('../../.env')).toThrow(ConfigError);
    expect(() => asConfigFile('/etc/passwd')).toThrow(ConfigError);
  });

  it('accepts the ones it does edit', () => {
    expect(asConfigFile('models.json')).toBe('models.json');
  });
});

describe('validating a draft', () => {
  it('accepts a model config the harness would boot with', () => {
    expect(validate('models.json', JSON.stringify(VALID_MODELS))).toBeNull();
  });

  it('rejects one the harness would refuse, using the harness’s own parser', () => {
    const broken = { ...VALID_MODELS, routes: { ...VALID_MODELS.routes, simple: ['nonexistent'] } };

    // The point of reusing `parseModelConfig`: a second schema would agree
    // today and drift by Christmas.
    expect(validate('models.json', JSON.stringify(broken))).not.toBeNull();
  });

  it('says what is wrong with malformed JSON rather than throwing', () => {
    // A half-typed draft is the normal state of a form, not an error page.
    expect(validate('models.json', '{ "models": ')).toMatch(/not valid JSON/);
  });

  it('accepts connector placeholders without resolving them', () => {
    const connectors = {
      'google-drive': {
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        clientId: '${GOOGLE_CLIENT_ID}',
        clientSecret: '${GOOGLE_CLIENT_SECRET}',
        scopes: ['drive.readonly'],
      },
    };

    // Checked as a shape, not through the loader that reads the environment: a
    // secret unset on this machine is not a reason to refuse somebody's edit.
    expect(validate('connectors.json', JSON.stringify(connectors))).toBeNull();
  });

  it('names the connector that is incomplete', () => {
    expect(validate('connectors.json', JSON.stringify({ drive: { clientId: 'x' } }))).toMatch(
      /drive/,
    );
  });
});

describe('saving', () => {
  it('writes a valid draft, ending the file with a newline', async () => {
    await save('models.json', JSON.stringify(VALID_MODELS, null, 2));

    const written = await readFile(join(dir, 'models.json'), 'utf8');
    // A missing trailing newline makes every future change show as touching
    // the last line.
    expect(written.endsWith('\n')).toBe(true);
    expect(JSON.parse(written)).toMatchObject({ routes: { simple: ['cheap'] } });
  });

  it('never writes a draft that would stop the harness starting', async () => {
    await expect(save('models.json', '{ "models": {} }')).rejects.toBeInstanceOf(ConfigError);

    await expect(readFile(join(dir, 'models.json'), 'utf8')).rejects.toThrow();
  });

  it('keeps a secret placeholder exactly as written', async () => {
    const text = JSON.stringify(
      {
        drive: {
          authorizationEndpoint: 'https://x/auth',
          tokenEndpoint: 'https://x/token',
          clientId: '${DRIVE_CLIENT_ID}',
          clientSecret: '${DRIVE_CLIENT_SECRET}',
        },
      },
      null,
      2,
    );

    await save('connectors.json', text);

    // Resolving on save would write a live client secret into a file that goes
    // to Git.
    expect(await readFile(join(dir, 'connectors.json'), 'utf8')).toContain(
      '${DRIVE_CLIENT_SECRET}',
    );
  });
});

describe('reading', () => {
  it('reports a missing file rather than failing', async () => {
    // `connectors.json` usually is missing, and the page offers to create it.
    expect(await read('connectors.json')).toMatchObject({ exists: false, text: '' });
  });

  it('reads one that is there', async () => {
    await writeFile(join(dir, 'models.json'), '{}\n', 'utf8');

    expect(await read('models.json')).toMatchObject({ exists: true, text: '{}\n' });
  });
});

describe('the diff a save would make', () => {
  it('marks the line that changed, and leaves the rest alone', () => {
    expect(diff('a\nb\nc', 'a\nB\nc')).toEqual([
      { sign: ' ', text: 'a' },
      { sign: '-', text: 'b' },
      { sign: '+', text: 'B' },
      { sign: ' ', text: 'c' },
    ]);
  });

  it('shows both versions whole when the length changed', () => {
    const lines = diff('a\nb', 'a\nb\nc');

    // A console is not a merge tool, and a diff that guesses wrong about a
    // moved block is worse than one saying "this became that".
    expect(lines.filter((line) => line.sign === '-')).toHaveLength(2);
    expect(lines.filter((line) => line.sign === '+')).toHaveLength(3);
  });

  it('says nothing changed when nothing did', () => {
    expect(diff('a\nb', 'a\nb').every((line) => line.sign === ' ')).toBe(true);
  });
});
