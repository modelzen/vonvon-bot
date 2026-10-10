import { readFileSync } from 'node:fs';
import { transpile } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UI_HTML, UI_PURE_JS } from '../src/web/ui';
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
    'router' + between(handler, '    .on(DM.restart,', '    // handler 立即返回让 SDK ack') + ';',
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

class Element {
  children: Element[] = [];
  style = {};
  onclick?: () => void;
  private value = '';
  constructor(readonly tag: string, value = '') { this.value = value; }
  set textContent(value: string) { this.value = value; this.children = []; }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join('\n'); }
  appendChild(child: Element): Element { this.children.push(child); return child; }
  buttons(): Element[] { return [...(this.tag === 'button' ? [this] : []), ...this.children.flatMap(child => child.buttons())]; }
}
const el = (tag: string, _className?: string, text?: string) => new Element(tag, text);
const pageFunction = (name: string) => between(UI_HTML, `  function ${name}(`, '\n  function ');

describe('foreground web rendering', () => {
  it('keeps current PID version and uptime visible when service management is unsupported', () => {
    const box = new Element('div');
    new Function('box', 'el', 'daemon', UI_PURE_JS + pageFunction('fmtUptime') + pageFunction('renderDaemon') + '\nrenderDaemon(box);')(
      box, el, { running: true, selfHosted: true, supported: false, pid: 12345, version: '0.7.0', uptimeMs: 60_000 },
    );
    expect(box.textContent).toContain('12345');
    expect(box.textContent).toContain('v0.7.0');
    expect(box.textContent).toContain('已运行');
    expect(box.textContent).toContain('vonvon daemon run');
    expect(box.buttons()).toEqual([]);
    expect(box.textContent).not.toContain('feishu-codex-bridge install');
  });

  it('preview add-bot guidance does not invoke an unavailable start action', () => {
    const toast = vi.fn();
    const openWizard = vi.fn();
    new Function('daemon', 'toast', 'openWizard', pageFunction('tryAddBot') + '\ntryAddBot();')({ running: false }, toast, openWizard);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('vonvon daemon run'));
    expect(openWizard).not.toHaveBeenCalled();
  });

  it('wizard completion navigates to status without promising an automatic restart', () => {
    const box = new Element('div');
    const go = vi.fn();
    const close = vi.fn();
    new Function('$', 'el', 'wizStepBar', 'openBotBtn', 'closeWizard', 'go', 'wizSetup', 'wizBotId', pageFunction('renderWizDone') + '\nrenderWizDone();')(
      () => box, el, () => el('div'), () => el('a'), close, go, { botName: 'Test' }, 'bot-id',
    );
    expect(box.textContent).toContain('vonvon daemon run');
    expect(box.textContent).not.toContain('重启使其上线');
    const buttons = box.buttons();
    expect(buttons.map(button => button.textContent)).toEqual(['查看机器人状态']);
    buttons[0]?.onclick?.();
    expect(close).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith({ tab: 'bot', botId: 'bot-id' });
  });

  it.each(['applied', 'restartRequired'])('activation %s only gives restart guidance when needed', async (activation) => {
    const toast = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, json: async () => ({ activation }) }));
    new Function('fetch', 'toast', 'loadState', pageFunction('toggleBotEnabled') + "\ntoggleBotEnabled({ appId: 'bot-id', active: false });")(
      fetch, toast, () => undefined,
    );
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(toast.mock.calls).includes('vonvon daemon run')).toBe(activation === 'restartRequired');
  });

  it('no daemon update check or lifecycle write remains in the served page', () => {
    expect(UI_HTML).not.toMatch(/\/api\/update(?:\/check|\/status)?['"]|\/api\/daemon\/(?:start|stop|restart)/);
    expect(UI_HTML).toContain('/version');
  });
});
