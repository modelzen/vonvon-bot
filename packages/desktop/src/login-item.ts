import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { classifyDistribution, type Distribution } from '../../daemon/src/service/distribution.js';
import type { Registration } from './daemon-manager.js';

interface LoginItemRuntime {
  platform: NodeJS.Platform;
  packaged: boolean;
  resources: string;
  executable: string;
  root: string;
  env: NodeJS.ProcessEnv;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface LoginItemDependencies {
  classifyDistribution?(root: string): Distribution;
  runCommand?(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult>;
  readRegistration(): Promise<Registration>;
  reattachAfterUninstall(): Promise<void>;
}

const outputLimit = 64 * 1024;

async function runCommand(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = Buffer.alloc(outputLimit);
    const stderr = Buffer.alloc(outputLimit);
    let stdoutLength = 0;
    let stderrLength = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.copy(stdout, stdoutLength, 0, Math.min(chunk.length, outputLimit - stdoutLength));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLength += chunk.copy(stderr, stderrLength, 0, Math.min(chunk.length, outputLimit - stderrLength));
    });
    child.once('error', error => reject(new Error(`Vonvon service command failed: ${error.message}`, { cause: error })));
    child.once('close', (code, signal) => {
      const output = { stdout: stdout.toString('utf8', 0, stdoutLength), stderr: stderr.toString('utf8', 0, stderrLength) };
      if (signal !== null || code === null) {
        reject(new Error(`Vonvon service command failed (${signal ?? 'no exit code'}): ${output.stderr || output.stdout || 'No output.'}`));
      } else {
        resolve({ code, ...output });
      }
    });
  });
}

export async function setLoginItem(
  enabled: boolean,
  runtime: LoginItemRuntime,
  dependencies: LoginItemDependencies,
): Promise<CommandResult> {
  if (runtime.platform !== 'darwin' && runtime.platform !== 'win32') {
    throw new Error(`Open at login is unavailable on ${runtime.platform}.`);
  }
  if (!runtime.packaged) throw new Error('Open at login requires the packaged desktop application.');
  const distribution = (dependencies.classifyDistribution ?? classifyDistribution)(join(runtime.resources, 'daemon'));
  if (distribution.kind !== 'bundled') throw new Error('The bundled Vonvon daemon is unavailable.');

  const env: NodeJS.ProcessEnv = { ...runtime.env, ELECTRON_RUN_AS_NODE: '1', VONVON_HOME: runtime.root };
  delete env.VONVON_SERVICE;
  const action = enabled ? 'install' : 'uninstall';
  const result = await (dependencies.runCommand ?? runCommand)(runtime.executable, [distribution.cliPath, 'service', action], env);
  if (result.code !== 0) {
    throw new Error(`Vonvon service ${action} exited ${result.code}: ${result.stderr || result.stdout || 'No output.'}`);
  }

  const registration = await dependencies.readRegistration();
  const expected = enabled ? 'ours' : 'absent';
  if (registration.kind !== expected) {
    throw new Error(`Vonvon service ${action} exited 0, but registration is ${registration.kind}; expected ${expected}.`);
  }
  if (!enabled) await dependencies.reattachAfterUninstall();
  return result;
}
