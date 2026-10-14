import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessHost } from '../../src/provider/process/process-host';
import { compileHolder, type HolderBinary } from '../provider/native/holder-driver';

export function processHosts(): { setup(): void; host(): ProcessHost; teardown(): Promise<void> } {
  let binary: HolderBinary | undefined;
  const hosts: ProcessHost[] = [];
  const dirs: string[] = [];
  return {
    setup() { if (process.platform !== 'win32') binary = compileHolder(); },
    host() {
      const dataDir = mkdtempSync(join(tmpdir(), 'vonvon-test-host-'));
      dirs.push(dataDir);
      const host = new ProcessHost({ dataDir, daemonBootId: randomUUID(), ...(binary ? { platform: 'posix', holderPath: binary.path } : { platform: 'win32' }) });
      hosts.push(host);
      return host;
    },
    async teardown() {
      await Promise.all(hosts.splice(0).map(host => host.closeAll()));
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
      binary?.dispose();
    },
  };
}
