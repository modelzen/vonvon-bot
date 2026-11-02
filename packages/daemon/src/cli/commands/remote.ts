import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import type { AddressKind, DeviceReply, DeviceStatus } from '@vonvon/protocol';
import { paths } from '../../config/paths';
import { canonicalHost, cgnatRisk, hostHeader, needsConfirmation, networkIdentity, PUBLIC_RISK, resolveEnable, TAILSCALE_HINT, type EnableDeps } from '../../remote/address';
import { candidateContext, candidateLabel, defaultCandidate, listCandidates, type Candidate } from '../../remote/candidates';
import { disableAddress, enableAddress, PORT_RANGE, readRemoteConfig, setPort, updateRemoteConfig, type RemoteAddress, type RemoteConfig } from '../../remote/config';
import { loadOrCreateDevice } from '../../remote/device';
import { NO_REMOTE_ADDRESS } from '../../server/rpc/device';
import { readMachineId } from '../../server/local-credential';
import { tailscaleIps } from '../../remote/tailscale';
import { badArgs, CommandError } from '../command-error';
import { print, want, withDaemon, type Daemon, type Io } from '../daemon-client';
import { either, onFiles } from './device';

// D3 4.8; the texts: devices 第 15 节
const KIND_NAME: Record<AddressKind, string> = { tailscale: 'Tailscale 地址', overlay: '组网地址', lan: '局域网地址', cgnat: '运营商地址', public: '公网地址', loopback: '回环地址' };
const confirmed = (kind: AddressKind): string => needsConfirmation(kind) ? `${KIND_NAME[kind]}（已确认）` : KIND_NAME[kind];
const STATE_NAME: Record<DeviceStatus['remote']['addresses'][number]['state'], string> = {
  listening: '在听', waiting: '等待地址出现', 'needs-confirmation': '网络变了，确认后再开', failed: '失败', disabled: '没在听',
};
const NOT_RUNNING = '后台服务没在运行，下次启动时生效。';
const enabled = (host: string, port: number, kind: AddressKind): string => `已在 ${hostHeader(host, port)} 接受连接（${confirmed(kind)}）。只有配对过的客户端能连上，接下来运行 \`vonvon pair\` 生成连接链接。`;
// A1: one address. Another one replaces it; the clients paired before follow it the way U1 lets them follow any move: a
// new link pasted into 添加 only updates the addresses it keeps (connections.ts `already_added` + `routesChanged`).
const replacedLine = (from: string, to: string, live: boolean): string => `已把远程地址从 ${from} 换成 ${to}，${from} 不再接受连接${live ? '，经它的连接已断开' : ''}。`;
const followLine = (count: number): string => `已配对的 ${count} 台设备要换到新地址：运行 \`vonvon pair\` 生成连接链接，粘到那台电脑的 Vonvon Bot → 设置 → 设备 → 添加，只会更新地址，不用重新配对。`;
const NOTHING_OPEN = '现在没有开启的远程地址。';
const PICK_HEADER = '别的设备用哪个地址连这台设备？只能开一个，已经开着别的会被换掉。';
const CANCELLED = '已取消，什么都没改。';
const EXAMPLE_HOST = '100.x.y.z';

const machine: EnableDeps = { interfaces: networkInterfaces, tailscale: () => tailscaleIps(), networkIdentity: iface => networkIdentity(iface) };
/** What `remote enable` with no address asks through: a person at a terminal (never under --json, nor a pipe). */
export interface Terminal { interactive: boolean; ask(question: string): Promise<string | undefined> }
/** One line from the terminal; Ctrl-C and EOF answer undefined. */
function askLine(question: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    prompt.on('SIGINT', () => prompt.close());
    prompt.on('close', () => { if (!answered) { process.stdout.write('\n'); resolve(undefined); } });
    prompt.question(question, answer => { answered = true; prompt.close(); resolve(answer); });
  });
}
const processTerminal = (): Terminal => ({ interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), ask: askLine });

