import { describe, expect, it } from 'vitest';
import { CLAUDE_SIGNED_OUT_MESSAGE, CLAUDE_TURN_SIGNED_OUT_MESSAGE } from '../src/agent/claude-agent/login';
import { authText, LOGIN_STATE } from '../src/cli/commands/env';

const states = [undefined, { state: 'signedIn', message: '' }, { state: 'unknown', message: '读不到' }, { state: 'signedOut', message: '' }] as const;

// main 必败: Codex and Claude need an account or a custom API, not a 登录 (devices 6.4, devices-ui-2 4.2)
describe('Provider words without 登录', () => {
  it('says 配置 for Claude, the CLI states and every Codex or Claude answer', () => {
    for (const text of [CLAUDE_SIGNED_OUT_MESSAGE, CLAUDE_TURN_SIGNED_OUT_MESSAGE, ...Object.values(LOGIN_STATE)]) expect(text).not.toContain('登录');
    for (const tool of ['codex', 'claude'] as const) {
      for (const auth of states) expect(authText({ tool, auth }), `${tool} ${auth?.state}`).not.toContain('登录');
    }
    expect(authText({ tool: 'codex', auth: { state: 'signedOut', message: '' } })).toBe('没配置好：在终端里运行 codex 配置（账号或自定义 API 都行）');
  });

  it('keeps lark-cli, which does sign in to Feishu, word for word', () => {
    expect(states.map(auth => authText({ tool: 'lark-cli', auth }))).toEqual([
      '登录状态查不到', '已登录', '登录状态不确定：读不到', '没登录：运行 vonvon env login lark-cli',
    ]);
  });
});
