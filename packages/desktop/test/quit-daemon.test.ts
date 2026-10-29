import { describe, expect, it, vi } from 'vitest';
import type { VerifiedDaemon } from '../src/daemon-manager.js';
import { stopDaemonForQuit } from '../src/quit-daemon.js';

const initial: VerifiedDaemon = { pid: 42, startedAt: 'initial', listen: '127.0.0.1:42345' };

function fixture() {
  let time = 0;
  return {
    readVerifiedDaemon: vi.fn(async (): Promise<VerifiedDaemon | null> => null),
    requestStop: vi.fn(async (_owner: VerifiedDaemon) => {}),
    ownerRunning: vi.fn(async (_owner: VerifiedDaemon) => false),
    pause: vi.fn(async (ms: number) => { time += ms; }),
    now: () => time,
    timeoutMs: 1000,
  };
}

describe('explicit desktop quit drains the current daemon', () => {
  it('finishes without starting or stopping anything when no daemon is running', async () => {
    const deps = fixture();
    await stopDaemonForQuit(deps);
    expect(deps.requestStop).not.toHaveBeenCalled();
    expect(deps.ownerRunning).not.toHaveBeenCalled();
  });

  it('waits for the authenticated owner to die before declaring exit complete', async () => {
    const deps = fixture();
    deps.readVerifiedDaemon.mockResolvedValueOnce(initial);
    deps.ownerRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    await stopDaemonForQuit(deps);
    expect(deps.requestStop).toHaveBeenCalledExactlyOnceWith(initial);
    expect(deps.ownerRunning.mock.calls).toEqual([[initial], [initial], [initial]]);
    expect(deps.pause).toHaveBeenCalledTimes(2);
    expect(deps.readVerifiedDaemon).toHaveBeenCalledTimes(2);
  });

  it('stops a freshly authenticated replacement instead of leaving its Bots running', async () => {
    const successor = { ...initial, pid: 43, startedAt: 'successor' };
    const deps = fixture();
    deps.readVerifiedDaemon.mockResolvedValueOnce(initial).mockResolvedValueOnce(successor);
    await stopDaemonForQuit(deps);
    expect(deps.requestStop.mock.calls).toEqual([[initial], [successor]]);
    expect(deps.ownerRunning.mock.calls).toEqual([[initial], [successor]]);
    expect(deps.readVerifiedDaemon).toHaveBeenCalledTimes(3);
  });

  it('waits for a pending service handoff before reading and stopping the successor', async () => {
    const successor = { ...initial, pid: 44, startedAt: 'service-handoff' };
    const deps = fixture();
    let pending = true;
    let released!: () => void;
    deps.pause.mockImplementationOnce(() => new Promise<void>(resolve => { released = resolve; }));
    deps.readVerifiedDaemon.mockResolvedValueOnce(successor);
    const stopping = stopDaemonForQuit({ ...deps, handoffPending: () => pending });
    expect(deps.pause).toHaveBeenCalledOnce();
    expect(deps.readVerifiedDaemon).not.toHaveBeenCalled();
    expect(deps.requestStop).not.toHaveBeenCalled();
    pending = false;
    released();
    await stopping;
    expect(deps.requestStop).toHaveBeenCalledExactlyOnceWith(successor);
    expect(deps.ownerRunning).toHaveBeenCalledExactlyOnceWith(successor);
    expect(deps.readVerifiedDaemon).toHaveBeenCalledTimes(2);
  });

  it('does not finish in an ownerless gap when a service handoff appears during verification', async () => {
    const successor = { ...initial, pid: 45, startedAt: 'late-handoff' };
    const deps = fixture();
    let pending = false;
    let finishRead!: () => void;
    let released!: () => void;
    let completed = false;
    deps.readVerifiedDaemon.mockImplementationOnce(() => new Promise<VerifiedDaemon | null>(resolve => {
      finishRead = () => { pending = true; resolve(null); };
    })).mockResolvedValueOnce(successor);
    deps.pause.mockImplementationOnce(() => new Promise<void>(resolve => { released = resolve; }));
    const stopping = stopDaemonForQuit({ ...deps, handoffPending: () => pending });
    void stopping.then(() => { completed = true; });
    finishRead();
    await vi.waitFor(() => expect(deps.pause).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(deps.requestStop).not.toHaveBeenCalled();
    pending = false;
    released();
    await stopping;
    expect(deps.requestStop).toHaveBeenCalledExactlyOnceWith(successor);
    expect(deps.readVerifiedDaemon).toHaveBeenCalledTimes(3);
  });

  it('times out without sending stop requests when a service handoff never settles', async () => {
    const deps = fixture();
    await expect(stopDaemonForQuit({ ...deps, handoffPending: () => true })).rejects.toThrow();
    expect(deps.now()).toBeGreaterThanOrEqual(deps.timeoutMs);
    expect(deps.readVerifiedDaemon).not.toHaveBeenCalled();
    expect(deps.requestStop).not.toHaveBeenCalled();
    expect(deps.ownerRunning).not.toHaveBeenCalled();
  });

  it('does not treat a refused or unauthenticated stop as a successful exit', async () => {
    const deps = fixture();
    deps.readVerifiedDaemon.mockResolvedValue(initial);
    const refusal = new Error('Cannot verify daemon owner');
    deps.requestStop.mockRejectedValueOnce(refusal);
    await expect(stopDaemonForQuit(deps)).rejects.toBe(refusal);
  });

  it('reports a daemon that never exits instead of silently leaving it in the background', async () => {
    const deps = fixture();
    deps.readVerifiedDaemon.mockResolvedValue(initial);
    deps.ownerRunning.mockResolvedValue(true);
    await expect(stopDaemonForQuit(deps)).rejects.toThrow();
    expect(deps.requestStop).toHaveBeenCalledOnce();
    expect(deps.pause).toHaveBeenCalled();
    expect(deps.now()).toBeGreaterThanOrEqual(deps.timeoutMs);
  });

  it('propagates owner verification failure without sending a stop request', async () => {
    const deps = fixture();
    const error = new Error('The local daemon credential is unavailable');
    deps.readVerifiedDaemon.mockRejectedValueOnce(error);
    await expect(stopDaemonForQuit(deps)).rejects.toBe(error);
    expect(deps.requestStop).not.toHaveBeenCalled();
  });

  it('keeps process-death uncertainty visible', async () => {
    const deps = fixture();
    deps.readVerifiedDaemon.mockResolvedValueOnce(initial);
    const error = new Error('Process identity unavailable');
    deps.ownerRunning.mockRejectedValueOnce(error);
    await expect(stopDaemonForQuit(deps)).rejects.toBe(error);
  });
});
