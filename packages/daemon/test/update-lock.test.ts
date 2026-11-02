import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// 只需 appDir：更新锁 / 更新状态文件都落在这里。指到临时目录，绝不碰真 home。
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'update-lock-test-'));
  return { paths: { appDir } };
});

import { paths } from '../src/config/paths';
import { acquireUpdateLock, clearUpdateStatus, processStart, readUpdateStatus, writeUpdateStatus } from '../src/service/update';

const lockFile = (): string => join(paths.appDir, 'update.lock');
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

const guardDir = (): string => `${lockFile()}.reclaim`;
const DEAD_PID = 2147483000; // a pid that is almost surely nobody's: process.kill(pid, 0) → ESRCH
const aged = (file: string, ms: number): void => { const then = (Date.now() - ms) / 1000; utimesSync(file, then, then); };
afterEach(() => {
  rmSync(lockFile(), { force: true });
  rmSync(guardDir(), { recursive: true, force: true });
  clearUpdateStatus();
});

// B（跨进程更新锁）：防止 Web「升级」与私聊「更新」并发跑两个 `npm i -g` 装坏全局目录。
// O_EXCL 原子占有 + 陈旧回收（持有者已死，或 pid 已换了进程）。纯 fs，mac 上可测。
describe('acquireUpdateLock（跨进程更新互斥）', () => {
  it('持锁期间第二次 acquire 返回 null；release 后可再拿', () => {
    const r1 = acquireUpdateLock();
    expect(typeof r1).toBe('function');
    expect(existsSync(lockFile())).toBe(true);

    // 活体、新鲜的持有者（就是本测试进程）→ 第二次判「进行中」，绝不并发 npm。
    expect(acquireUpdateLock()).toBeNull();

    r1!();
    expect(existsSync(lockFile())).toBe(false);

    const r3 = acquireUpdateLock(); // 已释放 → 能再拿
    expect(typeof r3).toBe('function');
    r3!();
  });

  it('陈旧锁（持有者已死）被回收', () => {
    // 一个几乎不可能存在的 pid：process.kill(pid,0) → ESRCH → 判死 → 回收。
    writeFileSync(lockFile(), JSON.stringify({ pid: 2147483000, at: Date.now() }), 'utf8');
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function'); // 回收死锁并抢到
    r!();
  });

  it('存活持有者的锁不因超过 30min 而被回收', () => {
    // 父进程（vitest 主进程）在跑：写锁时没记启动时间的旧锁只按 pid 判。
    writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, at: Date.now() - 31 * 60 * 1000 }), 'utf8');
    const r = acquireUpdateLock();
    try { expect(r).toBeNull(); } finally { r?.(); }
  });

  // 审查（3a/3b 修完后的检查）：只认 pid 死了才算陈旧，被杀掉的更新留下的锁在 pid 被再用后永远拿不回来。
  it('写着本进程 pid、却不是本进程拿的锁（之前同 pid 的进程留下的）被回收', () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() - 7 * 86_400_000 }), 'utf8');
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    expect(acquireUpdateLock()).toBeNull(); // 本进程拿着的照旧算进行中
    r!();
    expect(existsSync(lockFile())).toBe(false);
  });

  it.runIf(process.platform === 'linux')('pid 还活着、但启动时间不是锁里记的（pid 被别的进程再用了）→ 回收', () => {
    const start = processStart(process.ppid);
    expect(start).toMatch(/^[\w-]+\/\d+$/);
    writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, at: Date.now(), start }), 'utf8');
    expect(acquireUpdateLock()).toBeNull(); // 同一个进程 → 还在用
    writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, at: Date.now(), start: `${start}0` }), 'utf8');
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid, start: processStart(process.pid) });
    r!();
  });

  it('release 只删一次：同一进程之后再拿的锁不被早先的 release 删掉', () => {
    const r1 = acquireUpdateLock();
    r1!();
    const r2 = acquireUpdateLock();
    expect(typeof r2).toBe('function');
    r1!(); // 早先那把的第二次 release
    expect(existsSync(lockFile())).toBe(true);
    expect(acquireUpdateLock()).toBeNull();
    r2!();
    expect(existsSync(lockFile())).toBe(false);
  });

  it('读不出的锁（另一个进程刚建、还没写完）10 秒内不回收，之后回收', () => {
    writeFileSync(lockFile(), '', 'utf8');
    expect(acquireUpdateLock()).toBeNull();
    const old = (Date.now() - 11_000) / 1000;
    utimesSync(lockFile(), old, old);
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    r!();
  });

  it('release 只删属于自己的锁：文件被换成别的 pid 时不误删', () => {
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    // 模拟锁被回收后换了新主（另一个存活进程 = 本测试进程，但 pid 记成别的值）。
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid + 1, at: Date.now() }), 'utf8');
    r!(); // 我们的 release：发现 pid 不是自己 → 不动
    expect(existsSync(lockFile())).toBe(true); // 新主的锁仍在
  });
});

