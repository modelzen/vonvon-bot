import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'recipe-crash-'));
const entry = join(root, 'recipe.cjs');
beforeAll(async () => {
  await build({stdin: {contents: "export {RecipeStore} from './src/recipe/store';export {sha256} from './src/recipe/manifest';", resolveDir: fileURLToPath(new URL('..', import.meta.url))},
    outfile: entry, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['@larksuiteoapi/node-sdk']});
});
afterAll(async () => {await rm(root, {recursive: true, force: true});});

for (const phase of ['before', 'after'] as const) it(`recovers after process death ${phase} the atomic rename`, async () => {
  const home = join(root, phase), botId = 'cli_crash_fixture', botDir = join(home, 'bots', botId), file = join(botDir, 'projects.json');
  await mkdir(botDir, {recursive: true});
  await writeFile(join(home, 'bots.json'), JSON.stringify({version: 1, bots: [{name: 'Fixture', appId: botId, tenant: 'feishu', createdAt: 1, registrationId: randomUUID()}]}));
  await writeFile(file, JSON.stringify({version: 1, projects: [{name: 'Group', chatId: 'oc_crash', cwd: '/tmp', blank: false, createdAt: 1, supplement: 'old'}]}));
  const prelude = `const fs=require('node:fs/promises');const m=require(${JSON.stringify(entry)});const store=new m.RecipeStore({targetPublicKey:Buffer.alloc(32,4).toString('base64url'),isInChat:async()=>{}});`;
  const value = {schema: 1, recipeId: randomUUID(), versionId: randomUUID(), authorId: randomUUID(), revision: 1, access: 'direct', role: 'new'};
  const script = `${prelude}(async()=>{const bytes=Buffer.from(JSON.stringify(${JSON.stringify(value)}));
    const request={type:'prepare',botId:${JSON.stringify(botId)},groupId:'oc_crash',accountId:${JSON.stringify(randomUUID())},manifest:bytes.toString('base64url'),manifestSha256:m.sha256(bytes)};
    const review=await store.prepare(request);const p=await store.prepare({...request,reviewToken:review.reviewToken,resolution:{role:{kind:'replace'}}});
    const original=await store.get(${JSON.stringify(botId)},p.operationId);
    await store.authorize(${JSON.stringify(botId)},p.operationId,{operationId:p.operationId,accountId:original.accountId,purpose:'installBoundRole',generation:1,deadline:Date.now()+300000,versionId:p.versionId,manifestSha256:p.manifestSha256,targetPublicKey:p.targetPublicKey,nonceCommitment:p.nonceCommitment,serverPublicKey:Buffer.alloc(32,8).toString('base64url'),ticket:Buffer.alloc(32,12).toString('base64url'),status:'authorized'});
    await store.redeemed(${JSON.stringify(botId)},p.operationId);
    const rename=fs.rename;fs.rename=async(a,b)=>{if(b.endsWith('/projects.json')){const next=JSON.parse(await fs.readFile(a,'utf8'));if(next.recipeInstallOperations?.[p.operationId]?.status==='applied'){if(${JSON.stringify(phase)}==='before')process.exit(73);await rename(a,b);process.exit(74);}}return rename(a,b)};
    await store.apply(${JSON.stringify(botId)},p.operationId,async()=>{});
  })().catch(e=>{console.error(e);process.exitCode=1});`;
  const result = await exec(process.execPath, ['-e', script], {env: {...process.env, VONVON_HOME: home}}).catch(error => error);
  expect(result.code).toBe(phase === 'before' ? 73 : 74);
  const raw = JSON.parse(await readFile(file, 'utf8')), operationId = Object.keys(raw.recipeInstallOperations)[0]!;
  expect(raw.projects[0].supplement).toBe(phase === 'before' ? 'old' : 'new');
  expect(raw.recipeInstallOperations[operationId].status).toBe(phase === 'before' ? 'in_progress' : 'applied');
  expect(raw.projects[0].recipeInstall?.versionId).toBe(phase === 'before' ? undefined : value.versionId);
  const recovered = await exec(process.execPath, ['-e', `${prelude}(async()=>{await store.apply(${JSON.stringify(botId)},${JSON.stringify(operationId)},async()=>{});console.log(JSON.stringify(await store.status(${JSON.stringify(botId)},${JSON.stringify(operationId)})))})().catch(e=>{console.error(e);process.exitCode=1})`], {env: {...process.env, VONVON_HOME: home}});
  expect(JSON.parse(recovered.stdout)).toMatchObject({status: 'applied', operationId});
});
