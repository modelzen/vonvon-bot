import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_SUBAGENT_ICON, RUNTIME_TERMINAL_ICON, serializeRuntimeCard } from '../src/card/runtime-card-icons';
import { installAtGuard } from '../src/card/at-guard';
import { buildAskCard } from '../src/card/ask-card';
import { buildGoalDoneCard } from '../src/card/goal-card';
import { buildCleanCard } from '../src/card/markdown-render';
import { buildRunCard, buildRunCardPlain } from '../src/card/run-card';
import { initialState, reduce } from '../src/card/run-state';

function terminalCard() {
  return { body: { elements: [
    { tag: 'standard_icon', token: RUNTIME_TERMINAL_ICON },
    { tag: 'standard_icon', token: 'search_outlined' },
    { tag: 'markdown', content: RUNTIME_TERMINAL_ICON },
  ] } };
}
function client(create = vi.fn().mockResolvedValue({ code: 0, data: { image_key: 'img_terminal' } })) {
  return { im: { v1: { image: { create } } } };
}

describe('runtime terminal icon serialization', () => {
  afterEach(() => vi.useRealTimers());

  it('uploads the embedded PNG once per client and replaces only terminal icon nodes', async () => {
    const bot = client();
    const input = terminalCard();
    const [first, second] = await Promise.all([
      serializeRuntimeCard(input, bot), serializeRuntimeCard(input, bot),
    ]);
    expect(first).toBe(second);
    expect(JSON.parse(first).body.elements).toEqual([
      { tag: 'custom_icon', img_key: 'img_terminal' },
      { tag: 'standard_icon', token: 'search_outlined' },
      { tag: 'markdown', content: RUNTIME_TERMINAL_ICON },
    ]);
    expect(bot.im.v1.image.create).toHaveBeenCalledTimes(1);
    const upload = bot.im.v1.image.create.mock.calls[0]![0];
    expect(upload.data.image_type).toBe('message');
    expect(upload.data.image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(input).toEqual(terminalCard());
    const other = client(vi.fn().mockResolvedValue({ data: { image_key: 'img_other_bot' } }));
    expect(await serializeRuntimeCard(input, other)).toContain('img_other_bot');
    expect(other.im.v1.image.create).toHaveBeenCalledTimes(1);
  });

  it('captures the original frame before awaiting the upload', async () => {
    let finish!: (response: unknown) => void;
    const bot = client(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const input = terminalCard();
    const result = serializeRuntimeCard(input, bot);
    input.body.elements.push({ tag: 'markdown', content: 'later mutation' });
    finish({ data: { image_key: 'img_terminal' } });
    expect(await result).not.toContain('later mutation');
  });

  it('caches robot and terminal images independently without changing other icons', async () => {
    const create = vi.fn().mockResolvedValueOnce({ data: { image_key: 'img_terminal' } })
      .mockResolvedValueOnce({ data: { image_key: 'img_robot' } });
    const bot = client(create);
    const input = { elements: [
      { tag: 'standard_icon', token: RUNTIME_SUBAGENT_ICON },
      ...terminalCard().body.elements,
    ] };
    const [first, second] = await Promise.all([serializeRuntimeCard(input, bot), serializeRuntimeCard(input, bot)]);
    expect(first).toBe(second);
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.parse(first).elements).toEqual([
      { tag: 'custom_icon', img_key: 'img_robot' },
      { tag: 'custom_icon', img_key: 'img_terminal' },
      { tag: 'standard_icon', token: 'search_outlined' },
      { tag: 'markdown', content: RUNTIME_TERMINAL_ICON },
    ]);
    expect(create.mock.calls[0]![0].data.image.equals(create.mock.calls[1]![0].data.image)).toBe(false);
  });

  it('keeps the native robot fallback when only its upload fails', async () => {
    const create = vi.fn().mockResolvedValueOnce({ data: { image_key: 'img_terminal' } })
      .mockRejectedValueOnce(new Error('robot offline'));
    const bot = client(create);
    const input = { elements: [
      { tag: 'standard_icon', token: RUNTIME_TERMINAL_ICON },
      { tag: 'standard_icon', token: RUNTIME_SUBAGENT_ICON, color: 'grey' },
    ] };
    const first = await serializeRuntimeCard(input, bot);
    expect(JSON.parse(first).elements).toEqual([
      { tag: 'custom_icon', img_key: 'img_terminal' },
      input.elements[1],
    ]);
    expect(await serializeRuntimeCard(input, bot)).toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not upload when the frame needs no terminal icon or the client has no image API', async () => {
    const bot = client();
    expect(await serializeRuntimeCard({ body: { elements: [] } }, bot)).toBe('{"body":{"elements":[]}}');
    expect(bot.im.v1.image.create).not.toHaveBeenCalled();
    for (const partial of [{}, { im: {} }, { im: { v1: {} } }]) {
      expect(await serializeRuntimeCard(terminalCard(), partial)).toBe(JSON.stringify(terminalCard()));
    }
  });

  it.each([
    { code: 999, data: { image_key: 'rejected_key' } },
    { code: 0, data: { image_key: '' } },
    { data: { image_key: 123 } },
    null,
  ])('retains the native fallback on invalid upload response %j', async (response) => {
    const bot = client(vi.fn().mockResolvedValue(response));
    expect(await serializeRuntimeCard(terminalCard(), bot)).toBe(JSON.stringify(terminalCard()));
  });

  it('retains the native fallback after a rejected upload without retrying every frame', async () => {
    const bot = client(vi.fn().mockRejectedValue(new Error('offline')));
    for (let i = 0; i < 2; i++) {
      expect(await serializeRuntimeCard(terminalCard(), bot)).toBe(JSON.stringify(terminalCard()));
    }
    expect(bot.im.v1.image.create).toHaveBeenCalledTimes(1);
  });

  it('retries a failed upload after a cooldown and shares the retry across cards', async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ data: { image_key: 'recovered_key' } });
    const bot = client(create);
    expect(await serializeRuntimeCard(terminalCard(), bot)).not.toContain('recovered_key');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await serializeRuntimeCard(terminalCard(), bot)).not.toContain('recovered_key');
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const cards = await Promise.all([serializeRuntimeCard(terminalCard(), bot), serializeRuntimeCard(terminalCard(), bot)]);
    expect(cards.every(card => card.includes('recovered_key'))).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled upload to three seconds and keeps the same fallback after late completion', async () => {
    vi.useFakeTimers();
    let finish!: (response: unknown) => void;
    const bot = client(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const pending = serializeRuntimeCard(terminalCard(), bot);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBe(JSON.stringify(terminalCard()));
    finish({ data: { image_key: 'late_key' } });
    expect(await serializeRuntimeCard(terminalCard(), bot)).toBe(JSON.stringify(terminalCard()));
    expect(bot.im.v1.image.create).toHaveBeenCalledTimes(1);
  });
});

