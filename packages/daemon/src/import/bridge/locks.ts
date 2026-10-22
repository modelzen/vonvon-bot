import {join} from 'node:path';
import {acquireSingleInstanceLock, readSingleInstanceHolder} from '../../core/single-instance';
import {inspectLocalPath, readLocalText} from './bounded-local-files';

/** One exit listener, including when a migrated installation contains many Bots. */
export class BridgeLocks {
  private readonly releases = new Map<string, {release: () => void; startedAt: number; dev: number; ino: number}>();
  private readonly exit = () => this.releaseAll();
  constructor(readonly sourceDir: string) {process.once('exit', this.exit);}
  holder(appId: string) {return readSingleInstanceHolder(appId, join(this.sourceDir, 'bots', appId, 'processes.json'));}
  async acquire(appId: string, allowMissing = false): Promise<void> {
    const dir = join(this.sourceDir, 'bots', appId);
    const metadata = await inspectLocalPath(this.sourceDir, dir);
    if (!metadata && allowMissing) {this.release(appId); return;}
    if (!metadata?.isDirectory()) throw new Error('Bridge Bot directory is missing');
    const path = join(dir, 'processes.json'), owned = this.releases.get(appId);
    if (owned) {
      // readSingleInstanceHolder deliberately ignores our own pid. Compare the persisted receipt directly;
      // never unlink/recreate a healthy owned lock during the periodic guard.
      const text = await readLocalText(this.sourceDir, path, undefined, 4096), current = await inspectLocalPath(this.sourceDir, path);
      const record = text === undefined ? undefined : JSON.parse(text);
      if (record?.pid === process.pid && record.appId === appId && record.startedAt === owned.startedAt
        && current?.dev === owned.dev && current.ino === owned.ino) return;
    }
    // A replaced lock is never removed by an old release callback.
    this.releases.delete(appId);
    const release = acquireSingleInstanceLock(appId, path, {createDir: false, onExit: false});
    const record = JSON.parse((await readLocalText(this.sourceDir, path, undefined, 4096)) ?? 'null');
    const receipt = await inspectLocalPath(this.sourceDir, path);
    if (record?.pid !== process.pid || record.appId !== appId || !receipt?.isFile()) {release(); throw new Error('Bridge lock ownership changed');}
    this.releases.set(appId, {release, startedAt: record.startedAt, dev: receipt.dev, ino: receipt.ino});
  }
  release(appId: string): void {const owned = this.releases.get(appId); this.releases.delete(appId); owned?.release();}
  releaseAll(): void {for (const id of this.releases.keys()) this.release(id);}
  close(): void {this.releaseAll(); process.off('exit', this.exit);}
}
