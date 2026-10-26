import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, checkVersionGate, compareVersions, manifestURL, releaseMetadata, validateConfig } from './release-mac.mjs';

test('release version comparisons are numeric and reject ambiguous values', () => {
  assert.equal(compareVersions('0.7.10', '0.7.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.7.0', '0.7.14'), -1);
  for (const v of ['0.7', '0.7.0-beta.1', '0.07.0', '0.7.-1', '9007199254740992.0.0']) {
    assert.throws(() => compareVersions(v, '0.7.0'));
  }
});

test('formal releases cannot promote an equal or lower version', () => {
  for (const version of ['0.7.9', '0.7.10']) {
    assert.throws(() => checkVersionGate({ version, mode: 'release', liveVersion: '0.7.10' }));
  }
  checkVersionGate({ version: '0.7.11', mode: 'release', liveVersion: '0.7.10' });
  assert.throws(() => checkVersionGate({ version: '0.7.11', mode: 'release' }));
});

test('rehearsals require and obey their next-release version ceiling', () => {
  checkVersionGate({ version: '0.7.0', mode: 'rehearsal', nextVersion: '0.7.0' });
  checkVersionGate({ version: '0.6.9', mode: 'rehearsal', nextVersion: '0.7.0' });
  assert.throws(() => checkVersionGate({ version: '0.7.14', mode: 'rehearsal', nextVersion: '0.7.0' }));
  assert.throws(() => checkVersionGate({ version: '0.7.0', mode: 'rehearsal' }));
  assert.throws(() => checkVersionGate({ version: '0.7.0', mode: 'unknown' }));
});

test('only the explicit stable endpoint and two config fields are permitted', () => {
  const valid = { manifestURL, teamIdentifier: 'AAAAAAAAAA' };
  assert.equal(validateConfig(valid), valid);
  for (const config of [null, {}, { ...valid, extra: true }, { ...valid, teamIdentifier: 'invalid' }, { ...valid, manifestURL: 'http://dl.vonvon.cc/bot/mac/stable/manifest.json' }, { ...valid, manifestURL: manifestURL + '?token=secret' }]) {
    assert.throws(() => validateConfig(config));
  }
});

test('Squirrel manifest, feed and ZIP share a stable HTTPS directory', () => {
  const { manifest, feed } = releaseMetadata('0.7.0', '2026-10-26T00:00:00Z', 'Release notes');
  assert.equal(manifest.version, '0.7.0');
  assert.equal(new URL('.', manifest.feedURL).href, new URL('.', manifestURL).href);
  assert.equal(new URL('.', feed.url).href, new URL('.', manifestURL).href);
  assert.equal(new URL(feed.url).pathname, '/bot/mac/stable/Vonvon-Bot-0.7.0-universal.zip');
  assert.deepEqual(Object.keys(manifest).sort(), ['feedURL', 'version']);
  assert.equal(feed.notes, 'Release notes');
});

test('canonicalization resolves existing parents before testing nonexistent output paths', async () => {
  const canonicalRoot = dirname(fileURLToPath(import.meta.url));
  const alias = canonicalRoot.replace(/^\/private\/var\//, '/var/');
  assert.equal(await canonicalPath(alias), canonicalRoot);
  assert.equal(await canonicalPath(join(alias, 'not-created-output', 'release')), join(canonicalRoot, 'not-created-output', 'release'));
});
