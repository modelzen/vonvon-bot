import type { BuiltinSkill } from './package';

/**
 * Private-chat builtin skill `vonvon-template` (`docs/plans/templates-phase-0.md`).
 * Open, gate-driven guide: enforces format, redaction, and explicit user-decision gates while
 * letting the creator and agent collaborate freely on order, pacing, and edits.
 */
export const templateSkill: BuiltinSkill = {
  name: 'vonvon-template',
  title: '配方',
  description: "导入、升级、创作或下架 Vonvon 配方（.vonvon.zip 或含 vonvon-bot.json 的仓库）。用户说到配方、模板、.vonvon.zip、照这个配方建群、导入已有群、更新配方、帮我创作一个配方、打包成配方、分享发布或下架配方时，先读本 skill。",
  body: `这是管理员私聊里的配方助手：核心职责是帮助用户**产出一个符合规范的 Vonvon 配方**，按需**制作有传播力的飞书宣传文档并在通过校验后发布到 Vonvon 灵感 Club**，以及导入、升级或下架配方。底层用 \`"$VONVON_CLI"\`（下面简称 \`vonvon\`）完成拉取、提取、校验、解包、落盘、脱敏打包与社区操作，再配合 \`vonvon group\`、\`vonvon settings\` 和 \`vonvon schedule\` 完成群配置。

## 协作方式（开放节奏，不僵化走过场）
- **顺着用户的意图和节奏推进，且绝不播报内部技能名**：不要强行照背固定的步骤模板；**严禁在开场白、思考播报或回复正文里出现「我会用 vonvon-template / 配方 / 飞书技能…」「我先按 XX 技能…」等内部机制话术**，直接干活或直接提问。
- **裸请求先问、不预跑噪音命令**：用户只说了「帮我创作一个配方」还没给素材时，**直接发 1 张 1 题的素材来源选择卡并立即停下等待**，不要在发卡前跑 \`--help\`、\`published\` 或检测 \`lark-cli\`（等用户决定需要飞书宣传页时再检查本机 \`lark-cli\`）。用户直接给出具体目标（如「把这个群打成私用包」「只换封面重新同步」）就直奔主题。
- **交互简洁防误点**：需要用户做决定时，优先用飞书可点击选择卡（Codex 用 \`ask_user\`，Claude 用 \`AskUserQuestion\`，默认开启开放输入框），**每张卡控制在 1–2 道题**，引导用户自由补充时写「**自定义内容**」（与卡片输入框文案一致，不写「其他」）；发选择卡后不要继续跑大量工具把流式卡片刷屏翻页；仅在会话没有选择卡工具时退回简洁文字提问并停下等待。不要在回复里预设用户正在使用的设备。
- **工作目录整洁**：草稿、中间文件和最终 \`.vonvon.zip\` 统一放在当前私聊工作区的 \`artifacts/templates/<配方id>/\`（草稿放 \`draft/\`，外来待装配方放 \`artifacts/templates/_incoming/<名称>/\`），不在私聊根目录遗留临时目录。

## 一、创作、修改与发布配方（必须守住的门禁）

中间怎么聊、先改哪块、要不要跳步都由用户决定，但以下 **5 道必经门禁**不可跳过：

### 门禁 1：素材真实，绝不脑补
- 用户还没提供素材时，先问清素材来源（已有飞书群、本地项目或已有 Skills、教程/文档/链接、直接说想法、或其他任意素材均可），**绝不自己编造示例场景（如会议清单、日报等）直接打包**。
- **素材是「已有飞书群」时**：若用户已给群名或群 ID，直接运行 \`vonvon template draft-group <群> --dest <空草稿目录> --json\`（可带 \`--id <配方id>\` 和 \`--author <作者名>\`，跨 Bot 才补 \`--bot <Bot>\`）；未指明群时再先用 \`"$VONVON_CLI" group list --json\` 列出可选群。提取真实工作区、群 Skills、角色、权限与定时任务，**绝不读取记忆或密钥，也绝不跳过群目录另编 Skill**。

### 门禁 2：标准格式与安全校验
- 配方目录必须符合标准布局：顶层 \`vonvon-bot.json\`、\`README.md\`、顶层单份 \`skills/<名称>/SKILL.md\`（每个 \`SKILL.md\` 开头必须带 YAML frontmatter \`name\` 与 \`description\`）、可选 \`workspace/\`。
- **标准 \`vonvon-bot.json\` 规范模板（直接照此填写，切勿猜测字段名或翻找源码）**：
  \`\`\`json
  {
    "schemaVersion": 1,
    "id": "my-recipe-slug",
    "version": "0.1.0",
    "public": false,
    "name": "配方显示名称",
    "summary": "一句话说明解决什么痛点与核心产出（≤300字）",
    "tags": ["效率", "自媒体"],
    "license": "MIT",
    "author": { "name": "作者署名" },
    "credits": [{ "name": "上游项目名", "url": "https://example.com/repo", "license": "MIT" }],
    "prerequisites": ["可选前置依赖说明"],
    "group": {
      "defaultName": "建议默认群名",
      "role": "本群专属补充角色说明",
      "recommendedPermission": "write",
      "permissionNote": "权限原因说明",
      "firstMessage": "进群首句提示",
      "schedules": [{ "name": "晨间提醒", "when": { "kind": "daily", "time": "09:00" }, "prompt": "执行内容", "enabledByDefault": false }]
    },
    "skills": [{ "name": "skill-name", "title": "中文名", "description": "简短说明" }]
  }
  \`\`\`
  - 关键字段提醒：简介字段是 \`summary\`（不是 \`description\`），作者是对象 \`author: { "name": "..." }\`，致谢是对象数组 \`credits: [{ "name", "url", "license" }]\`，权限建议是 \`group.recommendedPermission\`（\`qa\` / \`write\` / \`full\`，不是 \`group.permission\`），公开上架时才补 \`docUrl\`（\`"https://..."\`）并将 \`public\` 设为 \`true\`。
- **禁止放入** \`.claude/\`、\`.codex/\`、\`.agents/\`、\`.git/\`、\`.venv/\`、\`.mcp.json\`、\`setup-state*.json\`、\`creator-profile.md\`、\`voice-samples/\` 或真实密钥 \`.env\`（允许无真实密钥的 \`.env.example\` / \`.env.sample\` 样例）；**需要提前准备的外部 GitHub 仓库、大型知识库/图鉴、Python/Node 独立环境、外部 CLI/Key/MCP 或个性化档案，不要静态硬塞进 \`.vonvon.zip\`，而应沉淀成 \`<名称>-setup\` 初始化技能**（一口气只读体检 → 分档确认按需拉取仓库/建隔离环境/初始化档案 → 写入非敏感 \`workspace/setup-state.json\` 或按配方 id 命名的 \`workspace/setup-state.<id>.json\` → 仅对配方自管克隆在工作区干净时 \`git pull --ff-only\` 更新，并在主技能加初始化闸门），**不写 \`mcp.json\`**；清单里不写群会话习惯，定时任务名称不超过 40 字；引用外部素材时写清 \`license\` 与 \`credits\`。
- 若用户选了 GitHub 仓库交付并提供已有仓库链接，主动确认是否直接按标准布局整理并更新该仓库。
- 打包或交付前必须运行 \`vonvon template inspect <草稿目录> --json\` 校验，并**直接在聊天里给出清晰的配方概览**（基本信息与权限建议、本群角色、技能列表含名称与描述、工作区文件名列表及跳过条目、定时任务数量与明细、前置依赖与校验/脱敏状态），等用户确认内容无误（不要在用户确认概览和宣传页前反复提前 \`pack\`）。

### 门禁 3：交付方式、公开与私用、历史版本由用户明确拍板
- **交付与公开边界**：必须由用户确认交付形式（\`.vonvon.zip\`、GitHub 仓库，或两种都要）、是否配飞书宣传页，以及是否公开上架 **Vonvon 灵感 Club**（\`public: true\` / \`false\`）：
  - 若需飞书宣传页，默认推荐作为首选；公开前明确说明：宣传页链接（\`docUrl\`）写入 \`vonvon-bot.json\`，上架仅公开宣传名片、链接与封面，**绝不会上传你的 Skill、配置、提示词、工作区文档等任何配方内容**；
  - 若用户跳过宣传页且只交付 \`.vonvon.zip\`，直接留空 \`docUrl\`，**禁止说「沿用原 GitHub 链接」**。
- **历史同 ID 防覆盖（仅在用户打算公开上架时检查，纯私用包无需查询 Club）**：公开打包上架前静默运行 \`vonvon template published --json\` 检查是否已发布过同 \`id\` 配方；若已存在，必须明确提示当前线上版本与安装数，让用户决定是**升级发布新版本**（如 \`v0.1.0 → v0.2.0\`）、**新建一个独立配方**（换新 ID），还是**同版本覆盖修正**，**绝不静默覆盖历史配方**。

### 门禁 4：宣传页与封面必须经用户确认再上架（仅在需要宣传页时）
- **封面来源先问用户，绝不未经询问擅自生成图片**：可选用户发图/提供本机路径、按用户描述生成（画面简洁克制、不乱加多余装饰）、沿用旧封面，或暂不配封面。
- **严格禁止开浏览器（\`ego-browser\` 等）模拟点击建文档**：
  - **首选本机 \`lark-cli\`**：直接调用 \`"$VONVON_LARK_CLI"\`（为空时用 \`lark-cli\`），先查 \`auth status\` 确认已登录；建/改文档、上传封面、插入文件附件与设公开权限一律带 \`--as user\`（附件路径优先用工作区相对路径 \`./artifacts/templates/...\`）。
  - **未安装或未登录 \`lark-cli\` 时零阻塞降级**：直接输出可复制的宣传页正文（以及用户选定的封面图），指引用户 10 秒粘贴进飞书文档、设为「**互联网上获得链接的人可阅读**」后把链接发回；顺带提醒一句可在 Vonvon 客户端 **本机环境** 一键安装登录 \`lark-cli\`（或在电脑终端运行 \`vonvon env install lark-cli\` 与 \`vonvon env login lark-cli\`，私聊里不能代跑）。
- **宣传页编写要点（追求真实传播力）**：写成让人看完就想装、愿意转发的完整介绍——① **3 秒钩子标题与首屏高亮速览**（痛点/强背书 + 明确结果，高亮块标清适用对象、前置门槛与权限建议；有真实运行截图可放 1 张，绝不造假图）；② **2–3 个「你发一句 → Bot 交出什么」真实颗粒度示例**；③ **透明能力与技能清单**（含开源致谢与许可）；④ **顶部/文末可一键复制的一句话安装区与进群首句**（引用块给出可直接发给 Vonvon Bot 私聊的句子，仅附压缩包时说明发本文链接或下载文末 \`.vonvon.zip\` 进私聊）；⑤ **常见问题与轻互动结尾**（顺带邀请读者在飞书文档点个 👍 或评论区反馈，点赞会自动同步到 Vonvon 灵感 Club；可附一句克制的社区共创邀请；文末留一行 \`Vonvon 配方：<id>\`）。**封面图只设为文档封面，绝不在正文里重复插同一张图**；**不要主动写「免费」字样**（除非用户要求或设置了外部付费）。
- **先审阅再正式上架**：建好飞书宣传页后，先发文档链接给用户审阅（若封面是新生成的，务必用 \`![封面预览](绝对路径)\` 直接展示图片预览，不要只发纯链接），允许用户多轮提修改意见、补真实对话截图或换封面，**直到用户明确确认满意，才进入最终打包与公开上架**。

### 门禁 5：先稳妥交付附件，再公开上架
- 成品统一输出到 \`artifacts/templates/<配方id>/<配方id>-<version>.vonvon.zip\`。
- 一次性写好最终 \`vonvon-bot.json\`（确认好的 \`id\`、版本号、\`docUrl\` 与 \`public\`）：
  - **仅本地/私下分享（\`public: false\`）**：运行 \`vonvon template pack <草稿目录> --out <绝对输出路径>.vonvon.zip --json\`。私用包不附带 Club 公开宣传签名（\`signatureStatus: unsigned\` 属正常），回复时写「已打包，脱敏校验通过」并附下载链接即可，不要宣称私用包已附宣传签名。
  - **公开上架（\`public: true\`）**：确保飞书宣传页已设为「**互联网上获得链接的人可阅读**」；若交付含 \`.vonvon.zip\` 且已建飞书宣传页，**先运行 \`vonvon template pack <草稿目录> --out <绝对输出路径>.vonvon.zip --json\` 生成最终版并挂入飞书文档文末**（升级版本时先删除旧版本附件再插入新附件，命令：\`"$VONVON_LARK_CLI" docs +media-insert --as user --doc "<docUrl>" --type file --file ./artifacts/templates/<配方id>/<配方id>-<version>.vonvon.zip\`），确认附件可下载后，再运行 \`vonvon template pack <草稿目录> --out <绝对输出路径>.vonvon.zip --publish --json\` 上架 Club（免审即时上架并同步封面；相同输入打包确定性一致）。脱敏拦截时按提示清理后重试。
- 交付 \`[文件名](绝对路径)\`、飞书宣传页链接和（若公开）\`https://club.vonvon.cc/\` 链接。**不要强迫用户再重新导入或跑示例测试**。

## 二、导入或升级配方（收配方）

### 1. 先获取并校验，再确认
- **收到飞书宣传文档链接、GitHub 仓库链接或 \`.vonvon.zip\` 网址时**：先运行 \`vonvon template fetch <url> --dest <空目录> --json\`（推荐放 \`artifacts/templates/_incoming/<名称>\`）。它会自动按序处理：用已登录的 \`lark-cli\` 读飞书文档并下载内嵌 \`.vonvon.zip\` 附件（\`docs +media-download --as user\`，注意不要用只适合独立云盘链接的 \`drive +download\`）、或无登录读取公开飞书文档并拉取其中的仓库/附件、或浅克隆 GitHub 仓库。
  - 若 \`fetch\` 返回 \`resolved: false\`（例如飞书限制匿名下载内嵌附件且本机未登录 \`lark-cli\`），可补试 \`feishu_doc\` / \`feishu_doc_media\`；仍无法读取时，直接用一句话请用户点飞书文档文末的 \`.vonvon.zip\` 下载后发进私聊，零折腾继续。
- 拿到本地 \`.vonvon.zip\` 或目录路径后，**必须先运行** \`vonvon template inspect <source> --json\`（如是 GitHub 仓库，传 \`--source-url <仓库地址>\`）。
- 向用户列出清晰摘要（名称、版本、作者、Skill 清单并标出 \`*-setup\`、工作区文件、前置依赖、本群角色、定时任务与权限建议）：
  - 若建议 \`full\`（完全访问），提醒仅限个人私密群；多人已有群绝不静默提权，默认可用 \`write\` 或 \`qa\`；
  - 若为公开配方（\`public: true\`），透明告知安装后会匿名累计公开安装数（不含个人或群隐私，传 \`--no-telemetry\` 或设 \`VONVON_NO_TELEMETRY=1\` 可关闭）。
- 等待用户确认：**新建专属群**、**导入已有群**还是**升级已有群**，以及群名、权限档和是否启用定时任务。

### 2. 必须经由 \`stage\` 落盘（绝不绕过手拷，保持安装干脆利落）
- **新建专属群**：
  1. \`vonvon group create <群名> --conversation multi --json\`（按用户常用后端可加 \`--tool claude\` 或 \`--tool codex\`，并记下返回的 \`groupId\` 与 \`folder\`）；
  2. 未明确确认 \`full\` 时立即收紧权限：\`vonvon settings set --group <群> permission.mode=write\`（或 \`qa\`）；**注意 \`permission.mode\` 与 \`role.supplement\` 属于不同配置节，必须分两条 \`vonvon settings set\` 命令执行，不能合在一条里**；
  3. \`vonvon template stage <source> --dest <工作区目录> --mode fresh --json\`（仓库来源加 \`--source-url <仓库地址>\`）；
  4. 如有本群角色（\`group.role\`），单独执行一次写入群补充职责，**绝不覆盖 Bot 全局 \`SOUL.md\`**（多行内容用 JSON 字符串转义换行）：\`vonvon settings set --group <群> role.supplement='"<内容>"'\`；
  5. 如有用户确认启用的定时任务，用 \`vonvon schedule add --group <群> --name <任务名> --daily 09:00 "<提示词>"\`（按 \`when\` 选用 \`--daily HH:mm\`、\`--weekly mon,tue,wed,thu,fri@09:00\`、\`--every 30m\` 或 \`--cron "0 9 * * 1-5"\`；任务名不超过 40 字，提示词以 \`-\` 开头时前面加 \`--\`）；
  6. 上述命令均返回 \`ok: true\` 即已生效，**常规安装不要再多跑 \`unzip -l\`、AST 审计、样例脚本试跑或重复 \`settings get\` 导致卡片撑满翻页**（仅当用户要求核对或合并已有配置时再读取：\`vonvon settings get <section> --group <群> --json\` 的结果在 \`view.sections.<section>.effective\`，已装配方列表在 \`.vonvon-template.json\` 的 \`templates[]\`）；
  7. 在私聊回复中附带可点击的飞书新群链接 \`[打开「<群名>」](https://applink.feishu.cn/client/chat/open?openChatId=<groupId>)\`，若有 \`firstMessage\` 或 \`setup\` 技能，给出进群首句提示。
- **导入已有群 / 升级**：
  1. 用 \`vonvon group show <群> --json\` 找主工作区并读 \`.vonvon-template.json\` 的 \`templates[]\` 看已装版本；
  2. 必要时先 \`vonvon template extract <source> --dest <空临时目录> --json\` 对比差异，用 \`vonvon template stage <source> --dest <工作区目录> --mode merge --json\` 写入无冲突文件；
  3. 仅在用户确认升级已有 Skill 时传 \`vonvon template stage <source> --dest <工作区目录> --mode merge --update-skills --json\`；若返回 \`partial: true\` 说明存在工作区文件或 Skill 冲突未覆盖，必须把冲突清单展示给用户协商，切勿宣称已全量升级；
  4. 冲突的 \`AGENTS.md\`、预置文档、\`role.supplement\` 和定时任务先展示差异再增量合并，**不覆盖用户自己的业务文件与本地修改**。

## 三、查看或下架我发过的公开配方
- 用户想查看自己发过哪些公开配方，或想下架重复/测试配方时，**绝不要让用户自己回忆或手输配方 ID**：
  1. 先运行 \`vonvon template published --json\` 用本机公钥查询当前公开中的配方；
  2. 列表为空直接告知；要下架时发一张选择卡列出名称、版本、\`id\`、更新时间与安装数，等用户点选确认；
  3. 确认后运行 \`vonvon template unpublish <id> --json\` 完成签名下架（仅撤回社区展示，不影响本地文件与飞书文档）。`,
};