/** With no daemon: the addresses as written, none listened on, and no client connected. */
async function filesStatus(home: string, config: RemoteConfig): Promise<DeviceStatus> {
  const { deviceId, name, keypair } = await loadOrCreateDevice(home, await readMachineId(home));
  const total = await onFiles(home, async registry => registry.list().filter(client => client.revokedAt === undefined).length);
  return {
    device: { id: deviceId, name, publicKey: keypair.publicKey },
    remote: { port: config.port, addresses: config.addresses.map(({ host, kind, enabledAt }) => ({ host, kind, enabledAt, state: 'disabled' as const })) },
    clients: { total, active: 0 },
  };
}
type Source = { source?: 'files' };
const tail = (from: Source): string[] => from.source === 'files' ? [NOT_RUNNING] : [];
/** One address's state as a line, for the ones a command just changed and does not listen on yet. */
const stateLine = (address: DeviceStatus['remote']['addresses'][number] | undefined): string[] =>
  address && address.state !== 'listening' && address.state !== 'disabled' ? [`现在：${STATE_NAME[address.state]}${address.detail ? `，${address.detail}` : ''}。`] : [];
const statusOf = (what: string) => async (reply: Promise<DeviceReply>): Promise<DeviceStatus> => want(what, await reply, 'deviceStatus').status;

/** A candidate as `--json` gives it, with what a person reads. */
function candidateView(candidate: Candidate, recommended: Candidate | undefined) {
  const best = candidate === recommended && candidate.kind === 'tailscale';
  return { ...candidate, label: candidateLabel(candidate, best), ...(best ? { recommended: true } : {}), ...(needsConfirmation(candidate.kind) ? { needsConfirmation: true } : {}) };
}
const recommendedOf = (candidates: readonly Candidate[]): Candidate | undefined => {
  const first = defaultCandidate(candidates);
  return first?.kind === 'tailscale' ? first : undefined;
};
const shownOf = (candidates: readonly Candidate[]): Candidate[] => candidates.filter(candidate => !candidate.hidden);
/** The ones left out by default (virtual bridges, a proxy's fake IPs), said in one line. */
const hiddenHint = (candidates: readonly Candidate[]): string[] => {
  const hidden = candidates.length - shownOf(candidates).length;
  return hidden ? [`另有 ${hidden} 个一般用不上的地址（虚拟网桥、代理软件的虚拟地址、自动分配的地址），运行 \`vonvon remote candidates --all\` 列出。`] : [];
};
/** `remote enable` with no address and no terminal (A1): exit 2, the addresses and a command to copy. */
function noAddress(candidates: readonly Candidate[]): CommandError {
  const shown = shownOf(candidates);
  const best = recommendedOf(shown);
  const example = (defaultCandidate(shown) ?? shown[0])?.host ?? EXAMPLE_HOST;
  const message = shown.length
    ? ['没给地址。别的设备能用这些地址连这台设备（只能开一个）：', ...shown.map(candidate => `  ${candidateLabel(candidate, candidate === best)}`), `选一个运行，例如：vonvon remote enable ${example}`]
    : [`没给地址，这台设备上也没找到别的设备能连的地址。${TAILSCALE_HINT}`, ...hiddenHint(candidates), `找到后运行，例如：vonvon remote enable ${example}`];
  return new CommandError('bad-args', message.join('\n'), { reason: 'address_required', partial: { candidates: shown.map(candidate => candidateView(candidate, best)) } });
}

/** The risk of a CGNAT or public address, and the owner's yes; anything else cancels. */
async function confirmRisk(terminal: Terminal, risk: string): Promise<void> {
  const answer = await terminal.ask(`${risk}\n确定开启吗？[y/N] `);
  if (!/^\s*y(es)?\s*$/i.test(answer ?? '')) throw new CommandError('interrupted', CANCELLED);
}
/** The daemon's confirm_required words without the flag it names: here the terminal asks instead. */
const riskOnly = (message: string): string => (message.replace(/^开启远程地址失败：/, '').split('确定要开启请加')[0] ?? message).trim();

