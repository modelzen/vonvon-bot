# R1 调研：Today 与消费级 personal agent 的记忆和人设产品形态

依据标记：**[图]** 是看 Today 文章配图确认的；**[文]** 是文章正文，`article.txt:行号`；**[官]** 是官网、帮助中心或官方文档；**[媒]** 是媒体转述；**[三]** 是第三方博客或搜索摘要，没核实；**[推]** 是我的推断。很多国内站点从 JP-VPS 连不上（ECONNREFUSED），OpenAI 帮助页返回 403，这部分只能靠搜索摘要和转述。

---

## 0. 结论先行

1. **Today 的记忆面板就是"一屏文件夹 + 条目数"。** 截图里约 14 个文件夹，总共大约 30 条 [图 08]，量很少，是筛过的。Today 在对话里自己说"我这边的归档是记忆式的，不是全量对话流水"[图 07]。卡尔觉得好用，只因为"有哪些记忆想要纠正，我直接点开就能看到"（`article.txt:27-28`）。
2. **人设在 Today 里占两个位置。** 记忆面板里有一个"缪斯的角色设定（1 项）"文件夹 [图 08]，界面上还有一个独立的"缪斯"tab [图 03、08]。媒体写到这个区"允许用户为 AI 设置名字、切换性格，并查看它的日记和亲密度"[媒，硅星人]。
3. **"aha moment"的实际来源是用户给过的数据，不是凭空猜出来的。** "两个微信"这件事，从截图看来自用户交给它的飞书记账表结构。Today 回复："付款来源那一栏我先空着（那是细到微信1、微信2的）"[图 03]。文章另有三张截图，用户在追问"你咋知道我有两微信的""你从哪里知道这个信息的"[图 04/05/06]。**惊喜和不安之间，差的就是"显示来源"。**
4. **Today 的存储方式和每条记忆的来源，公开资料里都找不到。** 官方只说"知识图谱，有版本记录、可编辑，也可以由你决定遗忘""优先保存在本地"[官 zh-Hans]，隐私政策又写同步数据在 Today 云端 [官 privacy]。
5. **行业的通行做法是分层记忆，加一个是否继承上层的开关。** Claude 每个项目有自己的记忆，另有"Use account memory"开关 [官]。ChatGPT 的项目可以设成 project-only [三，引 OpenAI 文档]。Grok Bot 分用户记忆、bot 记忆、项目记忆 [三]。扣子 Agent 在飞书、微信、网页之间记忆打通，对话不打通 [官]。这和 vonvon"Bot 公共 + 本群 + 私聊、可选继承"的结构基本对得上。
6. **国内产品里，能逐条看、改、删记忆的不多。** 有评测专门把这点当成 Today 的差异化 [三 toolin、smzdm 摘要]。扣子新版 Agent 的记忆存成 `SOUL.md`/`USER.md`/`MEMORY.md` 文件，可以看，但"暂不支持手动编辑"[官]。

---

## 1. Today：文章和配图里能看到什么

### 1.1 形态
- 手机端底部 5 个 tab：聊天 / Today / 任务 / 记忆 / 缪斯（最后一个是 AI 伙伴的头像）[图 03、14]。桌面端左边是和"缪斯"的单一对话流，右边是分段面板 Today / 任务 / 记忆 / 缪斯，右下角有个"灵感"按钮 [图 07、08]。
- 国际版官网的手机 tab 写的是 Chat / Today / Memories / Tasks / **Spark** [官 today.ai]。[推] 第 5 个 tab 显示的是 AI 伙伴的名字。"缪斯"是卡尔自己起的名，还是国内版的默认名，没查到。
- 单一长对话流："all conversations take place in a single long-horizon dialogue stream"[媒，BigGo 融资报道]；"one thread held across seasons"[官 blog]。
- 任务结果会回到对话流，带"来自任务：<任务名>"的标签 [图 15]。

