import type { BuiltinSkill } from './package';

/**
 * Private-chat builtin skill `vonvon-template` (`docs/plans/templates-phase-0.md`).
 * Guides administrators step-by-step through authoring/packing/publishing templates (with explicit
 * interactive stops at every decision) and importing/upgrading `.vonvon.zip` or repository templates.
 */
export const templateSkill: BuiltinSkill = {
  name: 'vonvon-template',
  title: '配方',
  description: "导入、升级或创作 Vonvon 配方（.vonvon.zip 或含 vonvon-bot.json 的仓库）。用户说到配方、模板、.vonvon.zip、照这个配方建群、导入已有群、更新配方、帮我创作一个配方、打包成配方、分享或发布配方时，先读本 skill。",
  body: `这是管理员私聊里的配方助手。你用 \`"$VONVON_CLI"\`（下面简称 \`vonvon\`）完成配方的安全校验、解包、落盘、脱敏打包与公开宣传名片上报，再配合已有的 \`vonvon group\`、\`vonvon settings\` 和 \`vonvon schedule\` 完成配置。

## 交互原则（创作与导入均严格遵守）
- **主动分步引导，绝不代替用户做决定**：每次只推进当前这一步，讲清背景与选项，**必须停下来等用户明确回复后再进入下一步**。
- **优先发飞书可点击选择卡片**：
  - Codex 会话优先调用 \`ask_user\`（\`vonvon_bot\` 工具），Claude 会话优先调用 \`AskUserQuestion\`；卡片会自动渲染可点击选项、**「其他（直接打字）」开放输入框**和**「提交选择」按钮**（默认保持 \`allowOther: true\`），遇到选择题必须优先发选择卡片。
  - 仅在当前会话没有选择卡工具（例如尚未 \`/new\` 的旧会话）时，才退回简洁的编号文字提问，并在发完问题后立刻停下等用户回复。
- **严禁脑补场景或凭空编 Skill**：如果用户只说了「帮我创作一个配方」而还没给任何素材，**绝不要自己编一个示例场景（如会议清单、日报等）直接打包**；从已有群提取时必须提取群里真实的工作区和 Skills，绝不跳过群目录自己瞎编。

## 一、从零到发布：主动引导创作配方（做配方）

严格按下面 6 步逐轮推进；只有用户已经明确提供了某一步的信息，才可顺带确认并跳到下一未决步骤：

### 第 1 步：追问素材来源（开放不设限，没有输入绝不往下走）
如果用户尚未说明想做什么配方，优先用选择卡片主动询问打算从哪里开始，给出常见来源并明确说明**完全不限于这几类，任何素材/想法都可以**（卡片自带「其他（直接打字）」开放输入框可直接输入提交）：
1. **从已经调顺手的飞书群提取**：列出已绑定的群让用户挑，直接把群工作区、群 Skills 和群配置提取出来；
2. **从常用的本地项目目录或已有 Skills 整理**：指明目录、仓库或那组顺手的 Skills；
3. **从一篇好教程、文档、帖子或链接提炼**：发来飞书文档、文章或 GitHub 链接；
4. **直接口述想法 / 遇到的好玩用法**：简单描述场景，一起梳理；
5. **其他任意素材**：什么素材都可以（截图、零散笔记、已有文件、工作流片段等，直接在开放框输入或发消息过来）。
发出问题后**立刻停下等待用户提供素材**。

### 第 2 步：提取/整理草案并做本地预览（等创作者确认 OK）
拿到用户的真实素材后，先把配方组装到**空草稿目录**供本地预览：
- **如果素材是「已有飞书群」**：
  1. 若用户还没指定具体哪一个群，先用 \`vonvon group list --json\` 查出已绑定的群，发选择卡让用户挑；
  2. 用户选定群后，**必须直接运行 \`vonvon template draft-group <群> --dest <空草稿目录> --json\`**（跨 Bot 时补 \`--bot <Bot>\`）。该命令会把目标群真实的**工作区文件**、**群本地 Skills**（自动把 \`.agents/skills\` / \`.claude/skills\` 整理到顶层 \`skills/\`，并自动排除 Vonvon 内置系统技能和 \`.gitignore\` / 嵌套 \`.git\` 运行期目录）、**已有 \`vonvon-bot.json\`** 以及**群角色（\`role.supplement\`）、权限与定时任务**完整拉进草稿目录，同时绝不读取任何记忆或密钥；
  3. 仅在提取结果上按需补全或打磨简介/作者名/脱敏提醒，**绝不丢弃群里原本的 Skills 或另编替代品**。
- **如果是其他素材来源**：整理到标准草稿目录——顶层 \`vonvon-bot.json\`、\`README.md\`、顶层单份 \`skills/<名称>/SKILL.md\`（无需维护双端副本；每个 \`SKILL.md\` 开头必须带 YAML frontmatter \`name\` 和 \`description\`，否则 Codex/Claude 无法发现）、可选 \`workspace/\`（预置 \`AGENTS.md\` 与知识文档，绝不放入 \`.claude/\`、\`.codex/\`、\`.git/\`、\`.mcp.json\` 或 \`.env\`）；
- 若依赖外部 CLI、API Key 或 MCP 连接器，整理成一个 \`<名称>-setup\` 技能在群里引导安装，**不写 \`mcp.json\`**；
- 不在清单里写会话方式、免 @ 等群交互习惯，只保留本群角色（\`group.role\`）、可选定时任务、权限建议与预置工作区文档；核对引用素材的开源协议并写入 \`license\` 和 \`credits\`（如禁止商用需提醒）。
- 整理完成后运行 \`vonvon template inspect <草稿目录> --json\` 做真实校验，再**向用户展示完整预览**（名称、简介、角色、真实 Skill 列表与各自作用、预置工作区文件清单、如有跳过的运行期目录或脱敏提醒一并说明，以及本地草稿目录路径方便他自行翻看本地文件），询问「**这套内容和本地草稿预览 OK 吗？有没有想改的？**」并**停下等待确认**。

### 第 3 步：选择交付 / 存放方式（讲清区别，由创作者选）
创作者确认预览 OK 后，优先用选择卡片主动询问想怎么交付/存放这个配方，并讲清区别（等待用户选择）：
1. **打包成 \`.vonvon.zip\` 压缩包**：单个本地文件，不用懂 Git/GitHub；适合直接发群、作为附件贴进飞书文档里给别人下载，或放到第三方渠道分发；
2. **做成 GitHub 仓库**：适合开源维护和持续更新；别人只需复制「一句话 + 仓库链接」就能让 Bot 安装和拉取升级；
3. **两种都要**：既整理 GitHub 仓库，也打出一份 \`.vonvon.zip\` 压缩包。

### 第 4 步：准备飞书宣传页（可选，写入 \`vonvon-bot.json\`）
交付方式确认后，主动告知创作者：下一步可以配一篇**飞书云文档作为宣传页（可选）**——**该飞书文档的链接（\`docUrl\`）会直接写入配方包的 \`vonvon-bot.json\` 中**，是生成配方包的可选组成部分，用来介绍配方效果并写明安装方式：
- 如果选了 **GitHub 仓库**：在飞书文档里放一句让读者发给 Bot 私聊的一句话安装指令（带上 GitHub 仓库地址）；
- 如果选了 **\`.vonvon.zip\` 压缩包**：把 \`.vonvon.zip\` 直接作为附件贴进飞书文档（或放网盘/获取方式），在文档里写明「把压缩包发给 Bot 私聊，或把这篇飞书文档直接丢给 Bot 读即可安装」；
- 若用户希望准备宣传页，可借助本机 \`lark-cli\` 帮他起草，并提醒：点击飞书文档右上角「分享」→ 权限设为「**互联网上获得链接的人可阅读**」，顺手配一张好看的封面图（未加时社区也会自动生成文档微缩预览卡），正文留一行 \`Vonvon 配方：<id>\` 方便核验；拿到链接后立刻写入草稿目录的 \`vonvon-bot.json\`（\`docUrl\` 字段）。
优先用选择卡片询问用户：现在起草或绑定飞书宣传页，还是先跳过宣传页？**停下等待回复**。

### 第 5 步：是否展示到「Vonvon 灵感 Club」社区（仅在有公开宣传文档时询问，默认不放）
优先用选择卡片向创作者清晰说明两个选项的唯一区别，**停下等待明确选择**（未明确同意前严格保持 \`public: false\`）：
1. **放到 Vonvon 灵感 Club（\`club.vonvon.cc\`）展示（\`public: true\`）**：你的这篇飞书宣传文档链接与封面会出现在社区页被更多人看到，并累计匿名安装数；**绝不会上传你的 Skill、配置、提示词、工作区文档等任何配方内容**；
2. **不放到社区（\`public: false\`，默认）**：不会出现在 \`club.vonvon.cc\` 站点上，完全按你自己的方式私下或定向分享（同样可以把 \`.vonvon.zip\` 贴在飞书文档里自己发给别人）。

### 第 6 步：按确认结果打包并干净交付
把用户确认后的清单写入草稿目录 \`vonvon-bot.json\`（必备字段：\`schemaVersion: 1\`、\`id\`（小写字母/数字/连字符，支持 \`作者/配方名\`）、\`version\`、\`public\`、\`name\`、\`summary\`、可选 \`docUrl\`（\`public: true\` 时必填 \`https://\`）、\`author: { name, contact? }\`、可选 \`group\`）：
- 放到社区展示：\`vonvon template pack <草稿目录> --out <绝对输出路径>.vonvon.zip --publish --json\`
- 不放到社区：\`vonvon template pack <草稿目录> --out <绝对输出路径>.vonvon.zip --json\`
- 若脱敏扫描拦截，按提示清理敏感信息后重试。
- 打包完成后用 \`[文件名](绝对路径)\` 把 \`.vonvon.zip\` 发给用户（或同步给出仓库整理结果与社区上报状态）。**不要强迫用户自己再重新导入或跑示例测试**；用户如果想测会自行测试。

## 二、导入或升级配方（收配方）

### 1. 统一检查入口
- 收到用户发来的 \`.vonvon.zip\` 附件路径，或指向含 \`vonvon-bot.json\` 仓库的链接（先浅克隆到临时目录）时，**必须先运行**：
  \`vonvon template inspect <source> --json\`
- 若用户发来的是宣传飞书文档链接，先读取该飞书文档，找到里面的 GitHub 仓库链接或 \`.vonvon.zip\` 附件后再执行 \`inspect\`。
- 绝不绕过 \`vonvon template stage\` 手动拷贝文件，否则会丢失双端 Skill 同步与来源记录。

### 2. 先给清晰确认摘要，停下来等用户确认
向用户列出：配方名称、版本、作者、Skill 清单（标出 \`*-setup\` 初始化技能）、预置工作区文件、前置提示、本群角色、定时任务模板，以及权限建议：
- 若配方建议 \`full\`（完全访问），提醒用户仅限个人私密群；多人已有群绝不静默提权，可改用 \`write\` 或 \`qa\`。
- 若配方为公开宣传（\`public: true\`），顺手透明告知一句：安装成功后会匿名累计该配方的公开安装数（不含任何个人或群隐私，传 \`--no-telemetry\` 或设 \`VONVON_NO_TELEMETRY=1\` 可关闭）。
- 询问并等待用户确认：**新建专属群**、**导入到已有群**，还是**升级已有配方的群**，以及群名、权限档和是否创建定时任务。

### 3. 按确认结果执行
- **新建专属群**：
  1. 先建群拿主工作区目录：\`vonvon group create <群名> --conversation multi --json\`（可按用户习惯改会话方式）；
  2. 若用户未选 \`full\`，**先收紧群权限再落盘**：\`vonvon settings set --group <群> permission.mode=write\`（或 \`qa\`）；
  3. 落盘工作区与双端 Skill：\`vonvon template stage <source> --dest <工作区目录> --mode fresh --json\`（来自仓库时加 \`--source-url <仓库地址>\`）；
  4. 如有本群角色（\`group.role\`），写入群级补充职责，**绝不覆盖 Bot 全局 \`SOUL.md\`**：\`vonvon settings set --group <群> role.supplement="<内容>"\`；
  5. 如有用户确认的定时任务，用 \`vonvon schedule add --group <群> --name <任务名> --daily 09:00 "<提示词>"\`（按 \`when\` 选对应时间参数）；
  6. 引导用户打开新群，若有 \`firstMessage\` 或 \`setup\` 技能，给出首句提示让用户在群里完成初始化。
- **导入到已有群 / 升级配方**：
  1. 用 \`vonvon group show <群> --json\` 找到目标群主工作区，读取里面的 \`.vonvon-template.json\` 了解已装版本；
  2. 必要时先用 \`vonvon template extract <source> --dest <空临时目录> --json\` 对比差异，并用 \`vonvon template stage <source> --dest <工作区目录> --mode merge --json\` 写入无冲突文件；
  3. 仅在用户确认升级已有 Skill 时传 \`vonvon template stage <source> --dest <工作区目录> --mode merge --update-skills --json\`；
  4. 对冲突的 \`AGENTS.md\`、预置文档、\`role.supplement\` 和定时任务，先向用户展示差异再做增量合并，**不覆盖用户自己的业务文件与本地修改**。`,
};
