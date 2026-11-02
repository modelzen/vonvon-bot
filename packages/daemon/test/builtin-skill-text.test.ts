import { describe, expect, it } from 'vitest';
import { FULL_ACCESS_WARNING } from '@vonvon/protocol';
import { feishuSkill } from '../src/agent/builtin-skills/feishu';
import { scheduledTasksSkill } from '../src/agent/builtin-skills/scheduled-tasks';
import { builtinSkillsOfSet } from '../src/agent/builtin-skills/registry';
import { SESSION_RULES } from '../src/agent/builtin-skills/session-rules';
import { settingsSkill } from '../src/agent/builtin-skills/settings';
import { NOT_DM_MESSAGE } from '../src/agent/entry/registry';
import { SESSION_ENV, SESSION_SCOPE_ENV, sessionScope, withoutSessionMarkers } from '../src/config/session-env';
import { skillCommands } from './helpers/skill-commands';

const requiredSentences = [
  "用户说定时、每天、每周、提醒、稍后、过一会，就用这里的工具。",
  "你自己要过一会再看（比如等一个构建、等一个回复），也用 `schedule_create` 给自己排一个一次性任务，不要在这一轮里等。",
  "先调 `schedule_list`，回复第一行是现在的时间和时区，按它算。",
  "一次性的用 `when: { kind: 'once', at: 'YYYY-MM-DD HH:mm' }` 或 `inMinutes`；不要自己算毫秒。",
  "用户说的时区和这里不一样，填 `timeZone`。",
  "'工作日'是 `weekly` 的 `days: [1,2,3,4,5]`；'每半小时'是 `every` 30。",
  "先 `schedule_list` 看有没有重名或重复的任务。",
  "建完在回复里说名字、时间和下一次运行时间。",
  "改和删要带 `revision`，从 `schedule_list` 里取。",
  "发到哪：默认跟群走；用户说'开个话题发'填 `where: 'newTopic'`，说'就在这个话题里发'填 `where: 'thisTopic'`。",
  "成员只能改自己建的；被拒了就把拒绝原因告诉用户，不要绕。",
  "没有人在场：不要提问，不要等人确认；能定的自己定，做不了的写出来。",
  "要再来一次，用 `schedule_edit` 改自己这个任务的时间；不能建新任务，不能改设置。",
  "不要用 Claude Code 的 CronCreate、ScheduleWakeup，也不要用 Codex 的自动化；这里关着，用了也不会跑。",
  "写清目标、输出形式、发到哪里，像给同事留便签。"
];

