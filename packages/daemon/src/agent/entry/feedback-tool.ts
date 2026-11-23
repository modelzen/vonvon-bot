import {z} from 'zod';
import {FeedbackPrivacyError} from '../../feedback/privacy';
import {feedbackSummarySchema, feedbackTooLongMessage} from '../../feedback/types';
import {ToolRefusal, type AgentTool} from './tools';

const schema = z.object({
  summary: feedbackSummarySchema,
  attachmentRefs: z.array(z.string().uuid()).max(6).default([]),
}).strict();

/** Bound at SDK intake and retained by just the accepted provider turn. */
export interface FeedbackSource {
  readonly chatId: string;
  readonly openId: string;
  readonly messageId: string;
  readonly attachments: readonly {ref: string; name: string}[];
  prepare(input: z.infer<typeof schema>, signal: AbortSignal, checkTurn: () => void): Promise<{operationId: string; trackingCode: string}>;
}

export const FEEDBACK_PREPARE = 'feedback_prepare';
export const feedbackTool: AgentTool = {
  name: FEEDBACK_PREPARE, class: 'feedback', places: ['group'], input: schema,
  description: '按当前用户的要求整理反馈并发送完整核对卡片。按需填写排查记录、源码依据、待验证问题、使用场景及验收标准，各项不超过 6000 字；只有已核实与现场版本对应的官方公开源码才填源码依据，可留空。附件只能使用本条消息给出的附件引用，公开提交需要本人点击卡片。',
  async run(args, ctx) {
    if (!ctx.feedback) throw new ToolRefusal({ok: false, code: 'refused', message: '请在已配置反馈接收目标的群聊中重新发起请求。'});
    try {return await ctx.feedback(schema.parse(args));}
    catch (error) {
      if (error instanceof ToolRefusal) throw error;
      if (error instanceof FeedbackPrivacyError) throw new ToolRefusal({ok: false, code: 'refused', message: error.message});
      if (error instanceof Error && error.message === feedbackTooLongMessage) {
        throw new ToolRefusal({ok: false, code: 'refused', message: feedbackTooLongMessage});
      }
      throw new ToolRefusal({ok: false, code: 'refused', message:
        '未能生成可用核对卡。首次请在本人私聊发送 /feedback authorize；若已点过提交，请先在原卡查询回执。还可核对本群反馈目标、附件和摘要长度后重新整理。'});
    }
  },
};
