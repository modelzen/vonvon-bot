import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { connectLocal } from '@vonvon/client';
import { runRemote } from '../src/cli/commands/remote';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import type { EnableDeps } from '../src/remote/address';
import { devicesPath } from '../src/remote/files';
import { acquirePidLock, publishPidLock, releasePidLock } from '../src/server/pid-lock';
import { startFixture } from './server-fixture';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vonvon-cli-remote-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const output = (json = true) => {
  const lines: string[] = [];
  return { lines, io: { json, write: (text: string) => { lines.push(text); } }, last: () => JSON.parse(lines.at(-1) ?? 'null'), text: () => lines.join('') };
};
const noDaemon = () => { throw new Error('the daemon is not running'); };
const nic = (address: string) => ({ address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '02:00:00:00:00:01', internal: false, cidr: `${address}/24` });
const LAN = '10.255.255.253';
const deps: EnableDeps = { interfaces: () => ({ eth0: [nic(LAN)] }), tailscale: async () => ({ installed: false, ips: [] }), networkIdentity: async () => 'gw:aa:bb:cc:dd:ee:ff' };

// D3 4.8 / devices 8.3: main 必败, there was no remote command.
it('writes remote.json itself when no daemon runs, says it takes effect at the next start, and refuses what needs confirming', async () => {
  const enabled = output();
  await runRemote('enable', { host: LAN }, enabled.io, noDaemon, home, deps);
  expect(enabled.last()).toMatchObject({ ok: true, host: LAN, source: 'files', status: { remote: { port: 7767, addresses: [{ host: LAN, kind: 'lan', state: 'disabled' }] }, clients: { total: 0, active: 0 } } });
  expect(JSON.parse(await readFile(devicesPath(home, 'remote.json'), 'utf8')).addresses).toEqual([{ host: LAN, enabledAt: expect.any(Number), kind: 'lan', iface: 'eth0', network: 'gw:aa:bb:cc:dd:ee:ff' }]);
  const human = output(false);
  await runRemote('enable', { host: LAN }, human.io, noDaemon, home, deps);
  expect(human.text()).toBe(`已在 ${LAN}:7767 接受连接（局域网地址）。只有配对过的客户端能连上，接下来运行 \`vonvon pair\` 生成连接链接。\n后台服务没在运行，下次启动时生效。\n`);
  const status = output();
  await runRemote('status', {}, status.io, noDaemon, home, deps);
  expect(status.last()).toMatchObject({ source: 'files', status: { remote: { addresses: [{ host: LAN, state: 'disabled' }] } } });
  const table = output(false);
  await runRemote('status', {}, table.io, noDaemon, home, deps);
  expect(table.text()).toBe(`地址  种类  状态  说明  端口\n${LAN}  局域网地址  没在听  —  7767\n客户端：0 台，在线 0\n后台服务没在运行，下次启动时生效。\n`);

  await expect(runRemote('enable', { host: '203.0.113.5' }, output().io, noDaemon, home, deps)).rejects.toMatchObject({ kind: 'refused', reason: 'confirm_required', message: expect.stringContaining('这是公网地址') });
  await expect(runRemote('enable', { host: '203.0.113.5', tailscale: true }, output().io, noDaemon, home, deps)).rejects.toMatchObject({ kind: 'bad-args' });
  await expect(runRemote('enable', { tailscale: true }, output().io, noDaemon, home, deps)).rejects.toMatchObject({ kind: 'refused', reason: 'tailscale_unavailable' });
  await expect(runRemote('port', { port: '80' }, output().io, noDaemon, home, deps)).rejects.toMatchObject({ kind: 'bad-args' });
  await expect(runRemote('disable', { host: '192.0.2.1' }, output().io, noDaemon, home, deps)).rejects.toMatchObject({ kind: 'bad-args', message: '这个地址没有开启。' });
  const moved = output();
  await runRemote('port', { port: '17767' }, moved.io, noDaemon, home, deps);
  expect(moved.last()).toMatchObject({ source: 'files', status: { remote: { port: 17767 } } });
  const off = output();
  await runRemote('disable', { host: LAN }, off.io, noDaemon, home, deps);
  expect(off.last()).toMatchObject({ host: LAN, source: 'files', status: { remote: { addresses: [] } } });
});
it('goes through the daemon when it runs', async () => {
  const fixture = await startFixture(undefined, undefined, undefined, { interfaces: deps.interfaces, tailscale: deps.tailscale, networkIdentity: deps.networkIdentity, timers: { retry: 60_000 } });
  const lock = await acquirePidLock(fixture.home);
  try {
    await publishPidLock(fixture.home, lock, `127.0.0.1:${fixture.api.port}`);
    const cliEntry = join(fixture.home, 'fake-cli.mjs');
    await writeFile(cliEntry, `process.stdout.write(JSON.stringify({running:true,listen:"127.0.0.1:${fixture.api.port}"}));`);
    const daemon: Daemon = fn => withDaemon(fn, () => connectLocal({ home: fixture.home, cliEntry }));
    const enabled = output(false);
    await runRemote('enable', { host: LAN }, enabled.io, daemon, fixture.home, deps);
    // not on this machine: opened, and waiting for the address
    expect(enabled.text()).toBe(`已在 ${LAN}:7767 接受连接（局域网地址）。只有配对过的客户端能连上，接下来运行 \`vonvon pair\` 生成连接链接。\n现在：等待地址出现，等待地址 ${LAN} 出现。\n`);
    const status = output();
    await runRemote('status', {}, status.io, daemon, fixture.home, deps);
    expect(status.last()).toEqual({ ok: true, status: expect.objectContaining({ remote: { port: 7767, addresses: [expect.objectContaining({ host: LAN, state: 'waiting' })] } }) });
    await expect(runRemote('enable', { host: '100.70.0.1' }, output().io, daemon, fixture.home, deps)).rejects.toMatchObject({ kind: 'refused', message: expect.stringContaining('CGNAT') });
  } finally {
    await releasePidLock(fixture.home, lock);
    await fixture.close();
  }
});
