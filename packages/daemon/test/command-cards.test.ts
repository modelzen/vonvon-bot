import { describe, expect, it } from 'vitest';
import {
  buildClearedCard,
  buildHelpCard,
  buildResumeCard,
  buildResumeDoneCard,
  buildWelcomeCard,
  type ResumeCardState,
} from '../src/card/command-cards';
import type { ThreadSummary } from '../src/agent/types';
import { weaveRecordBlock, weaveSender } from '../src/bot/context-weave';

function buttons(node: unknown, acc: any[] = []): any[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.tag === 'button') acc.push(o);
    for (const k of Object.keys(o)) buttons(o[k], acc);
  }
  return acc;
}

function state(threads: ThreadSummary[]): ResumeCardState {
  return { chatId: 'oc_x', originalMsgId: 'om_x', requesterOpenId: 'ou_x', cwd: '/x', threads, createdAt: Date.now() };
}

const NOW = Math.floor(Date.now() / 1000);

describe('buildResumeCard', () => {
  it('renders one labeled button per session (time · title), unambiguous', () => {
    const longTitle = 'X-Alimail-AntiSpam:AC=CONTINUE;BC=-1|1;BR=01201311R271S09ruler050_05242_201210;CH=green';
    const threads: ThreadSummary[] = [
      { sessionId: 'c1', preview: '查看功能', name: '查看功能', createdAt: NOW - 1500, updatedAt: NOW - 1500 },
      { sessionId: 'c2', preview: longTitle, name: '', createdAt: NOW - 20 * 86400, updatedAt: NOW - 20 * 86400 },
      // two same-title sessions, different times → must get different labels
      { sessionId: 'c3', preview: '分析 SLS 告警', name: '分析 SLS 告警', createdAt: NOW - 20 * 86400, updatedAt: NOW - 20 * 86400 },
      { sessionId: 'c4', preview: '分析 SLS 告警', name: '分析 SLS 告警', createdAt: NOW - 20 * 86400 - 4000, updatedAt: NOW - 20 * 86400 - 4000 },
    ];
    const card = buildResumeCard(state(threads));
    const btns = buttons(card);

    // exactly one button per session, each carrying its sessionId
    expect(btns.length).toBe(4);
    expect(btns.map((b) => b.behaviors[0].value.t)).toEqual(['c1', 'c2', 'c3', 'c4']);
    // every label is the time·title button (no bare "恢复" buttons)
    for (const b of btns) expect(b.text.content).toMatch(/^↩️ .+ · /);
    // long/garbage title is truncated to one line with …
    const longLabel = btns[1].text.content as string;
    expect(longLabel).toContain('…');
    expect(longLabel.length).toBeLessThan(60); // bounded, not the full ~90-char title
    expect(longLabel).not.toContain('\n');
    // same-title sessions are disambiguated by the timestamp
    expect(btns[2].text.content).not.toBe(btns[3].text.content);
  });

  // An unnamed session's preview is its first prompt as the bot wove it.
  it("titles an unnamed session by the person's words, never the sender line or record block", () => {
    const woven = weaveRecordBlock(weaveSender('修一下登录', { senderId: 'ou_secret_id', senderName: '张三' }), {
      place: { group: '验收群', me: 'Vonvon Bot 6' },
      entries: [{ messageId: 'om_old', senderName: '李四', text: '上文', createTime: 1, from: 'user' }],
      now: 2,
    });
    const threads: ThreadSummary[] = [
      { sessionId: 'w1', preview: woven, createdAt: NOW - 60, updatedAt: NOW - 60 },
      { sessionId: 'w2', preview: weaveSender('', { senderId: 'ou_secret_id', senderName: '张三' }), createdAt: NOW - 60, updatedAt: NOW - 60 },
      // a name gets the same stripping, as on the desktop list
      { sessionId: 'w3', preview: '', name: weaveSender('登录修复', { senderId: 'ou_secret_id', senderName: '张三' }), createdAt: NOW - 60, updatedAt: NOW - 60 },
    ];
    const labels = buttons(buildResumeCard(state(threads))).map((b) => b.text.content as string);
    expect(labels[0]).toMatch(/ · 修一下登录$/);
    expect(labels[1]).toMatch(/ · \(无摘要\)$/);
    expect(labels[2]).toMatch(/ · 登录修复$/);
    for (const label of labels) expect(label).not.toMatch(/open_id|ou_secret_id|发信人|飞书|上文/);
  });

  it('shows an empty-state hint and no buttons when there is no history', () => {
    const card = buildResumeCard(state([]));
    expect(buttons(card).length).toBe(0);
    expect(JSON.stringify(card)).toContain('还没有历史会话');
  });

  // 单会话群就地切回 vs 多话题群开新话题：选择卡的引导语随 flat 变。
  it('flat（单会话群）→ 提示「就地切回·不另起话题」；非 flat → 提示「新话题」', () => {
    const threads: ThreadSummary[] = [{ sessionId: 'c1', preview: 'x', createdAt: NOW - 60, updatedAt: NOW - 60 }];
    const flat = JSON.stringify(buildResumeCard({ ...state(threads), flat: true }));
    expect(flat).toContain('就地');
    expect(flat).not.toContain('新话题');

    const topic = JSON.stringify(buildResumeCard(state(threads)));
    expect(topic).toContain('新话题');
  });
});