### 1.2 记忆面板 [图 08]
- **顶部健康卡片**：写着"健康 · 35 条数据，3 条记录 · 更新于 02:04"，旁边 4 个小格（月亮、心、黄心、步行），数值都是"--"。[推] 数据来自 HealthKit 一类的接入。隐私政策写了健康数据会"over an encrypted connection to Today's cloud services"同步 [官 privacy 1B]。
- **文件夹网格（名字 · 条目数）**：录音笔记 0（麦克风图标，[推] 对应 Apple Watch 全天录音，`article.txt:79-82`）、缪斯的角色设定 1、关于卡尔 3、Work 4、Projects 4、Preferences 3、People 1、Life 4、Journal 1、Interests 1、Health 3、Feedback 1、Devices（被截断）、Automation Preferences（被截断）。
- [推] 中文名的三个（录音笔记、角色设定、关于<用户名>）像系统固定的；英文名的像模型按主题自动建的，"Feedback""Automation Preferences"正好用来放"以后你派活我先过一遍历史"这类规矩 [图 07："规矩记下了"]。
- 从截图看不到文件夹里面的样子：条目长什么样、有没有来源、有没有时间，**都不知道**。

### 1.3 记忆来源（能看到的）
- **对话里明确交代的**：Chief of Staff 那段提示语被 Today 记成长期规矩 [图 07]。
- **连接器和用户交过来的文档**：飞书记账表 [图 03]；接入微信 [媒，硅星人："第一次打开 Today，我就接入了微信"]。
- **本机文件**："他通过我本机做出的一些信息日报和我平时关注…"（`article.txt:56`）。下载文件夹它也能盘点 [图 11]。
- **本机其他 agent 的记忆文件**：卡尔说"这些 Personal Agent 基本都可以做到读取电脑里面跟你相关的记忆文件"（`article.txt:25-26`），还专门设计了提示语来测这件事（`article.txt:21-24`）。Today 复述了"过去 90 天（2026-07-24 起）"的两条选题线 [图 07]。Today 官方资料里**找不到**"读取其他 agent 记忆文件"的说明。
- **操作环境**：派任务之前"先看一眼之前记过的工作台信息：哪台机器跑什么、产出放哪、Tailscale 那边怎么连"[图 14]。[推] 这些就是 Devices 文件夹的内容。

### 1.4 用户怎么纠正
- 直接点开文件夹改（`article.txt:28`）[文]。官方说"readable, editable, and deletable row by row"[官 blog]。
- 在对话里纠正：用户在记账场景里说过"如果我忘，但是你可以根据我的习惯去纠正"[图 03]。

### 1.5 aha moment 拆解
| 现象 | 用了哪条记忆 | 怎么用的 | 依据 |
|---|---|---|---|
| 知道有两个微信 | 用户给的飞书表里，付款来源一列有"微信1/微信2" | 记账时追问要不要细到微信1/2 | [图 03]；用户觉得"从没告诉过它"（`article.txt:18-19`） |
| 推荐看流星雨 | 作息偏夜猫（[推] 来自健康数据或 Life） | 查了极大期，给出时段建议，"不用为它调整任何安排" | [图 12]，`article.txt:55` |
| 推两条 AI 新闻 | 本机日报、最近关注的模型名、"实测和教程的选题口径" | 自己搜，标来源和抓取时间，写明"只有媒体转述，还没核到官方" | [图 13]，`article.txt:56-58` |
| 问要不要逆向游戏 | Projects 里"在逆向空调、电视机" | 主动提出相近的新任务 | `article.txt:59` |

**由此看出的提取方式和用法 [推]：**
- 提取的不是聊天原话，而是**能拿来做事的事实**：账户、作息、兴趣口径、设备。
- 用的时候**跨场景联想**：从记账联想到付款账户，从作息联想到天象。
- 主动建议有**边界感**：只给建议，不改日程（`article.txt:55`）。
- **不对称**：外部事实都标了来源（博物馆、PAGASA 链接和抓取时间），**用到的记忆却没标**（"你的作息本来就偏夜猫"没说从哪来）[图 12]。图 04-06 里用户追问来源，就是这个缺口。

---

## 2. Today：公开资料能确认什么

