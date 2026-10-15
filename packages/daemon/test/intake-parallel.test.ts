import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { fetchThreadContext } from '../src/bot/context-weave';
import { isSeen, type SessionRecord } from '../src/bot/session-store';

// M-1 入站并行化的正确性关键：话题上文与 resolveThread 并行时拿不到 codexEmpty，
// 于是投机按已有水位翻页拉到水位为止，汇合后在本地按 isSeen（水位加插话、排队送达的
// id）收敛成增量。这组测试钉死「拉到水位为止 + 本地过滤 ≡ 整个话题全拉 + 同样过滤」：
// 翻页早停永远不会丢掉一条会话没见过的消息。

/** Serve `items` (newest-first) two per page, like the API's page_token paging. */
function pagedChannel(items: unknown[]): LarkChannel {
  return {
    rawClient: {
      im: { v1: { message: { list: async ({ params }: { params: { page_token?: string } }) => {
        const start = Number(params.page_token ?? 0);
        const next = start + 2;
        return { code: 0, data: { items: items.slice(start, next), has_more: next < items.length, page_token: next < items.length ? String(next) : undefined } };
      } } } },
    },
  } as unknown as LarkChannel;
}

function userMsg(id: string, createTime: number, text = `m-${id}`): Record<string, unknown> {
  return {
    message_id: id,
    msg_type: 'text',
    create_time: String(createTime),
    sender: { id: 'ou_u', sender_type: 'user', sender_name: 'U' },
    body: { content: JSON.stringify({ text }) },
  };
}

type Mark = Pick<SessionRecord, 'lastSeenAt' | 'seen'>;

/** The unseen delta, pulled both ways; the two must agree. */
async function delta(items: unknown[], rec: Mark, before?: number): Promise<string[]> {
  const ch = pagedChannel(items);
  const unseen = (msgs: { messageId: string; createTime: number }[]) =>
    msgs.filter((m) => !isSeen(rec, m.messageId, m.createTime)).map((m) => m.messageId);
  const stopped = await fetchThreadContext(ch, 'omt_x', { stopAt: rec.lastSeenAt ?? 0, before });
  const whole = await fetchThreadContext(ch, 'omt_x', { before });
  expect(unseen(stopped.messages)).toEqual(unseen(whole.messages));
  return unseen(stopped.messages);
}

describe('翻页拉到水位为止 ≡ 整个话题全拉（同样的本地过滤）', () => {
  // newest-first，混入 bot 消息与撤回消息（fetchThreadContext 内部会滤掉）
  const items = [
    userMsg('om_6', 6000),
    userMsg('om_5', 5000),
    { message_id: 'om_bot', msg_type: 'text', create_time: '4500', sender: { id: 'cli_b', sender_type: 'app', sender_name: 'Bot' }, body: { content: JSON.stringify({ text: 'bot 回复' }) } },
    userMsg('om_4', 4000),
    { ...userMsg('om_del', 3500), deleted: true },
    userMsg('om_3', 3000),
    userMsg('om_2', 2000),
    userMsg('om_1', 1000),
  ];

  it('水位在中间：只留水位之后的（恰等于水位的算见过）', async () => {
    expect(await delta(items, { lastSeenAt: 3000 })).toEqual(['om_4', 'om_5', 'om_6']);
  });

  it('插话和排队送过的消息不再带', async () => {
    expect(await delta(items, { lastSeenAt: 2000, seen: [{ id: 'om_2', at: 2000 }, { id: 'om_4', at: 4000 }] })).toEqual(['om_3', 'om_5', 'om_6']);
  });

  it('只带比触发消息早的', async () => {
    expect(await delta(items, { lastSeenAt: 1000 }, 5000)).toEqual(['om_2', 'om_3', 'om_4']);
  });

  it('补拉失败后从 0 重来：整个话题都没见过，送过的除外', async () => {
    expect(await delta(items, { lastSeenAt: 0, seen: [{ id: 'om_6', at: 6000 }] })).toEqual(['om_1', 'om_2', 'om_3', 'om_4', 'om_5']);
  });

  it('createTime=0 的噪音消息不破坏等价', async () => {
    const noisy = [userMsg('om_new', 9000), { ...userMsg('om_zero', 0), create_time: undefined }, userMsg('om_old', 1000)];
    expect(await delta(noisy, { lastSeenAt: 5000 })).toEqual(['om_new']);
    expect(await delta(noisy, { lastSeenAt: 500 })).toEqual(['om_old', 'om_new']);
  });

  it('水位之后为空（最常见的热路径）：一页就停', async () => {
    let pages = 0;
    const ch = pagedChannel(items);
    const list = ch.rawClient.im.v1.message.list.bind(ch.rawClient.im.v1.message);
    (ch.rawClient.im.v1.message as { list: unknown }).list = (p: never) => { pages++; return list(p); };
    const out = await fetchThreadContext(ch, 'omt_x', { stopAt: 99999 });
    expect(out.messages.filter((m) => !isSeen({ lastSeenAt: 99999 }, m.messageId, m.createTime))).toEqual([]);
    expect(pages).toBe(1);
  });
});