// Review 220: `update-state.lock` took a lock from a live holder once it was 10 s old, and reclaiming a stale lock by
// renaming it aside left the name free between the rename and the link back, so a third process got in while the
// reclaimer believed it held the lock. The lock now never goes by age for a readable record, and a stale record is
// removed only under the reclaim guard `<lock>.reclaim`, after reading it again.
describe('acquireUpdateLock（回收不抢活着的持有者，回收本身互斥）', () => {
  it('a live holder keeps its lock however old the record and the file are', () => {
    const start = processStart(process.ppid);
    const record = JSON.stringify({ pid: process.ppid, at: Date.now() - 11_000, token: 'theirs', ...(start ? { start } : {}) });
    writeFileSync(lockFile(), record, 'utf8');
    aged(lockFile(), 11_000);
    expect(acquireUpdateLock()).toBeNull();
    aged(lockFile(), 3 * 86_400_000);
    expect(acquireUpdateLock()).toBeNull();
    expect(readFileSync(lockFile(), 'utf8')).toBe(record);
  });

  it('takes a stale lock through the reclaim guard and leaves neither behind', () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: DEAD_PID, at: 0, token: 'dead' }), 'utf8');
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid });
    expect(existsSync(guardDir())).toBe(false);
    r!();
    expect(existsSync(lockFile())).toBe(false);
  });

  it('recovers a reclaim guard a dead process left behind, then takes the stale lock', () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: DEAD_PID, at: 0, token: 'dead' }), 'utf8');
    mkdirSync(guardDir());
    writeFileSync(join(guardDir(), 'gone'), JSON.stringify({ pid: DEAD_PID, at: 0, token: 'gone' }), 'utf8');
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    expect(existsSync(guardDir())).toBe(false);
    r!();
  });

  it('recovers a reclaim guard whose owner file is unreadable only once it is old', () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: DEAD_PID, at: 0, token: 'dead' }), 'utf8');
    mkdirSync(guardDir());
    writeFileSync(join(guardDir(), 'half'), '', 'utf8');
    expect(acquireUpdateLock()).toBeNull();
    aged(join(guardDir(), 'half'), 11_000);
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    r!();
  });

  it('waits behind a reclaim guard a live process holds: the stale lock under it is theirs to take', () => {
    const stale = JSON.stringify({ pid: DEAD_PID, at: 0, token: 'dead' });
    writeFileSync(lockFile(), stale, 'utf8');
    mkdirSync(guardDir());
    const start = processStart(process.ppid);
    const owner = JSON.stringify({ pid: process.ppid, at: Date.now() - 60_000, token: 'reclaimer', ...(start ? { start } : {}) });
    writeFileSync(join(guardDir(), 'reclaimer'), owner, 'utf8');
    expect(acquireUpdateLock()).toBeNull();
    expect(readFileSync(lockFile(), 'utf8')).toBe(stale);
    expect(readFileSync(join(guardDir(), 'reclaimer'), 'utf8')).toBe(owner);
  });

  it('shows no half-written lock: the file appears with its whole record', () => {
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    expect(() => JSON.parse(readFileSync(lockFile(), 'utf8'))).not.toThrow();
    r!();
    expect(existsSync(`${lockFile()}.tmp`)).toBe(false);
  });
});

// D（更新结果状态）：给 detached helper 的结果一个 daemon 能读、Web 能轮询的落点。
describe('update status 读/写/清', () => {
  it('无记录返回 null；写后可读；清后又为 null', () => {
    expect(readUpdateStatus()).toBeNull();

    writeUpdateStatus({ phase: 'error', ok: false, from: '0.6.6', message: '安装失败：x', at: 123 });
    const s = readUpdateStatus();
    expect(s?.phase).toBe('error');
    expect(s?.from).toBe('0.6.6');
    expect(s?.message).toContain('安装失败');

    clearUpdateStatus();
    expect(readUpdateStatus()).toBeNull();
  });

  it('损坏的状态文件读成 null（不抛）', () => {
    writeFileSync(join(paths.appDir, 'update-status.json'), '{ not json', 'utf8');
    expect(readUpdateStatus()).toBeNull();
  });
});
