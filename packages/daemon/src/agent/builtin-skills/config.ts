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
  description: "看和改这台电脑上的 Bot、群和它们的设置：消息卡展示、沟通方式、智能提示词、角色设定、权限、模型、Skill、MCP、记忆，建群绑群。用户说帮我调调、卡片怎么显示、老抢话、太吵、不回话、以后在某个群怎样说话、照这篇帖子配一下、建个群、这台电脑有哪些 Bot 和群时，先读本 skill。",
  body: `这是管理员的私聊。你能用 \`vonvon\` 命令行读和改这台电脑上所有 Bot 和它们的群的配置，用户不用知道有哪些设置。

## 私聊是什么
就像和同事私下聊：用户可以让你改你在群里的行为（其实就是改配置），给你安排事情，单独聊，一起做事。
要协作的工作尽量放在群里，群里还有别的人和别的 Bot，可以提一句。这只是引导，用户要在这里做，就在这里做。

## 命令在哪
用 \`"$VONVON_CLI"\`，里面是运行你的这个 vonvon 的完整路径；PowerShell 里写 \`& $env:VONVON_CLI\`。PATH 上的 \`vonvon\` 可能是另一份安装，这个变量是空的才直接写它。下面写的 \`vonvon\` 都指这条命令。

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
- \`--dm\`：这个 Bot 的私聊，比如 \`vonvon settings get --dm\`、\`vonvon schedule list --dm\`。私聊的沟通方式（\`conversation.mode\`，\`smart\` 或 \`single\`）和判断规则（\`smartRules.respond\`）也用它改。
- 人的 id 按 Bot 分：往 Bot B 的名单里写人，用 \`vonvon feishu members <群> --bot B\` 查到的 id。

## 写文字
\`settings set\` 的值是 JSON 或普通文字。普通文字里的 \`\\n\` 不是换行，会原样存进去。要换行就写成带双引号的 JSON 字符串：\`vonvon settings set --group X smartRules.respond='"第一段\\n\\n第二段"'\`。

## 群角色与规则
群的补充职责用 \`role.supplement\`。工作执行规则用 \`role.workRules\`，只在群工作中生效，不参与智能判断；判断是否回应、是否开新话题分别用 \`smartRules.respond\` 和 \`smartRules.newTopic\`。不要把工作规则合并进补充职责或智能判断规则。工作规则最多 16 KiB UTF-8 字节，空字符串表示清空。
先读目标群的 \`vonvon settings get role --group X --json\`，基于当前值只合并用户指定部分；保存使用原来的 role revision：\`vonvon settings set --group X --revision <原版本> role.workRules='"工作规则"'\`。发生 conflict 后重新读并重做合并，保存后读回核对。配方仅供本轮参考，普通配置不绑定来源；同一版本可以参考到不同群，不执行配方安装或自动更新。

## 配置消息卡
消息卡按每个群聊、每个私聊独立保存，没有 Bot 级消息卡设置。先用 \`vonvon settings get presentation --group X --json\` 看群，或用 \`vonvon settings get presentation --dm --json\` 看这个 Bot 的私聊；跨 Bot 加 \`--bot B\`。\`stored.cardDisplay\` 是本会话保存的对象，\`effective.cardDisplay\` 是实际生效值。null 表示固定旧版默认展示，不继承 Bot。旧的 \`showToolCalls\` 和 \`showModel\` 只用于兼容已有值，不再用 Bot 的 \`cards.*\` 开关配置消息卡。
读取时同时记录 \`view.sections.presentation.revision\` 和目标 Bot、群或私聊，后续保存必须使用同一目标和这个原版本。所有基于快照的修改保存都必须带 \`--revision <原版本>\`，不能在临保存时另读一个新版本替代它。
要自定义时，先复制当前 \`effective.cardDisplay\`；若是 null，用 \`vonvon settings card-template --json\` 响应中的 \`cardDisplay\` 作为起点，仍使用刚才读取的 presentation revision。新对象第一次保存前，参考当前会话已有的工具和模型显示值：\`showToolCalls=false\` 对应工具块 \`mode=off\`，\`showModel\` 的 \`off/running/always\` 对应模型块同名 \`mode\`。只改用户指定字段，并把完整 JSON 对象写到文件。
若改了脚本，先运行 \`vonvon settings card-test <file> --cwd <绝对目录> --json\`，在这个群或私聊的实际目录显式运行脚本；返回的是样例卡片值，不是当前真实会话。脚本从 stdin 读取 JSON，里面有 context、model、elapsed、status 和 cwd；没有全局 input 变量，Node 可用 process.cwd()。Node 要输出一行 JSON 对象，例如 \`const {execFileSync}=require('node:child_process');let branch='未建分支';try{branch=execFileSync('git',['branch','--show-current'],{cwd:process.cwd(),encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()||'未建分支'}catch{}console.log(JSON.stringify({branch}));\`；只返回表达式、没有打印结果会失败。用户指定了无数据、无仓库时的降级文案，这也是有效结果；在实际 cwd 跑 card-test 验证降级，不因目录还不是 Git 仓库而阻塞保存。
脚本测试通过后运行 \`vonvon settings card-check <file> --json\`；card-check 只做静态与卡片检查，不执行自定义脚本。这两步都不保存。然后用 \`vonvon settings set --group X --revision <原版本> presentation.cardDisplay='<完整 JSON 对象>'\` 保存群，或 \`vonvon settings set --dm --revision <原版本> presentation.cardDisplay='<完整 JSON 对象>'\` 保存私聊；跨 Bot 保留原来的 \`--bot B\`。一次提交完整对象，不用嵌套路径；完整对象漏传 revision 会在连接 daemon 前被拒绝。保存会再次检查配置、模板语法和各运行状态下的实际卡片；未通过不会写入。若返回 conflict，必须重新读取同一目标的当前配置和 revision，在新对象上只重做用户指定的修改，再检查、保存；禁止仅换 revision 重提旧对象。保存后再读同一目标的 \`settings get ... --json\`，逐项核对用户要求的位置、显隐、展示时机、文案和提醒行为，核对所有具体要求后再报告完成。已发出的卡片不会追改，后续新任务使用新设置。
恢复固定旧版默认：群用 \`vonvon settings set --group X presentation.cardDisplay=null\`，私聊用 \`vonvon settings set --dm presentation.cardDisplay=null\`。
完成提醒也在同一份 \`presentation\` 中：\`completionMode\` 可选 \`manual\`（本轮手动）、\`long\`（长任务）、\`failures\`（失败或超时）、\`always\`（每次）；\`longTaskMinutes\` 是长任务阈值，1–1440 分钟。\`completionTemplate\` 是提醒的纯文本格式，可换行，最多 500 字。常用变量为 \`{{task}}\`（任务名称）、\`{{elapsed}}\`（耗时数值）、\`{{status}}\`（结果）、\`{{statusIcon}}\`（成功 ✅、失败 ⚠️、超时 ⏱）。「用时」「结果在上方卡片。」等文字直接写在模板中，可按用户要求改写。旧变量 \`{{icon}}\`、\`{{durationLabel}}\`、\`{{detail}}\` 仍兼容。真实 @ 提醒由系统添加，不在模板里手写飞书标签。null 恢复旧版提醒格式，不继承 Bot 的模板。
例如 \`vonvon settings set --group X presentation.completionMode=long presentation.longTaskMinutes=10 presentation.completionTemplate='"{{statusIcon}} {{task}}：{{status}}\\n用时 {{elapsed}}，结果在上方卡片。"'\`；私聊把 \`--group X\` 换成 \`--dm\`。模式、时长、格式和卡片可以在一次 settings set 里一起提交；只改用户指定的字段。CLI 先做静态模板校验，daemon 保存前再次检查；未知变量、未闭合变量、空内容或超长模板会拒绝整次提交，原配置不变。读回核对后再告诉用户；最终卡片更新失败时，系统会保留必要的失败说明。
手动提醒按钮是卡片中的 \`kind=reminder\` 内置组件，只在流式执行的手动提醒模式出现。可改 \`template\` 点击前文字、\`requestedTemplate\` 点击后文字（均为单行 1–80 字，支持 emoji）和 \`slot\`（top-left/top-right/bottom-left/bottom-right/actions-left/actions-right）；点击后保持原位并禁用，不再发送回调。旧配置省略 \`requestedTemplate\` 时使用“🔔 本轮结束后会提醒发起人”。固定 \`mode=running\`、\`appearance=text\`、\`source=builtin\`，不能隐藏、改高度或注入变量。非手动模式不会凭空生成按钮。
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
比如"老抢话"，要看两边：用飞书读取工具（\`feishu_messages\`）看群里的记录，用命令行看这个群的沟通方式和智能提示词：\`vonvon group show X\`、\`vonvon settings get judge --group X\`。

回不回话归哪项设置管，看这个群的会话方式（\`group show\` 里写着）：
- 智能：Bot 自己判断，改智能提示词 \`smartRules.respond\`。
- 多会话、单会话：智能提示词不起作用，由免 @ \`response.noMention\` 决定。开着时话题里不用 @ 也回，关了要 @ 才回。
想让 Bot 看内容决定回不回，用 \`vonvon group set X --conversation smart\` 改成智能。`,
};
