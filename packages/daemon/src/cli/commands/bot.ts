import { botSteps, toolSteps, type Agent, type SetupStep, type StepTone } from '@vonvon/protocol';
import { pickBot, print, want, withDaemon, withoutAvatar, type Daemon, type Io } from '../daemon-client';

const MARK: Record<StepTone, string> = { success: '✓', warning: '!', danger: '✗', neutral: '·' };

function botLine(agent: Agent, groups: number): string {
  const state = !agent.enabled ? '没启用' : !agent.running ? '没运行' : '已启用';
  const connection = agent.connection === 'connected' ? '已连接' : agent.connection === 'connecting' || agent.connection === 'reconnecting' ? '连接中' : '未连接';
  const parts = [state, connection, `${groups} 个群`];
  if (agent.activation === 'restartRequired') parts.push('还没按新状态运行');
  if (agent.readError) parts.push(`读取失败：${agent.readError}`);
  return `${agent.name}  ${agent.id}  ${parts.join(' · ')}`;
}

export async function runBotList(io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const snapshot = await daemon(call => call('读取快照', c => c.snapshot()));
  const human = snapshot.agents.length
    ? snapshot.agents.map(agent => botLine(agent, snapshot.memberships.filter(m => m.agentId === agent.id).length))
    : ['还没有 bot。在网页里扫码注册（vonvon open）。'];
  print(io, human, { bots: snapshot.agents.map(withoutAvatar) });
}

function stepLines(step: SetupStep): string[] {
  const out = [`${MARK[step.tone]} ${step.title}：${step.status}`];
  if (step.detail) out.push(`    ${step.detail}`);
  for (const item of step.items ?? []) out.push(`    - ${item}`);
  for (const warning of step.warnings ?? []) out.push(`    ${warning}`);
  // A finished step's buttons (取消勾选, 检查登录) are not a next step, unless a warning still points at one.
  if (step.done && !step.warnings?.length) return out;
  for (const action of step.actions) {
    out.push(action.kind === 'open' ? `    ${action.label}：${action.url}` : `    在网页里点「${action.label}」（vonvon open）`);
  }
  return out;
}

/** Exits 0 whatever the steps show; scripts read `ready` from --json. */
export async function runBotStatus(wanted: string | undefined, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { agent, setup, tools } = await daemon(async call => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const agent = pickBot(snapshot.agents, wanted);
    const reply = await call('读取清单状态', c => c.admin({ type: 'setupStatus', agentId: agent.id }), { feishu: true });
    return { agent, setup: want('读取清单状态', reply, 'setupStatus').status, tools: toolSteps(snapshot.tools) };
  });
  const bot = botSteps(agent, setup);
  const steps = [...bot, ...tools.steps];
  const left = bot.filter(step => !step.done).length + (tools.ready ? 0 : 1);
  const human = [`${agent.name}（${agent.id}）`, ...steps.flatMap(stepLines), left ? `还有 ${left} 步没完成。` : '全部就绪。'];
  print(io, human, { bot: withoutAvatar(agent), setup, steps, ready: left === 0 });
}
