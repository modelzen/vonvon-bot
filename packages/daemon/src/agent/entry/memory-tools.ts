import { z } from 'zod';
import type { MemoryWriter, WriteContext } from '../../bot/memory-writer';
import { ToolRefusal, type AgentTool, type ToolContext } from './tools';

/**
 * 记忆工具（记忆设计 §3.3）：`memory_add` / `memory_update` / `memory_forget` 是 `class:'memory'`，群和私聊里给；
 * `memory_list` 是读类，评论会话也给，但评论里只返回 Bot 记忆的"合作方式"。权限、落点、来源都由 daemon 判（`bot/memory-writer.ts`），
 * 这里的说明只是教模型怎么用，不是边界。
 */

/** 三个写工具共用的一段说明（§3.3） */
const HOW_TO_REMEMBER = [
  '只记以后还用得上的稳定内容，写陈述句；不记任务进度、密钥、临时状态。',
  '"谁该回、谁不该回、某个 bot 的职责"不记，告诉对方这要主人改补充职责。',
  '拿不准范围就记到项目；私聊里不用选，默认记到这个人的私聊记忆。',
  'branch 从记忆开头"分支："那一行里挑最合适的，照原样写名字；都不合适才起一个新的短名字（12 字以内，比如"发版"），意思相近的用已有的。拿不准就写"其他"。Bot 记忆里的"关于你"说的是主人；项目记忆里的"人和分工"只记人谁管什么，不记哪个 bot 该回什么。',
  '记了就在这一轮的回复里像平常说话一样带一句，比如"好，记住了""这个我记下了，以后按周四来"。',
  '没有固定格式；不逐条列记了什么，不说记在哪个项目、哪一层，不单独发一条消息。别人让你记的、你自己判断要记的都一样。',
  '没记成（refused，或者满了又腾不出位）就别说记住了；refused 的原因是 duplicate 时，说明已经记着，照常说。',
  '有人说"刚才那条记错了""删掉"，用 memory_update / memory_forget，做完用一句话回。',
].join('\n');

const scopeSchema = z.union([z.enum(['project', 'bot', 'dm']), z.object({ project: z.string().min(1).max(100) }).strict()]);
const addInput = z.object({
  text: z.string().min(1).max(500), branch: z.string().max(100).optional(), scope: scopeSchema.optional(),
  claim: z.enum(['asked', 'self']).optional(), why: z.string().max(200).optional(),
}).strict();
const updateInput = z.object({ id: z.string().min(1).max(200), text: z.string().min(1).max(500).optional(), branch: z.string().max(100).optional(), why: z.string().max(200).optional() }).strict();
const forgetInput = z.object({ id: z.string().min(1).max(200), why: z.string().max(200).optional() }).strict();
const listInput = z.object({ scope: z.union([z.enum(['project', 'bot', 'dm']), z.object({ project: z.string().min(1).max(100) }).strict()]).optional() }).strict();

function writeContext(ctx: ToolContext, guard: () => void): WriteContext {
  const memoryTurn = ctx.memoryTurn;
  if (!memoryTurn) throw new ToolRefusal({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
  return {
    turn: memoryTurn, guard,
    ...(ctx.turn?.triggerMessageId ? { triggerMessageId: ctx.turn.triggerMessageId } : {}),
    ...(ctx.reserveBotWrite ? { reserveBotWrite: ctx.reserveBotWrite } : {}),
    ...(ctx.releaseBotWrite ? { releaseBotWrite: ctx.releaseBotWrite } : {}),
  };
}
/** 写入走 registry 的 commit：提交点前 `guard()`（70 秒预算照旧）；没走到提交点的（满了、重复）不算错 */
function committed<T>(ctx: ToolContext, write: (context: WriteContext) => Promise<T>): Promise<T> {
  if (!ctx.commit) throw new ToolRefusal({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
  return ctx.commit(guard => write(writeContext(ctx, guard)));
}

export function createMemoryTools(writer: MemoryWriter): AgentTool[] {
  return [{
    name: 'memory_add', class: 'memory', input: addInput,
    description: `记一条记忆。text 是一条陈述句；branch 是分支；scope 默认记到本群的项目（私聊里是这个人的私聊记忆），只有主人亲手打的跨项目要求才会进 Bot 记忆（由 vonvon 核对，不符合会记到默认的地方）；claim 说明是"用户要我记"（asked）还是"我自己判断"（self）；why 是一句为什么记。\n${HOW_TO_REMEMBER}`,
    run: (args, ctx) => committed(ctx, context => writer.add(context, addInput.parse(args), 'tool')),
  }, {
    name: 'memory_update', class: 'memory', input: updateInput,
    description: `改一条已有的记忆：text 是新文本，branch 是换到本份记忆里的另一个分支（不能借它跨层）。id 来自 memory_list 或 memory_add 的结果。\n${HOW_TO_REMEMBER}`,
    run: (args, ctx) => committed(ctx, context => writer.update(context, updateInput.parse(args))),
  }, {
    name: 'memory_forget', class: 'memory', input: forgetInput,
    description: `忘掉一条记忆（归档，主人能在桌面端找回）。id 来自 memory_list 或 memory_add 的结果。\n${HOW_TO_REMEMBER}`,
    run: (args, ctx) => committed(ctx, context => writer.forget(context, forgetInput.parse(args))),
  }, {
    name: 'memory_list', class: 'read', input: listInput,
    description: '列出本会话能用的记忆，按分支分组，附分支名单和条数。默认列本群的项目记忆和 Bot 记忆，私聊里是这个人的私聊记忆和 Bot 记忆；scope 可选 project、bot、dm 或 {project:id}。要改、要忘一条之前先用它找 id。',
    async run(args, ctx) {
      return writer.list(ctx.place, listInput.parse(args).scope);
    },
  }];
}