| 问题 | 能确认的 | 依据 |
|---|---|---|
| 产品 | Today / Today AI，today.ai（国内页 todayai.cn）。创始人齐俊元（Teambition 创始人，做过豆包 PC 端）。海外 2026-09-08 上线，国内 09-24 上线。Mac/Win/Linux/iOS/Android 都有，另有浏览器扩展 | [官 downloads]，[媒 X 思维怪怪、BigGo] |
| 名字混淆 | App Store 上的"today ai: personal agent"开发商是 Since Kindly, Inc.，**是另一个产品**。"Today Helper CN"是 Today 在 macOS 上申请屏幕录制权限的辅助进程名 | [官 App Store]，[图 02] |
| 存储 | "知识图谱，有版本记录、可编辑，也可以由你决定遗忘"，"优先保存在本地"。隐私政策：删号时会删"memories"，同步数据在 Today 云端。toolin 写的是"个人知识图谱"。**是文件还是数据库：找不到** | [官 zh-Hans]，[官 privacy 6A]，[三 toolin] |
| 提取和更新 | "会不断从邮件、对话和软件行为中提取仍然有用的信息"，按三类生命周期分（只服务这次交互的 / 有时效、任务结束前要留的 / 长期影响判断的）。"通过主动遗忘、压缩和更新来管理 Memory"，细节"逐步降级，在真正需要时再重新寻找" | [媒 硅星人/腾讯新闻 2026-09-08] |
| 每条的来源 | **找不到**。官方只说"see the fact, fix the fact, delete the fact" | [官 blog] |
| 编辑和删除 | 能，逐条 | [官 blog]，[媒 硅星人] |
| 人设和记忆的关系 | AI 伙伴专区：名字、性格切换、日记、亲密度 [媒]。截图里角色设定以记忆文件夹的形式出现 [图 08]。[推] 人设也是一条可编辑的记忆 | 见左 |
| 多 agent 共享记忆 | Today 能调度两台远程电脑上的 Codex、Claude Code、Grok（`article.txt:62-66`，[图 14]）。被调度的 agent 拿不拿得到 Today 的记忆：**找不到**。[推] Today 先读自己的记忆，再写进任务说明 | [文]，[图 14] |
| 模型 | 文章说内置 DeepSeek（`article.txt:46`）。国际版隐私政策列的 AI 提供商是 AWS、Anthropic、OpenAI，没有 DeepSeek。[推] 国内版和国际版用的模型不同 | [文]，[官 privacy 1C] |
| 隐私争议 | 有"公测 72 小时「全盘扫描」的隐私争议"，有人发了"这种个人助理产品真不敢用"的帖子。**具体扫了什么、官方怎么回应：找不到**（原文打不开） | [三 toolin]，[三 smzdm 标题/摘要] |

---

## 3. 其他产品

**Grok Bot（xAI）** [三：Youmind 转述的 X 长文、Vellum、Composio，都不是官方文档]
- 一个用户养多个专职 bot。截图侧栏按"01 工作入口（Projects Manager）/ 02 内容与采集（选题雷达、goodcase 采集器）/ 03 研究与开发（仓库管理员、调查、last30days）/ 04 备用工具"分组 [图 02]。
- 记忆分三层：用户记忆（名字、时区、偏好，**任何 bot 都能改**）；bot 记忆（"a profile file"当这个 bot 的顶层定义，加一份交互日志）；项目记忆（加入同一项目的 bot 共享决定和约定）。bot 之间可以互相触发。
- Vellum 说用户"can't inspect, correct, export, or delete individual memories"；多个 bot 共用一台用户级电脑，"不是安全边界"。

**ChatGPT** [三：past.dev 引 OpenAI 的 FAQ 和 release notes，OpenAI 原页 403]
- 两层：saved memories（明确的列表，可以逐条删）和 reference chat history（看不到列表）。
- 2025-10 起自动管理，不重要的记忆"移到后台"。2026-01 起用到的过往对话会标成来源。2026-06 推出新系统，减少"stale and contradictory memories"。
- 回答下方有个书本图标，列出影响这条回答的来源：自定义指令、过往对话、文件、记忆。
- 项目可以设成 project-only，边界双向都不跨。每个自定义 GPT 有各自的记忆。
- 对话里的"Memory updated"提示，点开能进管理页：这是训练知识，**本次没核实**。

