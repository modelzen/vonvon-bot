import { describe, expect, it } from 'vitest';
import { scheduledTasksSkill } from '../src/agent/builtin-skills/scheduled-tasks';
import { builtinSkillsOfSet } from '../src/agent/builtin-skills/registry';

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
  it('teaches every required rule in eight concise sections', () => {
    for (const sentence of requiredSentences) expect(scheduledTasksSkill.body).toContain(sentence);
    expect(scheduledTasksSkill.body.split('\n').length).toBeLessThanOrEqual(140);
    expect(scheduledTasksSkill.body.match(/^## /gm)).toHaveLength(8);
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
    expect(builtinSkillsOfSet('group')).toEqual([scheduledTasksSkill]);
  });
});
