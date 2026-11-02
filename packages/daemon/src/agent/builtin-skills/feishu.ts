import type { BuiltinSkill } from './package';
import { SESSION_RULES } from './session-rules';

/**
 * devices 9 / skills-scope: the read-only queries of a Bot and its group, by tool or by the command line, and what to
 * say when a group asks for what only a private chat or the computer itself does. s48 adds the topics and sessions of
 * product.md 3.5 to this skill.
 */
export const feishuSkill: BuiltinSkill = {
  name: 'feishu',
  title: '飞书',
  description: '查本 Bot 的群、群成员、本群在 vonvon 里的绑定、会话和设置（只读）；群里有人要改 vonvon 的设置，或者让你重启、升级 vonvon 时，也先读本 skill。',
  body: `${SESSION_RULES}

## 什么时候用
有人问本 Bot 在哪些群、群里有谁、本群绑在哪个文件夹、用什么会话方式、有哪些会话、本群现在的设置是什么时用。群里只查得到本群，查不到别的群和别的 Bot。

## 有工具先用工具
- \`feishu_groups\`：本 Bot 的群；在群里只回本群。
- \`feishu_members\`：群成员，\`chatId\` 填本群；在群里只能查本群。
- \`settings_get\`：读设置；在群里只读得到本群，各节都标着只读。
- \`session_info\`：这条会话在哪、这一轮能不能改设置。
没有这些工具时，才用下面的命令行。

## 命令行（只读）
先 \`echo "$VONVON_SCOPE"\`，\`group=\` 后面那段是本群的群 id，下面写成 \`<chatId>\`：
\`\`\`
vonvon feishu groups --scope "$VONVON_SCOPE" --json
vonvon feishu members <chatId> --scope "$VONVON_SCOPE" --json
vonvon group show <chatId> --scope "$VONVON_SCOPE" --json
vonvon session list --group <chatId> --scope "$VONVON_SCOPE" --json
vonvon settings get --group <chatId> --scope "$VONVON_SCOPE" --json
\`\`\`
输出是一行 JSON，成功时 \`ok\` 是 true：
- \`feishu groups\`：\`groups\` 每项有 \`chatId\`、\`name\`、\`bound\`；有 \`nextCursor\` 就加 \`--cursor <nextCursor>\` 查下一页。
- \`feishu members\`：\`members\` 每项有 \`openId\`、\`name\`；翻页同上。
- \`group show\`：\`group\` 里有 \`name\`、\`folder\`、\`tool\`、\`conversation\`、\`enabled\`。
- \`session list\`：\`sessions\` 是本群的会话，每项有 \`threadId\`、\`summary\`、\`updatedAt\`。
- \`settings get\`：\`view.sections\` 是本群各节设置，每节的 \`effective\` 是现在生效的值。

## 被拒了
失败时 \`ok\` 是 false，\`error.message\` 是原因；退出码 4 是被拒：
- "设置只能在私聊里改。请对方去私聊里跟我说。"：原话告诉用户。
- 说范围超过了这条会话，或者必须带 \`--scope\`：看是不是照抄了 \`$VONVON_SCOPE\`；不要换更大的范围。
- 说这条命令不能在 Bot 会话里运行：告诉用户去那台设备上或桌面端里做。
- 说会话令牌已失效，或者没有有效的会话令牌：这条会话的命令行用不了了，告诉用户下一条会话再试。
- 说那一轮对话已经结束：不要在后台跑 \`vonvon\`，等对方下一条消息再做。
退出码 3 是连不上 vonvon：告诉用户就好，不要换别的办法去连。

## 飞书上的操作
发消息、读云文档、建日程这类飞书操作照旧用 lark-cli，它走自己的授权，不归 vonvon 管。`,
};
