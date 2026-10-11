import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { resolveWebUiRoot } from '../src/server/web-ui';

describe('web UI root', () => {
  it('uses a package-local UI when present', () => {
    const module = 'file:///tmp/global/vonvon-bot/dist/cli.js';
    const local = resolve(fileURLToPath(new URL('../ui/dist/', module)));
    expect(resolveWebUiRoot(module, path => path === resolve(local, 'index.html'))).toBe(local);
  });

  it('uses the workspace or desktop sibling UI otherwise', () => {
    for (const module of ['file:///tmp/repo/packages/daemon/dist/cli.js', 'file:///tmp/app/daemon/dist/cli.js']) {
      expect(resolveWebUiRoot(module, () => false)).toBe(resolve(fileURLToPath(new URL('../../ui/dist/', module))));
    }
  });
});
