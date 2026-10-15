import { describe, expect, it } from 'vitest';
import { errorKindFromText } from '../src/agent/error-kind';

describe('errorKindFromText', () => {
  it.each([
    ['fetch failed', 'network'],
    ['API Error: Connection error.', 'network'],
    ['Request timed out.', 'network'],
    ['stream disconnected before completion', 'network'],
    ['API Error: 529 {"type":"overloaded_error"}', 'network'],
    ['503 Service Unavailable', 'network'],
    ['401 Unauthorized', 'auth'],
    ['Not logged in · Please run /login', 'auth'],
    ['429 Too Many Requests', 'quota'],
    ["You've hit your usage limit", 'quota'],
    ["The 'gpt-6-luna' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.", 'version'],
    ['boom', undefined],
  ])('%s → %s', (message, kind) => {
    expect(errorKindFromText(message)).toBe(kind);
  });
});
