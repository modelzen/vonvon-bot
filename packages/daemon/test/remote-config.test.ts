import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { disableAddress, enableAddress, readRemoteConfig, setPort, updateRemoteConfig, writeRemoteConfig } from '../src/remote/config';
import { devicesPath } from '../src/remote/files';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vonvon-remote-config-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

// D3 4.1: main 必败, remote.json had no writer.
it('adds, replaces and removes addresses, keeps the port in range, and writes 0600', async () => {
  const empty = await readRemoteConfig(home);
  expect(empty).toEqual({ v: 1, port: 7767, addresses: [] });
  const one = enableAddress(empty, { host: '192.168.1.9', enabledAt: 1, kind: 'lan', iface: 'eth0', network: 'gw:a' });
  const again = enableAddress(one, { host: '192.168.1.9', enabledAt: 2, kind: 'lan', iface: 'eth0', network: 'gw:b' });
  expect(again.addresses).toEqual([{ host: '192.168.1.9', enabledAt: 2, kind: 'lan', iface: 'eth0', network: 'gw:b' }]);
  // A1: one address; another one replaces it. main 必败: it was added beside the first
  expect(enableAddress(again, { host: '100.101.2.3', enabledAt: 3, kind: 'tailscale' }).addresses).toEqual([{ host: '100.101.2.3', enabledAt: 3, kind: 'tailscale' }]);
  expect(() => disableAddress(again, '10.0.0.1')).toThrow('这个地址没有开启。');
  expect(disableAddress(again, '192.168.1.9').addresses).toEqual([]);
  expect(() => setPort(again, 80)).toThrow('端口要在 1024 到 65535 之间。');
  expect(() => setPort(again, 70_000)).toThrow();
  await writeRemoteConfig(home, setPort(again, 17767));
  if (process.platform !== 'win32') expect((await stat(devicesPath(home, 'remote.json'))).mode & 0o777).toBe(0o600);
  expect(await readRemoteConfig(home)).toEqual({ ...again, port: 17767 });
});
it('keeps what a newer version added, and writes one change at a time', async () => {
  await writeRemoteConfig(home, { v: 1, port: 7767, addresses: [] });
  const file = devicesPath(home, 'remote.json');
  await writeFile(file, JSON.stringify({ v: 1, port: 7767, relay: { x: 1 }, addresses: [{ host: '10.0.0.1', enabledAt: 1, kind: 'lan', later: true }] }));
  // each change reads what the one before wrote: three at once all land
  await Promise.all([1, 2, 3].map(() => updateRemoteConfig(home, config => setPort(config, config.port + 1))));
  const written = JSON.parse(await readFile(file, 'utf8'));
  expect(written).toMatchObject({ port: 7770, relay: { x: 1 } });
  expect(written.addresses).toEqual([{ host: '10.0.0.1', enabledAt: 1, kind: 'lan', later: true }]);
  // A1: one address, the last one opened
  await Promise.all(['10.0.0.2', '10.0.0.3', '10.0.0.4'].map((host, n) => updateRemoteConfig(home, config => enableAddress(config, { host, enabledAt: n, kind: 'lan' }))));
  expect(JSON.parse(await readFile(file, 'utf8')).addresses).toEqual([{ host: '10.0.0.4', enabledAt: 2, kind: 'lan' }]);
});
// A1: a file D3 wrote with several addresses. main 必败: all of them were listened on.
it('reads several addresses from before A1 as the one opened last, and writes only that one back', async () => {
  await writeRemoteConfig(home, { v: 1, port: 7767, addresses: [] });
  const file = devicesPath(home, 'remote.json');
  await writeFile(file, JSON.stringify({ v: 1, port: 7767, addresses: [
    { host: '192.168.1.9', enabledAt: 5, kind: 'lan' }, { host: '100.101.2.3', enabledAt: 9, kind: 'tailscale' }, { host: '10.0.0.1', enabledAt: 7, kind: 'lan' },
  ] }));
  expect((await readRemoteConfig(home)).addresses).toEqual([{ host: '100.101.2.3', enabledAt: 9, kind: 'tailscale' }]);
  await updateRemoteConfig(home, config => setPort(config, 17767));
  expect(JSON.parse(await readFile(file, 'utf8')).addresses).toEqual([{ host: '100.101.2.3', enabledAt: 9, kind: 'tailscale' }]);
});
