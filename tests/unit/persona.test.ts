// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PersonaError, loadPersona, parsePersona } from '../../src/core/persona.js';

const CONFIG_DIR = join(process.cwd(), 'config', 'personas');

describe('persona configuration', () => {
  it('applies defaults for the optional fields', () => {
    const persona = parsePersona(
      { id: 'minimal', name: 'Minimal', instructions: 'Be useful.' },
      'test',
    );

    expect(persona.task).toBe('reasoning');
    expect(persona.maxToolIterations).toBe(8);
  });

  it('rejects an id the session table would refuse', () => {
    expect(() => parsePersona({ id: 'Not Valid', name: 'x', instructions: 'y' }, 'test')).toThrow(
      PersonaError,
    );
  });

  it('rejects empty instructions rather than running with no system prompt', () => {
    expect(() => parsePersona({ id: 'empty', name: 'x', instructions: '' }, 'test')).toThrow(
      PersonaError,
    );
  });

  it('names the offending field so a config error is actionable', () => {
    expect(() =>
      parsePersona(
        { id: 'bad', name: 'x', instructions: 'y', maxToolIterations: 99 },
        'personas/bad.json',
      ),
    ).toThrowError(/personas\/bad\.json.*maxToolIterations/s);
  });

  it('loads the persona shipped with the harness', async () => {
    const persona = await loadPersona('default', CONFIG_DIR);

    expect(persona.id).toBe('default');
    expect(persona.instructions.length).toBeGreaterThan(0);
  });

  it('fails clearly when the persona does not exist', async () => {
    await expect(loadPersona('missing', CONFIG_DIR)).rejects.toThrow(PersonaError);
  });
});
