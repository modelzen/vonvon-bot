import { describe, expect, test } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { applyPreviewEnvironment } from '../src/preview-environment.js';

describe('isolated Preview entry', () => {
  test('uses a separate macOS root regardless of inherited production or testing overrides', () => {
    const env = { VONVON_HOME: '/owner/production', VONVON_DESKTOP_TEST_HOME: '/old/testing' };
    applyPreviewEnvironment(env, '/Users/example', 'darwin');
    expect(env).toEqual({
      VONVON_HOME: '/Users/example/Library/Application Support/Vonvon Bot Preview/data',
      VONVON_DESKTOP_TEST_HOME: '/Users/example/Library/Application Support/Vonvon Bot Preview/desktop',
    });
    expect(() => applyPreviewEnvironment({}, 'relative', 'darwin')).toThrow('absolute');
  });

  test('the actual bundled entry sets both roots before the main module evaluates', async () => {
    const result = await build({
      entryPoints: [new URL('../src/preview-main.ts', import.meta.url).pathname], bundle: true,
      platform: 'node', format: 'cjs', write: false,
      plugins: [{name: 'capture-main-environment', setup(builder) {
        builder.onResolve({filter: /^\.\/main\.js$/}, () => ({path: 'captured-main', namespace: 'capture'}));
        builder.onLoad({filter: /.*/, namespace: 'capture'}, () => ({contents: 'globalThis.captured = {...process.env};', loader: 'js'}));
      }}],
    });
    const require = createRequire(import.meta.url);
    const context: Record<string, unknown> = {
      process: {env: {VONVON_HOME: '/owner/production'}, platform: 'darwin'},
      require: (name: string) => name === 'node:os' ? {homedir: () => '/Users/example'} : require(name),
      module: {exports: {}}, exports: {},
    };
    runInNewContext(result.outputFiles[0].text, context);
    await new Promise(setImmediate);
    expect(context.captured).toEqual({
      VONVON_HOME: '/Users/example/Library/Application Support/Vonvon Bot Preview/data',
      VONVON_DESKTOP_TEST_HOME: '/Users/example/Library/Application Support/Vonvon Bot Preview/desktop',
    });
  });
});
