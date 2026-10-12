import { readFileSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { decodeGeneratedDefinition } from '../../src/service/definitions';
import { WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE, type CanonicalRoot } from '../../src/service/identity';
import { createWindowsService } from '../../src/service/windows';

type Owner = { pid: number; startedAt: string; listen: string };
type State = {
  root: string;
  runValue: string | null;
  files: Record<string, string>;
  owner: Owner | null;
  work: string[];
  scenario: string;
  calls: string[];
  stops: number[];
  newCmdBase64: string | null;
  newVbsBase64: string | null;
  newRunValue: string | null;
};

const statePath = process.env.VONVON_OUTCOMES_STATE;
if (!statePath) throw new Error('Windows fixture state missing');
const read = (): State => JSON.parse(readFileSync(statePath, 'utf8'));
const update = (change: (state: State) => void): State => {
  const state = read();
  change(state);
  writeFileSync(statePath, JSON.stringify(state));
  return state;
};
const owner: Owner = { pid: 41001, startedAt: '2026-10-12T00:00:00Z', listen: '127.0.0.1:32123' };
function bytes(state: State, path: string): Buffer | null {
  const encoded = state.files[path];
  return encoded === undefined ? null : Buffer.from(encoded, 'base64');
}
function notFound(): Error {
  return Object.assign(new Error('fixture file missing'), { code: 'ENOENT' });
}

export function getServiceAdapter() {
  const initial = read();
  if (!win32.isAbsolute(initial.root)) throw new Error('Windows fixture root must be absolute');
  const root = initial.root as CanonicalRoot;
  const cmdPath = win32.join(root, 'service', 'vonvon-bot.cmd');
  const vbsPath = win32.join(root, 'service', 'vonvon-bot.vbs');
  const service = createWindowsService({ root }, {
    resolveRoot: async () => root,
    executable: 'C:\\fixture\\node.exe', capturedPath: 'C:\\fixture',
    distribution: async () => ({ kind: 'global-npm', cliPath: 'C:\\fixture\\vonvon.mjs' }),
    freePort: async () => 32123,
    now: () => 0,
    pause: async () => { throw new Error('Unexpected Windows drain wait'); },
    readRun: () => {
      const value = read().runValue;
      return value === null ? { kind: 'absent' } : { kind: 'value', type: 'REG_SZ', value };
    },
    registration: async () => {
      const state = read();
      if (state.runValue === null) return { kind: 'absent' };
      const cmd = bytes(state, cmdPath);
      const vbs = bytes(state, vbsPath);
      if (!cmd || !vbs) return { kind: 'unrecognized', location: cmd ? vbsPath : cmdPath, reason: 'Incomplete launcher pair' };
      try {
        const definition = decodeGeneratedDefinition({ platform: 'win32', cmdPath, vbsPath },
          { platform: 'win32', cmd, vbs, runValue: state.runValue });
        return { kind: 'ours', definition: { ...definition, root } };
      } catch (error) {
        return { kind: 'unrecognized', location: cmdPath, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    lstat: (async (path: Parameters<typeof import('node:fs/promises').lstat>[0]) => {
      const value = bytes(read(), String(path));
      if (!value) throw notFound();
      return { isFile: () => true, size: value.length, ino: 1, dev: 1, mtimeMs: 1 } as Awaited<ReturnType<typeof import('node:fs/promises').lstat>>;
    }) as typeof import('node:fs/promises').lstat,
    readFile: (async (path: Parameters<typeof import('node:fs/promises').readFile>[0]) => {
      const value = bytes(read(), String(path));
      if (!value) throw notFound();
      return value;
    }) as typeof import('node:fs/promises').readFile,
    mkdir: async () => undefined,
    open: async (path, flag) => {
      if (flag !== 'wx') throw new Error(`Unexpected Windows fixture open: ${flag}`);
      return {
        writeFile: async (content: Uint8Array) => { update(s => { s.files[String(path)] = Buffer.from(content).toString('base64'); }); },
        sync: async () => {}, close: async () => {},
      } as Awaited<ReturnType<typeof import('node:fs/promises').open>>;
    },
    rename: async (from, to) => {
      update(s => {
        const encoded = s.files[String(from)];
        if (encoded === undefined) throw notFound();
        s.files[String(to)] = encoded;
        delete s.files[String(from)];
        s.calls.push(`rename:${String(to) === cmdPath ? 'cmd' : String(to) === vbsPath ? 'vbs' : 'unknown'}`);
      });
    },
    unlink: async path => {
      const name = String(path) === cmdPath ? 'cmd' : String(path) === vbsPath ? 'vbs' : 'unknown';
      if (name === 'unknown') throw new Error('Unexpected Windows fixture unlink');
      const state = update(s => { s.calls.push(`unlink:${name}`); });
      if (state.scenario === 'rollback_unlink_persistent' && name === 'cmd') {
        throw Object.assign(new Error('EACCES: fixture cmd unlink denied'), { code: 'EACCES' });
      }
      if ((state.scenario === 'unload_failed' || state.scenario === 'rollback_unload_failed')
        && state.calls.filter(call => call === 'unlink:cmd').length === 1) throw new Error('fixture launcher unlink failed');
      update(s => {
        if (s.files[String(path)] === undefined) throw notFound();
        delete s.files[String(path)];
      });
    },
    run: args => {
      const action = args[0];
      const state = update(s => { s.calls.push(`reg:${action}`); });
      if (action === 'query' && args[1] === WINDOWS_RUN_KEY) return { status: 0, stdout: '', stderr: '' };
      if (action === 'delete' && args[1] === WINDOWS_RUN_KEY && args[3] === WINDOWS_RUN_VALUE) {
        update(s => { s.runValue = null; });
        return { status: 0, stdout: '', stderr: '' };
      }
      if (action === 'add' && args[1] === WINDOWS_RUN_KEY && args[3] === WINDOWS_RUN_VALUE) {
        const value = args[args.indexOf('/d') + 1];
        if (!value) throw new Error('Run add lacks /d value');
        update(s => { s.runValue = value; });
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected reg.exe command: ${args.join(' ')}, scenario ${state.scenario}`);
    },
    launch: async path => {
      if (path !== vbsPath) throw new Error('Unexpected Windows launcher path');
      const state = update(s => {
        s.calls.push('launch');
        s.newCmdBase64 = s.files[cmdPath] ?? null;
        s.newVbsBase64 = s.files[vbsPath] ?? null;
        s.newRunValue = s.runValue;
      });
      if (state.scenario === 'rollback_unlink_persistent') {
        update(s => { s.owner = owner; s.work = ['new-job-work']; });
      }
      if (state.scenario.startsWith('rollback_') || state.scenario === 'install_launch_failed') {
        throw new Error('fixture launcher failed');
      }
      update(s => { s.owner = owner; s.work = ['new-job-work']; });
    },
    readOwner: async () => {
      const state = update(s => {
        if (s.scenario === 'step5_stop_unconfirmed' && s.runValue === null
          && s.files[cmdPath] === undefined && s.files[vbsPath] === undefined && s.owner === null) {
          s.owner = owner; s.work = ['new-job-work'];
        }
      });
      if ((state.scenario === 'drain_failed' || state.scenario === 'resumed_read_failed'
        || state.scenario === 'rollback_drain_failed') && state.runValue === null) {
        throw new Error('fixture lock read failed');
      }
      return state.owner;
    },
    verifyOwner: async () => {},
    stopOwner: async (_home, current) => {
      const state = update(s => { s.stops.push(current.pid); });
      if (state.scenario.includes('stop_unconfirmed')) throw new Error('fixture stop reply lost');
      update(s => { s.owner = null; s.work = []; });
    },
  });
  return { install: service.install, uninstall: service.uninstall };
}
