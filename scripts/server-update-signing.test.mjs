// The server manifest signing key and envelope (docs/plans/server-5-release.md 4.2, 5): the CLI, the checks shared with
// the daemon, and that install.sh's sed reads what is signed here. Keys are made in a temporary directory.
// main 必败: none of these files exist on main.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PUBLISHED_TARGETS, SERVER_BASE_URL, archiveName } from './server-constants.mjs';
import { canonicalPayload, installScriptBaseURL, installScriptKey, publicKeyForms, publicKeyFromPrivate, signServerManifest, unsignedManifest,
  validateServerPayload, verifyServerManifest, withInstallScriptKey } from './server-manifest.mjs';
import { createServerKey, main } from './server-update-signing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const payload = (version = '0.9.0', extra = {}) => ({ schemaVersion: 1, product: 'vonvon-bot-server', channel: 'stable', version, publishedAt: 1_793_000_000_000,
  files: Object.fromEntries(PUBLISHED_TARGETS.map((target, index) => [target, { url: `${SERVER_BASE_URL}/${version}/${archiveName(version, target)}`, sha512: String(index + 1).repeat(128), size: 1000 + index }])), ...extra });
const reason = work => { try { work(); return 'accepted'; } catch (error) { return error.reason ?? error.message; } };

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-server-signing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('create-key writes a private key only once, readable by its owner, and prints both forms of one public key', async t => {
  const dir = await temporary(t), key = join(dir, 'keys', 'server.pem');
  const output = [];
  await main(['create-key', '--out', key], text => output.push(text));
  assert.equal((await stat(key)).mode & 0o777, 0o600);
  const text = output.join('');
  assert.doesNotMatch(text, /PRIVATE KEY/);
  const forms = publicKeyFromPrivate(await readFile(key, 'utf8'));
  assert.ok(text.includes(forms.base64) && text.includes(forms.pem));
  assert.equal(publicKeyForms(forms.pem).base64, forms.base64);
  await assert.rejects(createServerKey(key), { code: 'EEXIST' });
  await assert.rejects(createServerKey('relative.pem'), /absolute/);
  const again = [];
  await main(['public-key', '--key', key], line => again.push(line));
  assert.ok(again.join('').includes(forms.base64));
});