/** A1: in a terminal with no address, the list and a number; Enter takes the first one offered. An IP typed in is taken
 * as it is (the daemon classifies it). */
async function pickAddress(candidates: readonly Candidate[], terminal: Terminal, io: Io): Promise<{ host: string; kind?: AddressKind }> {
  const shown = shownOf(candidates);
  if (!shown.length) throw badArgs([`这台设备上没找到别的设备能连的地址。${TAILSCALE_HINT}`, ...hiddenHint(candidates)].join('\n'));
  const best = recommendedOf(shown);
  const first = defaultCandidate(shown);
  const index = first ? shown.indexOf(first) + 1 : undefined;
  io.write(`${[PICK_HEADER, ...shown.map((candidate, at) => `  ${at + 1}) ${candidateLabel(candidate, candidate === best)}  ${candidate.iface}`)].join('\n')}\n`);
  for (;;) {
    const answer = await terminal.ask(index ? `选一个 [${index}]: ` : '选一个: ');
    if (answer === undefined) throw new CommandError('interrupted', CANCELLED);
    const typed = answer.trim();
    if (typed === '' && first) return first;
    if (/^\d+$/.test(typed)) {
      const picked = shown[Number(typed) - 1];
      if (picked) return picked;
    }
    if (typed && isIP(canonicalHost(typed))) return { host: canonicalHost(typed) };
    io.write(`输入编号，1 到 ${shown.length}。\n`);
  }
}

/** `vonvon remote status|enable|disable|port|candidates` (D3 4.8, A1): through the daemon when it runs, which binds and
 * closes the listener at once; otherwise on remote.json under the host mutex, for the next start. `candidates` reads
 * this machine's interfaces only. */
