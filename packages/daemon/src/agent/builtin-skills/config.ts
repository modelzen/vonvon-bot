import type { BuiltinSkill } from './package';

/**
 * product.md 3.7, dm-agent 9: a private chat's `vonvon` command line, which is how an administrator's chat reads and
 * changes the settings of every Bot on this computer. It teaches what can be done and nothing of how to decide (owner
 * 2026-11-05): whether a post can be trusted or a change wants a confirmation is the Agent's own business. The commands
 * it names are checked against the CLI by test/builtin-skill-text.test.ts.
 */
export const configSkill: BuiltinSkill = {
  name: 'vonvon-config',
  title: '配置',
  description: "看和改这台电脑上的 Bot、群和它们的设置：沟通方式、智能提示词、角色设定、权限、模型、Skill、MCP、记忆，建群绑群。用户说帮我调调、老抢话、太吵、不回话、以后在某个群怎样说话、照这篇帖子配一下、建个群、这台电脑有哪些 Bot 和群时，先读本 skill。",
  body: `这是管理员的私聊。你能用 \`vonvon\` 命令行读和改这台电脑上所有 Bot 和它们的群的配置，用户不用知道有哪些设置。

## 私聊是什么
就像和同事私下聊：用户可以让你改你在群里的行为（其实就是改配置），给你安排事情，单独聊，一起做事。
要协作的工作尽量放在群里，群里还有别的人和别的 Bot，可以提一句。这只是引导，用户要在这里做，就在这里做。

## 命令在哪
直接写 \`vonvon\`。找不到时用 \`$VONVON_CLI\`，里面是完整路径；PowerShell 里写 \`& $env:VONVON_CLI\`。

## 先看现状
设置项会变，不要背，先看再改：
- \`vonvon --help\`，各个命令也能加 \`--help\`，比如 \`vonvon settings --help\`；
- \`vonvon bot list\`：这台电脑有哪些 Bot；
- \`vonvon group list\`：绑定了哪些群；
- \`vonvon settings get\`：这个 Bot 的设置；\`vonvon settings get --group X\`：一个群的设置。
要完整的字段，加 \`--json\`。

## 指定目标
- 什么都不写：这个 Bot，就是你自己。
- \`--bot B\`：别的 Bot，写名字或 id。
- \`--group X\`：一个群，写群名或 \`oc_\` 开头的 id；别的 Bot 的群要同时写 \`--bot\`。
- \`--dm\`：这个 Bot 的私聊，比如 \`vonvon settings get --dm\`、\`vonvon schedule list --dm\`。
- 人的 id 按 Bot 分：往 Bot B 的名单里写人，用 \`vonvon feishu members <群> --bot B\` 查到的 id。

## 改完什么时候生效
群设置改完下一轮生效。Skill 和 MCP 要等新会话。

## 进群
Bot 自己进不了已有的群，要用户在飞书里把它拉进去。拉进去以后 \`vonvon group pending\` 看得到，再用 \`vonvon group bind\` 绑定。
新群可以直接建，用 \`vonvon group create\`，发起这件事的人会被拉进去。

## 这里做不了的
这些事命令行会拒绝，告诉用户到 Vonvon Bot 客户端或终端里做：
- 注册 Bot、换凭据；
- 删除 Bot，停用这个 Bot（别的 Bot 可以停用）；
- 停止、重启、升级 vonvon，装卸后台服务；
- API key；
- 管理员名单；
- 配对和远程连接；
- Provider 和 lark-cli 的安装和登录；
- 从 Bridge 导入。
重启和更新，用户也可以在私聊里发 \`/menu\` 自己点。

## 调群里的行为
比如"老抢话"，要看两边：用飞书读取工具（\`feishu_messages\`）看群里的记录，用命令行看这个群的沟通方式和智能提示词：\`vonvon group show X\`、\`vonvon settings get judge --group X\`。`,
};
