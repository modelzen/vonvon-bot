import { expect, it } from 'vitest';
import { ClaudeAgentBackend } from '../src/agent/claude-agent/backend';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { resolveSessionProfile, type SessionProfile } from '../src/agent/session-profile';

// T4b 4.1: a capability package passes only where the backend says it delivers one; MCP is still refused.
const packages: SessionProfile['capabilityPackages'] = [{ path: '/data/bots/app/capabilities/builtin/group', kind: 'builtin' }];
const profile: SessionProfile = { instructions: '', env: {}, nativeSettings: { automaticMemory: false }, additionalRoots: [], capabilityPackages: packages, mcpServers: [] };

it('passes a builtin package through as it came', () => {
  expect(resolveSessionProfile(profile, { additionalRoots: true, capabilityPackages: true }).capabilityPackages).toEqual(packages);
  expect(resolveSessionProfile({ ...profile, capabilityPackages: [] }, { additionalRoots: true, capabilityPackages: true }).capabilityPackages).toEqual([]);
});

it('refuses it as before where packages are not delivered', () => {
  for (const capabilities of [undefined, { additionalRoots: true }, { additionalRoots: true, capabilityPackages: false }]) {
    expect(() => resolveSessionProfile(profile, capabilities)).toThrow('额外根、能力包和 MCP profile 交付尚未支持（s39）');
  }
});

it('still refuses MCP servers', () => {
  expect(() => resolveSessionProfile({ ...profile, mcpServers: [{ name: 'fixture' }] }, { additionalRoots: true, capabilityPackages: true })).toThrow('s39');
});

it('has both backends deliver packages', () => {
  expect(new CodexAppServerBackend().profileCapabilities.capabilityPackages).toBe(true);
  expect(new ClaudeAgentBackend(async () => { throw new Error('unused'); }, () => undefined).profileCapabilities.capabilityPackages).toBe(true);
});
