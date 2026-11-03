import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { connectLocal } from '@vonvon/client';
import { runRemote, type Terminal } from '../src/cli/commands/remote';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import type { EnableDeps, Interfaces } from '../src/remote/address';
import { createClientRegistry } from '../src/remote/clients';
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
const LAN2 = '10.255.255.252';
const deps: EnableDeps = { interfaces: () => ({ eth0: [nic(LAN), nic(LAN2)] }), tailscale: async () => ({ installed: false, ips: [] }), networkIdentity: async () => 'gw:aa:bb:cc:dd:ee:ff' };
/** No terminal: what a pipe, a script or an agent is. */
const pipe: Terminal = { interactive: false, ask: async () => { throw new Error('asked without a terminal'); } };
/** A person at a terminal who answers these, in order; then Ctrl-C. */
function person(...answers: string[]) {
  const questions: string[] = [];
  const terminal: Terminal = { interactive: true, ask: async question => { questions.push(question); return answers.shift(); } };
  return { terminal, questions };
}
const PICK = '在终端里运行 `vonvon remote enable` 选一个这台设备的地址，或者 `vonvon remote candidates` 看有哪些。';
/** A Linux server: Tailscale, ZeroTier, a LAN, Docker, and a public address. */
const server: Interfaces = {
  eth0: [nic('203.0.113.9')], tailscale0: [nic('100.101.7.12')], ztc3q6qbhk: [nic('10.147.17.5')], wlan0: [nic('192.168.1.23')], docker0: [nic('172.17.0.1')],
};
const serverDeps: EnableDeps = { ...deps, interfaces: () => server };

// D3 4.8 / devices 8.3: main 必败, there was no remote command.
it('writes remote.json itself when no daemon runs, says it takes effect at the next start, and refuses what needs confirming', async () => {
  const enabled = output();
  await runRemote('enable', { host: LAN }, enabled.io, noDaemon, home, deps, pipe);
  expect(enabled.last()).toMatchObject({ ok: true, host: LAN, source: 'files', status: { remote: { port: 7767, addresses: [{ host: LAN, kind: 'lan', state: 'disabled' }] }, clients: { total: 0, active: 0 } } });
  expect(enabled.last().replaced).toBeUndefined();
  expect(JSON.parse(await readFile(devicesPath(home, 'remote.json'), 'utf8')).addresses).toEqual([{ host: LAN, enabledAt: expect.any(Number), kind: 'lan', iface: 'eth0', network: 'gw:aa:bb:cc:dd:ee:ff' }]);
  const human = output(false);
  await runRemote('enable', { host: LAN }, human.io, noDaemon, home, deps, pipe);
  expect(human.text()).toBe(`已在 ${LAN}:7767 接受连接（局域网地址）。只有配对过的客户端能连上，接下来运行 \`vonvon pair\` 生成连接链接。\n后台服务没在运行，下次启动时生效。\n`);
  const status = output();
  await runRemote('status', {}, status.io, noDaemon, home, deps);
  expect(status.last()).toMatchObject({ source: 'files', status: { remote: { addresses: [{ host: LAN, state: 'disabled' }] } } });
  const table = output(false);
  await runRemote('status', {}, table.io, noDaemon, home, deps);
  expect(table.text()).toBe(`地址  种类  状态  说明  端口\n${LAN}  局域网地址  没在听  —  7767\n客户端：0 台，在线 0\n后台服务没在运行，下次启动时生效。\n`);

  await expect(runRemote('enable', { host: '203.0.113.5' }, output().io, noDaemon, home, deps, pipe)).rejects.toMatchObject({ kind: 'refused', reason: 'confirm_required', message: expect.stringContaining('这是公网地址') });
  // a terminal does not turn an address typed on the command line into a question: --allow-public as before
  const asked = person('y');
  await expect(runRemote('enable', { host: '203.0.113.5' }, output(false).io, noDaemon, home, deps, asked.terminal)).rejects.toMatchObject({ reason: 'confirm_required' });
  expect(asked.questions).toEqual([]);
  await expect(runRemote('port', { port: '80' }, output().io, noDaemon, home, deps)).rejects.toMatchObject({ kind: 'bad-args' });
  // Codex review 232-1, 234-1, 234-2: the file path refuses a wildcard and a link-local IPv6 like the daemon, writing nothing
  const before = await readFile(devicesPath(home, 'remote.json'), 'utf8');
  for (const host of ['0.0.0.0', '::', 'fe80::1%eth0']) {
    await expect(runRemote('enable', { host, allowPublic: true }, output().io, noDaemon, home, deps, pipe)).rejects.toMatchObject({ kind: 'bad-args', message: expect.stringMatching(new RegExp(`^不能开启 .*${PICK.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')}$`)) });
  }
  expect(await readFile(devicesPath(home, 'remote.json'), 'utf8')).toBe(before);
  await expect(runRemote('disable', { host: '192.0.2.1' }, output().io, noDaemon, home, deps)).rejects.toMatchObject({ kind: 'bad-args', message: '这个地址没有开启。' });
  const moved = output();
  await runRemote('port', { port: '17767' }, moved.io, noDaemon, home, deps);
  expect(moved.last()).toMatchObject({ source: 'files', status: { remote: { port: 17767 } } });
  // fixes-0-9-0: a new port needs a new link pasted, in the panel's words (portHint); the pairing stays. main 必败: 要重新配对
  const movedText = output(false);
  await runRemote('port', { port: '17768' }, movedText.io, noDaemon, home, deps);
  expect(movedText.text()).toBe('远程端口改成了 17768，已配对的设备要粘一次新链接（`vonvon pair` 生成），只会更新地址，不用重新配对。\n后台服务没在运行，下次启动时生效。\n');
  const off = output();
  await runRemote('disable', { host: LAN }, off.io, noDaemon, home, deps);
  expect(off.last()).toMatchObject({ host: LAN, source: 'files', status: { remote: { addresses: [] } } });
});

