import { readFileSync } from 'node:fs';
import { transpile } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildForegroundRestartCard, buildForegroundUpdateCard, DM } from '../src/card/dm-cards';

const handler = readFileSync(new URL('../src/bot/handle-message.ts', import.meta.url), 'utf8');
const between = (text: string, start: string, end: string) => {
  const at = text.indexOf(start);
  const stop = text.indexOf(end, at + start.length);
  if (at < 0 || stop < 0) throw new Error(`Missing source boundary ${start}`);
  return text.slice(at, stop);
};

function callbackFixture(orphan = false) {
  const update = vi.fn(async () => !orphan);
  const send = vi.fn(async () => undefined);
  const callbacks = new Map<string, (input: object) => void>();
  const router = { on(action: string, callback: (input: object) => void) { callbacks.set(action, callback); return this; } };
  const code = [
    between(handler, '  const settleUpdate = (', '  function pruneResumePending'),
    between(handler, '  const patch = (', '  async function renderForegroundUpdate'),
    'router' + between(handler, '    .on(DM.restart,', '    .on(DM.usage,') + ';',
  ].join('\n');
  new Function('router', 'DM', 'dmAdmin', 'channel', 'updateManagedCard', 'sendManagedCard', 'log', 'CARD_SETTLE_MS', 'buildForegroundRestartCard', 'renderForegroundUpdate', transpile(code))(
    router, DM, (id: string) => id === 'owner', {}, update, send, { info() {}, fail() {} }, 500,
    buildForegroundRestartCard, () => buildForegroundUpdateCard({ current: '0.7.0' }),
  );
  return { update, send, click(action: string, openId = 'owner') {
    const callback = callbacks.get(action);
    if (!callback) throw new Error(`No callback ${action}`);
    return callback({ evt: { messageId: 'old-card', chatId: 'private-chat', operator: { openId } } });
  } };
}

afterEach(() => vi.useRealTimers());

describe('foreground lifecycle callback delivery', () => {
  it.each([DM.restart, DM.restartDo, DM.update, DM.updateDo])('%s acknowledges before settling and recovers an orphan card', async (action) => {
    vi.useFakeTimers();
    const fixture = callbackFixture(true);
    expect(fixture.click(action)).toBeUndefined();
    expect(fixture.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.update).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith({}, 'private-chat', expect.any(Object));
    const text = JSON.stringify(fixture.send.mock.calls);
    expect(text).toContain('vonvon daemon run');
    expect(text).not.toMatch(/npm i -g|sudo|确认重启|立即更新|正在重启/);
  });

  it.each([DM.restart, DM.restartDo, DM.update, DM.updateDo])('%s keeps non-admin callbacks inactive', async (action) => {
    vi.useFakeTimers();
    const fixture = callbackFixture();
    fixture.click(action, 'guest');
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each([DM.restart, DM.update])('%s application menu sends the same guidance', async (eventKey) => {
    const send = vi.fn(async () => undefined);
    const body = between(handler, '      switch (evt.eventKey)', '\n    } catch (err)');
    await new Function('evt', 'DM', 'sendDm', 'buildForegroundRestartCard', 'renderForegroundUpdate', transpile('return (async () => {' + body + '})();'))(
      { eventKey }, DM, send, buildForegroundRestartCard, () => buildForegroundUpdateCard({ current: '0.7.0' }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(eventKey === DM.restart ? buildForegroundRestartCard() : buildForegroundUpdateCard({ current: '0.7.0' }));
  });
});
