/**
 * Declaration consistency: runtime `lib/index.js` exports vs `lib/index.d.ts`.
 * Scope: stdlib only (`node:test`, `node:assert/strict`, `node:fs`,
 * `node:path`, `node:url`). Run: `node --test test/exports-declaration.test.js`
 * (cwd `plugin/`). No type checker used (offline; no `npx tsc`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as entry from '../lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DTS_PATH = join(HERE, '..', 'lib', 'index.d.ts');

describe('exports/declaration consistency (index.js vs index.d.ts)', () => {
  it('every runtime export has a matching `export declare` line', () => {
    const dts = readFileSync(DTS_PATH, 'utf8');
    const runtimeKeys = Object.keys(entry).sort();
    assert.ok(runtimeKeys.length > 0, 'runtime must export at least one name');
    for (const key of runtimeKeys) {
      assert.match(
        dts,
        new RegExp(`export declare (?:const|function) ${key}\\b`),
        `index.d.ts must declare runtime export '${key}'`,
      );
    }
  });

  it('CATEGORIES/PHASES values match diagnostics source of truth', async () => {
    const diagnostics = await import('../lib/diagnostics.js');
    assert.deepEqual(Array.from(entry.CATEGORIES), Array.from(diagnostics.CATEGORIES));
    assert.deepEqual(Array.from(entry.PHASES), Array.from(diagnostics.PHASES));
    assert.deepEqual(Array.from(entry.CATEGORIES), ['validation', 'config', 'io', 'internal']);
    assert.deepEqual(Array.from(entry.PHASES), ['tool-execute', 'pre-execute-guard', 'prompt-section']);
  });
});
