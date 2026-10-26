import { describe, expect, it } from 'vitest';
import { findSecretShape, looksLikeSecret } from '../src/bot/memory-secret-shape';

/** Pseudo-random base62, seeded so a failure repeats; a periodic string would not look like a key. */
const part = (length: number, seed = 12345): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let state = seed;
  return Array.from({ length }, () => { state = (state * 1103515245 + 12345) % 2147483648; return alphabet[(state >>> 8) % alphabet.length]; }).join('');
};

describe('secret shapes', () => {
  const samples: Record<string, string> = {
    'openai-key': `用这个 key：sk-proj-${part(40)}`,
    'anthropic-key': `sk-ant-api03-${part(40)}`,
    'github-token': `ghp_${part(36)}`,
    'github fine-grained': `github_pat_${part(40)}`,
    'slack-token': 'xoxb-1234567890-abcdefghij',
    'aws-key-id': 'AKIAIOSFODNN7EXAMPLE',
    'google-api-key': `AIzaSy${part(33)}`,
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'private key': '-----BEGIN RSA PRIVATE KEY-----\nMIIEow',
    'private key (no algorithm)': '-----BEGIN PRIVATE KEY-----',
    'feishu app secret': 'app secret 是 dKq3VnZb8LmXw2RtYp6HcJa9SfGe4UoN',
    'long mixed token': `token=${part(48)}`,
  };
  for (const [name, text] of Object.entries(samples)) {
    it(`rejects ${name}`, () => { expect(looksLikeSecret(text), text).toBe(true); });
  }

  it('lets a path, a commit id, a slug and plain sentences through', () => {
    for (const text of [
      '日志放在 /var/log/pay 下',
      '/var/log/pay',
      '发版 commit 3f2a9c1d4e5b6a7980c1d2e3f4a5b6c7d8e9f0a1 已上线',
      '部署用 deploy-config-staging-us-west-2-region-primary 这套配置',
      '周四发版，发版前先在测试群里跑一遍回归',
      '请先写结论，再写过程。',
      'task-force 和 desk-lamp 都是普通词',
      'The quick brown fox jumps over the lazy dog and keeps running',
      'PaymentGatewayConfigurationManagerFactory 是个类名',
      '版本 v1.2.3，端口 8080',
    ]) expect(findSecretShape(text), text).toBeUndefined();
  });
});
