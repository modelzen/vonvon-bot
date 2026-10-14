import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScopeGrantUrl,
  GRANT_SCOPES,
  labelScope,
  REQUIRED_SCOPES,
  SCOPE_LABELS,
  V1_OPTIONAL_SCOPES,
} from '../src/config/scopes';
import { validateAppCredentials } from '../src/utils/feishu-auth';

// v1 飞书权限表（docs/product.md 3.11）：im:message:readonly 必需；include_bot 和 self_manage 可选；
// 不申请 im:message.group_msg.include_bot:read。

describe('v1 飞书权限表', () => {
  it('im:message:readonly 是必需权限，有中文标签', () => {
    expect(REQUIRED_SCOPES).toContain('im:message:readonly');
    expect(SCOPE_LABELS['im:message:readonly']).toBeTruthy();
    expect(labelScope('im:message:readonly')).toContain('（im:message:readonly）');
  });

  it('新的可选组：进一键授权，不进必需权限，都有中文标签', () => {
    expect(V1_OPTIONAL_SCOPES).toEqual(['im:message.group_at_msg.include_bot:readonly', 'application:application:self_manage']);
    for (const s of V1_OPTIONAL_SCOPES) {
      expect(GRANT_SCOPES).toContain(s);
      expect(REQUIRED_SCOPES).not.toContain(s);
      expect(SCOPE_LABELS[s], s).toBeTruthy();
    }
  });

  it('不申请收别的 bot 全部消息的权限', () => {
    expect(GRANT_SCOPES).not.toContain('im:message.group_msg.include_bot:read');
  });

  it('一键授权链接预选新的必需和可选权限', () => {
    const url = new URL(buildScopeGrantUrl('cli_scopes123', 'feishu'));
    const selected = (url.searchParams.get('q') ?? '').split(',');
    for (const s of ['im:message:readonly', ...V1_OPTIONAL_SCOPES]) expect(selected).toContain(s);
    expect(selected).not.toContain('im:message.group_msg.include_bot:read');
  });
});

describe('缺权限检测带上新的必需权限', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGranted(granted: readonly string[]): void {
    vi.stubGlobal('fetch', (async (input: unknown): Promise<Response> => {
      const u = String(input);
      const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/auth/v3/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 't-scopes' });
      if (u.includes('/bot/v3/info')) return json({ code: 0, bot: { app_name: 'ScopeBot', open_id: 'ou_bot' } });
      if (u.includes('/application/v6/scopes')) return json({ data: { scopes: granted.map((s) => ({ scope_name: s, grant_status: 1 })) } });
      throw new Error('unexpected fetch ' + u);
    }) as unknown as typeof fetch);
  }

  it('迁移来的 bot 只开了旧的必需权限时，缺的就是 im:message:readonly', async () => {
    stubGranted(REQUIRED_SCOPES.filter((s) => s !== 'im:message:readonly'));
    const v = await validateAppCredentials('cli_scopes123', 'secret', 'feishu');
    expect(v.ok).toBe(true);
    expect(v.missingScopes).toEqual(['im:message:readonly']);
  });

  it('开齐必需权限时不报缺，可选权限不算缺', async () => {
    stubGranted(REQUIRED_SCOPES);
    const v = await validateAppCredentials('cli_scopes123', 'secret', 'feishu');
    expect(v.missingScopes).toEqual([]);
  });
});
