import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { paths } from '../src/config/paths';
import {
  buildDaemonControlCommand,
  collectHostDoctor,
  toDaemonStatus,
} from '../src/admin/host';
describe('host · toDaemonStatus（前台进程快照）', () => {
  it('前台运行：实际 PID、版本和启动时间，服务管理不可用', () => {
    const d = toDaemonStatus({ foreground: { pid: 4242, startedAt: 1000 }, version: '0.3.11', now: 61_000 });
    expect(d.installed).toBe(false);
    expect(d.running).toBe(true);
    expect(d.pid).toBe(4242);
    expect(d.version).toBe('0.3.11');
    expect(d.uptimeMs).toBe(60_000);
    expect(d.supported).toBe(false);
    expect(d.platformName).toBeUndefined();
    expect(d.selfHosted).toBe(true);
  });

  it('只读预览没有运行时长', () => {
    const d = toDaemonStatus({ version: '0.3.11' });
    expect(d.uptimeMs).toBeUndefined();
  });

  it('手动前台 daemon 运行且不注册服务', () => {
    const d = toDaemonStatus({ foreground: { pid: 4242, startedAt: 1000 }, version: '0.3.11', now: 5000 });
    expect(d.running).toBe(true);
    expect(d.selfHosted).toBe(true);
    expect(d.installed).toBe(false);
  });

  it('无前台进程时不支持服务管理且未运行', () => {
    const d = toDaemonStatus({ version: '0.3.11' });
    expect(d.supported).toBe(false);
    expect(d.installed).toBe(false);
    expect(d.running).toBe(false);
    expect(d.pid).toBeUndefined();
  });

  it('预览不会认领旧服务注册状态和 PID', () => {
    const d = toDaemonStatus({ version: '0.3.11' });
    expect(d.installed).toBe(false);
    expect(d.running).toBe(false);
    expect(d.pid).toBeUndefined();
    expect(d.selfHosted).toBe(false);
  });

  it('时钟回拨时运行时长至少为零', () => {
    expect(toDaemonStatus({ foreground: { pid: 42, startedAt: 5000 }, version: '0.3.11', now: 1000 }).uptimeMs).toBe(0);
  });
});

describe('host · buildDaemonControlCommand（detached helper 命令构建，只验生成不真跑）', () => {
  it('restart：node + binPath + __daemon-control restart', () => {
    const { command, args } = buildDaemonControlCommand('restart', '/pkg/bin/feishu-codex-bridge.mjs', '/usr/bin/node');
    expect(command).toBe('/usr/bin/node');
    expect(args).toEqual(['/pkg/bin/feishu-codex-bridge.mjs', '__daemon-control', 'restart']);
  });

  it('update：固定 action 形参，无任意字符串拼接进 shell（无注入面）', () => {
    const { args } = buildDaemonControlCommand('update', '/pkg/bin/x.mjs', '/usr/bin/node');
    expect(args).toEqual(['/pkg/bin/x.mjs', '__daemon-control', 'update']);
  });

  it('start / stop：同样只是固定 action 形参（service install / uninstall 的 detached 执行）', () => {
    expect(buildDaemonControlCommand('start', '/pkg/bin/x.mjs', '/usr/bin/node').args).toEqual([
      '/pkg/bin/x.mjs',
      '__daemon-control',
      'start',
    ]);
    expect(buildDaemonControlCommand('stop', '/pkg/bin/x.mjs', '/usr/bin/node').args).toEqual([
      '/pkg/bin/x.mjs',
      '__daemon-control',
      'stop',
    ]);
  });

  it('缺省 binPath/nodePath 时回退到当前 Node 与解析出的 bin（绝对路径）', () => {
    const { command, args } = buildDaemonControlCommand('restart');
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/bin\/vonvon\.mjs$/);
    expect(args.slice(1)).toEqual(['__daemon-control', 'restart']);
  });
});

describe('host · collectHostDoctor（宿主机域聚合，绝不抛错）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'host-doctor-test-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('Node/平台/路径形状齐全 + 日志体量递归累加字节', async () => {
    const logsDir = join(tmp, 'logs');
    mkdirSync(join(logsDir, 'sub'), { recursive: true });
    writeFileSync(join(logsDir, 'a.log'), 'x'.repeat(100));
    writeFileSync(join(logsDir, 'sub', 'b.log'), 'y'.repeat(50));
    const h = await collectHostDoctor(logsDir);
    expect(h.node).toBe(process.version);
    expect(typeof h.platform).toBe('string');
    expect(typeof h.arch).toBe('string');
    expect(h.appDir).toBe(paths.appDir);
    expect(h.logsDir).toBe(logsDir);
    expect(h.logBytes).toBe(150); // 100 + 50（含子目录）
    expect(h.version).toBeTruthy();
  });

  it('日志目录不存在 → logBytes 0，不抛错', async () => {
    const h = await collectHostDoctor(join(tmp, 'nope'));
    expect(h.logBytes).toBe(0);
  });
});