describe('scheduled tasks builtin skill', () => {
  it('retains the exact discovery description and identity', () => {
    expect(scheduledTasksSkill).toMatchObject({ name: 'scheduled-tasks', title: '任务', description: "创建、修改、暂停、删除本群的定时任务，或给自己排一个稍后回来看的一次性任务。用户提到定时、每天、每周、提醒、稍后、过一会再看时读本 skill。" });
    expect(scheduledTasksSkill.description).not.toMatch(/[\r\n]/);
    expect(scheduledTasksSkill.description.length).toBeLessThanOrEqual(200);
  });
  it('teaches every required rule in nine concise sections', () => {
    for (const sentence of requiredSentences) expect(scheduledTasksSkill.body).toContain(sentence);
    expect(scheduledTasksSkill.body.split('\n').length).toBeLessThanOrEqual(140);
    expect(scheduledTasksSkill.body.match(/^## /gm)).toHaveLength(9);
    const whenSection = scheduledTasksSkill.body.split('## 怎么写 when\n')[1]!.split('\n## 怎么调')[0]!;
    for (const kind of ['once', 'every', 'daily', 'weekly', 'cron']) {
      expect(whenSection).toContain(`kind: '${kind}'`);
    }
    expect(scheduledTasksSkill.body).toContain('省略 where 就是 `here`：在话题里建一次性任务默认回到这个话题，周期任务默认跟群走；要固定在这个话题用 `thisTopic`。');
    expect(scheduledTasksSkill.body).toContain('cron 只在用户自己给了表达式时用。');
  });
  it('contains no credentials, real chat identifiers or machine paths', () => {
    const text = JSON.stringify(scheduledTasksSkill);
    expect(text).not.toMatch(/(?:cli_|oc_|ou_)[a-zA-Z0-9]{8,}|sk-[a-zA-Z0-9]{12,}|-----BEGIN|群名|测试群|\/(?:home|Users)\//);
  });
  it('selects the complete group set', () => {
    expect(builtinSkillsOfSet('group')).toEqual([scheduledTasksSkill, feishuSkill]);
  });
});

// devices 9 / skills-scope: the three skills teach the command line as the tools' fallback under the same rules.
describe('the builtin skills and the command line', () => {
  const all = [scheduledTasksSkill, feishuSkill, settingsSkill];
  it('a private chat gets the Feishu skill and the settings one, a group never the settings one', () => {
    expect(builtinSkillsOfSet('dm')).toEqual([feishuSkill, settingsSkill]);
    expect(builtinSkillsOfSet('group')).not.toContain(settingsSkill);
  });
  it.each(all)('$name opens with the session rules: tools first, the scope copied, no settings in a group', skill => {
    expect(skill.body.startsWith(`${SESSION_RULES}\n\n## `)).toBe(true);
    expect(skill.body).toContain(`群里有人要改，就回"${NOT_DM_MESSAGE}"，不去试命令行。`);
    expect(skill.body).toContain('每条都带 `--scope "$VONVON_SCOPE"` 和 `--json`。');
    expect(skill.body).toContain('不要换更大的范围重试，也不要去掉 `--scope`。');
    expect(skill.body).toContain('在会话里一律被拒。不要替用户跑，告诉用户去那台设备上或桌面端里做');
  });
  it.each(all)('every `vonvon` line of $name carries the copied scope and --json', skill => {
    const lines = skillCommands(skill.body);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/ --scope "\$VONVON_SCOPE" --json$/);
  });
  it.each(all)('$name teaches none of what a session is refused', skill => {
    expect(skill.body).not.toMatch(/vonvon (?:secrets|remote|pair|update|service|daemon|clients|device|open|dir|memory|env|provider|mcp|import|bot |project workspace|group (?:bind|unbind))/);
    expect(skill.body).not.toMatch(/--folder|--host|--primary/);
  });
  it.each(all)('$name is safe to load: a one-line description, no shell injection, no real ids or paths', skill => {
    expect(skill.description).not.toMatch(/[\r\n]/);
    expect(skill.description.length).toBeLessThanOrEqual(200);
    expect(skill.body).not.toContain('!`');
    expect(skill.body).not.toMatch(/^(?:hooks|allowed-tools):/m);
    expect(JSON.stringify(skill)).not.toMatch(/(?:cli_|oc_|ou_)[a-zA-Z0-9]{8,}|sk-[a-zA-Z0-9]{12,}|-----BEGIN|测试群|\/(?:home|Users)\//);
  });
  it('the task skill keeps its tools and adds the group\'s command lines', () => {
    expect(scheduledTasksSkill.body).toContain('## 没有任务工具时');
    expect(skillCommands(scheduledTasksSkill.body).every(line => line.startsWith('vonvon schedule ') && line.includes(' --group <chatId> '))).toBe(true);
  });
  it('the Feishu skill only reads', () => {
    expect(skillCommands(feishuSkill.body).every(line => / (?:groups|members|show|list|get) /.test(line))).toBe(true);
    expect(feishuSkill.body).toContain(`- "${NOT_DM_MESSAGE}"：原话告诉用户。`);
  });
  it('the settings skill says what changed: before → after and when it applies', () => {
    expect(settingsSkill.body).toContain('改完在回复里说清：改了哪个范围（整个 Bot，还是哪个群）、改前 → 改后、什么时候生效。');
    expect(settingsSkill.body).toContain('生效时机照改完回的 `effects` 里的 `detail` 写，不自己猜。');
    expect(settingsSkill.body).toContain('"已把「支付组」的权限从「工作区可写」改成「只读」，下一轮生效。"');
    expect(settingsSkill.body).toContain(FULL_ACCESS_WARNING);
    expect(settingsSkill.body).toContain('加、去掉本机管理员，只有主人那一轮能改。');
  });
});

describe('the session scope variable', () => {
  it('names a group session\'s group and nothing past a private chat\'s Bot', () => {
    expect(sessionScope('cli_app', 'oc_chat')).toBe('bot=cli_app,group=oc_chat');
    expect(sessionScope('cli_app')).toBe('bot=cli_app');
  });
  it('is left behind with the token when vonvon starts its own processes', () => {
    expect(withoutSessionMarkers({ [SESSION_ENV]: 'vs1.x', [SESSION_SCOPE_ENV]: 'bot=a', PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });
});
