import assert from 'node:assert/strict';
import {createHash, randomUUID, generateKeyPairSync, randomBytes, sign} from 'node:crypto';
import {mkdtemp, mkdir, readdir, readFile, writeFile, unlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import pg from '../../recipe-api/node_modules/pg/lib/index.js';
import {createRequire} from 'node:module';
import {startRecipeService} from '../../recipe-api/src/main.mjs';
import {createRichBrokerServer} from '../../recipe-api/src/rich-broker.mjs';
import {createObjectStore} from '../../recipe-api/src/object-store.mjs';
import {createVerifier} from '../../recipe-api/src/auth.mjs';
import {richProof} from '../../recipe-api/src/rich-proof.mjs';
import {inventory} from '../../recipe-api/src/rich-document.mjs';
import {DISPATCH_DIGEST} from '../../recipe-api/src/authoring-proof.mjs';
import {createRecipeWeb} from '../server.mjs';
import {validatePublishableRichRecipeContent} from '../../../packages/protocol/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sharp = createRequire(new URL('../../recipe-api/package.json', import.meta.url))('sharp');
const sha = b => createHash('sha256').update(b).digest('hex');
const b64 = b => Buffer.from(b).toString('base64url');
const opId = () => {const h = Date.now().toString(16).padStart(12, '0'); return h.slice(0,8) + '-' + h.slice(8) + '-7' + randomUUID().slice(15);};
const listen = server => new Promise((yes, no) => server.once('error', no).listen(0, '127.0.0.1', yes));
const close = server => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));};
const host = server => 'http://127.0.0.1:' + server.address().port;
export const cookies = response => response.headers.getSetCookie().map(x => x.split(';', 1)[0]).join('; ');

