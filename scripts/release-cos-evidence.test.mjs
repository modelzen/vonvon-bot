import assert from 'node:assert/strict';
import test from 'node:test';
import { readCosReleaseEvidence } from './release-cos-evidence.mjs';
const config = { bucket: 'release-1234567890', region: 'ap-shanghai', prefix: 'bot/mac/stable/', publicManifestURL: 'https://dl.vonvon.cc/bot/mac/stable/manifest.json', ledgerFile: '/external/ledger.json' };
const readJSON = async path => path.endsWith('ledger.json') ? { versions: ['0.8.0'] } : config;
const params = page => ({ env: {}, readJSON, client: { getBucket: (input, callback) => callback(null, page(input)) } });

test('COS enumeration collects every page and the durable highest-version ledger', async () => {
  const markers = [];
  const evidence = await readCosReleaseEvidence('/external/cos.json', params(input => {
    markers.push(input.Marker);
    assert.equal(input.Prefix, 'bot/mac/stable/');
    return input.Marker ? { Contents: [{ Key: 'bot/mac/stable/Vonvon-Bot-0.9.0-universal.zip' }], IsTruncated: 'false' }
      : { Contents: [{ Key: 'bot/mac/stable/feed-0.7.0.json' }], IsTruncated: 'true', NextMarker: 'next-page' };
  }));
  assert.deepEqual(markers, ['', 'next-page']);
  assert.deepEqual(evidence.versions, ['0.8.0', '0.7.0', '0.9.0']);
  assert.equal(evidence.keys.length, 2);
});

test('COS errors and incomplete, looping or out-of-prefix listings never prove an empty prefix', async () => {
  for (const page of [
    {}, { Contents: [], IsTruncated: 'true' },
    { Contents: [], IsTruncated: 'true', NextMarker: 'same' },
    { Contents: [{ Key: 'elsewhere/feed-0.7.0.json' }], IsTruncated: false },
    { Contents: [{ Key: 'bot/mac/stable/feed-unknown' }], IsTruncated: false },
  ]) await assert.rejects(readCosReleaseEvidence('/external/cos.json', params(() => page)));
  const dependencies = params(() => ({}));
  dependencies.client.getBucket = (_, cb) => cb(new Error('credential value must not escape'));
  await assert.rejects(readCosReleaseEvidence('/external/cos.json', dependencies), error => !error.message.includes('credential value'));
});

test('COS gate requires external config, exact stable identity and readable ledger', async () => {
  await assert.rejects(readCosReleaseEvidence('relative.json', params(() => ({}))));
  await assert.rejects(readCosReleaseEvidence('/external/cos.json', { ...params(() => ({})), readJSON: async () => ({ ...config, prefix: 'other/' }) }));
  await assert.rejects(readCosReleaseEvidence('/external/cos.json', { ...params(() => ({})), readJSON: async path => path.endsWith('ledger.json') ? {} : config }));
});