test('sign writes compact bytes in C1 key order that verify accepts; a changed byte or a wrong payload is refused', async t => {
  const dir = await temporary(t), key = join(dir, 'server.pem');
  const forms = await createServerKey(key);
  await writeFile(join(dir, 'payload.json'), JSON.stringify({ files: payload().files, publishedAt: 1_793_000_000_000, version: '0.9.0', channel: 'stable', product: 'vonvon-bot-server', schemaVersion: 1, notes: '说明' }, null, 2));
  await main(['sign', '--key', key, '--payload', join(dir, 'payload.json'), '--out', join(dir, 'envelope.json')], () => {});
  const envelope = await readFile(join(dir, 'envelope.json'));
  assert.doesNotMatch(envelope.toString(), /\n/);
  const decoded = Buffer.from(JSON.parse(envelope).payload, 'base64').toString();
  assert.match(decoded, /^\{"schemaVersion":1,"product":"vonvon-bot-server","channel":"stable","version":"0\.9\.0","publishedAt":1793000000000,"files":\{"linux-x64":\{"url":"[^"]+","sha512":"1{128}","size":1000\},"linux-arm64":/);
  assert.match(decoded, /,"notes":"说明"\}$/);
  const shown = [];
  await main(['verify', '--public-key', forms.base64, '--envelope', join(dir, 'envelope.json')], text => shown.push(text));
  assert.equal(JSON.parse(shown.join('')).version, '0.9.0');
  await writeFile(join(dir, 'public.pem'), forms.pem);
  await main(['verify', '--public-key', join(dir, 'public.pem'), '--envelope', join(dir, 'envelope.json')], () => {});
  const changed = Buffer.from(decoded.replace('"size":1000', '"size":1001')).toString('base64');
  assert.equal(reason(() => verifyServerManifest(Buffer.from(JSON.stringify({ ...JSON.parse(envelope), payload: changed })), forms.base64)), 'signature');
  const other = generateKeyPairSync('ed25519').publicKey;
  assert.equal(reason(() => verifyServerManifest(envelope, publicKeyForms(other).base64)), 'signature');
  await writeFile(join(dir, 'extra.json'), JSON.stringify(payload('0.9.0', { extra: 1 })));
  await assert.rejects(main(['sign', '--key', key, '--payload', join(dir, 'extra.json'), '--out', join(dir, 'extra-envelope.json')], () => {}), /schema/);
  await assert.rejects(main(['sign', '--key', key, '--payload', join(dir, 'payload.json'), '--out', join(dir, 'envelope.json')], () => {}), { code: 'EEXIST' });
  // the unsigned versioned manifest is the payload without channel
  assert.deepEqual(Object.keys(JSON.parse(unsignedManifest(payload()))), ['schemaVersion', 'product', 'version', 'publishedAt', 'files']);
});

test('the release scripts and the daemon reach the same verdict on every shared sample', async () => {
  const fixture = JSON.parse(await readFile(join(here, 'fixtures', 'server-manifest-cases.json'), 'utf8'));
  assert.equal(fixture.baseURL, SERVER_BASE_URL);
  assert.ok(fixture.cases.filter(sample => sample.expect !== 'accepted').length >= 8);
  for (const sample of fixture.cases) assert.deepEqual([sample.name, reason(() => validateServerPayload(sample.payload, fixture.baseURL))], [sample.name, sample.expect]);
});

test('install.sh reads the signed payload with its own sed: version and this machine\'s package, with notes of any kind', async t => {
  const dir = await temporary(t);
  const script = await readFile(join(here, 'install.sh'), 'utf8');
  const line = pattern => { const match = script.match(pattern); assert.ok(match, String(pattern)); return match[0]; };
  const reader = [line(/^ {2}file='.*'$/m), line(/^ {2}shape='.*'$/m), line(/^ {2}VERSION=\$\(LC_ALL=C sed .*\)$/m), line(/^ {2}entry=\$\(LC_ALL=C sed .*\)$/m),
    'printf \'%s\\n%s\\n\' "$VERSION" "$entry"'].join('\n');
  for (const notes of [undefined, '修了"引号"、反斜杠 \\ 和\n换行', '']) {
    await writeFile(join(dir, 'payload.bin'), canonicalPayload(payload('1.2.3', notes === undefined ? {} : { notes })));
    const { stdout } = await run('/bin/sh', ['-c', reader], { env: { TMP: dir, TARGET: 'linux-arm64', PATH: '/usr/bin:/bin' } });
    assert.deepEqual(stdout.split('\n').slice(0, 2), ['1.2.3', `${SERVER_BASE_URL}/1.2.3/${archiveName('1.2.3', 'linux-arm64')} ${'2'.repeat(128)} 1001`]);
  }
});

test('the address and key agree across server-constants, server-update.json and install.sh', async () => {
  const committed = JSON.parse(await readFile(join(here, '../packages/daemon/server-update.json'), 'utf8'));
  const script = await readFile(join(here, 'install.sh'), 'utf8');
  assert.equal(committed.baseURL, SERVER_BASE_URL);
  assert.equal(installScriptBaseURL(script), SERVER_BASE_URL);
  const daemonTargets = await readFile(join(here, '../packages/daemon/src/service/standalone-manifest.ts'), 'utf8');
  assert.match(daemonTargets, new RegExp(`SERVER_TARGETS = \\[${PUBLISHED_TARGETS.map(target => `'${target}'`).join(', ')}\\] as const`));
  // Empty in both until the owner makes the key (4.2); then one key in both forms.
  const pem = installScriptKey(script);
  if (!committed.publicKey) assert.equal(pem, '');
  else assert.equal(publicKeyForms(pem).base64, committed.publicKey);
  const keys = generateKeyPairSync('ed25519'), forms = publicKeyForms(keys.publicKey);
  assert.equal(installScriptKey(withInstallScriptKey(script, forms.pem)), forms.pem);
  assert.equal(signServerManifest(payload(), keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).length < 64 * 1024, true);
});
