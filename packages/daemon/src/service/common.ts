import { createReadStream, statSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceState } from '@vonvon/protocol';
import { paths } from '../config/paths';

/**
 * Where the background service stands:
 * - `not-installed`: no definition and no manager job;
 * - `running`: the manager's job runs the verified daemon for this data root;
 * - `stopped`: installed, nothing running (after `vonvon daemon stop`);
 * - `disabled`: the definition is there but the manager has no enabled job, on macOS
 *   usually because the user turned it off under App Background Activity (e06);
 * - `detached`: installed, but the daemon running is not the manager's process;
 * - `conflict`: an unrecognized definition (an older format, which install rewrites),
 *   one for another data root, an interrupted uninstall, or a daemon that does not
 *   authenticate;
 * - `unknown`: the manager could not be asked.
 */
export type { ServiceState };

/** The background service as launchd (macOS) or systemd (Linux) reports it. */
export interface ServiceStatus {
  /** `"launchd (macOS)"` or `"systemd (Linux)"`. */
  platformName: string;
  state: ServiceState;
  /** The definition file exists. */
  installed: boolean;
  /** A verified daemon for this data root is running, whoever started it. */
  running: boolean;
  /** Label or unit name. */
  name: string;
  /** Path of the plist or unit. */
  servicePath: string;
  stdoutPath: string;
  stderrPath: string;
  pid?: string;
  /** One line on the state and the next step. */
  detail: string;
}

/** Service log files live under the app dir, identical across platforms. */
export function serviceStdoutPath(): string {
  return join(paths.appDir, 'service.log');
}

export function serviceStderrPath(): string {
  return join(paths.appDir, 'service.err.log');
}

/** Touch both log files so the service (and `logs` tail) always have a target. */
export async function ensureLogFiles(): Promise<void> {
  await mkdir(paths.appDir, { recursive: true });
  await appendFile(serviceStdoutPath(), '');
  await appendFile(serviceStderrPath(), '');
}

/**
 * Absolute path to the installed bin entry. After bundling, this module lives at
 * `<pkg>/dist/...`, so the bin is `<pkg>/bin/vonvon.mjs` — the same
 * layout in a global npm install and a local checkout. Used by the Windows/Linux
 * service definitions, which need an absolute ExecStart.
 */
export function resolveCliBinPath(): string {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return resolve(distDir, '..', 'bin', 'vonvon.mjs');
}

/**
 * Tail the service logs in pure Node (no `tail` binary — Windows lacks it, and
 * systemd's append files are plain files). Prints the last ~100 lines of each
 * file, then (when `follow`) polls for appended bytes until interrupted (Ctrl+C).
 * launchd keeps its own `tail`-based path; this serves Windows + Linux.
 */
export async function tailServiceLogs(follow: boolean): Promise<void> {
  await ensureLogFiles();
  const files = [serviceStdoutPath(), serviceStderrPath()];

  for (const f of files) {
    const tail = await lastLines(f, 100);
    if (tail) process.stdout.write(`\n===== ${f} =====\n${tail}\n`);
  }
  if (!follow) return;

  const offsets = new Map<string, number>(files.map((f) => [f, fileSize(f)]));
  await new Promise<void>((resolvePromise) => {
    const onSigint = (): void => {
      clearInterval(timer);
      process.off('SIGINT', onSigint);
      resolvePromise();
    };
    process.on('SIGINT', onSigint);
    const timer = setInterval(() => {
      for (const f of files) {
        const size = fileSize(f);
        const from = offsets.get(f) ?? 0;
        if (size > from) {
          offsets.set(f, size);
          createReadStream(f, { start: from, end: size - 1, encoding: 'utf8' }).pipe(process.stdout, {
            end: false,
          });
        } else if (size < from) {
          offsets.set(f, size); // truncated/rotated — reset
        }
      }
    }, 700);
  });
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

async function lastLines(file: string, n: number): Promise<string> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .slice(-n - 1)
      .join('\n')
      .trimEnd();
  } catch {
    return '';
  }
}
