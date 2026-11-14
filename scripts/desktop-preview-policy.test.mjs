import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertPreviewStage} from './desktop-preview-policy.mjs';

test('Preview packaging refuses ordinary stages, stale main bytes, updates and non-HTTPS origins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vv-preview-stage-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root,'dist')); await mkdir(join(root,'desktop'));
  const bytes = 'isolated preview bootstrap';
  const write = (name,value) => writeFile(join(root,name),JSON.stringify(value));
  const config = {appId:'com.vonvon.bot.preview',productName:'Vonvon Bot Preview'};
  const stamp = {format:1,channel:'preview',mainSha256:createHash('sha256').update(bytes).digest('hex'),webOrigin:'https://recipes-staging.example',apiOrigin:'https://recipes-staging.example'};
  await write('package.json',{name:'vonvon-bot-desktop',vonvonPreview:true}); await write('dist/update-config.json',{});
  await write('dist/preview-config.json',stamp); await writeFile(join(root,'desktop/main.cjs'),bytes);
  await assert.doesNotReject(assertPreviewStage(root,config));
  await assert.rejects(assertPreviewStage(root,{...config,appId:'com.vonvon.bot.desktop'}));
  await write('package.json',{name:'vonvon-bot-desktop'}); await assert.rejects(assertPreviewStage(root,config));
  await write('package.json',{name:'vonvon-bot-desktop',vonvonPreview:true});
  await writeFile(join(root,'desktop/main.cjs'),'ordinary entry'); await assert.rejects(assertPreviewStage(root,config));
  await writeFile(join(root,'desktop/main.cjs'),bytes);
  await write('dist/update-config.json',{manifestURL:'https://prod.example/stable'}); await assert.rejects(assertPreviewStage(root,config));
  await write('dist/update-config.json',{});
  await write('dist/preview-config.json',{...stamp,apiOrigin:'http://localhost:4317'}); await assert.rejects(assertPreviewStage(root,config));
});