describe('the <at> guard at the whole-card choke point (s27a0, all fail on main)', () => {
  const BOT = '<at id="ou_b">小审</at>';
  const bot = (): object => {
    const client = { im: {} };
    installAtGuard({ rawClient: client } as never, { peek: () => new Map([['ou_b', { name: '小审' }]]), load: async () => {} });
    return client;
  };
  let state = reduce(initialState, { type: 'thinking', itemId: 'r', text: `推理里 ${BOT}` });
  state = reduce(state, { type: 'text', itemId: 'p', text: `进度话 ${BOT}` });
  state = reduce(state, { type: 'tool_use', itemId: 't', title: 'pwd', kind: 'command' });
  state = reduce(state, { type: 'text', itemId: 'a', text: `回答 ${BOT}，<at id="ou_h">张三</at>` });

  it.each([
    ['a running card (process text and reasoning)', () => buildRunCard({ rs: state })],
    ['a terminal card', () => buildRunCard({ rs: reduce(state, { type: 'done', turnId: 't' }) })],
    ['a demoted card', () => buildRunCardPlain({ rs: state, cardKey: 'k' })],
    ['a goal summary card', () => buildGoalDoneCard({ objective: `目标 ${BOT}`, status: 'complete', tokensUsed: 1, timeUsedSeconds: 1 })],
    ['a fence card', () => buildCleanCard(`# 标题 ${BOT}\n\n正文 ${BOT}`)],
  ])('%s carries no bot <at>', async (_name, build) => {
    const out = await serializeRuntimeCard(build(), bot(), 'oc_1');
    expect(out).toContain('@小审');
    expect(out).not.toContain('ou_b');
  });

  it('keeps a person and an ask card\'s respondents, also when the bot list cannot be read', async () => {
    expect(await serializeRuntimeCard(buildRunCard({ rs: state }), bot(), 'oc_1')).toContain('<at id=\\"ou_h\\">张三</at>');
    const unread = { im: {} };
    installAtGuard({ rawClient: unread } as never, { peek: () => undefined, load: async () => {} });
    const ask = buildAskCard({ request: { id: 'q', kind: 'confirmation', title: '决定', detail: `问 ${BOT} 和 <at id="ou_h">张三</at>`,
      acceptedConsequence: '做', declinedConsequence: '停' }, state: { kind: 'pending' }, respondents: [{ openId: 'ou_owner', name: '主人' }] });
    const out = await serializeRuntimeCard(ask, unread, 'oc_1');
    expect(out).toContain('<at id=\\"ou_owner\\">主人</at>');
    expect(out).toContain('问 @小审 和 @张三');
  });
});
