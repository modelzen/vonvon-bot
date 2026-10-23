import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** D5: no card in the group says how many memory entries a turn used. That count is the desktop panel's alone. */
describe('Feishu cards', () => {
  it('never say "参考了" (run card, final card, /history card, markdown)', () => {
    const dir = join(__dirname, '../src/card');
    const files = readdirSync(dir).filter(name => name.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['run-card.ts', 'run-card-stream.ts', 'history-card.ts', 'markdown-render.ts']));
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toContain('参考了');
      expect(text, name).not.toContain('vonvon-mem');
    }
  });
});
