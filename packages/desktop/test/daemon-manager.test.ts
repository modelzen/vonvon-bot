import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import { createDaemonManager, type DaemonManagerDependencies, type VerifiedDaemon } from '../src/daemon-manager.js';

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
  const checkProtocol = vi.fn(async () => PROTOCOL_VERSION);
  const pause = vi.fn(async () => {});
  const dependencies: DaemonManagerDependencies = { readVerifiedDaemon, readRegistration, startManaged, startBundled, checkProtocol, pause };
  return { manager: createDaemonManager(dependencies, { maxAttempts: 3 }), readVerifiedDaemon, readRegistration, startManaged, startBundled, checkProtocol, pause };
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
    await expect(fixture.manager.ensureReady(42346)).rejects.toThrow('not requested port 42346');
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
    await expect(fixture.manager.ensureReady()).rejects.toThrow(`protocol version ${PROTOCOL_VERSION + 1}; desktop expects ${PROTOCOL_VERSION}`);
    expect(fixture.startManaged).not.toHaveBeenCalled();
    expect(fixture.startBundled).not.toHaveBeenCalled();
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
    await expect(fixture.manager.ensureReady()).rejects.toThrow(`protocol version ${PROTOCOL_VERSION + 1}`);
    expect(fixture.startBundled).toHaveBeenCalledOnce();
    expect(fixture.startManaged).not.toHaveBeenCalled();
  });

  it('rejects a requested port mismatch without stopping the accepted owner', async () => {
    const fixture = setup([running]);
    await expect(fixture.manager.ensureReady(42346)).rejects.toThrow('not requested port 42346');
    expect(fixture.checkProtocol).not.toHaveBeenCalled();
    expect(fixture.startManaged).not.toHaveBeenCalled();
  });

  it('reports missing readiness after a bounded wait', async () => {
    const fixture = setup([null, null, null, null]);
    await expect(fixture.manager.ensureReady()).rejects.toThrow('did not become ready');
    expect(fixture.startBundled).toHaveBeenCalledOnce();
    expect(fixture.pause).toHaveBeenCalledTimes(2);
  });
});