**Claude.ai** [官 support]
- 新版"saves memory as a set of individual topics"，在 Settings > Memory 里逐个 topic 改或删。
- "Each project has its own memory"，项目里可以关掉"Use account memory"，彻底隔离。
- 可以在对话里说"remember this"或让它忘掉。搜索过往对话时显示引用，能跳回原对话。无痕对话不进记忆。

**Gemini** [官 support]
- Saved info 可以看、改、删，也能在对话里让它记。"Your past chats"用于个性化。
- 用到 saved info 时，回答底部"Sources and related content"里会显示"Your saved info"，官方承认这个标签"may occasionally"显示错。

**Kimi** [官 help]
- 说"记住…"就生成一条"记忆指令"。"个人主页 → 设置 → 记忆指令"里能逐条看、删；最多 50 条，每条最多 500 字。
- 可以直接问"你当前都记住了我什么？"。
- "Kimi不会去记未经授权的隐私信息（如健康，密码，地址），除非用户主动要求"。记忆不用于训练。
- 有没有来源：页面没提。

**豆包 / 元宝 / 通义千问** [三，只有第三方博客和转载]
- 都说有记忆开关，能查看、编辑、删除，入口还在灰度。
- 有一篇豆包案例：作者以为排版规则存进长期记忆了，一周后才发现"根本没存进去"（woshipm 的搜索摘要，原文打不开）。

**扣子 Coze**
- **新版扣子 Agent**：自动提取，加定期整理，"分门别类地记录在 Memory.md 等 Markdown 文件中"[官]。
  - 文件有 `SOUL.md`（角色、语气、边界）、`USER.md`（主人画像）、`MEMORY.md`、`TOOLS.md`、`CONTACT.md`（群聊成员身份和协作关系）、`SECRET.md`（授权的账号密钥）。
  - 在 Agent 文件图标的"记忆"页签里看；"暂不支持手动编辑"，靠对话纠正。
  - "各个渠道对话不是打通的，但记忆打通"（飞书、微信、网页）；主对话和项目对话共用一份长期记忆 [官 FAQ]。
- **老版低代码智能体**：长期记忆按"用户 UID + 渠道 ID"隔离，开发者在调试区和记忆库里可以看、改、删；变量写进"人设与回复逻辑"使用 [官 docs.coze.cn，三 掘金]。

**飞书 aily / 智能伙伴**
- 找不到记忆管理的公开说明。只查到它"在用户授权范围内"基于飞书消息、文档、日历、会议、任务、多维表格工作 [三 新华网摘要]。

**LobeHub** [官 RFC 144/146]
- 用户记忆分 Identity / Context / Preference / Experience / Activity 五层（CIPEA）。后台循环"gate → extract → validate → insert"，检索按"similarity × recency × importance"。
- RFC 自己留了一个没回答的问题："When and how to surface memory diffs to users for review?"
- 文档页还是占位，"可编辑 + 置信度"只出现在搜索摘要里，没核实。

**Meta Muse（反例）** [媒，二手转述 WIRED]
- 内部指令描述了一个每小时跑的流程，给用户身边的人建档、更新档案。
- 删除对话后，"still remember what it learned"，要重置或指定忘记某个主题才行。
- 有报道说它把用户住址告诉了陌生人。卡尔也放弃了 Muse 和 OpenAI Dots（`article.txt:8`）。

**本地文件派（和"读本机其他 agent 记忆"相关）**
- Hermes 提供 `hermes import-agent openclaw|claude-code|codex|cursor`，带 `--dry-run` 预览，能导入 `SOUL.md`、`MEMORY.md`、`USER.md`（`hermes-agent/README.md:196-212`）。
- OpenClaw 用 `MEMORY.md`、`USER.md`、`memory/` 当常驻记忆（`openclaw/docs/reference/memory-config.md:469,496`）。

---

## 4. 对比表