export async function runRemote(action: 'status' | 'enable' | 'disable' | 'port' | 'candidates', target: { host?: string; allowPublic?: boolean; port?: string; all?: boolean },
  io: Io, daemon: Daemon = withDaemon, home = paths.appDir, deps: EnableDeps = machine, terminal: Terminal = processTerminal()): Promise<void> {
  if (action === 'candidates') {
    const all = listCandidates(await candidateContext(deps), { all: true });
    const candidates = target.all ? all : shownOf(all);
    const best = recommendedOf(candidates);
    const example = (defaultCandidate(candidates) ?? candidates[0])?.host;
    const human = candidates.length
      ? ['别的设备能用这些地址连这台设备（只能开一个）：', ...candidates.map(candidate => `  ${candidateLabel(candidate, candidate === best)}  ${candidate.iface}`),
        ...(example ? [`开其中一个：vonvon remote enable ${example}；在终端里直接运行 \`vonvon remote enable\` 可以选。`] : [])]
      : [`这台设备上没找到别的设备能连的地址。${TAILSCALE_HINT}`];
    if (!target.all) human.push(...hiddenHint(all));
    print(io, human, { candidates: candidates.map(candidate => candidateView(candidate, best)) });
    return;
  }
  if (action === 'status') {
    const [status, from] = await either(home, daemon, '读取远程连接状态', send => statusOf('读取远程连接状态')(send({ type: 'status' })), async () => filesStatus(home, await readRemoteConfig(home)));
    const rows = status.remote.addresses.map(({ host, kind, state, detail }) => `${host}  ${KIND_NAME[kind]}  ${STATE_NAME[state]}  ${detail ?? '—'}  ${status.remote.port}`);
    print(io, [...rows.length ? ['地址  种类  状态  说明  端口', ...rows] : [NO_REMOTE_ADDRESS], `客户端：${status.clients.total} 台，在线 ${status.clients.active}`, ...tail(from)], { status, ...from });
    return;
  }
  if (action === 'enable') {
    let host = target.host === undefined ? undefined : canonicalHost(target.host);
    let allowPublic = Boolean(target.allowPublic);
    const asked = host === undefined;
    if (host === undefined) {
      const candidates = listCandidates(await candidateContext(deps), { all: true });
      if (!terminal.interactive || io.json) throw noAddress(candidates);
      const picked = await pickAddress(candidates, terminal, io);
      host = picked.host;
      if (picked.kind && needsConfirmation(picked.kind) && !allowPublic) {
        await confirmRisk(terminal, picked.kind === 'cgnat' ? cgnatRisk(host) : PUBLIC_RISK);
        allowPublic = true;
      }
    }
    const open = (address: string, allow: boolean) => either(home, daemon, '开启远程地址', async send => {
      const read = statusOf('开启远程地址');
      const before = (await read(send({ type: 'status' }))).remote.addresses[0]?.host;
      return { before, status: await read(send({ type: 'enable', host: address, ...(allow ? { allowPublic: true } : {}) })) };
    }, async () => {
      const resolved = await resolveEnable({ host: address, ...(allow ? { allowPublic: true } : {}) }, deps);
      let before: RemoteAddress | undefined;
      const config = await updateRemoteConfig(home, current => { before = current.addresses[0]; return enableAddress(current, resolved); });
      return { before: before?.host, status: await filesStatus(home, config) };
    });
    let opened: Awaited<ReturnType<typeof open>>;
    try { opened = await open(host, allowPublic); }
    catch (error) {
      // the daemon tells this address apart otherwise than the list did (its PATH may have no `tailscale`): ask here too
      if (!(asked && !allowPublic && error instanceof CommandError && error.reason === 'confirm_required')) throw error;
      await confirmRisk(terminal, riskOnly(error.message));
      opened = await open(host, true);
    }
    const [{ before, status }, from] = opened;
    const address = status.remote.addresses.find(entry => entry.host === host);
    if (!address) throw new Error('开启的地址不在状态里。');
    const replaced = before !== undefined && before !== address.host ? before : undefined;
    const lines = [
      ...(replaced ? [replacedLine(replaced, address.host, from.source !== 'files')] : []),
      enabled(address.host, status.remote.port, address.kind), ...stateLine(address),
      ...(replaced && status.clients.total > 0 ? [followLine(status.clients.total)] : []), ...tail(from),
    ];
    print(io, lines, { host: address.host, ...(replaced ? { replaced } : {}), status, ...from });
    return;
  }
  if (action === 'disable') {
    // A1: with no address, the one that is open
    const given = target.host === undefined ? undefined : canonicalHost(target.host);
    const [{ host, status }, from] = await either(home, daemon, '关闭远程地址', async send => {
      const read = statusOf('关闭远程地址');
      const host = given ?? (await read(send({ type: 'status' }))).remote.addresses[0]?.host;
      if (host === undefined) throw badArgs(NOTHING_OPEN);
      return { host, status: await read(send({ type: 'disable', host })) };
    }, async () => {
      let host = given;
      const config = await updateRemoteConfig(home, current => {
        host ??= current.addresses[0]?.host;
        if (host === undefined) throw badArgs(NOTHING_OPEN);
        return disableAddress(current, host);
      });
      return { host: host ?? '', status: await filesStatus(home, config) };
    });
    print(io, [from.source === 'files' ? `已关闭 ${host}。` : `已关闭 ${host}，经这个地址的连接都已断开。`, ...tail(from)], { host, status, ...from });
    return;
  }
  const port = Number(target.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw badArgs(PORT_RANGE);
  const [status, from] = await either(home, daemon, '改远程端口', send => statusOf('改远程端口')(send({ type: 'setPort', port })),
    async () => filesStatus(home, await updateRemoteConfig(home, config => setPort(config, port))));
  print(io, [`远程端口改成了 ${port}，已配对的设备要重新配对。`, ...status.remote.addresses.flatMap(address => stateLine(address).map(line => `${address.host}：${line}`)), ...tail(from)], { status, ...from });
}
