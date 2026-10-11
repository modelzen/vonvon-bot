import { describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { resolveWebUiRoot } from '../src/server/web-ui';

describe('web UI root', () => {
  it('uses a package-local UI when present', () => {
    const module = pathToFileURL(resolve('fixture-global/vonvon-bot/dist/cli.js')).href;
    const local = resolve(fileURLToPath(new URL('../ui/dist/', module)));
    expect(resolveWebUiRoot(module, path => path === resolve(local, 'index.html'))).toBe(local);
  });

  it('uses the workspace or desktop sibling UI otherwise', () => {
    for (const path of ['fixture-repo/packages/daemon/dist/cli.js', 'fixture-app/daemon/dist/cli.js']) {
      const module = pathToFileURL(resolve(path)).href;
      expect(resolveWebUiRoot(module, () => false)).toBe(resolve(fileURLToPath(new URL('../../ui/dist/', module))));
    }
  });
});
