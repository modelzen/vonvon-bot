import { badArgs, CommandError } from '../command-error';
import { print, toolLabel, withDaemon, type Daemon, type Io } from '../daemon-client';

const BACKENDS = { codex: 'codex-appserver', claude: 'claude-agent' } as const;

/**
 * `vonvon provider models <codex|claude>` (cli-7-environment 4.3): every model the Provider reports, as the web page's
 * Provider list shows them. `settings models` is what one bot's picker offers for one use.
 */
export async function runProviderModels(name: string, io: Io, daemon: Daemon = withDaemon, refresh = false): Promise<void> {
  const backend = name === 'codex' || name === 'claude' ? BACKENDS[name] : undefined;
  if (!backend) throw badArgs(`Provider 写 codex 或 claude，不认识「${name}」。`);
  // the daemon starts the Provider to ask it, which can outlast the local wait. Without --refresh the daemon may answer
  // with the list it last read, as the web page's Provider list does; --refresh asks the Provider again (its 刷新).
  const reply = await daemon(call => call('读取模型列表', c => c.collaboration({ action: 'providerModels', backend, ...(refresh ? { refresh: true } : {}) }), { provider: true }));
  if (reply.kind === 'refused') throw new CommandError('refused', reply.message, { reason: reply.code });
  if (reply.kind !== 'providerModels') throw new CommandError('failed', `读取模型列表没有完成：daemon 回了意外的结果（${reply.kind}）。`);
  if (reply.state === 'unavailable') throw new CommandError('refused', `读不到 ${toolLabel(backend)} 的模型列表${reply.message ? `：${reply.message}` : '。'}`, { reason: 'models_unavailable' });
  const human = reply.models.length ? reply.models.map(model => `${model.id}  ${model.displayName}${model.isDefault ? '（默认）' : ''}`) : ['没有模型。'];
  print(io, human, { backend: reply.backend, state: reply.state, models: reply.models });
}
