import { NOT_DM_MESSAGE } from '../entry/registry';

/**
 * devices 9: the lines every builtin skill opens with. The command line is the tools' fallback under the same rules
 * (devices 5): a group changes no settings and says so in the tools' words, a session's commands carry the `--scope`
 * vonvon set in VONVON_SCOPE (config/session-env.ts) and `--json`, and what only the person at the computer runs is
 * refused in a session (devices-4a 4.9).
 */
export const SESSION_RULES = [
  'vonvon 的事先用 vonvon 的工具。命令行 `vonvon` 只是工具的备用，规则和工具完全一样，能做的不比工具多：',
  '- 只有这件事没有工具可用、shell 里又能跑 `vonvon`（完全访问档）时，才用命令行。每条都带 `--scope "$VONVON_SCOPE"` 和 `--json`。`VONVON_SCOPE` 是 vonvon 给这条会话设好的范围，照抄，不要自己拼，也不要换成别的群或别的 Bot；它是空的，这条会话就还不能用命令行。',
  `- 群里不改任何 vonvon 设置，权限档、会话方式、角色设定、成员名单都算。群里有人要改，就回"${NOT_DM_MESSAGE}"，不去试命令行。`,
  '- 群里用命令行能做的只有本群的定时任务和只读查询。记忆照开场的记忆约定做，不用命令行。',
  '- 范围不对会被拒（退出码 4）。不要换更大的范围重试，也不要去掉 `--scope`。',
  '- 重启、升级、停止 vonvon，装卸后台服务，开远程连接、配对设备，在会话里一律被拒。不要替用户跑，告诉用户去那台设备上或桌面端里做；也不要去读 vonvon 数据目录里的凭据文件，或者绕开命令行自己连 vonvon。',
].join('\n');
