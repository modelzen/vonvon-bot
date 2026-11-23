import { describe, expect, test } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { applyPreviewEnvironment } from '../src/preview-environment.js';
import {classifyDistribution} from '../../daemon/src/service/distribution.js';
import {createHash} from 'node:crypto';

describe('isolated Preview entry', () => {
  test('a Preview stage remains a recognized bundled daemon distribution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vv-preview-distribution-'));
    try {
      const app = join(root, 'app.asar'), daemon = join(root, 'daemon');
      for (const path of ['desktop', 'dist']) await mkdir(join(app, path), {recursive:true});
      for (const path of ['bin', 'dist']) await mkdir(join(daemon, path), {recursive:true});
      const main = 'isolated preview entry';
      const json = (path: string, value: unknown) => writeFile(path,JSON.stringify(value));
      await json(join(app,'package.json'), {name:'vonvon-bot-desktop',vonvonPreview:true,main:'desktop/main.cjs'});
      await json(join(app,'dist/update-config.json'),{});
      await json(join(app,'dist/preview-config.json'),{format:1,channel:'preview',mainSha256:createHash('sha256').update(main).digest('hex'),webOrigin:'https://recipes-staging.example',apiOrigin:'https://recipes-staging.example'});
      await writeFile(join(app,'desktop/main.cjs'),main);
      await json(join(daemon,'package.json'),{name:'@vonvon/daemon',bin:{vonvon:'bin/vonvon.mjs'}});
      await writeFile(join(daemon,'bin/vonvon.mjs'),'');await writeFile(join(daemon,'dist/cli.js'),'');
      const {assertPreviewStage}=await import(new URL('../../../scripts/desktop-preview-policy.mjs',import.meta.url).href);
      await expect(assertPreviewStage(app,{appId:'com.vonvon.bot.preview',productName:'Vonvon Bot Preview'})).resolves.toBeUndefined();
      expect(classifyDistribution(daemon).kind).toBe('bundled');
      await json(join(app,'package.json'),{name:'vonvon-bot-preview',vonvonPreview:true,main:'desktop/main.cjs'});
      await expect(assertPreviewStage(app,{appId:'com.vonvon.bot.preview',productName:'Vonvon Bot Preview'})).rejects.toThrow();
      expect(classifyDistribution(daemon).kind).toBe('unknown');
    } finally {await rm(root,{recursive:true,force:true});}
  });

  test('uses a separate macOS root regardless of inherited production or testing overrides', () => {
    const env = { VONVON_HOME: '/owner/production', VONVON_DESKTOP_TEST_HOME: '/old/testing', VONVON_APP_SCHEME: 'vonvon' };
    applyPreviewEnvironment(env, '/Users/example', 'darwin');
    expect(env).toEqual({
      VONVON_HOME: '/Users/example/Library/Application Support/Vonvon Bot Preview/data',
      VONVON_DESKTOP_TEST_HOME: '/Users/example/Library/Application Support/Vonvon Bot Preview/desktop',
      VONVON_APP_SCHEME: 'vonvon-preview',
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
      VONVON_APP_SCHEME: 'vonvon-preview',
    });
  });
});
