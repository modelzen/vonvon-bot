import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export type DataRoot = {
  path: string;
  kind: 'fresh' | 'legacy' | 'canonical';
};

export const migrationJournalName = '.vonvon-bridge-migration.json';
export const migrationWitnessName = '.vonvon-bridge-migration-witness.json';

export class DataRootMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`${message} Keep both data paths intact and complete offline recovery before starting Bridge.`, options);
    this.name = 'DataRootMigrationError';
  }
}

export function resolveDataRoot(home: string): DataRoot {
  const override = process.env.VONVON_HOME;
  if (override !== undefined && (!override.trim() || !isAbsolute(override))) {
    throw new Error('VONVON_HOME must be a nonempty absolute directory path.');
  }
  const selected = resolve(override ?? join(home, '.vonvon-bot'));
  try {
    const stat = lstatSync(selected);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Daemon root must be a physical directory.');
    return { path: realpathSync(selected), kind: 'canonical' };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  let ancestor = dirname(selected);
  const suffix = [basename(selected)];
  for (;;) {
    try { return { path: join(realpathSync(ancestor), ...suffix), kind: 'fresh' }; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}
