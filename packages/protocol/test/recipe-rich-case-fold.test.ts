import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect, it} from 'vitest';
import {canonicalCaselessSegment} from '../src/recipe-rich-filename.js';

it('matches every default full folding in Unicode 15.1.0 after canonical decomposition', () => {
  const ucd = readFileSync(new URL('../scripts/unicode-15.1.0/CaseFolding.txt', import.meta.url), 'utf8');
  const rows = [...ucd.matchAll(/^([0-9A-F]+); [CF]; ([0-9A-F ]+);/gm)];
  expect(rows).toHaveLength(1530);
  for (const [, code, mapping] of rows) {
    const scalar = String.fromCodePoint(parseInt(code!, 16));
    const expected = String.fromCodePoint(...mapping!.split(' ').map(hex => parseInt(hex, 16))).normalize('NFD');
    expect(canonicalCaselessSegment(scalar), code).toBe(expected);
  }
  expect(canonicalCaselessSegment('Iİı')).toBe('ii\u0307ı');
  expect(canonicalCaselessSegment('资料😀')).toBe('资料😀');
});

it('reproduces the checked-in table offline from the pinned source bytes', () => {
  const generator = new URL('../scripts/generate-case-fold.mjs', import.meta.url);
  execFileSync(process.execPath, [fileURLToPath(generator), '--check']);
});