| 产品 | 在哪看"记住了什么" | 能改 / 删 | 记忆从哪来 | 每条显示来源 | 人设怎么配 | 多 agent / 角色共享 | 依据 |
|---|---|---|---|---|---|---|---|
| Today | 独立"记忆"tab，按主题分文件夹，带条目数和健康卡 | 逐条改、删 | 对话、连接器（微信、邮件、日历）、本机文件、健康数据、[文] 本机 agent 记忆 | 找不到；用户在对话里追问 | AI 伙伴 tab（名字、性格、日记、亲密度）；角色设定是记忆里的一个文件夹 | 单一伙伴；调度外部 agent，记忆是否下发不明 | 图 + 官 + 媒 |
| Grok Bot | 公开文档没给入口 | 据称不能逐条 | 对话、交互日志 | 无 | 每个 bot 一个 profile 文件 | 用户层共享，bot 层独立，项目层共享 | 三 |
| ChatGPT | 设置 > 个性化 > 记忆；回答下的来源图标 | 能删，摘要可编辑 | 明确保存 + 对话历史自动提取 | 回答级来源（含过往对话） | 自定义指令；GPT 各有记忆 | 项目可设 project-only | 三（引官方） |
| Claude.ai | Settings > Memory 里的 topics | 逐个改、删；对话里说 | 对话自动整理 + "remember this" | 过往对话搜索有引用；topic 是否带来源没写 | 项目指令 | 每个项目独立，可关继承账户记忆 | 官 |
| Gemini | Personal context / Saved info | 改、删 | 明确保存 + 过往对话 | 回答底部"Your saved info" | Gems（没核） | — | 官 |
| Kimi | 设置 > 记忆指令（50 条） | 删；对话里改 | 自动 + "记住…" | 没写 | — | 没写 | 官 |
| 豆包 / 元宝 / 通义 | 据称在设置里 | 据称能 | 自动 | 没写 | — | 没写 | 三 |
| 扣子 Agent | 文件图标 > 记忆页签（`MEMORY.md` 等） | **不能手改**，靠对话 | 自动提取 + 定期整理 | 无 | `SOUL.md` | 同一 Agent 跨渠道共享，对话分开 | 官 |
| 飞书 aily | 找不到 | 找不到 | 飞书授权数据 | — | — | — | 三 |
| LobeHub | 设计中 | 据称能 | 后台抽取，带置信度门槛 | 没定 | 只管用户记忆，agent 记忆另设计 | — | 官 RFC |
| Meta Muse | — | 只能"忘记主题"或重置 | 对话、连接器、公开信息；给联系人建档 | — | — | — | 媒 |

---

## 5. 可借鉴的点

- **Today**
  - 记忆单独占一个一级入口，一屏看到全部分类和数量，点进去就能改。
  - 人设作为一个"可编辑的记忆项"，同时有自己的 tab。
  - 记得少而精。
  - 三类生命周期，主动遗忘。
  - 主动建议只给选项，不改动用户的东西。
  - 外部事实标来源和抓取时间。
  - 任务结果带"来自任务"标签。
- **Grok Bot**：三层记忆的划分（用户 / bot / 项目），bot 侧栏分组。正好对应 vonvon 的多个飞书 bot 和群。
- **ChatGPT**
  - 写入时就地提示，并能直达管理页。
  - 回答级的"用了哪些记忆"。
  - 项目隔离开关。
  - 自动降级，避免"记忆满了"。
- **Claude**
  - 按 topic 存，逐个可改。
  - 容器级的"继承账户记忆"开关，语义和 vonvon 的"继承 Bot"一样。
  - 无痕模式。
- **Gemini**：回答里标"用到了你保存的信息"。
- **Kimi**
  - 有明确上限（50 条 × 500 字）。
  - 可以直接问"你记住了我什么"。
  - 默认不记健康、密码、地址。
- **扣子**
  - 文件化（`SOUL`/`USER`/`MEMORY`/`CONTACT`），用户看得懂。
  - `CONTACT.md` 专记群成员关系，对群 bot 有用。
  - 渠道之间记忆和对话的边界写得清楚。
- **Hermes**：从其他 agent 导入前先 dry-run 预览，正好用来回应"读本机其他 agent 记忆"这件事。

---

## 6. 坑

