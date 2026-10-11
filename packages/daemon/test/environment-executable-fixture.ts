import { isAbsolute, relative, sep } from 'node:path';

export const executableRoots = new Set<string>();

export function fixtureFilesystem(fs: typeof import('node:fs/promises')) {
  return {
    ...fs,
    access: async (...args: Parameters<typeof fs.access>) => {
      const physical = await fs.realpath(args[0]);
      const allowed = physical === await fs.realpath(process.execPath) || [...executableRoots].some(root => {
        const path = relative(root, physical);
        return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
      });
      if (!allowed) throw new Error('Executable is outside the test fixture');
      return fs.access(...args);
    },
  };
}
