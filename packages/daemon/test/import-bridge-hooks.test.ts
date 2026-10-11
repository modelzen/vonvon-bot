import { describe, expect, it } from 'vitest';
import { convertBridgeHooks, type HookConversionOptions } from '../src/import/bridge/hooks';

const posix: HookConversionOptions = {
  platform: 'posix',
  legacyNodeCommands: [{ node: '/old Node/bin/node', script: '/old bridge/cli.js' }],
  target: { node: '/new Node/bin/node', script: '/vonvon bot/bin/cli.js' },
};

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}

describe('Bridge Hook conversion', () => {
  const windows: HookConversionOptions = {
    platform: 'win32',
    legacyNodeCommands: [{ node: 'C:\\Old Node\\node.exe', script: 'C:\\Old Bridge\\cli.js' }],
    target: { node: 'D:\\Vonvon Bot\\node.exe', script: 'D:\\Vonvon Bot\\cli.js' },
  };

  for (const options of [posix, windows]) {
    const pair = options.legacyNodeCommands[0]!;
    const target = `"${options.target.node}" "${options.target.script}"`;
    const overlap: HookConversionOptions = { ...options, legacyNodeCommands: [options.target] };

    it(`reports zero changes on a second same-path conversion on ${options.platform}`, () => {
      const source = { hooks: { Stop: [{ hooks: [
        { command: 'feishu-codex-bridge hook --agent claude' },
        { command: 'feishu-codex-bridge hook --bot bot_9 --agent codex' },
      ] }] } };
      const expected = { hooks: { Stop: [{ hooks: [
        { command: `${target} hook --agent claude` },
        { command: `${target} hook --bot bot_9 --agent codex` },
      ] }] } };
      const original = structuredClone(source);
      freezeDeep(source);
      const first = convertBridgeHooks(source, overlap);
      expect(first).toEqual({ kind: 'converted', value: expected, rewrittenCount: 2 });
      expect(source).toEqual(original);
      if (first.kind !== 'converted') throw new Error('expected converted result');
      freezeDeep(first.value);
      expect(convertBridgeHooks(first.value, overlap)).toEqual({ kind: 'unchanged', value: expected, rewrittenCount: 0 });
    });

    it(`preserves an already generated owned command on ${options.platform}`, () => {
      const source = { hooks: { Stop: [{ hooks: [
        { command: `${target} hook --bot bot_9 --agent codex`, timeout: 5 },
      ] }] } };
      const original = structuredClone(source);
      freezeDeep(source);
      expect(convertBridgeHooks(source, overlap)).toEqual({ kind: 'unchanged', value: original, rewrittenCount: 0 });
      expect(source).toEqual(original);
    });

    it(`counts only changed commands in a same-path mixed document on ${options.platform}`, () => {
      const source = { extra: ['keep'], hooks: { Stop: [{ hooks: [
        { command: `${target} hook --bot bot_9 --agent codex`, timeout: 5 },
        { command: 'feishu-codex-bridge hook --agent claude' },
      ] }] } };
      const expected = { extra: ['keep'], hooks: { Stop: [{ hooks: [
        { command: `${target} hook --bot bot_9 --agent codex`, timeout: 5 },
        { command: `${target} hook --agent claude` },
      ] }] } };
      const original = structuredClone(source);
      freezeDeep(source);
      expect(convertBridgeHooks(source, overlap)).toEqual({ kind: 'converted', value: expected, rewrittenCount: 1 });
      expect(source).toEqual(original);
    });

    it(`refuses a late ambiguous same-path command atomically on ${options.platform}`, () => {
      const source = { hooks: { Stop: [{ hooks: [
        { command: `${target} hook --bot bot_9 --agent codex` },
        { command: 'feishu-codex-bridge hook --agent claude' },
        { command: `${target} hook --agent codex && echo unsafe` },
      ] }] } };
      const original = structuredClone(source);
      freezeDeep(source);
      expect(convertBridgeHooks(source, overlap)).toEqual({
        kind: 'refused', reason: 'ambiguous-legacy-command',
        location: { event: 'Stop', groupIndex: 0, hookIndex: 2 },
      });
      expect(source).toEqual(original);
    });

    for (const base of ['feishu-codex-bridge', `"${pair.node}" "${pair.script}"`]) {
      it.each(['  ', '\t', ' \t '])(`accepts ASCII separators on ${options.platform} after ${base}: %j`, (space) => {
        const source = { extra: { keep: [true, null] }, hooks: { Stop: [{ matcher: '*', hooks: [
          { type: 'command', command: `${base}${space}hook${space}--bot${space}"bot_9"${space}--agent${space}codex`, timeout: 5 },
          { command: `${base}-custom${space}hook --agent claude` },
          { command: `${base}${space}hooks --agent claude` },
          { command: `${base}${space}hook --agent claude agent2lark-hook` },
        ] }] } };
        const expected = { extra: { keep: [true, null] }, hooks: { Stop: [{ matcher: '*', hooks: [
          { type: 'command', command: `${target} hook --bot bot_9 --agent codex`, timeout: 5 },
          { command: `${base}-custom${space}hook --agent claude` },
          { command: `${base}${space}hooks --agent claude` },
          { command: `${base}${space}hook --agent claude agent2lark-hook` },
        ] }] } };
        const original = structuredClone(source);
        freezeDeep(source);
        const result = convertBridgeHooks(source, options);
        expect(result).toEqual({ kind: 'converted', value: expected, rewrittenCount: 1 });
        expect(source).toEqual(original);
        if (result.kind !== 'converted') throw new Error('expected converted result');
        expect(convertBridgeHooks(result.value, options)).toEqual({ kind: 'unchanged', value: expected, rewrittenCount: 0 });
      });

      it.each(['  ', '\t', ' \t '])(`refuses malformed owned tails atomically on ${options.platform} after ${base}: %j`, (space) => {
        const source = { hooks: { Stop: [{ hooks: [
          { command: 'feishu-codex-bridge hook --agent claude' },
          { command: `${base}${space}hook --agent codex && echo unsafe` },
        ] }] } };
        const original = structuredClone(source);
        freezeDeep(source);
        expect(convertBridgeHooks(source, options)).toEqual({
          kind: 'refused', reason: 'ambiguous-legacy-command',
          location: { event: 'Stop', groupIndex: 0, hookIndex: 1 },
        });
        expect(source).toEqual(original);
      });

      it(`permits single-quoted bot IDs only on POSIX after ${base}`, () => {
        const source = { hooks: { Stop: [{ hooks: [
          { command: 'feishu-codex-bridge hook --agent claude' },
          { command: `${base} hook --bot 'bot_9' --agent codex` },
        ] }] } };
        const original = structuredClone(source);
        freezeDeep(source);
        expect(convertBridgeHooks(source, options)).toEqual(options.platform === 'posix' ? {
          kind: 'converted', rewrittenCount: 2,
          value: { hooks: { Stop: [{ hooks: [
            { command: `${target} hook --agent claude` },
            { command: `${target} hook --bot bot_9 --agent codex` },
          ] }] } },
        } : {
          kind: 'refused', reason: 'ambiguous-legacy-command',
          location: { event: 'Stop', groupIndex: 0, hookIndex: 1 },
        });
        expect(source).toEqual(original);
      });
    }
  }

  it('rewrites only owned commands across all events and preserves every other parsed field', () => {
    const source = {
      statusLine: { type: 'command', command: 'keep status', padding: [1, null, true] },
      hooks: {
        PermissionRequest: [{ matcher: '*', extra: { present: true }, hooks: [
          { type: 'command', command: 'feishu-codex-bridge hook --agent claude', timeout: 86400, id: 'first' },
          { type: 'command', command: '"/old Node/bin/node" "/old bridge/cli.js" hook --bot "cli_beta" --agent codex', extra: ['x'] },
          { type: 'command', command: 'echo feishu-codex-bridge hook --agent claude' },
          { type: 'command', command: 'agent2lark-hook hook --agent claude' },
          { type: 'prompt', command: 'feishu-codex-bridge hook --agent claude' },
        ] }],
        Custom: [{ hooks: [
          { command: "feishu-codex-bridge hook --bot 'bot_2' --agent codex" },
          { command: '"/other/node" "/old bridge/custom.js" hook --agent claude' },
          { command: '"/old Node/bin/node" "/old bridge/custom.js" hook --agent claude' },
        ] }],
      },
    };
    const expected = {
      ...source,
      hooks: {
        PermissionRequest: [{ ...source.hooks.PermissionRequest[0], hooks: [
          { type: 'command', command: '"/new Node/bin/node" "/vonvon bot/bin/cli.js" hook --agent claude', timeout: 86400, id: 'first' },
          { type: 'command', command: '"/new Node/bin/node" "/vonvon bot/bin/cli.js" hook --bot cli_beta --agent codex', extra: ['x'] },
          ...source.hooks.PermissionRequest[0]!.hooks.slice(2),
        ] }],
        Custom: [{ hooks: [
          { command: '"/new Node/bin/node" "/vonvon bot/bin/cli.js" hook --bot bot_2 --agent codex' },
          ...source.hooks.Custom[0]!.hooks.slice(1),
        ] }],
      },
    };
    freezeDeep(source);
    const result = convertBridgeHooks(source, posix);
    expect(result).toEqual({ kind: 'converted', value: expected, rewrittenCount: 3 });
    expect(source.hooks.PermissionRequest[0]!.hooks[0]!.command).toBe('feishu-codex-bridge hook --agent claude');
    if (result.kind !== 'converted') throw new Error('expected converted result');
    expect(convertBridgeHooks(result.value, posix)).toEqual({ kind: 'unchanged', value: expected, rewrittenCount: 0 });
  });

  it.each([
    'echo feishu-codex-bridge hook --agent claude',
    'wrapper feishu-codex-bridge hook --agent codex',
    '"/old Node/bin/node" "/old bridge/feishu-codex-bridge/custom.js" hook --agent claude',
    '"/old Node/bin/node" "/old bridge/custom.js" hook --agent claude',
    '/tmp/not-feishu-codex-bridge hook --agent claude',
    'feishu-codex-bridge hooks --agent claude',
    'agent2lark-hook feishu-codex-bridge hook --agent claude',
  ])('preserves unrelated command %s', (command) => {
    const source = { hooks: { Stop: [{ hooks: [{ command }] }] } };
    expect(convertBridgeHooks(source, posix)).toEqual({ kind: 'unchanged', value: source, rewrittenCount: 0 });
  });

  it.each([
    'feishu-codex-bridge hook',
    'feishu-codex-bridge hook --agent claude --agent codex',
    'feishu-codex-bridge hook --bot=bot --agent claude',
    'feishu-codex-bridge hook --bot bad.name --agent claude',
    'feishu-codex-bridge hook --agent other',
    'feishu-codex-bridge hook --agent claude; echo unsafe',
    '"/old Node/bin/node" "/old bridge/cli.js" hook --agent codex && echo unsafe',
  ])('refuses ambiguous owned command without partial output: %s', (command) => {
    const source = { hooks: { Stop: [{ hooks: [
      { command: 'feishu-codex-bridge hook --agent claude' },
      { command },
    ] }] } };
    expect(convertBridgeHooks(source, posix)).toEqual({
      kind: 'refused', reason: 'ambiguous-legacy-command',
      location: { event: 'Stop', groupIndex: 0, hookIndex: 1 },
    });
  });

  it.each([
    [null, []],
    [{ hooks: { Stop: {} } }, ['hooks', 'Stop']],
    [{ hooks: { Stop: [{ hooks: [null] }] } }, ['hooks', 'Stop', 0, 'hooks', 0]],
    [{ hooks: { Stop: [{ hooks: [{ command: 5 }] }] } }, ['hooks', 'Stop', 0, 'hooks', 0, 'command']],
    [{ hooks: { Stop: [{ hooks: [{ timeout: null }] }] } }, ['hooks', 'Stop', 0, 'hooks', 0, 'timeout']],
    [{ hooks: { Stop: [{ hooks: [{ command: 'feishu-codex-bridge hook --agent claude' }] }, { hooks: false }] } }, ['hooks', 'Stop', 1, 'hooks']],
  ])('refuses invalid JSON or Hook nesting at the concrete path', (source, path) => {
    expect(convertBridgeHooks(source, posix)).toEqual({ kind: 'refused', reason: 'invalid-json-shape', path });
  });

  it('refuses cyclic and non-JSON extension data', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(convertBridgeHooks(cycle, posix)).toEqual({ kind: 'refused', reason: 'invalid-json-shape', path: ['self'] });
    expect(convertBridgeHooks({ extra: undefined }, posix)).toEqual({ kind: 'refused', reason: 'invalid-json-shape', path: ['extra'] });
    expect(convertBridgeHooks({ extra: new Array(1) }, posix)).toEqual({ kind: 'refused', reason: 'invalid-json-shape', path: ['extra', 0] });
  });

  it('builds representable Windows strings, preserving explicit bot and agent', () => {
    const windows: HookConversionOptions = {
      platform: 'win32',
      legacyNodeCommands: [{ node: 'C:\\Old Node\\node.exe', script: 'C:\\Old Bridge\\cli.js' }],
      target: { node: 'D:\\Vonvon Bot\\node.exe', script: 'D:\\Vonvon Bot\\cli.js' },
    };
    const source = { hooks: { Stop: [{ hooks: [{ command: '"C:\\Old Node\\node.exe" "C:\\Old Bridge\\cli.js" hook --bot bot_9 --agent codex' }] }] } };
    expect(convertBridgeHooks(source, windows)).toEqual({
      kind: 'converted', rewrittenCount: 1,
      value: { hooks: { Stop: [{ hooks: [{ command: '"D:\\Vonvon Bot\\node.exe" "D:\\Vonvon Bot\\cli.js" hook --bot bot_9 --agent codex' }] }] } },
    });
  });

  it.each([
    ['posix', '/new/$HOME/node', '/new/cli.js'],
    ['posix', '/new/node', '/new/"cli.js'],
    ['posix', '/new/node', '/new/cli\n.js'],
    ['win32', 'C:\\New%Name\\node.exe', 'C:\\New\\cli.js'],
    ['win32', 'C:\\New!Name\\node.exe', 'C:\\New\\cli.js'],
    ['win32', 'C:\\New\\node.exe', 'relative\\cli.js'],
  ] as const)('refuses unsupported target path characters on %s', (platform, node, script) => {
    expect(convertBridgeHooks({}, { platform, legacyNodeCommands: [], target: { node, script } })).toEqual({
      kind: 'refused', reason: 'invalid-command-path', path: ['target'],
    });
  });
});
