import { readRunningPidLock, type PidLockInfo } from '../server/pid-lock';
import { stopVerifiedOwner } from '../server/owner-verification';

export type OwnerIdentity = Readonly<Pick<PidLockInfo, 'pid' | 'startedAt'>>;

export type DrainScope =
  | { readonly kind: 'all-owners' }
  | {
      readonly kind: 'job-only';
      readonly context: 'install-rollback' | 'uninstall-resumed';
    };

export type DrainFailure =
  | { readonly kind: 'drain-failed'; readonly reason: 'query_failed'; readonly detail: string }
  | {
      readonly kind: 'drain-failed';
      readonly reason: 'owner_unproven' | 'foreign_job_pid' | 'stop_unconfirmed';
      readonly pid: number;
      readonly detail: string;
    };

export type DrainResult =
  | { readonly kind: 'drained'; readonly retained: OwnerIdentity | null }
  | DrainFailure;

type DrainRequest = {
  readonly home: string;
  readonly scope: DrainScope;
  readonly queryJobPid: () => Promise<number | null>;
};

type DrainService = (request: DrainRequest) => Promise<DrainResult>;

type DrainDependencies = {
  readonly readRunningPidLock: typeof readRunningPidLock;
  readonly stopVerifiedOwner: typeof stopVerifiedOwner;
  readonly pause: (milliseconds: number) => Promise<void>;
};

type PublishedLock = PidLockInfo & { readonly listen: string };

type ProofAttempt =
  | { readonly kind: 'proven'; readonly owner: OwnerIdentity }
  | { readonly kind: 'unproven'; readonly owner: OwnerIdentity }
  | { readonly kind: 'stop-unconfirmed'; readonly pid: number; readonly detail: string };

const roundIntervalMs = 250;

export function createServiceDrain(overrides: Partial<DrainDependencies> = {}): DrainService {
  const dependencies: DrainDependencies = {
    readRunningPidLock: overrides.readRunningPidLock ?? readRunningPidLock,
    stopVerifiedOwner: overrides.stopVerifiedOwner ?? stopVerifiedOwner,
    pause: overrides.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
  };

  return async ({ home, scope, queryJobPid }) => {
    let previousUnproven: OwnerIdentity | null = null;
    try {
      for (;;) {
        const lock = await dependencies.readRunningPidLock(home);
        const jobPid = await queryJobPid();

        if (scope.kind === 'job-only' && jobPid === null) {
          return { kind: 'drained', retained: lock === null ? null : identity(lock) };
        }
        if (scope.kind === 'all-owners' && lock === null && jobPid === null) {
          return { kind: 'drained', retained: null };
        }

        if (scope.kind === 'job-only' && jobPid !== null && (lock === null || lock.pid !== jobPid)) {
          previousUnproven = null;
          if (scope.context === 'uninstall-resumed') {
            return {
              kind: 'drain-failed', reason: 'foreign_job_pid', pid: jobPid,
              detail: `Job PID ${jobPid} does not own this data root's live lock. Run vonvon daemon stop under that PID's VONVON_HOME.`,
            };
          }
        } else if (lock !== null && isPublishedLock(lock)) {
          const attempt = scope.kind === 'job-only'
            ? await finishManagerOwnerAttempt(home, lock, dependencies)
            : await stopOwner(home, lock, dependencies);

          switch (attempt.kind) {
            case 'stop-unconfirmed':
              return { kind: 'drain-failed', reason: 'stop_unconfirmed', pid: attempt.pid, detail: attempt.detail };
            case 'unproven':
              if (previousUnproven !== null && sameOwner(previousUnproven, attempt.owner)) {
                return {
                  kind: 'drain-failed', reason: 'owner_unproven', pid: attempt.owner.pid,
                  detail: `Cannot prove job ownership for PID ${attempt.owner.pid} after two consecutive attempts.`,
                };
              }
              previousUnproven = attempt.owner;
              break;
            case 'proven':
              previousUnproven = null;
              await waitForConfirmedOwner(home, attempt.owner, dependencies);
              break;
            default: {
              const exhaustive: never = attempt;
              return exhaustive;
            }
          }
        } else {
          previousUnproven = null;
        }

        await dependencies.pause(roundIntervalMs);
      }
    } catch (error) {
      return { kind: 'drain-failed', reason: 'query_failed', detail: errorDetail(error) };
    }
  };
}

async function finishManagerOwnerAttempt(
  home: string,
  lock: PublishedLock,
  dependencies: DrainDependencies,
): Promise<ProofAttempt> {
  const current = await dependencies.readRunningPidLock(home);
  if (current === null || !sameOwner(current, lock) || current.listen !== lock.listen) {
    return { kind: 'unproven', owner: identity(lock) };
  }
  return stopOwner(home, lock, dependencies);
}

async function stopOwner(
  home: string,
  lock: PublishedLock,
  dependencies: DrainDependencies,
): Promise<Exclude<ProofAttempt, { kind: 'unproven' }>> {
  try {
    await dependencies.stopVerifiedOwner(home, lock);
    return { kind: 'proven', owner: identity(lock) };
  } catch (error) {
    return {
      kind: 'stop-unconfirmed', pid: lock.pid,
      detail: `Stop for PID ${lock.pid} was not confirmed. It may be draining, or the stop may not have reached it. Run vonvon service uninstall again. ${errorDetail(error)}`,
    };
  }
}

async function waitForConfirmedOwner(
  home: string,
  owner: OwnerIdentity,
  dependencies: DrainDependencies,
): Promise<void> {
  for (;;) {
    const current = await dependencies.readRunningPidLock(home);
    if (current === null || !sameOwner(current, owner)) return;
    await dependencies.pause(roundIntervalMs);
  }
}

function identity(lock: PidLockInfo): OwnerIdentity {
  return { pid: lock.pid, startedAt: lock.startedAt };
}

function sameOwner(left: OwnerIdentity, right: OwnerIdentity): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

function isPublishedLock(lock: PidLockInfo): lock is PublishedLock {
  return lock.listen !== null;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
