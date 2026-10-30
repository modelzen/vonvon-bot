import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDownloadEnvironment } from './release-network.mjs';

const settings = `
<dictionary> {
  HTTPEnable : 1
  HTTPProxy : fallback.example
  HTTPPort : 8080
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7897
  ExceptionsList : <array> {
    0 : localhost
    1 : *.local
    2 : 10.0.0.0/8
    3 : <local>
    4 : invalid@example
  }
}`;
const mac = text => ({ platform: 'darwin', execute: async (command, args, options) => {
  assert.equal(command, '/usr/sbin/scutil'); assert.deepEqual(args, ['--proxy']);
  assert.equal(options.timeout, 3000);
  return { stdout: text };
} });

test('downloads inherit enabled macOS HTTPS proxy without mutating the caller environment', async () => {
  const original = { PATH: '/bin', GH_TOKEN: 'fixture-token' };
  const env = await resolveDownloadEnvironment(original, mac(settings));
  assert.deepEqual(original, { PATH: '/bin', GH_TOKEN: 'fixture-token' });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'localhost,*.local,10.0.0.0/8');
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
});

test('explicit proxy and bypass settings win without querying the system', async () => {
  const never = { platform: 'darwin', execute: async () => { throw new Error('must not inspect system'); } };
  for (const env of [
    { HTTPS_PROXY: 'http://user:password@proxy.example:8080', NO_PROXY: 'github.com' },
    { https_proxy: 'http://proxy.example:8080', no_proxy: '*' },
    { HTTPS_PROXY: '' }, { HTTPS_PROXY: '', HTTP_PROXY: 'http://proxy.example:8080' },
    { ALL_PROXY: 'socks5://proxy.example:1080' },
  ]) assert.deepEqual(await resolveDownloadEnvironment(env, never), env);
  assert.deepEqual(await resolveDownloadEnvironment({ http_proxy: 'http://proxy.example:8080', no_proxy: '.local' }, never),
    { http_proxy: 'http://proxy.example:8080', HTTPS_PROXY: 'http://proxy.example:8080', no_proxy: '.local' });
  const bypass = await resolveDownloadEnvironment({ NO_PROXY: '' }, mac(settings));
  assert.equal(bypass.NO_PROXY, '');
  assert.equal(bypass.HTTPS_PROXY, 'http://127.0.0.1:7897');
});

test('system HTTP proxy is a fallback; IPv6 endpoints remain valid', async () => {
  const env = await resolveDownloadEnvironment({}, mac(settings.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')));
  assert.equal(env.HTTPS_PROXY, 'http://fallback.example:8080');
  const ipv6 = await resolveDownloadEnvironment({}, mac('HTTPSEnable : 1\nHTTPSProxy : ::1\nHTTPSPort : 7897'));
  assert.equal(ipv6.HTTPS_PROXY, 'http://[::1]:7897');
});

test('invalid endpoints, disabled proxies and unavailable system settings safely retain the original environment', async () => {
  const env = { PATH: '/bin' };
  for (const text of [
    'HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897',
    'HTTPSEnable : 1\nHTTPSProxy : user:password@proxy.example\nHTTPSPort : 7897',
    'HTTPSEnable : 1\nHTTPSProxy : proxy.example/path\nHTTPSPort : 7897',
    'HTTPSEnable : 1\nHTTPSProxy : proxy.example\nHTTPSPort : 0',
    'HTTPSEnable : 1\nHTTPSProxy : proxy.example\nHTTPSPort : 65536',
    'ProxyAutoConfigEnable : 1\nSOCKSEnable : 1\nSOCKSProxy : 127.0.0.1\nSOCKSPort : 7897',
  ]) assert.deepEqual(await resolveDownloadEnvironment(env, mac(text)), env);
  assert.deepEqual(await resolveDownloadEnvironment(env, { platform: 'darwin', execute: async () => { throw new Error('unavailable'); } }), env);
  assert.deepEqual(await resolveDownloadEnvironment(env, { platform: 'linux', execute: async () => { assert.fail('must not query macOS'); } }), env);
});
