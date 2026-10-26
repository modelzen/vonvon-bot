import { describe, expect, it } from 'vitest';
import {
  getSessionTitleConfig,
  getSessionTitleEfforts,
  summarizeSessionTitleConfig,
  summarizeSessionTitles,
  type AppConfig,
} from '../src/config/schema';

function cfg(sessionTitles?: NonNullable<AppConfig['preferences']>['sessionTitles']): AppConfig {
  return {
    accounts: { app: { id: 'cli_app', secret: 's', tenant: 'feishu' } },
    preferences: { sessionTitles },
  };
}

describe('session title config', () => {
  it('defaults all sessions to no model', () => {
    expect(getSessionTitleConfig(cfg())).toEqual({ enabled: false });
    expect(summarizeSessionTitleConfig(cfg())).toContain('截断首句');
    expect(summarizeSessionTitles(cfg())).toBe('截断首句');
  });

  it('resolves legacy choices consistently, preferring the Bot default provider', () => {
    const config = cfg({ byBackend: {
      'codex-appserver': { enabled: true, model: 'codex-title', effort: 'xhigh' },
      'claude-agent': { enabled: true, model: 'claude-title', effort: 'low' },
    } });
    expect(getSessionTitleConfig(config, 'claude-agent')).toEqual({ enabled: true, backend: 'codex-appserver', model: 'codex-title', effort: 'xhigh' });
    config.preferences!.defaults = { backend: 'claude-agent' };
    expect(getSessionTitleConfig(config, 'codex-appserver')).toEqual({ enabled: true, backend: 'claude-agent', model: 'claude-title', effort: 'low' });
    config.preferences!.sessionTitles!.byBackend!['claude-agent'] = { enabled: false };
    expect(getSessionTitleConfig(config).enabled && getSessionTitleConfig(config)).toMatchObject({ backend: 'codex-appserver' });
  });

  it('uses the global provider for every session and respects global disable over legacy enabled', () => {
    const config = cfg({ policy: { enabled: true, backend: 'claude-agent', model: 'title-model', effort: 'low' }, byBackend: { 'codex-appserver': { enabled: true, model: 'old', effort: 'high' } } });
    expect(getSessionTitleConfig(config, 'codex-appserver')).toEqual(config.preferences!.sessionTitles!.policy);
    config.preferences!.sessionTitles!.policy = { enabled: false };
    expect(getSessionTitleConfig(config)).toEqual({ enabled: false });
    config.preferences!.sessionTitles!.policy = { enabled: true, backend: 'claude-agent', model: 'title', effort: 'ultra' };
    expect(getSessionTitleConfig(config)).toEqual({ enabled: false });
  });

  it('treats incomplete or invalid enabled configs as disabled', () => {
    const incomplete = cfg({
      byBackend: {
        missingModel: { enabled: true, effort: 'low' } as never,
        missingEffort: { enabled: true, model: 'third-party/model' } as never,
        blankModel: { enabled: true, model: '   ', effort: 'high' },
        invalidEffort: { enabled: true, model: 'third-party/model', effort: 'turbo' } as never,
      },
    });
    for (const backend of ['missingModel', 'missingEffort', 'blankModel', 'invalidEffort']) {
      expect(getSessionTitleConfig(incomplete, backend)).toEqual({ enabled: false });
    }
  });

  it('limits Effort by host protocol without limiting third-party model ids', () => {
    expect(getSessionTitleEfforts('codex-appserver')).toEqual([
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    expect(getSessionTitleEfforts('claude-agent')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getSessionTitleConfig(cfg({
      byBackend: {
        'codex-appserver': { enabled: true, model: 'any-vendor/model', effort: 'ultra' },
      },
    }), 'codex-appserver')).toEqual({ enabled: true, backend: 'codex-appserver', model: 'any-vendor/model', effort: 'ultra' });
  });
});