// A1: main 必败, a second address was opened beside the first, and disable needed the address.
it('replaces the open address with another one, tells the paired devices how to follow, and disables the open one by itself', async () => {
  await runRemote('enable', { host: LAN }, output().io, noDaemon, home, deps, pipe);
  const alone = output(false);
  await runRemote('enable', { host: LAN2 }, alone.io, noDaemon, home, deps, pipe);
  // nothing paired yet: no word about following
  expect(alone.text()).toBe([
    `已把远程地址从 ${LAN} 换成 ${LAN2}，${LAN} 不再接受连接。`,
    `已在 ${LAN2}:7767 接受连接（局域网地址）。只有配对过的客户端能连上，接下来运行 \`vonvon pair\` 生成连接链接。`,
    '后台服务没在运行，下次启动时生效。', '',
  ].join('\n'));
  const registry = await createClientRegistry(home);
  await registry.add({ name: '笔记本', publicKey: 'a'.repeat(43), clientKind: 'desktop', address: '192.0.2.1:1', invitedBy: 'local' });
  await registry.close();
  const back = output();
  await runRemote('enable', { host: LAN }, back.io, noDaemon, home, deps, pipe);
  expect(back.last()).toMatchObject({ host: LAN, replaced: LAN2, status: { remote: { addresses: [{ host: LAN }] }, clients: { total: 1 } } });
  const told = output(false);
  await runRemote('enable', { host: LAN2 }, told.io, noDaemon, home, deps, pipe);
  expect(told.text()).toContain('已配对的 1 台设备要换到新地址：运行 `vonvon pair` 生成连接链接，粘到那台电脑的 Vonvon Bot → 设置 → 设备 → 添加，只会更新地址，不用重新配对。');
  // the same one again: no replacement
  const again = output();
  await runRemote('enable', { host: LAN2 }, again.io, noDaemon, home, deps, pipe);
  expect(again.last().replaced).toBeUndefined();
  expect(JSON.parse(await readFile(devicesPath(home, 'remote.json'), 'utf8')).addresses).toEqual([expect.objectContaining({ host: LAN2 })]);

  const off = output();
  await runRemote('disable', {}, off.io, noDaemon, home, deps);
  expect(off.last()).toMatchObject({ host: LAN2, status: { remote: { addresses: [] } } });
  await expect(runRemote('disable', {}, output().io, noDaemon, home, deps)).rejects.toMatchObject({ kind: 'bad-args', message: '现在没有开启的远程地址。' });
});

