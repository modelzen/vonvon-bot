import { describe, expect, it } from 'vitest';
import { RUNTIME_TERMINAL_ICON } from '../src/card/runtime-card-icons';
import { statusSymbol } from '../src/card/process-status';
import { toolPresentation } from '../src/card/tool-presentation';

describe('toolPresentation', () => {
  it.each([
    ['running', "<font color='grey'>运行命令</font>"],
    ['done', "<font color='grey'>运行命令</font>"],
    ['error', "<font color='grey'>运行命令</font> <font color='red'>×</font>"],
  ] as const)('keeps a generic %s command out of its semantic heading', (status, header) => {
    const command = 'npm test -- --runInBand';

    const presentation = toolPresentation({ title: command, kind: 'command', status });
    expect(presentation).toEqual(expect.objectContaining({
      icon: RUNTIME_TERMINAL_ICON,
      action: '运行命令',
      label: '运行命令',
      command,
      header,
    }));
    expect(presentation).not.toHaveProperty('preview');
    expect(presentation.header).not.toContain(command);
  });

  it.each([
    ["sed -n '1,240p' /Users/clay/.agents/skills/agent-reach/SKILL.md", 'setting-inter_outlined', "<font color='grey'>读取 agent-reach 技能</font>"],
    ["sed -n '1,240p' '/tmp/a file.txt'", 'wiki-book_outlined', "<font color='grey'>读取 a file.txt</font>"],
    ['head -n 20 -- "/tmp/notes one.md"', 'wiki-book_outlined', "<font color='grey'>读取 notes one.md</font>"],
  ])('recognizes a simple read without repeating its command: %s', (command, icon, header) => {
    const presentation = toolPresentation({ title: command, kind: 'command', status: 'done' });

    expect(presentation).toEqual(expect.objectContaining({ icon, header, command }));
    expect(presentation.header).not.toContain(command);
  });

  it('recognizes a quoted zsh-wrapped Exa search and keeps the exact command for details', () => {
    const command = '/bin/zsh -lc "mcporter call exa.web_search_exa query=\\\"OpenAI 3 PM\\\" numResults=10"';

    const presentation = toolPresentation({ title: command, kind: 'command', status: 'done' });

    expect(presentation).toEqual(expect.objectContaining({
      icon: 'search_outlined',
      action: '搜索网页',
      subject: 'OpenAI 3 PM',
      header: "<font color='grey'>搜索网页 OpenAI 3 PM</font>",
      command,
    }));
    expect(presentation.header).not.toContain('mcporter');
  });

  it('uses the integration name for other simple mcporter calls', () => {
    const command = 'mcporter call lark.drive_search query=notes';

    expect(toolPresentation({ title: command, kind: 'command', status: 'running' })).toEqual(expect.objectContaining({
      icon: 'plugin_outlined',
      action: '使用',
      subject: 'lark 集成',
      header: "<font color='grey'>使用 lark 集成</font>",
      command,
    }));
  });

  it.each([
    'cat /tmp/a | sed -n 1p',
    'cat /tmp/a && echo changed',
    'ls\nrm -rf /tmp/stale',
    'sed -i 1d /tmp/a',
    'find /tmp -name stale -delete',
    '/bin/zsh -lc "cat /tmp/a; echo changed"',
    'mcporter call exa.web_search_exa query=$(cat /tmp/query)',
  ])('does not claim semantics for compound, scripted, or mutating commands: %s', (command) => {
    expect(toolPresentation({ title: command, kind: 'command', status: 'done' })).toEqual(expect.objectContaining({
      icon: RUNTIME_TERMINAL_ICON,
      action: '运行命令',
      header: "<font color='grey'>运行命令</font>",
      command,
    }));
  });

  it('allows shell metacharacters inside a quoted search query', () => {
    const command = "mcporter call exa.web_search_exa 'query=OpenAI | Anthropic'";

    expect(toolPresentation({ title: command, kind: 'command', status: 'done' })).toEqual(expect.objectContaining({
      icon: 'search_outlined',
      header: "<font color='grey'>搜索网页 OpenAI | Anthropic</font>",
      command,
    }));
  });

  it('preserves leading and trailing whitespace in shell arguments', () => {
    const command = '  printf "ok"  \n';
    expect(toolPresentation({ title: 'exec_command', kind: 'tool', status: 'done',
      detail: JSON.stringify({ cmd: command }) }).command).toBe(command);
  });
});

it('omits routine state marks and keeps colored marks for attention states', () => {
  expect(['running', 'completed', 'failed', 'stopped', 'waiting', 'unknown'].map(status =>
    statusSymbol(status as Parameters<typeof statusSymbol>[0]))).toEqual([
    '', '', "<font color='red'>×</font>",
    "<font color='grey'>□</font>", "<font color='orange'>Ⅱ</font>", "<font color='orange'>!</font>",
  ]);
});