export async function richFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vv-web-rich-')), sock = join(dir, 's'), db = join(dir, 'db');
  const bin = process.env.PG_BINDIR ?? execFileSync('pg_config', ['--bindir'], {encoding: 'utf8'}).trim();
  const run = (name, args) => execFileSync(join(bin, name), args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  let pgUp = false, api, broker, issuerServer, web, pool;
  t.after(async () => {
    if (web) await close(web);
    if (broker) await close(broker);
    if (pool) await pool.end();
    if (api) await api.close();
    if (issuerServer) await close(issuerServer);
    if (pgUp) run('pg_ctl', ['-D', db, '-m', 'immediate', '-w', 'stop']);
    await rm(dir, {recursive: true, force: true});
  });
  await mkdir(sock, {mode: 0o700});
  await mkdir(join(dir, 'objects'));
  run('initdb', ['-D', db, '-U', 'cloud_test', '--encoding=UTF8', '--locale=C', '--auth=trust']);
  run('pg_ctl', ['-D', db, '-l', join(dir, 'log'), '-w', '-o', `-k '${sock}' -p 5432 -c listen_addresses='' -c unix_socket_permissions=0700`, 'start']);
  pgUp = true;
  const sql = s => run('psql', ['-XAtq', '-h', sock, '-p', '5432', '-U', 'cloud_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', s]).trim();
  const migrations = join(root, 'supabase/migrations');
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
    run('psql', ['-h', sock, '-p', '5432', '-U', 'cloud_test', '-d', 'postgres', '-Xq', '-1', '-v', 'ON_ERROR_STOP=1', '-f', join(migrations, file)]);
  }
  sql('create role main_test login noinherit; grant recipe_api to main_test; create role verifier_test login noinherit; grant recipe_object_verifier to verifier_test');
  const pair = generateKeyPairSync('ec', {namedCurve: 'P-256'});
  const jwk = {...pair.publicKey.export({format: 'jwk'}), kid: 'web-rich-fixture', alg: 'ES256', use: 'sig'};
  const accounts = Object.fromEntries(['author', 'reader', 'other'].map(name => [name, randomUUID()]));
  let issuer;
  const jwt = subject => {
    const h = b64(JSON.stringify({alg: 'ES256', kid: jwk.kid})) + '.' + b64(JSON.stringify({iss: issuer, aud: 'authenticated', role: 'authenticated', sub: subject, exp: Math.floor(Date.now()/1000) + 900}));
    return h + '.' + b64(sign('sha256', Buffer.from(h), {key: pair.privateKey, dsaEncoding: 'ieee-p1363'}));
  };
  issuerServer = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/v1/.well-known/jwks.json') return res.end(JSON.stringify({keys: [jwk]}));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const subject = accounts[body.auth_code];
    assert.ok(subject);
    res.end(JSON.stringify({access_token: jwt(subject), refresh_token: 'synthetic-refresh', expires_in: 900, user: {id: subject}}));
  });
  await listen(issuerServer); issuer = host(issuerServer) + '/auth/v1';
  const tokens = Object.fromEntries(Object.entries(accounts).map(([name, subject]) => [name, jwt(subject)]));
  api = await startRecipeService({RECIPE_AUTH_ISSUER: issuer, RECIPE_DATABASE_URL: 'postgresql://main_test@localhost/postgres?host=' + encodeURIComponent(sock) + '&port=5432', RECIPE_CODE_KEY: randomBytes(32).toString('hex'), RECIPE_RICH_WRITES: '1', PORT: '0'});
  pool = new pg.Pool({user: 'verifier_test', database: 'postgres', host: sock, port: 5432});
  const objectPath = (id, lane) => join(dir, 'objects', lane + '-' + id);
  const storage = {
    create: (id, lane, bytes) => writeFile(objectPath(id, lane), bytes, {flag: 'wx'}),
    read: async (id, lane) => {try {return await readFile(objectPath(id, lane));} catch (error) {if (error.code === 'ENOENT') return null; throw error;}},
    remove: (id, lane) => unlink(objectPath(id, lane)),
  };
  broker = createRichBrokerServer({verify: createVerifier(issuer), store: await createObjectStore(pool), storage, admit: true});
  const brokerReads = []; broker.on('request', req => {if (req.method === 'GET') brokerReads.push(req.url);});
  await listen(broker);
  const publicOrigin = 'https://recipes.example';
  web = createRecipeWeb({RECIPE_WEB_ORIGIN: publicOrigin, RECIPE_API_ORIGIN: host(api.server), RECIPE_BROKER_ORIGIN: host(broker), SUPABASE_URL: host(issuerServer), SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', RECIPE_WEB_PROVIDERS: 'github'});
  await listen(web);
  async function request(path, body, {token = tokens.author, key, revision, method} = {}) {
    const headers = {}; if (token) headers.authorization = 'Bearer ' + token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
    if (revision) headers['if-match'] = '"' + revision + '"';
    const response = await fetch(host(api.server) + path, {method: method ?? (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body)});
    const data = await response.json(); assert.equal(response.status, 200, path + ' ' + JSON.stringify(data.error)); return data;
  }
  await request('/v2/me/profile', {displayName: '合成作者'});
  async function publish(access) {
    const operation = opId(), pkg = opId(), device = generateKeyPairSync('x25519'), nonce = randomBytes(32), path = '/v2/authoring/' + operation;
    const registered = await request(path + '/register', {format: 'rich-v2', purpose: 'prepareDraft', targetPublicKey: b64(device.publicKey.export({type: 'spki', format: 'der'}).subarray(-32)), nonceCommitment: b64(createHash('sha256').update(nonce).digest())});
    const authorize = (stage, payloadDigest) => request(path + '/authorize', {stage, stateRevision: stage === 'dispatch' ? 1 : 2, payloadDigest});
    const possession = c => ({ticket: c.ticket, nonce: b64(nonce), proof: b64(richProof(device.privateKey, c))});
    await request(path + '/dispatch', possession(await authorize('dispatch', DISPATCH_DIGEST)), {token: null});
    await request('/v2/objects/' + pkg + '/reserve', {draftId: registered.destinationDraftId, cap: 250000});
    async function upload(ordinal, kind, bytes) {
      const response = await fetch(host(broker) + '/v2/objects/' + pkg + '/members/' + ordinal, {method: 'PUT', headers: {authorization: 'Bearer ' + tokens.author, 'content-type': 'application/octet-stream', 'x-recipe-kind': kind, 'x-recipe-sha256': sha(bytes)}, body: bytes});
      const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
    }
    const text = await upload(0, 'text', Buffer.from('私有文档 **完整正文** <img src=x onerror="alert(1)">'));
    const png = await sharp({create: {width: 20, height: 30, channels: 3, background: '#22aa33'}}).png().toBuffer();
    const logo = await upload(64, 'finalLogo', png);
    const content = JSON.parse(await readFile(join(root, 'packages/protocol/test/fixtures/recipe-rich-v2.content.json'), 'utf8'));
    const identity = () => ({itemId: randomUUID(), originId: randomUUID()});
    content.public.name.value = '完整配方 ' + access;
    content.public.overview.value = '# 配方介绍\n**公开说明** <script>alert(1)</script>';
    content.role.text.value = '角色说明 **回答问题**';
    content.parts = [text, logo]; content.memories = [];
    content.rules = [{...identity(), purpose: 'work', text: {kind: 'inline', value: '工作规则正文'}}];
    content.settings = [{...identity(), field: 'sessionMode', value: 'smart'}, {...identity(), field: 'permission.requirement', value: {mode: 'qa'}}, {...identity(), field: 'presentation.voiceEnabled', value: true}];
    const file = {...identity(), name: 'SKILL.md', use: 'skillDescription', text: {kind: 'inline', value: '---\nname: sample-skill\ndescription: 核对环境并整理所选内容。\n---\nENTRY_PRIVATE_BODY_SENTINEL'}};
    const reference = {...identity(), name: 'reference.md', use: 'reference', text: {kind: 'part', objectId: text.objectId}};
    content.files = [file, reference]; content.skills = [{...identity(), name: '样例技能', entryFileId: file.itemId, fileIds: [file.itemId, reference.itemId]}];
    content.tasks = [{...identity(), name: '每日整理', instruction: {kind: 'inline', value: '任务执行说明'}, spec: {kind: 'daily', time: '09:00'}, timeZone: {kind: 'recommended', iana: 'Asia/Shanghai'}, placement: 'follow'}];
    content.setup = [{...identity(), kind: 'config', title: '使用前检查', instructions: '核对本地环境', required: true, action: {kind: 'manual'}}];
    content.finalLogo = {...identity(), objectId: logo.objectId};
    validatePublishableRichRecipeContent(content);
    const frozen = await request(path + '/freeze', {format: 'rich-v2', content, access, origins: inventory(content).map(({itemId}) => ({itemId, source: {kind: 'accountClaim'}})), logoUpload: {packageId: pkg, inputSha256: sha(png)}});
    const manifest = await upload(65, 'manifest', Buffer.from(frozen.canonical, 'base64url'));
    await request(path + '/accept', {...possession(await authorize('accept', frozen.payloadDigest)), payload: frozen.payload, canonical: frozen.canonical, manifestId: manifest.objectId, packageId: pkg}, {token: null});
    return request('/v2/drafts/' + registered.destinationDraftId + '/publish', {canonical: frozen.canonical}, {key: randomUUID(), revision: 1});
  }
  async function login(account) {
    const start = await fetch(host(web) + '/auth/start', {method: 'POST', redirect: 'manual', headers: {origin: publicOrigin}, body: new URLSearchParams({provider: 'github'})});
    const callback = await fetch(host(web) + '/auth/callback?code=' + account, {redirect: 'manual', headers: {cookie: cookies(start)}});
    assert.equal(callback.status, 303);
    const cookie = cookies(callback), session = await fetch(host(web) + '/auth/session', {headers: {cookie}}).then(response => response.json());
    return {cookie, 'X-Vonvon-Session': session.displaySession};
  }
  return {publish, request, login, host: host(web), apiHost: host(api.server), brokerHost: host(broker), brokerReads, publicOrigin, tokens, sha};
}