it('lists the candidates in words and as JSON, the left-out ones only with --all', async () => {
  const human = output(false);
  await runRemote('candidates', {}, human.io, noDaemon, home, serverDeps);
  expect(human.text()).toBe([
    '别的设备能用这些地址连这台设备（只能开一个）：',
    '  Tailscale（推荐）· 100.101.7.12  tailscale0', '  组网 · ZeroTier · 10.147.17.5  ztc3q6qbhk', '  局域网 · 192.168.1.23  wlan0', '  公网 · 203.0.113.9（要确认）  eth0',
    '开其中一个：vonvon remote enable 100.101.7.12；在终端里直接运行 `vonvon remote enable` 可以选。',
    '另有 1 个一般用不上的地址（虚拟网桥、代理软件的虚拟地址、自动分配的地址），运行 `vonvon remote candidates --all` 列出。', '',
  ].join('\n'));
  const json = output();
  await runRemote('candidates', {}, json.io, noDaemon, home, serverDeps);
  expect(json.last()).toEqual({ ok: true, candidates: [
    { host: '100.101.7.12', kind: 'tailscale', iface: 'tailscale0', tool: 'Tailscale', label: 'Tailscale（推荐）· 100.101.7.12', recommended: true },
    { host: '10.147.17.5', kind: 'overlay', iface: 'ztc3q6qbhk', tool: 'ZeroTier', label: '组网 · ZeroTier · 10.147.17.5' },
    { host: '192.168.1.23', kind: 'lan', iface: 'wlan0', label: '局域网 · 192.168.1.23' },
    { host: '203.0.113.9', kind: 'public', iface: 'eth0', label: '公网 · 203.0.113.9（要确认）', needsConfirmation: true },
  ] });
  const all = output();
  await runRemote('candidates', { all: true }, all.io, noDaemon, home, serverDeps);
  expect(all.last().candidates.at(-1)).toEqual({ host: '172.17.0.1', kind: 'lan', iface: 'docker0', hidden: 'bridge', label: '虚拟网桥 · 172.17.0.1（一般用不上）' });
  const nothing = output(false);
  await runRemote('candidates', {}, nothing.io, noDaemon, home, { ...deps, interfaces: () => ({}) });
  expect(nothing.text()).toMatch(/^这台设备上没找到别的设备能连的地址。推荐用 Tailscale/);
});

