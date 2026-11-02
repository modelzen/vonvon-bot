import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { feishuSkill } from '../src/agent/builtin-skills/feishu';
import { scheduledTasksSkill } from '../src/agent/builtin-skills/scheduled-tasks';
import { settingsSkill } from '../src/agent/builtin-skills/settings';
import { loadLocalOnly, loadProgram } from './helpers/cli-commands';
import { shellWords, skillCommands } from './helpers/skill-commands';

// skills-scope: every `vonvon …` line a builtin skill teaches is a command the real CLI parses, with its arguments and
// required options, and none the session refuses outright. test/manual/skills-probe.ts runs them against a daemon.
const lines = [scheduledTasksSkill, feishuSkill, settingsSkill].flatMap(skill => skillCommands(skill.body).map(line => [skill.name, line] as const));

/** The command a line names, and the words after its path, `--scope <spec>` (the program's own option) taken out. */
function resolve(program: Command, line: string): { path: string; leaf: Command; rest: string[] } {
  const words = shellWords(line);
  expect(words[0]).toBe('vonvon');
  let leaf = program, at = 1;
  for (;;) {
    const next = leaf.commands.find(command => command.name() === words[at] || command.aliases().includes(words[at]!));
    if (!next) break;
    leaf = next; at++;
  }
  const rest = words.slice(at);
  const scope = rest.indexOf('--scope');
  expect(scope, `${line}: --scope`).toBeGreaterThanOrEqual(0);
  expect(rest[scope + 1]).toBe('$VONVON_SCOPE');
  rest.splice(scope, 2);
  return { path: words.slice(1, at).join(' '), leaf, rest };
}

describe('the builtin skills\' command lines', () => {
  it('teaches some of each skill', () => {
    expect(new Set(lines.map(([name]) => name))).toEqual(new Set(['scheduled-tasks', 'feishu', 'settings']));
  });
  it.each(lines)('%s: %s', async (_name, line) => {
    const program = await loadProgram();
    const { path, leaf, rest } = resolve(program, line);
    expect(leaf.commands, `${line} names a command, not a group of them`).toEqual([]);
    expect(await loadLocalOnly()).not.toContain(path);
    const { operands, unknown } = leaf.parseOptions(rest);
    expect(unknown, `${line}: options the command does not have`).toEqual([]);
    const args = leaf.registeredArguments;
    expect(operands.length).toBeGreaterThanOrEqual(args.filter(arg => arg.required).length);
    if (!args.some(arg => arg.variadic)) expect(operands.length).toBeLessThanOrEqual(args.length);
    for (const option of leaf.options.filter(option => option.mandatory)) {
      expect(rest.some(word => word === option.long || word === option.short), `${line}: ${option.flags}`).toBe(true);
    }
    expect(rest).toContain('--json');
  });
});