describe('buildResumeDoneCard', () => {
  it('flat → 「已切回·就地继续」；非 flat → 「已恢复·新话题」', () => {
    const base = state([]);
    expect(JSON.stringify(buildResumeDoneCard({ ...base, flat: true }))).toContain('已切回');
    expect(JSON.stringify(buildResumeDoneCard(base))).toContain('新话题');
  });
});

describe('buildClearedCard', () => {
  it('说清「上下文已清空」但「飞书聊天记录不受影响」，并指向 /resume 找回', () => {
    const json = JSON.stringify(buildClearedCard());
    expect(json).toContain('已开启全新会话');
    expect(json).toContain('上下文已清空');
    // 用户最担心的点：飞书历史不会被删
    expect(json).toContain('飞书聊天记录不受影响');
    // 误清可恢复
    expect(json).toContain('/resume');
  });

  // M-8：回调值带 backend 标识（b），pick → readHistory → 重绑全程同后端。
  it('carries the backend id in each pick button value when the state has one', () => {
    const threads: ThreadSummary[] = [
      { sessionId: 'c1', preview: 'x', createdAt: NOW - 60, updatedAt: NOW - 60 },
    ];
    const withBackend = buildResumeCard({ ...state(threads), backend: 'codex-appserver' });
    expect(buttons(withBackend)[0].behaviors[0].value).toMatchObject({ t: 'c1', b: 'codex-appserver' });
    // 旧 state（无 backend）→ 不带 b，handler 落回默认后端
    const legacy = buildResumeCard(state(threads));
    expect(buttons(legacy)[0].behaviors[0].value.b).toBeUndefined();
  });
});

