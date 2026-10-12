import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLaunchdService } from '../../src/service/launchd';
import { LAUNCHD_LABEL } from '../../src/service/identity';

type Owner = { pid: number; startedAt: string; listen: string };
type State = {
  loaded: boolean;
  pid: number | null;
  owner: Owner | null;
  scenario: string;
  calls: string[];
  stops: number[];
  work: string[];
  clock: number;
  jobPrints: number;
  bootouts: number;
  bootstraps: number;
  newBytesBase64: string | null;
  ownerReads: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing macOS fixture ${name}`);
  return value;
}
const statePath = required('VONVON_OUTCOMES_STATE');
const root = required('VONVON_HOME');
const home = required('HOME');
const plistPath = join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const job = `gui/501/${LAUNCHD_LABEL}`;
const owner: Owner = { pid: 41001, startedAt: '2026-10-12T00:00:00Z', listen: '127.0.0.1:32123' };
const read = (): State => JSON.parse(readFileSync(statePath, 'utf8'));
const update = (change: (state: State) => void): State => {
  const state = read();
  change(state);
  writeFileSync(statePath, JSON.stringify(state));
  return state;
};
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const failed = (stderr: string) => ({ ok: false, stdout: '', stderr });

export function getServiceAdapter() {
  const service = createLaunchdService({ root }, {
    home, uid: 501, executable: '/fixture/bin/node', capturedPath: '/fixture/bin',
    distribution: async () => ({ kind: 'global-npm', cliPath: '/fixture/bin/vonvon.mjs' }),
    freePort: async () => 32123,
    now: () => read().clock,
    pause: async ms => {
      update(s => { s.clock += ms === 50 && s.bootstraps > 0 ? 25_000 : ms; });
      if (read().clock > 30_000) throw new Error('Exceeded fixture virtual clock');
    },
    readOwner: async () => {
      const state = update(s => {
        s.ownerReads += 1;
        if (s.scenario === 'step3_stop_unconfirmed' || s.scenario === 'replacement_stop_unconfirmed'
          || s.scenario === 'rollback_stop_unconfirmed') {
          if (!existsSync(plistPath) && s.loaded && s.owner === null) {
            s.owner = owner; s.pid = owner.pid; s.work = ['new-job-work'];
          }
        }
      });
      if (state.scenario === 'resumed_owner_unproven' && state.owner && state.ownerReads % 2 === 0) {
        return { ...state.owner, startedAt: 'different-owner-birth' };
      }
      return state.owner;
    },
    verifyOwner: async () => {},
    stopOwner: async (_home, current) => {
      const state = update(s => { s.stops.push(current.pid); });
      if (state.scenario.includes('stop_unconfirmed')) throw new Error('fixture stop reply lost');
      update(s => { s.owner = null; s.pid = null; s.work = []; });
    },
    run: async args => {
      const command = args.join(' ');
      const state = update(s => { s.calls.push(command); });
      if (command === 'print gui/501') return ok('gui/501 = {}');
      if (command === `print ${job}`) {
        const observed = update(s => { s.jobPrints += 1; });
        if (observed.scenario === 'unload_unknown_query' && observed.bootouts > 0) {
          return failed('fixture launchctl query failed');
        }
        if ((observed.scenario === 'drain_failed' || observed.scenario === 'replacement_drain_failed'
          || observed.scenario === 'resumed_drain_failed') && observed.jobPrints >= 2) return failed('fixture launchctl query failed');
        if (observed.scenario === 'rollback_drain_failed' && observed.bootstraps > 0 && !existsSync(plistPath)) {
          return failed('fixture launchctl query failed');
        }
        if (!observed.loaded) return failed('Could not find service');
        return ok(`${job} = {\n\tstate = ${observed.pid === null ? 'waiting' : 'running'}\n${observed.pid === null ? '' : `\tpid = ${observed.pid}\n`}}`);
      }
      if (command === `bootout ${job}`) {
        const observed = update(s => { s.bootouts += 1; });
        if (observed.scenario === 'unload_unknown_false' || observed.scenario === 'unload_unknown_query') {
          update(s => { s.loaded = false; s.pid = null; });
          return failed('fixture bootout failed after removing job');
        }
        if (observed.scenario === 'unload_unknown' || observed.scenario === 'replacement_unknown'
          || observed.scenario === 'rollback_unknown') return failed('fixture bootout failed');
        update(s => {
          s.loaded = false; s.pid = null;
          if (s.scenario === 'step5_stop_unconfirmed') { s.owner = owner; s.work = ['new-job-work']; }
        });
        return ok();
      }
      if (command === `bootstrap gui/501 ${plistPath}`) {
        update(s => {
          s.bootstraps += 1;
          s.loaded = true;
          s.newBytesBase64 = readFileSync(plistPath).toString('base64');
        });
        return state.scenario === 'bootstrap_failed_found' ? failed('fixture bootstrap failed') : ok();
      }
      throw new Error(`Unexpected launchctl command: ${command}`);
    },
  });
  return { install: service.install, uninstall: service.uninstall, status: service.status };
}
