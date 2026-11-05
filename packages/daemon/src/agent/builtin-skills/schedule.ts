import type { BuiltinSkill } from './package';

/**
 * product.md 3.6 / 3.13: the task skill, `vonvon-schedule` (s1b, owner 2026-11-02: "定时任务就叫 schedule"; before s1b
 * `scheduled-tasks`, titled 任务). The description is all a model reads before it decides to open it, so it lists what
 * people say (s1b's trigger test, test/manual/skill-trigger-eval.ts). A private chat has its own text under the same
 * name (dm-agent 8): its tasks stay in the chat and its timed turns are not limited, and a group's text teaches no
 * command line (settings-dm-only). What the two share is below.
 */
const WHEN = `## 什么时候用
用户说定时、每天、每周、提醒、稍后、过一会，就用这里的工具。
你自己要过一会再看（比如等一个构建、等一个回复），也用 \`schedule_create\` 给自己排一个一次性任务，不要在这一轮里等。

## 时间换算
先调 \`schedule_list\`，回复第一行是现在的时间和时区，按它算。
一次性的用 \`when: { kind: 'once', at: 'YYYY-MM-DD HH:mm' }\` 或 \`inMinutes\`；不要自己算毫秒。
用户说的时区和这里不一样，填 \`timeZone\`。
'工作日'是 \`weekly\` 的 \`days: [1,2,3,4,5]\`；'每半小时'是 \`every\` 30。

## 怎么写 when
- 一次：\`when: { kind: 'once', inMinutes: 10 }\`。
- 间隔：\`when: { kind: 'every', minutes: 30 }\`。
- 每天：\`when: { kind: 'daily', time: '09:00' }\`。
- 每周：\`when: { kind: 'weekly', days: [1,2,3,4,5], time: '09:00' }\`。
- 表达式：\`when: { kind: 'cron', expr: '0 9 * * 1-5' }\`。
cron 只在用户自己给了表达式时用。

## 怎么调
先 \`schedule_list\` 看有没有重名或重复的任务。
建完在回复里说名字、时间和下一次运行时间。
暂停用 \`schedule_pause\`，恢复用 \`schedule_resume\`，删除用 \`schedule_delete\`，立即运行一次用 \`schedule_run_now\`。
改和删要带 \`revision\`，从 \`schedule_list\` 里取。`;

const UNATTENDED = `## 在定时回合里
没有人在场：不要提问，不要等人确认；能定的自己定，做不了的写出来。`;

const CLOSING = `## 不用两家自带的定时
不要用 Claude Code 的 CronCreate、ScheduleWakeup，也不要用 Codex 的自动化；这里关着，用了也不会跑。

## 任务内容写给未来的自己看
写清目标、输出形式、发到哪里，像给同事留便签。`;

export const scheduleSkill: BuiltinSkill = {
  name: 'vonvon-schedule',
  title: '定时任务',
  description: "创建、查看、修改、暂停、恢复、删除本群的定时任务，或者给自己排一个稍后回来接着做的一次性任务。用户说到定时、每天/每周/每月/工作日几点、每隔多久、明天几点、提醒我、到时候叫我、稍后/过一会/20 分钟后再看、定期发日报周报、cron，或者问本群有哪些定时任务时，先读本 skill；你自己要等一件事过一阵再回来看时也读。",
  body: `${WHEN}
发到哪：默认跟群走；用户说'开个话题发'填 \`where: 'newTopic'\`，说'就在这个话题里发'填 \`where: 'thisTopic'\`。

省略 where 就是 \`here\`：在话题里建一次性任务默认回到这个话题，周期任务默认跟群走；要固定在这个话题用 \`thisTopic\`。

## 谁能改
成员只能改自己建的；被拒了就把拒绝原因告诉用户，不要绕。

${UNATTENDED}
要再来一次，用 \`schedule_edit\` 改自己这个任务的时间；不能建新任务，不能改设置。

${CLOSING}`,
};

export const dmScheduleSkill: BuiltinSkill = {
  ...scheduleSkill,
  description: "创建、查看、修改、暂停、恢复、删除这个私聊和各个群的定时任务，或者给自己排一个稍后回来接着做的一次性任务。用户说到定时、每天/每周/每月/工作日几点、每隔多久、明天几点、提醒我、到时候叫我、稍后/过一会/20 分钟后再看、定期发日报周报、cron，或者问有哪些定时任务时，先读本 skill；你自己要等一件事过一阵再回来看时也读。",
  body: `${WHEN}
这些工具管的是这个私聊的任务：任务建在这里，到点在这里跑，结果发在这里。私聊没有话题，不用填 \`where\`。

## 给群建任务
用命令行：\`vonvon schedule add --bot B --group X --name 日报 --daily 09:00 "汇总昨天的讨论"\`。\`--bot\` 不写就是这个 Bot，别的 Bot 的群要写。时间的写法看 \`vonvon schedule add --help\`。
建好就是普通的群任务：发在群里，按群的权限档跑，群里的规矩照旧。
看和改群的任务也用命令行：\`vonvon schedule list --group X\`，\`vonvon schedule list --all\` 列这个 Bot 所有的群和私聊的任务，其余看 \`vonvon schedule --help\`。

${UNATTENDED}
这个私聊的任务和人在场时一样：能建新任务，能改别的任务，能读能改设置。

${CLOSING}`,
};
