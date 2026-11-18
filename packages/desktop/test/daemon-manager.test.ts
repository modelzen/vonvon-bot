import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import { createDaemonManager, protocolMismatchMessage, type DaemonManagerDependencies, type VerifiedDaemon } from '../src/daemon-manager.js';

const running: VerifiedDaemon = {
  pid: 4321,
  listen: '127.0.0.1:42345',
  startedAt: '2026-10-11T00:00:00.000Z',
};

function setup(statuses: Array<VerifiedDaemon | null>, registration: DaemonManagerDependencies['readRegistration'] = async () => ({ kind: 'absent' })) {
  const readVerifiedDaemon = vi.fn(async () => statuses.shift() ?? null);
  const readRegistration = vi.fn(registration);
  const startManaged = vi.fn(async (_requestedPort = 0) => {});
  const startBundled = vi.fn(async (_requestedPort = 0) => {});
  const startSelectedBot = vi.fn(async (_requestedPort: number, _bot: string) => running.pid);
  const checkProtocol = vi.fn(async () => PROTOCOL_VERSION);
  const pause = vi.fn(async () => {});
  const dependencies: DaemonManagerDependencies = { readVerifiedDaemon, readRegistration, startManaged, startBundled, startSelectedBot, checkProtocol, pause };
  return { manager: createDaemonManager(dependencies, { maxAttempts: 3 }), readVerifiedDaemon, readRegistration, startManaged, startBundled, startSelectedBot, checkProtocol, pause };
}

