import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSystemdService } from '../../src/service/systemd';
import { SYSTEMD_UNIT_NAME } from '../../src/service/identity';

type Owner = { pid: number; startedAt: string; listen: string };
type State = {
  loaded: boolean;
  enabled: boolean;
  pid: number;
  owner: Owner | null;
  failure: 'none' | 'query_failed' | 'stop_unconfirmed' | 'unload_failed' | 'owner_unproven'
    | 'install_load_failed' | 'rollback_query_failed' | 'rollback_stop_unconfirmed' | 'rollback_unload_failed'
    | 'step5_stop_unconfirmed';
  calls: string[];
  stops: number[];
  ownerReads: number;
  work: string[];
  newBytesBase64: string | null;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Outcome fixture environment missing: ${name}`);
  return value;
}
const statePath = required('VONVON_OUTCOMES_STATE');
const root = required('VONVON_HOME');
const config = required('XDG_CONFIG_HOME');
const unitPath = join(config, 'systemd', 'user', SYSTEMD_UNIT_NAME);
const read = (): State => JSON.parse(readFileSync(statePath, 'utf8'));
const update = (change: (state: State) => void): State => {
  const state = read();
  change(state);
  writeFileSync(statePath, JSON.stringify(state));
  return state;
};
const ok = (stdout = '') => ({ ok: true, status: 0, stdout, stderr: '' });
const failure = (stderr: string) => ({ ok: false, status: 1, stdout: '', stderr });

export function getServiceAdapter() {
  const service = createSystemdService({ root }, {
    home: root,
    xdgConfigHome: config,
    executable: '/fixture/bin/node',
    capturedPath: '/fixture/bin',
    distribution: async () => ({ kind: 'global-npm', cliPath: '/fixture/bin/vonvon.mjs' }),
    freePort: async () => 32123,
    now: () => 0,
    pause: async () => { if (read().failure !== 'owner_unproven') throw new Error('Unexpected drain wait'); },
    readOwner: async () => {
      const state = update(s => { s.ownerReads += 1; });
      if (state.failure === 'owner_unproven' && state.owner && state.ownerReads % 2 === 0) {
        return { ...state.owner, startedAt: 'different-owner-birth' };
      }
      return state.owner;
    },
    verifyOwner: async () => {},
    stopOwner: async (_home, owner) => {
      const state = update(s => { s.stops.push(owner.pid); });
      if (state.failure === 'stop_unconfirmed' || state.failure === 'rollback_stop_unconfirmed'
        || state.failure === 'step5_stop_unconfirmed') throw new Error('fixture stop reply lost');
      update(s => { s.owner = null; s.pid = 0; });
    },
    run: async args => {
      const command = args.join(' ');
      const state = update(s => { s.calls.push(command); });
      if (command === 'is-system-running') return ok('running');
      if (command === `is-enabled ${SYSTEMD_UNIT_NAME}`) return state.enabled ? ok('enabled') : { ...failure(''), stdout: 'disabled' };
      if (command === `show -p MainPID --value ${SYSTEMD_UNIT_NAME}`) {
        return state.failure === 'query_failed' || state.failure === 'rollback_query_failed' ? failure('fixture MainPID query failed') : ok(String(state.pid));
      }
      if (command === `show -p LoadState -p FragmentPath -p MainPID ${SYSTEMD_UNIT_NAME}`) {
        return ok(`LoadState=${state.loaded ? 'loaded' : 'not-found'}\nFragmentPath=${state.loaded ? unitPath : ''}\nMainPID=${state.pid}\n`);
      }
      if (command === `disable ${SYSTEMD_UNIT_NAME}`) {
        update(s => { s.enabled = false; });
        return ok();
      }
      if (command === 'daemon-reload') {
        update(s => {
          if (s.failure === 'rollback_query_failed' && s.newBytesBase64 === null && existsSync(unitPath)) {
            s.newBytesBase64 = readFileSync(unitPath).toString('base64');
          }
          s.loaded = existsSync(unitPath) || s.pid !== 0;
        });
        return ok();
      }
      if (command === `reset-failed ${SYSTEMD_UNIT_NAME}`) {
        if (state.failure === 'step5_stop_unconfirmed') {
          update(s => { s.owner = { pid: 41001, startedAt: '2026-10-12T00:00:00Z', listen: '127.0.0.1:32123' }; s.work = ['new-job-work']; });
        }
        return state.failure === 'unload_failed' || state.failure === 'rollback_unload_failed'
          ? { ...failure('fixture reset-failed failed'), status: 2 } : ok();
      }
      if (command === `enable --now ${SYSTEMD_UNIT_NAME}`) {
        if (state.failure === 'rollback_stop_unconfirmed') {
          update(s => { s.owner = { pid: 41001, startedAt: '2026-10-12T00:00:00Z', listen: '127.0.0.1:32123' }; s.pid = 41001; s.work = ['new-job-work']; });
        }
        if (state.failure === 'install_load_failed' || state.failure === 'rollback_query_failed'
          || state.failure === 'rollback_stop_unconfirmed' || state.failure === 'rollback_unload_failed') {
          return failure('fixture enable --now failed');
        }
        throw new Error('Unexpected successful install in fixture');
      }
      if (command === `enable ${SYSTEMD_UNIT_NAME}`) {
        update(s => { s.enabled = true; });
        return ok();
      }
      throw new Error(`Unexpected manager command: ${command}`);
    },
  });
  return { install: service.install, uninstall: service.uninstall, status: service.status };
}
