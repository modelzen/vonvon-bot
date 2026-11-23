import { z } from 'zod';
import { CodeAccessError, type ReleaseCodeTool } from '../../release-code/connection';
import { ToolRefusal, type AgentTool } from './tools';

export const codeNamespace = 'vonvon-release-code';
export const codeTool = (name: string): name is ReleaseCodeTool => name === 'rg' || name === 'read';
const inputs = {
  rg: z.object({ argv: z.array(z.string().min(1).max(1024)).min(1).max(40) }).strict(),
  read: z
    .object({
      path: z.string().min(1).max(1024),
      offset: z.number().int().min(1).max(16777216).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
};
export function releaseCodeTools(): AgentTool[] {
  return (['rg', 'read'] as const).map((name) => ({
    name,
    class: 'release-code',
    places: ['group'],
    input: inputs[name],
    description:
      name === 'rg'
        ? '在 VonVon 最新正式版源码中按常用只读 rg 参数查找文件或内容，返回实际版本。'
        : '按路径读取 VonVon 最新正式版源码。offset 从第 1 行开始，limit 是行数。',
    async run(args, ctx) {
      if (!ctx.codeSource)
        throw new ToolRefusal({ ok: false, code: 'refused', message: '请从已启用代码查阅的帮助群发起。' });
      try {
        return await ctx.codeSource(name, inputs[name].parse(args));
      } catch (error) {
        throw new ToolRefusal({
          ok: false,
          code: 'refused',
          message:
            error instanceof CodeAccessError ? error.message : '发布版代码查询未完成，请核对连接状态后重试。',
        });
      }
    },
  }));
}