describe('daemon manager', () => {
  it('attaches to a verified running daemon without consulting registration or starting another', async () => {
    const fixture = setup([running]);
    await expect(fixture.manager.ensureReady()).resolves.toEqual(running);
    expect(fixture.checkProtocol).toHaveBeenCalledWith(running);
    expect(fixture.readRegistration).not.toHaveBeenCalled();
    expect(fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.startBundled).not.toHaveBeenCalled();
  });

  it('starts the bundled daemon when no registration exists and waits for verified readiness', async () => {
    const fixture = setup([null, null, running]);
    await expect(fixture.manager.ensureReady()).resolves.toEqual(running);
    expect(fixture.startBundled).toHaveBeenCalledOnce();
    expect(fixture.startBundled).toHaveBeenCalledWith(0);
    expect(fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.pause).toHaveBeenCalledOnce();
  });

  it('uses managed CLI start for our registration without a bundled fallback', async () => {
    const fixture = setup([null, running], async () => ({ kind: 'ours' }));
    await expect(fixture.manager.ensureReady()).resolves.toEqual(running);
    expect(fixture.startManaged).toHaveBeenCalledOnce();
    expect(fixture.startManaged).toHaveBeenCalledWith(0);
    expect(fixture.startBundled).not.toHaveBeenCalled();
  });

  it('passes the selected Bot unchanged to the single-Bot run path', async () => {
    const fixture = setup([null, running]);
    await expect(fixture.manager.ensureReady(0, 'cli_exact_Bot_ID')).resolves.toEqual(running);
    expect(fixture.startSelectedBot).toHaveBeenCalledExactlyOnceWith(0, 'cli_exact_Bot_ID');
    expect(fixture.startBundled).not.toHaveBeenCalled();
    expect(fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.checkProtocol).toHaveBeenCalledExactlyOnceWith(running);
  });

  it('refuses a different authenticated owner that wins the lock during selected Bot launch', async () => {
    const otherOwner = { ...running, pid: running.pid + 1 };
    const fixture = setup([null, otherOwner]);
    await expect(fixture.manager.ensureReady(0, 'cli_exact_Bot_ID')).rejects.toThrow(`另一个后台服务（PID ${otherOwner.pid}）在启动选定的 Bot`);
    expect(fixture.startSelectedBot).toHaveBeenCalledExactlyOnceWith(0, 'cli_exact_Bot_ID');
    expect(fixture.startBundled).not.toHaveBeenCalled();
    expect(fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.checkProtocol).not.toHaveBeenCalled();
    expect(fixture.readVerifiedDaemon).toHaveBeenCalledTimes(2);
    expect(fixture.pause).not.toHaveBeenCalled();
  });

  it('propagates selected Bot launch failure without accepting another owner or falling back', async () => {
    const fixture = setup([null, running]);
    fixture.startSelectedBot.mockRejectedValue(new Error('selected launch failed'));
    await expect(fixture.manager.ensureReady(0, 'cli_exact_Bot_ID')).rejects.toThrow('selected launch failed');
    expect(fixture.startBundled).not.toHaveBeenCalled();
    expect(fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.readVerifiedDaemon).toHaveBeenCalledOnce();
    expect(fixture.checkProtocol).not.toHaveBeenCalled();
    expect(fixture.pause).not.toHaveBeenCalled();
  });

  it('refuses a selected Bot under a registered service without launching another owner', async () => {
    const fixture = setup([null], async () => ({ kind: 'ours' }));
    await expect(fixture.manager.ensureReady(0, 'cli_exact_Bot_ID')).rejects.toThrow('请先卸载已注册的后台服务');
    expect(fixture.startSelectedBot).not.toHaveBeenCalled();
    expect(fixture.startBundled).not.toHaveBeenCalled();
    expect(fixture.startManaged).not.toHaveBeenCalled();
  });

  it('does not accept a running default daemon as a selected Bot start', async () => {
    const fixture = setup([running]);
    await expect(fixture.manager.ensureReady(0, 'cli_exact_Bot_ID')).rejects.toThrow('请先停掉正在运行的后台服务');
    expect(fixture.startSelectedBot).not.toHaveBeenCalled();
  });

  it.each(['absent', 'ours'] as const)('passes the explicit port to the %s launch and accepts its ready owner', async (kind) => {
    const statuses: Array<VerifiedDaemon | null> = [null];
    const fixture = setup(statuses, async () => ({ kind }));
    const launch = kind === 'ours' ? fixture.startManaged : fixture.startBundled;
    launch.mockImplementation(async (requestedPort = 0) => {
      statuses.push({ ...running, listen: `127.0.0.1:${requestedPort || 42345}` });
    });

    const ready = { ...running, listen: '127.0.0.1:42346' };
    await expect(fixture.manager.ensureReady(42346)).resolves.toEqual(ready);
    expect(launch).toHaveBeenCalledExactlyOnceWith(42346);
    expect(fixture.checkProtocol).toHaveBeenCalledWith(ready);
    expect(kind === 'ours' ? fixture.startBundled : fixture.startManaged).not.toHaveBeenCalled();
  });

  it('preserves the managed fixed-port refusal without fallback or readiness polling', async () => {
    const fixture = setup([null], async () => ({ kind: 'ours' }));
    fixture.startManaged.mockImplementation(async (requestedPort = 0) => {
      if (requestedPort !== 0 && requestedPort !== 42345) {
        throw new Error('Registered daemon uses port 42345, not requested port 42346.');
      }
    });
    await expect(fixture.manager.ensureReady(42346)).rejects.toThrow('not requested port 42346');
    expect(fixture.startManaged).toHaveBeenCalledExactlyOnceWith(42346);
    expect(fixture.startBundled).not.toHaveBeenCalled();
    expect(fixture.readVerifiedDaemon).toHaveBeenCalledOnce();
    expect(fixture.checkProtocol).not.toHaveBeenCalled();
    expect(fixture.pause).not.toHaveBeenCalled();
  });

  it.each(['absent', 'ours'] as const)('rejects an owner on the wrong port after %s launch', async (kind) => {
    const fixture = setup([null, running], async () => ({ kind }));
    await expect(fixture.manager.ensureReady(42346)).rejects.toThrow('不是要求的端口 42346');
    expect(kind === 'ours' ? fixture.startManaged : fixture.startBundled).toHaveBeenCalledExactlyOnceWith(42346);
    expect(kind === 'ours' ? fixture.startBundled : fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.checkProtocol).not.toHaveBeenCalled();
  });

  it('propagates bundled startup failure without a managed fallback', async () => {
    const fixture = setup([null]);
    fixture.startBundled.mockRejectedValue(new Error('bundled start failed'));
    await expect(fixture.manager.ensureReady(42346)).rejects.toThrow('bundled start failed');
    expect(fixture.startBundled).toHaveBeenCalledExactlyOnceWith(42346);
    expect(fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.readVerifiedDaemon).toHaveBeenCalledOnce();
    expect(fixture.checkProtocol).not.toHaveBeenCalled();
  });

  it('refuses a protocol mismatch without stopping or replacing the running daemon', async () => {
    const fixture = setup([running]);
    fixture.checkProtocol.mockResolvedValue(PROTOCOL_VERSION + 1);
    await expect(fixture.manager.ensureReady()).rejects.toThrow('正在运行的服务端比这个桌面端新。');
    expect(fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.startBundled).not.toHaveBeenCalled();
  });

  // main 必败: the message did not say which side is older (devices 4.5, devices-ui-2 4.8)
  it('says which side is older and what to run', async () => {
    const npm = { kind: 'ours', definition: { kind: 'npm', executable: '/x/node', entry: '/x/cli.js', port: 0 } } as const;
    expect(protocolMismatchMessage({ server: 1, client: 2, registration: npm })).toContain('npm i -g vonvon-bot@latest');
    expect(protocolMismatchMessage({ server: 1, client: 2, registration: { kind: 'absent' } })).toContain('退出 Vonvon Bot 再打开');
    expect(protocolMismatchMessage({ server: 3, client: 2, registration: npm })).toContain('https://vonvon.bot/get/');
    const fixture = setup([running], async () => npm);
    fixture.checkProtocol.mockResolvedValue(PROTOCOL_VERSION - 1);
    await expect(fixture.manager.ensureReady()).rejects.toThrow('npm i -g vonvon-bot@latest');
  });

  it.each([
    [{ kind: 'other-root', root: '/other/home' } as const, '/other/home'],
    [{ kind: 'unrecognized', file: '/path/to/service' } as const, '/path/to/service'],
  ])('refuses a conflicting registration %j', async (registration, detail) => {
    const fixture = setup([null], async () => registration);
    await expect(fixture.manager.ensureReady()).rejects.toThrow(detail);
    expect(fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.startBundled).not.toHaveBeenCalled();
  });

  it('does not fall back to bundled launch after managed startup fails', async () => {
    const fixture = setup([null], async () => ({ kind: 'ours' }));
    fixture.startManaged.mockRejectedValue(new Error('manager failed'));
    await expect(fixture.manager.ensureReady()).rejects.toThrow('manager failed');
    expect(fixture.startBundled).not.toHaveBeenCalled();
  });

  it('leaves an incompatible newly started owner untouched', async () => {
    const fixture = setup([null, running]);
    fixture.checkProtocol.mockResolvedValue(PROTOCOL_VERSION + 1);
    await expect(fixture.manager.ensureReady()).rejects.toThrow('https://vonvon.bot/get/');
    expect(fixture.startBundled).toHaveBeenCalledOnce();
    expect(fixture.startManaged).not.toHaveBeenCalled();
  });

  it('rejects a requested port mismatch without stopping the accepted owner', async () => {
    const fixture = setup([running]);
    await expect(fixture.manager.ensureReady(42346)).rejects.toThrow('不是要求的端口 42346');
    expect(fixture.checkProtocol).not.toHaveBeenCalled();
    expect(fixture.startManaged).not.toHaveBeenCalled();
  });

  it('reports missing readiness after a bounded wait', async () => {
    const fixture = setup([null, null, null, null]);
    await expect(fixture.manager.ensureReady()).rejects.toThrow('后台服务启动超时');
    expect(fixture.startBundled).toHaveBeenCalledOnce();
    expect(fixture.pause).toHaveBeenCalledTimes(2);
  });
});
