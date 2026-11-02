import type { BuiltinSkill } from './package';
import { SESSION_RULES } from './session-rules';

export const scheduledTasksSkill: BuiltinSkill = {
  name: 'scheduled-tasks',
  title: '任务',
  description: "创建、修改、暂停、删除本群的定时任务，或给自己排一个稍后回来看的一次性任务。用户提到定时、每天、每周、提醒、稍后、过一会再看时读本 skill。",
  body: `${SESSION_RULES}

## 什么时候用
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
改和删要带 \`revision\`，从 \`schedule_list\` 里取。
发到哪：默认跟群走；用户说'开个话题发'填 \`where: 'newTopic'\`，说'就在这个话题里发'填 \`where: 'thisTopic'\`。

省略 where 就是 \`here\`：在话题里建一次性任务默认回到这个话题，周期任务默认跟群走；要固定在这个话题用 \`thisTopic\`。

## 没有任务工具时
没有 \`schedule_*\` 工具、shell 里又能跑 \`vonvon\` 时，用命令行，规则和工具一样。先 \`echo "$VONVON_SCOPE"\`，\`group=\` 后面那段是本群的群 id，下面写成 \`<chatId>\`：
\`\`\`
vonvon schedule list --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon schedule add "<任务内容>" --name <名字> --daily 09:00 --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon schedule edit <taskId> --revision <revision> --weekly mon,tue,wed,thu,fri@09:00 --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon schedule edit <taskId> --revision <revision> --new-topic --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon schedule pause <taskId> --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon schedule resume <taskId> --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon schedule run <taskId> --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon schedule delete <taskId> --revision <revision> --group <chatId> --scope "$VONVON_SCOPE" --json
\`\`\`
时间只给一个：\`--every 30m\`、\`--daily 09:00\`、\`--weekly mon,wed@10:00\`、\`--at "2026-11-05 14:00"\` 或 \`--cron "0 9 * * 1-5"\`；时区和这里不一样加 \`--tz Asia/Shanghai\`。\`--new-topic\` 是每次开个话题发，\`--follow\` 改回跟群走。任务 id 和 \`revision\` 从 \`schedule list --json\` 的 \`tasks\` 里取。退出码 4 是被拒，把 \`error.message\` 原话告诉用户。

## 谁能改
成员只能改自己建的；被拒了就把拒绝原因告诉用户，不要绕。

## 在定时回合里
没有人在场：不要提问，不要等人确认；能定的自己定，做不了的写出来。
要再来一次，用 \`schedule_edit\` 改自己这个任务的时间；不能建新任务，不能改设置。

## 不用两家自带的定时
不要用 Claude Code 的 CronCreate、ScheduleWakeup，也不要用 Codex 的自动化；这里关着，用了也不会跑。

## 任务内容写给未来的自己看
写清目标、输出形式、发到哪里，像给同事留便签。`,
};