1. **惊喜变成毛骨悚然**：Today 的 aha moment 引出三次"你从哪知道的"[图 04-06]。不显示来源，用户就会怀疑它在全盘扫描 [三 toolin]。
2. **误记会越积越难改**："Memory 如果更新错误……可能就会是一套越来越难纠正的误解"[媒 硅星人]；"记住≠理解"[三 36kr 等]。
3. **假装记住了**：豆包案例里说"记住了"但其实没写进去 [三]。写入结果要以实际落盘为准，不能听 agent 自报。
4. **串台**：扣子的记忆在飞书群和微信私聊之间打通，避免在群里说私事只能靠对话叮嘱 [官]。Grok Bot 的多个 bot 不是安全边界 [三]。Gemini 的来源标签会标错 [官]。
5. **过期和矛盾**：ChatGPT 专门为 stale/contradictory 记忆改过系统 [三]。
6. **容量静默丢弃**：ChatGPT 自动"移到后台"，用户报告满了以后就不再写入 [三]。
7. **隐私**：全盘扫描争议 [三]；Muse 给联系人建档，删了对话记忆还在 [媒]；扣子用 `SECRET.md` 把密钥放进记忆体系 [官]，风险高。
8. **主动推送变成噪音**：判断不准时，主动建议就成了"另一种通知噪音"[媒]。
9. **改不了的"可见"**：扣子能看不能改，用户发现错了只能在对话里求它改 [官]。

---

## 7. 对 vonvon 的含义（都是推断和建议，供后续讨论）

- **owner 看到"个性和记忆都是空的"，是设计如此**："bot 的个性、记忆、skill 导入后为空"（`docs/product.md:715`）；"第一版不做后台自动整理"（`docs/product.md:408`）；桌面端个性和公共记忆各只有一个输入区（`docs/product.md:56,75,81`）。Today 没有空状态，是因为一开始就从连接器和本机文件导入，再持续自动提取。可以考虑：首次打开时，从旧 bridge 设置、owner 本机 Claude/Codex 记忆里导入，先预览再确认，照 Hermes 的 dry-run 做。
- **"以什么身份"**：参照 Today 和扣子，把人设单独做成一张卡：飞书身份（`docs/product.md:68`，vonvon 不改）+ `SOUL.md` + 规矩，放在"个性与记忆"页最上面，不和记忆混在一个输入区里。
- **按范围分文件夹，比按主题分更适合 vonvon**：三种范围（`docs/product.md:399-405`）直接做成三类文件夹：公共、每个群、每个私聊对象。每条记忆带来源（谁说的、哪个群、什么时间、哪张卡片）。产品定义已经要求"已知来源由 daemon 的实际读取、提交记录给出"（`docs/product.md:409`），这正是 Today 缺的那一块。
- **继承**：行业的做法和 vonvon 的"灰色引用块 + 可移除"（`docs/product.md:70`）一致，接近 Claude 的"Use account memory"开关。跨群共享默认只走公共记忆，A 群的不进 B 群（`docs/product.md:407`），这比扣子的"渠道打通"更安全，建议保留。
- **写入提示**："已记到本群记忆：…［撤销］"（`docs/product.md:408`）相当于 ChatGPT 的"Memory updated"。可以再加一个"查看"，直达这一条。
- **回答级来源**：可以学 ChatGPT 和 Gemini，在卡片上标"用到了哪几条记忆"，直接回答"你咋知道的"。

来源网址：today.ai、today.ai/privacy、today.ai/articles/blog/meet-today、today.ai/articles/zh-Hans、today.ai/articles/capabilities、today.ai/downloads；news.qq.com/rain/a/20260908A055UF00（硅星人）；toolin.ai/tools/today-ai；post.smzdm.com/p/anv3g553（只有标题和摘要）；x.com/0xLogicrw/status/2103068752288063992；support.claude.com/en/articles/11817273；support.google.com/gemini/answer/16413516；kimi.com/zh-cn/help/features/memory-space；docs.coze.cn/cozespace_memory、docs.coze.cn/cozespace_coze_app_faq、docs.coze.cn/guides_long_term_memory；lobehub.com/blog/rfc-144、rfc-146；past.dev/blog/chatgpt-memory；vellum.ai/blog/official-grok-bot-breakdown；youmind.com/…/grok-bot-ai-computer-agent；letsdatascience.com/news/meta-muse-creates-profiles-of-users-contacts-15585c25；apps.apple.com/us/app/today-ai-personal-agent/id6767525653。