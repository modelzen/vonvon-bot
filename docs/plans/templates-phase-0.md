# 配方第一版：技术设计定稿（`templates-phase-0`）

状态：方案已完全定稿，准备开分支实现。
- 社区站点名：**Vonvon 灵感 Club**
- 社区域名：**`https://club.vonvon.cc`**（部署于现有腾讯云服务器，API 走同域 `https://club.vonvon.cc/api/*`）
- 命名规范：中文称**「配方」**，英文/CLI 命令用 **`template` / `templates`**，清单文件沿用 **`vonvon-bot.json`**，打包后缀使用 **`.vonvon.zip`**。
- 长期生态规划见飞书文档：[Vonvon Bot 社区与生态长期规划（模板与租赁）](https://my.feishu.cn/docx/LJ0RdwOGxo3Xxxx3wy3csxcKnye)。

---

## 1. 目标与硬边界

### 第一版目标
1. **平台零内容托管**：站点不存 `.vonvon.zip`、不存 Skill、不存 Prompt、不存工作区文档、不存封面大图、不渲染第三方 HTML；详情页直接外链至创作者的**公开飞书云文档（`docUrl`）**（兼容 GitHub / 小报童等 `https://` 链接）。
2. **发布即见效 + 安装持续累加**：
   - 创作者在私聊里选择「公开宣传（`public: true`）」并执行打包发布时，**即刻上报公开宣传名片与飞书文档链接**（`POST /api/publish`，安装数初始为 0，无需苦等第一个安装就能看到自己发出去的作品）；
   - 后续每当使用者通过 `vonvon template stage` 安装该配方时，客户端异步上报匿名去重安装计数（`POST /api/install`，同时兜底补录未主动发布过的公开包）。
3. **本机全场景闭环**：飞书私聊同时支持**新建专属群**、**导入已有群（智能合并）**与**配方版本升级**，跨 macOS / Linux / Windows 稳定可用。
4. **极简飞书文档网格站（`club.vonvon.cc`）**：采用方案 A（纯前端仿真飞书云文档微缩卡片预览，零存储零反爬，预留封面图槽位）、无登录点赞 👍、顶部「+ 创作我的配方」引导浮层，以及新作者公钥首次一键信任。
5. **开发阶段实测样板**：以 `modelzen/vonvon-assistant` 完成端到端实测。

### 明确不做
- 不改桌面端 UI（不新增社区 Tab、不注册深链接协议）。
- 不改 `projects.json`、不改 daemon RPC 协议、不建账号系统或支付系统。
- 不设 `assets/` 封面图目录、不设 `promo.html`、不设 `mcp.json`（外部工具、CLI、MCP 与认证统一交由配方自带的 `setup` Skill 引导安装）。
- 不包含会话方式（多会话/单会话/智能）、免 @、智能提示词、卡片展示等群交互习惯设置。
- 不自建站内自由评论框（评论/反馈采用外链，规避国内个人站点 UGC 评论合规风险）。

---

## 2. `.vonvon.zip` 目录规范与落地映射

### 标准包布局

```text
<slug>.vonvon.zip
├── vonvon-bot.json               # 必填：声明式清单（v1）+ 公开宣传元数据与签名
├── README.md                     # 推荐：给人看的说明与手动安装指引
├── skills/                       # 可选：顶层单份 Agent Skills（遵循 agentskills.io 规范）
│   └── <skill-name>/
│       ├── SKILL.md
│       ├── scripts/              # 可选
│       ├── references/           # 可选
│       └── assets/               # 可选（Skill 自身运行资源）
└── workspace/                    # 可选：原样铺进群主工作区的预置内容
    ├── AGENTS.md                 # 可选：群工作区规则
    ├── CLAUDE.md                 # 可选
    └── docs/                     # 可选：预置知识文档、模板、脚本等
```

### 顶层 `skills/` 与仓库根目录模式兼容
- 核对 `packages/daemon/src/agent/group-skills.ts`，Codex 读 `<cwd>/.agents/skills/`，Claude 读 `<cwd>/.claude/skills/`，两家均不直接读 `<cwd>/skills/`。
- 将 `skills/` 放包顶层，保持 `workspace/` 与新群工作区 1:1 纯净对应，安装时由 `stage` 将单份 `skills/` 实体复制到双端目录（不使用符号链接，保证 Windows 兼容）。
- 兼容 Git 仓库即工作区模式（如 `modelzen/vonvon-assistant`）：若源目录无 `workspace/` 子目录，则排除 `.git/` 与 `vonvon-bot.json` 后将根目录文件视为工作区内容；若已有 `.agents/skills/` 或 `.claude/skills/` 则自动补齐另一端。

### 群工作区轻量来源记录（`.vonvon-template.json`）
落盘后在目标群主工作区写入隐藏文件 `<cwd>/.vonvon-template.json`（数组结构，支持多配方并存与单独升级，不侵入 daemon 数据库）：

```json
{
  "schemaVersion": 1,
  "templates": [
    {
      "id": "modelzen/vonvon-assistant",
      "authorPublicKey": "<base64url-ed25519-pub>",
      "version": "0.1.0",
      "sourceUrl": "https://github.com/modelzen/vonvon-assistant",
      "skills": ["vonvon-setup", "vonvon-qa", "vonvon-diagnose", "vonvon-feedback"],
      "installedAt": "2026-11-24T12:00:00.000Z"
    }
  ]
}
```

---

## 3. `vonvon-bot.json` v1 Schema

### 完整示例

```json
{
  "schemaVersion": 1,
  "id": "modelzen/competitor-daily",
  "version": "0.1.0",
  "public": true,
  "name": "竞品日报助手",
  "summary": "每天定时抓取指定竞品动态，整理成结构化飞书日报并沉淀历史记录。",
  "tags": ["daily-report", "research", "feishu"],
  "docUrl": "https://my.feishu.cn/docx/xxxx",
  "installHint": "帮我照这个配方建群：https://github.com/modelzen/competitor-daily",
  "license": "Apache-2.0",
  "credits": [
    {
      "name": "example-web-skill",
      "url": "https://github.com/example/web-skill",
      "license": "MIT"
    }
  ],
  "author": {
    "name": "modelzen",
    "url": "https://github.com/modelzen",
    "contact": "小红书 @modelzen",
    "publicKey": "<由 pack 自动填入的 Ed25519 公钥>"
  },
  "repository": "https://github.com/modelzen/competitor-daily",
  "acquisition": ["local"],
  "pricing": {
    "kind": "free"
  },
  "compatibility": {
    "vonvonMinVersion": "0.10.0",
    "providers": ["codex", "claude"],
    "platforms": ["macos", "linux", "windows"]
  },
  "prerequisites": [
    "首次使用在群内发送「开始初始化」，按引导配置竞品清单与可选抓取工具"
  ],
  "group": {
    "defaultName": "竞品日报",
    "role": "你负责每日跟踪核心竞品更新，输出客观、带来源链接的中文简报，不编造未核实信息。",
    "recommendedPermission": "write",
    "permissionNote": "默认工作区可写即可联网抓取并保存日报记录；如需读取本机外部目录再按需提高权限。",
    "firstMessage": "开始初始化",
    "schedules": [
      {
        "name": "每日竞品早报",
        "when": { "kind": "weekly", "days": [1, 2, 3, 4, 5], "time": "09:00" },
        "prompt": "运行竞品跟踪技能，汇总过去 24 小时核心竞品动态并发送到群里。",
        "enabledByDefault": false
      }
    ]
  },
  "skills": [
    {
      "name": "competitor-setup",
      "title": "初始化配置",
      "description": "引导填写关注竞品列表并检查抓取环境"
    },
    {
      "name": "competitor-digest",
      "title": "竞品日报生成",
      "description": "抓取更新、去重整理并输出结构化日报"
    }
  ],
  "promoSignature": "<由 pack 自动生成的公开宣传元数据 Ed25519 签名>"
}
```

### 关键字段规则
- **`public`**（布尔，**未填时代码严格默认为 `false`**）：
  - `false`：仅内部/个人私用，打包发布与安装均绝不向社区上报任何信息；
  - `true`：公开宣传。**绝不上传 Skill、Prompt 或工作区正文**，仅把飞书宣传文档链接及结构化展示名片（`id`、`version`、`name`、`summary`、`tags`、`docUrl`、`installHint`、`author`、`pricing`、Skill 名称列表与签名）上报至 `club.vonvon.cc` 展示并统计安装量。
- **`docUrl`**：创作者对外宣传页链接（主推设为「互联网上获得链接的人可阅读」的飞书云文档，并在文档内附一行双向认领标记 `Vonvon 配方：<id>` 及获取方式；兼容 GitHub / 小报童等 `https://` 链接；同时兼容旧字段名 `homepage`）。
- **`installHint`**（可选，≤ 300 字纯文本）：免费开源配方可选提供的一句话安装提示。
- **`pricing`**：`{ kind: "free" }` 或 `{ kind: "external", displayPrice?: string, url: string }`。
- **`author.publicKey` & `promoSignature`**：由 `vonvon template pack` 自动基于本机 Ed25519 密钥生成与签名，后台按 `(id, authorPublicKey)` 联合作为唯一键防篡改劫持。
- **`group.role`**：写入新群或合并进已有群的「本群角色 / 补充职责（`role.supplement`，≤ 5,000 字）」，绝不改 Bot 全局 `SOUL.md`。
- **`group.schedules[].when`**：复用 `packages/daemon/src/agent/builtin-skills/schedule.ts` 既有的 `daily` / `weekly` / `every` / `cron` 四种格式，`enabledByDefault` 默认 `false`。
- **兼容旧版 `vonvon-assistant`**：若清单无 `group` 字段而存在旧 `defaults` 字段，宽松映射 `groupName` / `permission` / `permissionNote` / `firstMessage`，忽略 `conversation` 与 `response`。

---

## 4. 主线 1：`vonvon-bot` 本机核心设计

### 4.1 确定性 CLI 子命令：`vonvon template`

新增模块（全部在 `packages/daemon/src/template/`，无新增第三方依赖）：
- `schema.ts`：zod schema、旧 `defaults` 兼容解析、非空有效能力检查（拦截纯空壳包）、规范化公开宣传载荷（canonical JSON）构造。
- `zip.ts`：基于 `node:zlib`（`deflateRawSync`/`inflateRawSync` + CRC32）的标准 ZIP 读写器：
  - 写入强制设置 General Purpose Bit Flag bit 11（UTF-8 文件名），杜绝 Windows 中文乱码；
  - 读取强安全校验：拒绝绝对路径与 `..` 路径穿越（zip-slip）、拒绝符号链接、限制压缩体积 ≤ 15 MB、解压总大小 ≤ 25 MB、文件数 ≤ 500。
- `redact.ts`：打包前脱敏扫描器，命中密钥/Token（`sk-`、`cli_` 配 secret、`ghp_`、`xoxb-`、PEM 私钥、`VONVON_SESSION`、`local-credential`、`master.key`、`author-key.json`）、飞书私有 ID（`oc_`、`ou_`）、本机用户主目录绝对路径或私有状态文件（`memory.json`、`events.jsonl`、`projects.json`、`config.json`、`bots.json`、`.env`）时拒绝打包并精准报错。
- `author-key.ts`：管理本机创作者 Ed25519 密钥对 `~/.vonvon-bot/devices/author-key.json`（位于已由 `claudeReadScope` 整目录隔离的 `0700` `devices/` 目录内，文件权限 `0600`，首次打包原子排他创建，防止首次创建前启动的群会话逃逸隔离）。
- `club-client.ts`：与 `https://club.vonvon.cc` 通信的轻量客户端（支持 `VONVON_CLUB_API_URL` 覆盖用于本地与测试联调）：
  - **发布宣传页**（`POST /api/publish`）：创作者执行 `pack --publish`（或 `publish`）且 `public === true` 时同步上报公开宣传名片与 Ed25519 签名（不含任何正文），立刻返回状态（已上线或待首次信任确认）与社区链接；
  - **匿名安装上报**（`POST /api/install`）：仅在 `stage` 成功、清单 `public === true`、且未设 `VONVON_NO_TELEMETRY=1` / `--no-telemetry` 时异步发送（2 秒超时静默失败不阻塞），携带 `anonInstallKey = sha256(本机随机匿名盐值 + ":" + id + ":" + authorPublicKey)` 与公开宣传载荷（若此前未主动发布则自动补录）。
- `ops.ts`：`inspect` / `extract` / `stage` / `pack` / `publish` 实现。
- `packages/daemon/src/cli/commands/template.ts`：接入 `packages/daemon/src/cli/index.ts`。

子命令（均支持 `--json`）：

| 命令 | 职责 |
|---|---|
| `vonvon template inspect <source> [--json]` | 校验 `.vonvon.zip` 或本地目录中的 `vonvon-bot.json`、验证 `promoSignature`、检查非空能力、列出 Skill、预置文件、定时任务、权限建议与是否公开宣传 |
| `vonvon template extract <source> --dest <tempDir> [--json]` | 安全解包到干净临时目录，供私聊 Agent 在「导入已有群 / 配方升级」场景下对比差异与智能合并 |
| `vonvon template stage <source> --dest <dir> [--mode fresh\|merge] [--source-url <url>] [--no-telemetry] [--json]` | 铺设 `workspace/`（`fresh` 要求空目录；`merge` 仅写入不冲突文件并返回冲突列表交 Agent 合并）、双端铺设 `.agents/skills/` 与 `.claude/skills/`、更新 `.vonvon-template.json`；若 `public === true` 异步触发匿名安装上报 |
| `vonvon template pack <dir> --out <file.vonvon.zip> [--publish] [--json]` | 校验清单与结构（含非空能力校验）、执行强制脱敏扫描、用本机 Ed25519 密钥对公开宣传字段签名、生成 UTF-8 `.vonvon.zip` 并输出 `sha256`；传入 `--publish` 且 `public === true` 时立刻调用 `POST /api/publish` 让创作者马上看到自己的发布 |

**会话权限边界**：
- 本地终端与**私聊（DM）会话**允许执行 `vonvon template *`；
- **群聊与云文档评论会话**直接拒绝，防止群内非管理员触发打包、探测或落盘。

### 4.2 内置私聊 Skill：`vonvon-template`

新增 `packages/daemon/src/agent/builtin-skills/template.ts`，仅注册到 `packages/daemon/src/agent/builtin-skills/registry.ts` 的 `dm` 集合：
- `name`: `'vonvon-template'`，`title`: `'配方'`，单行 `description` ≤ 300 字，以 `先读本 skill。` 结尾。

#### 创作者体验引导（做配方）
1. **任意素材入口**：接受现有群（只读非敏感配置，绝不读记忆和密钥）、帖子、飞书文档、GitHub 仓库、零散 Skill 或口头描述。
2. **主动给出「做好配方」建议**：
   - 提炼直白易懂的名称与一句话场景卖点；
   - 发现依赖外部 CLI / API Key / MCP 时，引导整理为 `<slug>-setup` 初始化引导技能；
   - 引导制作公开飞书宣传文档（`docUrl`）：**必须明确引导创作者点击文档右上角「分享」→ 将权限设为「互联网上获得链接的人可阅读」**，否则他人从 `club.vonvon.cc` 点进去会无权限打开；同时在文档中附一行 `Vonvon 配方：<id>` 及获取方式（若本机装有 `lark-cli` 可协助起草）；
   - 核对引用素材的许可与署名（`credits`），建议拉临时测试群试跑验证。
3. **打包前必问的明确文案**：
   - 明确告知：**公开宣传（`public: true`）绝不会上传 Skill、提示词或任何配方正文，只会把你的这篇飞书宣传文档展示到「Vonvon 灵感 Club」（`club.vonvon.cc`）并统计安装量；想让别人下载或买到，记得在飞书文档里留好获取方式或联系方式。** 未明确选择公开时默认 `public: false`。
4. **打包与即刻发布**：调 `vonvon template pack --publish`（公开配方时）或 `pack`（私密配方），在私聊发回 `.vonvon.zip` 附件，同时给出发布结果（或 `club.vonvon.cc` 链接）和可直接转发群聊/小红书的分享文案。

#### 使用者体验引导（收配方 / 升级配方）
1. **统一入口规则**：收到 `.vonvon.zip` 文件或含 `vonvon-bot.json` 的 GitHub 仓库链接，一律先跑 `vonvon template inspect`，落盘统一走 `vonvon template stage`（绝不绕过 `stage` 手工拷贝）。
2. **明确确认摘要（绝不静默操作）**：列出名称、版本、作者、Skill、预置文件、定时任务、权限建议（涉及 `full` 强提醒仅限个人私密群，多人已有群切勿随意提权），并附透明说明（公开配方会匿名统计安装数，不含个人与群隐私，可设 `VONVON_NO_TELEMETRY=1` 关闭）。
3. **三种安装模式**：新建专属群（`fresh`）、导入已有群（`extract`/`merge` + Agent 对比增量合并）、配方升级（读 `.vonvon-template.json` 对比升级并保留用户本地自定义与定时任务时间）。

---

## 5. 主线 2：「Vonvon 灵感 Club」（`club.vonvon.cc`）极轻社区站（腾讯云现有服务器）

直接复用现有腾讯云服务器运行极轻 Node + SQLite 服务（约 20–30 MB 内存），Nginx 反代至 `https://club.vonvon.cc`：

- **SQLite 数据表（4 张极简表）**：
  1. `authors (public_key PRIMARY KEY, trusted INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0, first_seen_at, note)`
  2. `templates (id, author_public_key, version, name, summary, tags_json, skill_names_json, doc_url, install_hint, cover_url, author_json, pricing_json, promo_signature, updated_at, PRIMARY KEY (id, author_public_key))`（`cover_url` 为预留槽位，第一版为空）
  3. `installs (template_id, author_public_key, anon_install_key, version, source_kind, installed_at, PRIMARY KEY (template_id, author_public_key, anon_install_key))`
  4. `likes (template_id, author_public_key, voter_hash, liked_at, PRIMARY KEY (template_id, author_public_key, voter_hash))`
- **同域 API**：
  - `POST /api/publish`：创作者打包公开配方时立即上报，验 Ed25519 签名、URL 协议（仅 `https://`）、字段长度与限流 → 按 `(id, authorPublicKey)` 入库（初始 0 安装），返回状态（`published` 或 `pending_author_trust`）；
  - `POST /api/install`：使用者安装时异步上报，验签后去重累加安装数；若后端已有同 `(id, authorPublicKey, version)` 记录则不重复入库或重复抓取，仅在首次补录或收到更高签名版本时更新卡片；
  - `GET /api/list`：返回 `authors.trusted = 1 AND blocked = 0` 的公开配方列表（含累计去重安装数、近 7 天安装数、点赞数），支持按安装量 / 点赞数 / 最新排序与搜索；
  - `POST /api/like`：无登录点赞（匿名防重 + IP 限流）；
  - 极简管理员接口（Bearer Token 保护，支持你的 Vonvon Bot 经 `lark-cli` 预审新作者飞书文档后一键操作）：查看待信任新作者及其 `docUrl`、一键「信任该作者」或「拉黑下架」。
- **前端界面（`https://club.vonvon.cc` — 极简飞书云文档网格风格，冷启动克制优先）**：
  - 顶部栏：「Vonvon 灵感 Club」品牌标识 + 「下载 Vonvon」 + 醒目主按钮 **「+ 创作我的配方」**（弹窗一键复制 `帮我创作一个配方` 发给私聊 Bot，并附 `vonvon.cc/get/` 下载引导）；初期不展示冷启动全站计数徽标，也不设前端分类/标签栏（`tags` 仅留作后台搜索关键词，待配方数量自然增长后再沉淀真正有效的分类）；
  - 精简工具行（仅在公开配方 ≥ 6 个或用户输入搜索词时显示，初期卡片很少时界面保持极简）：单行搜索框 + 「热门 / 最新」两档排序；
  - 卡片网格：
    - 上半区：优先展示经服务端拉取缓存的**真实飞书文档封面图**（`cover_url`）；无封面时自动兜底渲染方案 A（纯 CSS 仿真飞书云文档微缩画布，展示标题、简介与 Skill 胶囊）；不展示静态标价或「免费 / 付费」角标（价格与获取方式动态可变，统一以创作者飞书宣传文档正文为准）；
    - 下半区：飞书文档图标 + 配方名称 + 可选「复制安装」按钮 + 作者署名 + 安装数（> 0 时展示，避免新发布显示冷清的 `0 安装`）+ 无登录点赞按钮（0 赞显示 `👍 赞`）；
    - 点击卡片直接新窗口跳转创作者的**飞书宣传文档（`docUrl`）**。

---

## 6. 测试与验证计划

1. **主线 1 单元测试（`packages/daemon/test/template-*.test.ts`）**：
   - 零依赖 ZIP 编解码：UTF-8 中文文件名往返、路径分隔符归一化、zip-slip 拦截、符号链接拒绝、体积与文件数上限。
   - 脱敏扫描与空壳拦截：密钥/Token/`oc_`/`ou_`/绝对路径/记忆文件阻断；无 Skill、无预置文件且无 `group.role` 的空壳包拦截。
   - Ed25519 密钥与签名：`author-key.json` 权限 `0600`、纳入 `ROOT_SECRETS` 测试、篡改字段验签失败。
   - `stage` & `extract`：`fresh` 与 `merge` 模式、双端 Skill 复制、`.vonvon-template.json` 多配方数组读写、`vonvon-assistant` 旧 `defaults` 兼容。
   - 发布与匿名上报：`public: false`（或缺省）绝不发请求、`VONVON_NO_TELEMETRY=1` 绝不发安装上报、超时静默不阻塞。
2. **主线 1 契约与端到端回归**：
   - 更新 `packages/daemon/test/builtin-skill-text.test.ts` 与 `packages/daemon/test/cli-parity.test.ts`（含群会话拒绝 `vonvon template`）；
   - 三端 CI（Linux / macOS / Windows）；
   - 用 `modelzen/vonvon-assistant` 跑通完整实测：打包发布 → 私聊收发 → 新建群 → 已有群升级 → 安装计数回流。
3. **主线 2 接口与安全单测**：
   - 同 `id` 不同公钥互不覆盖、非法签名拒绝、非 `https://` 拒绝、未信任新公钥不出现在公网列表、一键信任后立即可见、同用户升级不重复虚增去重安装数。