// A1 (Codex 261 P3): the removed --tailscale says what to write instead, and writes nothing.
it('tells an old --tailscale what to write instead', async () => {
  await expect(runRemote('enable', { tailscale: true }, output().io, noDaemon, home, serverDeps, pipe)).rejects.toMatchObject({
    kind: 'bad-args', message: expect.stringMatching(/^没有 `--tailscale` 了，直接写地址：`vonvon remote enable "\$\(tailscale ip -4\)"`。.*vonvon remote candidates/),
  });
  await expect(readFile(devicesPath(home, 'remote.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

// A1: main 必败, `remote enable` with no address needed --tailscale.
it('asks for no address without a terminal: exit 2, the candidates and a command to copy', async () => {
  await expect(runRemote('enable', {}, output().io, noDaemon, home, serverDeps, pipe)).rejects.toMatchObject({
    kind: 'bad-args', reason: 'address_required',
    message: ['没给地址。别的设备能用这些地址连这台设备（只能开一个）：', '  Tailscale（推荐）· 100.101.7.12', '  组网 · ZeroTier · 10.147.17.5', '  局域网 · 192.168.1.23',
      '  公网 · 203.0.113.9（要确认）', '选一个运行，例如：vonvon remote enable 100.101.7.12'].join('\n'),
    partial: { candidates: expect.arrayContaining([expect.objectContaining({ host: '100.101.7.12', recommended: true })]) },
  });
  await expect(runRemote('enable', {}, output().io, noDaemon, home, { ...deps, interfaces: () => ({ docker0: [nic('172.17.0.1')] }) }, pipe)).rejects.toMatchObject({
    kind: 'bad-args', message: expect.stringMatching(/^没给地址，这台设备上也没找到别的设备能连的地址。.*\n另有 1 个一般用不上的地址.*\n找到后运行，例如：vonvon remote enable 100\.x\.y\.z$/s),
  });
  // --json is never a terminal
  const json = person('1');
  await expect(runRemote('enable', {}, output().io, noDaemon, home, serverDeps, json.terminal)).rejects.toMatchObject({ kind: 'bad-args', reason: 'address_required' });
  expect(json.questions).toEqual([]);
  await expect(readFile(devicesPath(home, 'remote.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('lets a person at a terminal pick one, Enter taking Tailscale, and asks before a public address', async () => {
  const enter = person('');
  const picked = output(false);
  await runRemote('enable', {}, picked.io, noDaemon, home, serverDeps, enter.terminal);
  expect(enter.questions).toEqual(['选一个 [1]: ']);
  expect(picked.text()).toBe([
    '别的设备用哪个地址连这台设备？只能开一个，已经开着别的会被换掉。',
    '  1) Tailscale（推荐）· 100.101.7.12  tailscale0', '  2) 组网 · ZeroTier · 10.147.17.5  ztc3q6qbhk', '  3) 局域网 · 192.168.1.23  wlan0', '  4) 公网 · 203.0.113.9（要确认）  eth0',
    '已在 100.101.7.12:7767 接受连接（Tailscale 地址）。只有配对过的客户端能连上，接下来运行 `vonvon pair` 生成连接链接。',
    '后台服务没在运行，下次启动时生效。', '',
  ].join('\n'));
  // a wrong answer asks again; the ZeroTier one needs no confirmation
  const zt = person('9', 'x', '2');
  const overlay = output(false);
  await runRemote('enable', {}, overlay.io, noDaemon, home, serverDeps, zt.terminal);
  expect(zt.questions).toEqual(['选一个 [1]: ', '选一个 [1]: ', '选一个 [1]: ']);
  expect(overlay.text()).toContain('输入编号 1 到 4，或者直接输入一个 IP。\n');
  expect(overlay.text()).toContain('已把远程地址从 100.101.7.12 换成 10.147.17.5，100.101.7.12 不再接受连接。\n已在 10.147.17.5:7767 接受连接（组网地址）。');
  // the public one: the risk, then yes
  const yes = person('4', 'y');
  const opened = output();
  await runRemote('enable', {}, { ...opened.io, json: false }, noDaemon, home, serverDeps, yes.terminal);
  expect(yes.questions[1]).toBe('这是公网地址。开启后互联网上任何人都能尝试连接这台设备；虽然只有配对过的客户端能连上、内容加密，但你的服务端会直接暴露在扫描和攻击之下。建议改用 Tailscale 或局域网地址。\n确定开启吗？[y/N] ');
  expect(JSON.parse(await readFile(devicesPath(home, 'remote.json'), 'utf8')).addresses).toEqual([{ host: '203.0.113.9', enabledAt: expect.any(Number), kind: 'public' }]);
  // no, Enter (the default is no), or Ctrl-C: nothing changes, exit 130
  for (const answers of [['4', 'n'], ['4', ''], ['4'], []]) {
    const no = person(...answers);
    await expect(runRemote('enable', {}, output(false).io, noDaemon, home, { ...serverDeps, interfaces: () => ({ ...server, eth0: [nic('198.51.100.7')] }) }, no.terminal))
      .rejects.toMatchObject({ kind: 'interrupted', message: '已取消，什么都没改。' });
  }
  expect(JSON.parse(await readFile(devicesPath(home, 'remote.json'), 'utf8')).addresses).toEqual([expect.objectContaining({ host: '203.0.113.9' })]);
  // an IP typed in is taken as it is
  const typed = person('192.168.1.23');
  await runRemote('enable', {}, output(false).io, noDaemon, home, serverDeps, typed.terminal);
  expect(JSON.parse(await readFile(devicesPath(home, 'remote.json'), 'utf8')).addresses).toEqual([expect.objectContaining({ host: '192.168.1.23', kind: 'lan' })]);
  // none to offer
  await expect(runRemote('enable', {}, output(false).io, noDaemon, home, { ...deps, interfaces: () => ({}) }, person('1').terminal)).rejects.toMatchObject({ kind: 'bad-args', message: expect.stringMatching(/^这台设备上没找到别的设备能连的地址。/) });
});

it('goes through the daemon when it runs, closing the old address when another one replaces it', async () => {
  // the daemon sees 100.70.0.1 on eth0 (CGNAT); the terminal's list took it for Tailscale's
  const fixture = await startFixture(undefined, undefined, undefined, { interfaces: () => ({ eth0: [nic(LAN), nic(LAN2), nic('100.70.0.1')] }), tailscale: deps.tailscale, networkIdentity: deps.networkIdentity, timers: { retry: 60_000 } });
  const lock = await acquirePidLock(fixture.home);
  try {
    await publishPidLock(fixture.home, lock, `127.0.0.1:${fixture.api.port}`);
    const cliEntry = join(fixture.home, 'fake-cli.mjs');
    await writeFile(cliEntry, `process.stdout.write(JSON.stringify({running:true,listen:"127.0.0.1:${fixture.api.port}"}));`);
    const daemon: Daemon = fn => withDaemon(fn, () => connectLocal({ home: fixture.home, cliEntry }));
    const enabled = output(false);
    await runRemote('enable', { host: LAN }, enabled.io, daemon, fixture.home, deps, pipe);
    // not on this machine: opened, and waiting for the address
    expect(enabled.text()).toBe(`已在 ${LAN}:7767 接受连接（局域网地址）。只有配对过的客户端能连上，接下来运行 \`vonvon pair\` 生成连接链接。\n现在：等待地址出现，等待地址 ${LAN} 出现。\n`);
    const status = output();
    await runRemote('status', {}, status.io, daemon, fixture.home, deps);
    expect(status.last()).toEqual({ ok: true, status: expect.objectContaining({ remote: { port: 7767, addresses: [expect.objectContaining({ host: LAN, state: 'waiting' })], candidates: expect.any(Array) } }) });
    // devices-ui-3 4.1: the daemon's own candidates ride along; the hidden flag is not sent
    expect(status.last().status.remote.candidates).toContainEqual({ host: LAN, kind: 'lan', iface: 'eth0' });
    expect(JSON.stringify(status.last().status.remote.candidates)).not.toContain('hidden');
    await expect(runRemote('enable', { host: '100.70.0.1' }, output().io, daemon, fixture.home, deps, pipe)).rejects.toMatchObject({ kind: 'refused', message: expect.stringContaining('CGNAT') });
    const replaced = output(false);
    await runRemote('enable', { host: LAN2 }, replaced.io, daemon, fixture.home, deps, pipe);
    expect(replaced.text()).toMatch(new RegExp(`^已把远程地址从 ${LAN} 换成 ${LAN2}，${LAN} 不再接受连接，经它的连接已断开。\n已在 ${LAN2}:7767`));
    const after = output();
    await runRemote('status', {}, after.io, daemon, fixture.home, deps);
    expect(after.last().status.remote.addresses).toEqual([expect.objectContaining({ host: LAN2 })]);
    // the terminal's list and the daemon disagree: the daemon's confirmation is asked here, then sent again
    const picker = person('', 'y');
    const terminalDeps: EnableDeps = { ...deps, interfaces: () => ({ tailscale0: [nic('100.70.0.1')] }) };
    const confirmed = output(false);
    await runRemote('enable', {}, confirmed.io, daemon, fixture.home, terminalDeps, picker.terminal);
    expect(picker.questions[1]).toMatch(/^100\.70\.0\.1 不在 Tailscale 或别的组网工具的网卡上，可能是运营商分配的地址（CGNAT），开启后同一运营商的其他用户也可能连到这台设备。\n确定开启吗？\[y\/N\] $/);
    expect(confirmed.text()).toContain('已在 100.70.0.1:7767 接受连接（运营商地址（已确认））。');
    const off = output();
    await runRemote('disable', {}, off.io, daemon, fixture.home, deps);
    expect(off.last()).toMatchObject({ host: '100.70.0.1', status: { remote: { addresses: [] } } });
    await expect(runRemote('disable', {}, output().io, daemon, fixture.home, deps)).rejects.toMatchObject({ kind: 'bad-args', message: '现在没有开启的远程地址。' });
  } finally {
    await releasePidLock(fixture.home, lock);
    await fixture.close();
  }
});
