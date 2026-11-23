import { isAbsolute, join } from 'node:path';

/** A Preview bundle always owns its data root, even when launched from Finder. */
export function applyPreviewEnvironment(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): void {
  if (!isAbsolute(home)) throw new Error('Preview requires an absolute home directory');
  const root = platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Vonvon Bot Preview')
    : join(home, '.vonvon-bot-preview');
  env.VONVON_DESKTOP_TEST_HOME = join(root, 'desktop');
  env.VONVON_HOME = join(root, 'data');
  env.VONVON_APP_SCHEME = 'vonvon-preview';
}
