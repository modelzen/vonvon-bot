import { FULL_ACCESS_WARNING } from '@vonvon/protocol';
import type { BuiltinSkill } from './package';
import { SESSION_RULES } from './session-rules';

/**
 * devices 9 / skills-scope: changing a Bot's and its groups' settings from a private chat (product.md 3.7), by tool or by
 * the command line, and saying what changed: before → after and when it applies. Only the private-chat set has it; no
 * private chat runs a session yet (s54a hands it over, with the 聊天改设置 switch deciding).
 */
export const settingsSkill: BuiltinSkill = {
  name: 'settings',
  title: '设置',
  description: '在私聊里查和改本 Bot 及它的群的 vonvon 设置：权限档、会话方式、启用停用、响应成员、管理员、卡片显示、评论说明等。主人或管理员要查或改设置时读本 skill。',
  body: `${SESSION_RULES}

## 谁能改
只有主人或管理员发消息触发的这一轮，能改本 Bot 和它所有群的设置；加、去掉本机管理员，只有主人那一轮能改。主人关了"聊天改设置"时一律不能改。这些都由 vonvon 判，和工具一样；被拒了就把原因原话告诉对方，不要绕，也不要换成命令行再试。

## 先读，再改，再说清楚
1. 先读：\`settings_get\`，没有工具时用 \`vonvon settings get\`。记下要改的那一项现在的值和它那一节的 \`revision\`，这就是"改前"。
2. 再改：\`settings_set\` 带上这个 \`revision\`，命令行是 \`--revision\`。版本过期会被拒，重新读一次再改。
3. 改完在回复里说清：改了哪个范围（整个 Bot，还是哪个群）、改前 → 改后、什么时候生效。生效时机照改完回的 \`effects\` 里的 \`detail\` 写，不自己猜。比如："已把「支付组」的权限从「工作区可写」改成「只读」，下一轮生效。"
权限档：\`qa\` 是只读，\`write\` 是工作区可写，\`full\` 是完全访问。给群选完全访问时（\`group create\` 建的群就是完全访问），回复里加一句："${FULL_ACCESS_WARNING}"

## 命令行（备用）
\`<chatId>\` 是群 id，用 \`vonvon feishu groups\` 查；\`<revision>\` 从先读的那次 \`--json\` 输出里取：
\`\`\`
vonvon settings get --scope "$VONVON_SCOPE" --json
vonvon settings get --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon settings set --group <chatId> permission.mode=qa --revision <revision> --reason "<为什么改>" --scope "$VONVON_SCOPE" --json
vonvon settings set cards.showToolCalls=false --revision <revision> --scope "$VONVON_SCOPE" --json
vonvon settings act member add <openId> --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon settings act member all --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon settings act admin add <openId> --scope "$VONVON_SCOPE" --json
vonvon settings act comment-instructions --text "<评论说明>" --scope "$VONVON_SCOPE" --json
vonvon group show <chatId> --scope "$VONVON_SCOPE" --json
vonvon group set <chatId> --conversation smart --revision <revision> --scope "$VONVON_SCOPE" --json
vonvon group set <chatId> --disable --scope "$VONVON_SCOPE" --json
vonvon group create <群名> --conversation multi --scope "$VONVON_SCOPE" --json
\`\`\`
\`group set\` 的 \`--revision\` 从 \`group show --json\` 里取。会话方式是 \`multi\`（多会话）、\`single\`（单会话）或 \`smart\`（智能）；\`--enable\`、\`--disable\` 是启用、停用。响应成员用 \`member add\` 或 \`member remove\` 加一个 openId，\`member all\` 清空名单、所有成员都能用。

## 不在聊天里做的
下面这些告诉对方去桌面端、网页或那台设备的终端里做，不用命令行去试：
- 填、换、删 API key 和别的密钥。有人把 key 发在聊天里，不存、不复述，提醒他这个 key 已经进了会话记录，最好去那家服务换一个新的。
- 本机设置、建新 Bot、改别的 Bot、绑已有的群、解绑群、换项目或群的文件夹。
- "聊天改设置"这个开关本身。
- 重启、升级、停止 vonvon，后台服务，远程连接和配对。`,
};