describe('buildHelpCard 权限过滤', () => {
  it('主群区：非管理员看不到 owner-only 命令(/resume)，但对话类命令仍在', () => {
    const json = JSON.stringify(buildHelpCard('main', true, false));
    expect(json).not.toContain('/resume');
    expect(json).not.toContain('/settings');
    expect(json).toContain('/model'); // 对话类命令对所有人开放
    expect(json).toContain('/help');
  });

  it('主群区：管理员能看到全部命令；群里不列 /settings（s1b，只在私聊里有）', () => {
    const json = JSON.stringify(buildHelpCard('main', true, true));
    expect(json).toContain('/resume');
    expect(json).not.toContain('/settings');
    expect(json).toContain('/model');
  });

  it('单会话群：谁都看不到 /settings（s1b），/model 始终可见', () => {
    for (const scope of ['single', 'topic', 'main'] as const) {
      for (const admin of [true, false]) {
        for (const kind of ['single', 'smart', 'multi'] as const) expect(JSON.stringify(buildHelpCard(scope, false, admin, undefined, kind))).not.toContain('/settings');
      }
    }
    expect(JSON.stringify(buildHelpCard('single', true, false))).toContain('/model');
  });

  it('单会话群：/clear、/resume 仅管理员可见（对话类命令不受影响）', () => {
    const guest = JSON.stringify(buildHelpCard('single', true, false));
    expect(guest).not.toContain('/clear');
    expect(guest).not.toContain('/resume');
    expect(guest).toContain('/model'); // 对话类照常

    const admin = JSON.stringify(buildHelpCard('single', true, true));
    expect(admin).toContain('/clear');
    expect(admin).toContain('/resume');
  });

  it('私聊（dm-agent 5）：主区和话题的帮助都列 /menu，群里不列', () => {
    const main = JSON.stringify(buildHelpCard('single', true, true, undefined, undefined, true));
    expect(main).toContain('/menu'); expect(main).toContain('私聊');
    expect(JSON.stringify(buildHelpCard('topic', true, true, undefined, undefined, true))).toContain('/menu');
    expect(JSON.stringify(buildHelpCard('single', true, true))).not.toContain('/menu');
  });

  it('/new（s15）：单会话群给管理员列 /new 和 /clear；/compact 写明忙时等；话题里怎么开新会话按群的类型写', () => {
    const admin = JSON.stringify(buildHelpCard('single', true, true));
    expect(admin).toContain('`/new`（或 `/clear`）→ 换一条新会话，旧的能 `/resume` 回来（飞书消息保留）');
    expect(admin).toContain('`/compact` → 压缩上下文（正忙时等这一轮结束再压）');
    expect(JSON.stringify(buildHelpCard('topic', true, false, undefined, 'single'))).toContain('要新的会话，就在主区的某条消息下开一个新话题。');
    expect(JSON.stringify(buildHelpCard('topic', true, false))).toContain('开新话题：回到主群区 @我 + 内容。');
  });

  it('智能群（s25c）：主区和话题里都不提免@，说直接说话我看情况回、@ 我马上看但不说一定回；单会话群照旧', () => {
    for (const [scope, admin] of [['single', true], ['single', false], ['topic', false]] as const) {
      // noMentionOf is false for 智能: the card must not offer /settings for a 免@ it lacks.
      const smart = JSON.stringify(buildHelpCard(scope, false, admin, undefined, 'smart'));
      expect(smart).not.toContain('免@');
      expect(smart).not.toContain('本群默认需 @');
      // 3.4: an @ is judged too and may go unanswered, so the card must not promise a reply.
      expect(smart).toContain('· **@我 + 内容** → 我马上看，该回就回');
      expect(smart).not.toContain('一定回');
      expect(smart).toContain(scope === 'topic' ? '· 直接说话 → 我看情况回' : '· 直接说话 → 我看情况接话或开话题');
    }
    const head = JSON.stringify(buildHelpCard('single', false, true, undefined, 'smart'));
    expect(head).toContain('💬 **智能开话题** — 不用 @ 我，我会读群消息，合适时接话。');
    expect(head).not.toContain('/settings');
    expect(JSON.stringify(buildHelpCard('topic', false, false, undefined, 'smart'))).toContain('要新的会话，就在主区的某条消息下开一个新话题。');
    expect(JSON.stringify(buildHelpCard('single', false, true, undefined, 'single'))).toContain('本群默认需 @）');
  });

  it('智能群的欢迎卡（s25c）：第一行就是那一句"我会读群消息，合适时接话"，不提免@', () => {
    const smart = JSON.stringify(buildWelcomeCard('smart', undefined, false));
    expect(smart).toContain('💬 **智能开话题** — 不用 @ 我，我会读群消息，合适时接话。主区一条会话；聊到新的事，我自己开话题。');
    expect(smart.match(/我会读群消息/g)).toHaveLength(1);
    expect(smart).not.toContain('免@');
    expect(smart).toContain('· **@我 + 内容** → 我马上看，该回就回');
    expect(smart).not.toContain('一定回');
    expect(smart).toContain('/new');
    for (const kind of ['single', 'smart', 'multi'] as const) expect(JSON.stringify(buildWelcomeCard(kind, undefined, false))).not.toContain('/settings');
  });

  it('单会话群：后端不支持 resume（caps.resume=false）时管理员也不列 /resume，但仍列 /clear', () => {
    const admin = JSON.stringify(buildHelpCard('single', true, true, { resume: false }));
    expect(admin).not.toContain('/resume');
    expect(admin).toContain('/clear'); // /clear 不依赖后端 resume 能力
  });
});

describe('/goal 可发现性', () => {
  it('三个 scope 的 help 卡都列出 /goal（非管理员也可见）', () => {
    for (const scope of ['main', 'topic', 'single'] as const) {
      expect(JSON.stringify(buildHelpCard(scope, true, false))).toContain('/goal');
    }
  });

  it('欢迎卡两种群类型都列出 /goal（默认 = codex，caps undefined）', () => {
    expect(JSON.stringify(buildWelcomeCard('multi'))).toContain('/goal');
    expect(JSON.stringify(buildWelcomeCard('single'))).toContain('/goal');
  });
});

