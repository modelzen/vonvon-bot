import { expect, it } from 'vitest';
import type { Tool, ToolState } from '@vonvon/protocol';
import { availableJoinTools } from '../src/JoinGroupDialog';

const state = (tool: Tool, installation: ToolState['installation']): ToolState => ({
  tool, installation, authentication: 'unknown', version: null,
});

it('offers Codex and installed execution tools, excluding missing or unknown installs', () => {
  expect(availableJoinTools([
    state('claude', 'installed'),
    state('copilot', 'missing'),
    state('opencode', 'installed'),
    state('pi', 'unknown'),
    state('acp', 'installed'),
  ])).toEqual(['codex', 'claude', 'opencode', 'acp']);
  expect(availableJoinTools([])).toEqual(['codex']);
});
