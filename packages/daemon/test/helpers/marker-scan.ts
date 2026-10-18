import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read-only: files under `root` changed since `since` (no symlinks followed, nothing over 50 MB)
 * that contain `needle`. Returns paths only, never contents (the real-judge tests, design 6.2). */
export function filesWith(root: string, since: number, needle: string): string[] {
  const hits: string[] = [];
  const bytes = Buffer.from(needle);
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && stat.mtimeMs >= since && stat.size <= 50 * 1024 * 1024) {
        try { if (readFileSync(path).includes(bytes)) hits.push(path); } catch { /* unreadable */ }
      }
    }
  };
  walk(root);
  return hits;
}
