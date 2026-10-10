import { Command } from 'commander';
import { mkdir } from 'node:fs/promises';
import { bridgeVersion } from '../core/version';
import { paths } from '../config/paths';
import { enterDataAccess, type DataLease } from '../config/data-access';
import { observeShutdown, type ShutdownControl } from '../host/lifecycle';

const program = new Command().name('vonvon').description('Vonvon Bot daemon').version(bridgeVersion());
let lease: DataLease | undefined;
let control: ShutdownControl | undefined;
program.hook('preAction', async (_command, action) => {
  if (action.name() === 'run') control = observeShutdown();
  await mkdir(paths.appDir, { recursive: true, mode: 0o700 });
  lease = await enterDataAccess(paths.appDir);
});
program.hook('postAction', () => { lease?.release(); control?.dispose(); });
program.command('daemon').description('Run the local daemon')
  .command('run').description('Run in the foreground')
  .option('--bot <appId>', 'Run one bot')
  .action(async (options: { bot?: string }) => {
    await (await import('../host/bootstrap')).runHostRuntime({ bot: options.bot, managed: false, control });
  });

// Internal plumbing — the `secrets-getter` wrapper execs `secrets get` to
// resolve the App Secret from the keystore. Users never call it, so hide it
// from --help (still fully functional, just unlisted).
const secrets = program.command('secrets', { hidden: true }).description('本地加密密钥库（内部）');
secrets
  .command('get')
  .description('exec-provider 端点（从 stdin 读 JSON 请求）')
  .action(async () => {
    await (await import('./commands/secrets')).secretsGet();
  });
secrets
  .command('set <id>')
  .description('存储密钥（值从 stdin 读）')
  .action(async (id: string) => {
    await (await import('./commands/secrets')).secretsSet(id);
  });
secrets
  .command('list')
  .description('列出密钥 id')
  .action(async () => {
    await (await import('./commands/secrets')).secretsList();
  });
secrets
  .command('remove <id>')
  .description('删除密钥')
  .action(async (id: string) => {
    await (await import('./commands/secrets')).secretsRemove(id);
  });

program
  .command('hook', { hidden: true })
  .requiredOption('--agent <agent>', 'claude or codex')
  .option('--bot <nameOrAppId>', 'target bot name or appId')
  .action(async (options: { agent: string; bot?: string }) => {
    const { runHookCommand } = await import('../cli-bridge');
    await runHookCommand(options.agent, options.bot);
  });

program.parseAsync(process.argv).then(() => {
  if (control) process.exit(process.exitCode ?? 0);
}).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
