import {describe, expect, it} from 'vitest';
import {codexAccountMetadata} from '../src/agent/codex-appserver/login';
import {environmentReplySchema} from '@vonvon/protocol';

describe('safe Codex account metadata', () => {
  it('distinguishes paid, free, API and unknown without copying identity or credentials', () => {
    expect(codexAccountMetadata({type: 'chatgpt', planType: 'plus', email: 'private@example.com', token: 'secret'})).toEqual({kind: 'subscription', planType: 'plus', apiProvider: 'chatgpt'});
    expect(codexAccountMetadata({type: 'chatgpt', planType: 'free'})).toEqual({kind: 'free', planType: 'free', apiProvider: 'chatgpt'});
    expect(codexAccountMetadata({type: 'apiKey', key: 'secret'})).toEqual({kind: 'api', apiProvider: 'openai'});
    expect(codexAccountMetadata({type: 'amazonBedrock'})).toEqual({kind: 'api', apiProvider: 'amazonBedrock'});
    expect(codexAccountMetadata({type: 'chatgpt', planType: 'future'})).toMatchObject({kind: 'unknown'});
    expect(codexAccountMetadata({type: 'chatgpt', planType: 'self_serve_business_usage_based'})).toMatchObject({kind: 'unknown'});
    expect(codexAccountMetadata(null)).toBeUndefined();
    expect(codexAccountMetadata('bad')).toBeUndefined();
  });
  it('keeps optional metadata through the existing environment reply and strips unknown fields', () => {
    expect(environmentReplySchema.parse({kind: 'backendLogin', id: 'codex-appserver', state: 'signedIn', message: 'ok', account: {kind: 'subscription', planType: 'plus', email: 'private@example.com'}})).toEqual({kind: 'backendLogin', id: 'codex-appserver', state: 'signedIn', message: 'ok', account: {kind: 'subscription', planType: 'plus'}});
    expect(environmentReplySchema.safeParse({kind: 'backendLogin', id: 'codex-appserver', state: 'signedIn', message: 'old daemon'}).success).toBe(true);
  });
});