describe('buildWelcomeCard 按后端能力裁剪命令（与 /help 同源 caps）', () => {
  it('caps 标 goal/resume:false 时欢迎卡不列 /goal、/resume，但 compact:true 仍列 /compact 与 /context', () => {
    // 局部能力：compact 已实现(true)，但 goal/resume 显式 false。
    const caps = { goal: false, compact: true, resume: false };
    for (const kind of ['multi', 'single'] as const) {
      const j = JSON.stringify(buildWelcomeCard(kind, undefined, true, caps));
      expect(j).not.toContain('/goal');
      expect(j).not.toContain('/resume');
      expect(j).toContain('/model'); // 共享能力仍在
    }
    const multi = JSON.stringify(buildWelcomeCard('multi', undefined, true, caps));
    expect(multi).toContain('/compact'); // compact:true → 话题内仍列压缩
    expect(multi).toContain('/context');
  });

  it('caps 全 false 时欢迎卡不列 /goal /resume /compact —— 话题内只剩「/context → 看上下文」', () => {
    const caps = { goal: false, compact: false, resume: false };
    const multi = JSON.stringify(buildWelcomeCard('multi', undefined, true, caps));
    expect(multi).not.toContain('/goal');
    expect(multi).not.toContain('/resume');
    expect(multi).not.toContain('/compact');
    expect(multi).toContain('/context'); // 看占用仍在
    expect(multi).toContain('/model');
  });

  it('codex（caps undefined ⇒ 全 true）：欢迎卡仍全列 /goal /resume /compact（向后兼容）', () => {
    const multi = JSON.stringify(buildWelcomeCard('multi'));
    expect(multi).toContain('/goal');
    expect(multi).toContain('/resume');
    expect(multi).toContain('/compact');
  });

  it('单会话群欢迎卡列出 /new 与 /resume（codex 默认全能）', () => {
    const single = JSON.stringify(buildWelcomeCard('single'));
    expect(single).toContain('`/new`（或 `/clear`）→ 开新会话（管理员，旧的能 `/resume` 回来，飞书消息保留）');
    expect(single).toContain('/resume');
  });

  it('单会话群欢迎卡：后端不支持 resume 时不列 /resume，但仍列 /new', () => {
    const single = JSON.stringify(buildWelcomeCard('single', undefined, true, { goal: true, compact: true, resume: false }));
    expect(single).not.toContain('/resume');
    expect(single).toContain('/new');
  });

  it('欢迎卡默认使用新招呼语，不再显示后端名或绑定说明', () => {
    const codex = JSON.stringify(buildWelcomeCard('multi'));
    expect(codex).toContain('你的助手来了！~神奇田螺');
    expect(codex).not.toContain('欢迎使用 Vonvon Bot');
    expect(codex).not.toContain('本群已绑定一个项目目录');

    const claude = JSON.stringify(buildWelcomeCard('multi', undefined, true, undefined, 'Claude'));
    expect(claude).toContain('你的助手来了！~神奇田螺');
    expect(claude).not.toContain('欢迎使用 Vonvon Bot');
    expect(claude).not.toContain('本群已绑定一个项目目录');
    expect(claude).not.toContain('Codex'); // Claude 群里不该再出现 Codex 字样
  });

  it('欢迎卡标题和开场文案可以使用 Bot 自己的配置', () => {
    const welcome = JSON.stringify(buildWelcomeCard(
      'multi',
      undefined,
      true,
      undefined,
      'Codex',
      {title: '研发项目群指南', intro: '欢迎加入 **研发项目群**\n有问题直接 @ 我。'},
    ));
    expect(welcome).toContain('研发项目群指南');
    expect(welcome).toContain('欢迎加入 **研发项目群**\\n有问题直接 @ 我。');
    expect(welcome).toContain('/goal');
  });

  it('空的自定义文案回退到系统默认值', () => {
    const welcome = JSON.stringify(buildWelcomeCard('multi', undefined, true, undefined, 'Codex', {title: '  ', intro: ''}));
    expect(welcome).toContain('本群使用说明');
    expect(welcome).toContain('你的助手来了！~神奇田螺');
  });
});
