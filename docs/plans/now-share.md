# 此刻页改版和分享 GIF（now-share）

2026-11-08 起。设计讨论和效果图在 owner 的两份飞书文档里（此刻页改版和分享 GIF 效果图；分享图底部一行：文案和样式备选），本计划只写已定的结论和怎么做。集成分支 `claude/now-share-integration`，各片 PR 合进它，最后开一个集成 → dev 的 PR，`frozen` 只打一次。

## 1. 做什么

此刻页：用量移到群动态上面；Codex、Claude Code、Jev 三个用量面板各按自己的数据重做；工牌去掉横贯的线，改成往上淡出的挂绳。右上角加「分享」：生成一张约 3 秒的 GIF，内容和样式与 app 里一样，工牌翻面用 app 里真实的悬停效果，用量一天一天加上来。

## 2. 已定的产品行为（owner 2026-11-08）

- 此刻页顺序：工牌 → 用量 → 群动态。标题旁不加说明行。右上角「分享」在「添加 Bot」左边。
- 用量面板：
  - Codex：左边四个数（累计 Token，下注会话数；连续活跃，下注最长；峰值单日；最长单任务），中间 13 周每日 Token 热力图，右边额度一栏（套餐、读取时间、每个窗口的百分比、进度条、重置时间，用到 90% 及以上变警示色）。下面一行：常用技能前 3、推理强度、Fast 模式。
  - Claude Code：左边四个数（累计 Token，下注最常用模型；连续活跃，下注最长和共活跃天数；会话，下注消息数；最长会话，下注消息数），中间 13 周每日消息热力图（分级按 Claude Code 的 p25/p50/p75），右边额度一栏（含 Fable 7 天限额，修掉现在"暂不可用"的错）。下面一行：各模型 Token 占比条、24 小时会话开始分布和"最常在 N 点开工"。数据按 Claude Code 自己 `/usage` → Stats 的算法从本机记录统计（N2）。
  - Jev：Tab 前加 TypeSafe AI 的 logo。左边四个数：今天判断（截至几点）、14 天合计（日均）、最忙一天（日期）、昨天。中间 14 天柱状图（紫色，今天加深并标数）。右边按 Bot 分 14 天只算 Jev 的次数，只有一个 Bot 或 daemon 太旧拿不到分来源时不显示。底下一行说明 Jev 是什么。所有数都来自 daemon 的判断记录，不臆造。
  - app 里没有逐日累加的动效，分享时才有；除此之外，分享图里的用量和 app 里内容、样式一样。
- 挂绳：去掉横线，每张工牌挂两股挂绳，往上渐渐淡出。挂绳比效果图宽，两面不同颜色：一面浅蓝色，一面黑色；效果好的话，浅蓝那面印 `Vonvon`，黑色那面印 `more than a bot`。具体做法开发时用真实代码渲染几版，截图给 owner 选。
- 分享框（用 app 现有的设置分组、开关、勾选组件）：
  - 显示：工牌（开）；用量多选 Codex / Claude Code / Jev（最近 7 天有用量的 Provider 默认勾选，Jev 默认不勾）；使用习惯（关）；额度和套餐（关）；群动态（关，最近 3 条）。
  - 打码：群名称（开，工牌背面和群动态都管；群头像不打码）；人名（开：直属上级、账号名；Bot 名不打码）。
  - 始终不出现：设备名、窗口外框、Bot 的飞书二维码和"去飞书找我"、消息内容。标题固定「我的 AI 团队」。
- 分享图底部一行（owner 2026-11-08 定）：用第一份文档里分享 GIF 的那版底部，调得不显眼。
  - 左边两行：`vonvon.cc`；「给你的 飞书 也招几位 AI 同事」，"飞书"用官网带图标的写法，没有"群"字。
  - 右边：两行小字「扫码了解 Vonvon Bot」「在电脑上下载使用」，旁边一个小二维码，扫到 `https://vonvon.cc/?utm_source=share`。
  - 上面一条很淡的分隔线。文字全用灰色系，网址也不用正文黑。二维码约 42px，保持能扫。
  - 参考图：`claude-work/now-share-1108/out/foot/share-still-lanyard-final.png`。
- GIF：先做桌面端，网页端不显示分享按钮。约 3 秒循环，第一帧是最终画面。

## 3. 切片

| 片 | 内容 | 依赖 |
|-|-|-|
| N0 | 本计划和协议字段（`profile.localStats`、`dailyBuckets[].messages`、`judgeUsage` 的 `bots[].sources`） | — |
| N1 | daemon：判断次数按 Bot 分来源 | N0 |
| N2 | daemon：Claude Code 本机统计 | N0 |
| N3 | UI：此刻页顺序、三个用量面板、Fable 一行、Jev 图标 | N0；数据来自 N1、N2，没有时降级 |
| N4 | UI：挂绳几版，owner 选后定稿 | — |
| N5 | 分享：分享框、分享卡、桌面端录 GIF | N3、N4 |

N1 小，和 N3 一起做（同一个 PR 也可以）。N2、N3、N4 并行，N5 等它们合进集成分支。

## 4. 各片做法

### N1 判断次数按 Bot 分来源

- `packages/daemon/src/admin/judge-usage.ts` 的 `judgeUsageView`：每个 Bot 每天累加时，同时按 `kind:id` 记 `sources`，写进 `day.bots[i].sources`；`count` 照旧是总和。排序和 `day.sources` 一样。
- 协议是可选字段：老 daemon 不发，新 UI 看不到 `sources` 时，Jev 面板不显示按 Bot 一栏，不拿总和冒充 Jev 的次数。
- 测试：一个 Bot 同一天有 `llm:codex-appserver` 和 `decision:typesafe` 两种记录时，`bots[0].sources` 两条、`count` 是和。

### N2 Claude Code 本机统计

- 新文件 `packages/daemon/src/agent/claude-agent/local-stats.ts`，`fetchClaudeUsageBundle` 返回时把结果放进 `profile.localStats`、`profile.dailyBuckets`（含 `messages`）、`lifetimeTokens`、`peakDailyTokens`、`currentStreakDays`、`longestStreakDays`。额度部分（`/api/oauth/usage`）照旧，两者互不阻塞：统计没好时额度照常返回。
- 算法照抄本机安装的 Claude Code（JP-VPS 上 2.1.319，`/home/operator/.local/share/claude/versions/2.1.319`）的 `/usage` → Stats，实现前先读它的打包代码核对，和下面不一致时以它为准，写进 PR：
  - 读 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/*/*.jsonl`，以及 `<项目>/<会话>/subagents/agent-*.jsonl`；主会话里 `isSidechain` 的行不算。配置目录的解析和 `usage.ts` 读认证用同一套。
  - 每条 assistant 消息的 Token = input + output + cache_read + cache_creation，按模型、按天累加；每天的消息数、会话数、工具调用数；按会话开始时间的本地小时计 24 格。
  - 天按 UTC 日期（`toISOString().slice(0,10)`），连续活跃从今天往回数。
  - 最长会话、活跃天数、最常用模型、峰值小时照它的定义。
- 只取计数字段，不读、不存、不记日志消息正文。
- 缓存：放 Vonvon 自己的数据目录（`config/paths` 里找合适的位置），按文件路径、大小、mtime 增量；到昨天为止的天数结果缓存，今天每次重算。不读写 Claude Code 自己的 `stats-cache.json`。
- 第一次扫在后台跑（流式读行、让出事件循环、限并发），期间 `state: 'scanning'`，UI 显示"正在统计本机 Claude Code 记录"；找不到配置目录或没有记录时 `state: 'unavailable'`。出错只记一行日志（不带路径以外的内容），额度照常返回。
- 远程设备和 Linux 服务器：统计的是 daemon 所在机器的 Claude Code，和执行任务的位置一致。
- 测试：用测试目录里手写的几份 jsonl（含子代理、sidechain、跨 UTC 日界、多个模型），断言每天 Token、消息数、会话数、连续天数、最常用模型、24 格；改一个文件的 mtime 后只重扫这个文件；扫描进行中返回 `scanning`。如果本机 `~/.claude/stats-cache.json` 存在，可以只读地拿它的数字和自己的结果对照，结果写进 PR，测试里不依赖它。

### N3 此刻页和用量面板

- `TodayHome.tsx`：`NowUsage` 挪到 `NowActivity` 前面；右上角在「添加 Bot」左边加「分享」按钮，只在 `window.vonvonShell?.share` 存在时显示（N5 接上之前先不显示）。
- `NowUsage.tsx` 和 `management/UsageContent.tsx`：按第 2 节重做三个面板。拆成可复用的组件（例如 `CodexUsagePanel`、`ClaudeUsagePanel`、`JevUsagePanel`、`QuotaColumn`），接受：
  - `progress?: number`（0 到 1，默认 1）：只显示前 `progress` 比例的天，累计数按已显示的天累加。N5 的分享卡用它做逐日累加；app 里不传。
  - `sections?: {habits?: boolean; quota?: boolean}`：默认都开；分享卡按分享框的开关传。
- 热力图沿用 `UsageHeatmap`，Claude 用消息数分级。Fable 等 `extras` 只有 `secondary` 时显示成正常的「<名字> 7 天限额」一行。
- Jev 图标：TypeSafe AI 官网 logo（`https://typesafe.ai` 的图标，品红圆底），缩到 64px 放 `packages/ui/public/agent-icons/typesafe.png`，`THIRD-PARTY-NOTICES.txt` 和 `agent-icons/README.md` 照现有格式补来源。
- 窄窗口（默认 910×808，以及更窄）下额度一栏换到下方，不挤压数字；按 `break-ui` 的思路试长技能名、0 用量、只有一个 Bot、老 daemon 没有新字段。
- 测试：沿用现有 UI 测试的写法，覆盖三个面板在完整数据、缺字段（老 daemon）、`scanning`、`progress=0.5` 下的输出，Jev 按 Bot 一栏在没有 `sources` 时不显示。

### N4 挂绳

**owner 2026-11-08 给了参考图，颜色、正反面和字以这里为准，任务说明里的"浅蓝 / Vonvon / more than a bot"作废：**参考图是 `/home/operator/vonvon/claude-work/now-share-1108/ref/lanyard-ref.png`（只在本机看，不进仓库，图里有人像）。挂绳是缎面织带，一面青绿色（浅蓝绿，照片里亮处约 `#4fb3b3`，正常处约 `#2f9a9c`，背光处约 `#1f6e70`，带缎面的光泽），另一面黑色（约 `#16191b`），黑色那面印青绿色的斜体手写风格字。owner 原话："颜色你就参考这个颜色。也是这样双面的，上面有字的……一面有什么字、另一面有什么字，你可以自行考虑。把字放在什么地方能够展示出来，或者感觉太小、没必要展示，你也可以把字去掉。工牌绳的宽度和工牌宽度的比例，不一定要完全按照这个示意图来。你在产品中展示时，调到一个合适的宽度就好了。"

- 默认做法：青绿面不印字；黑面印青绿色斜体字，内容从 `Vonvon`、`more than a bot`、`Vonvon · more than a bot` 里挑在实际大小下最好看、最能看清的；1 倍屏上看不清就不印。字体不引入新的网络字体，用系统里有的斜体或者把字做成 SVG 路径。
- `now-badges.css` 和 `NowBotBadge.tsx`：去掉 `.badge-cable`；`.badge-wire` 换成两股挂绳（SVG 或 CSS），从夹子往上渐渐淡出，随 `--swing` 一起摆。夹子保留。缎面光泽用顺着挂绳方向的细微明暗渐变，不要塑料感。
- 两面：挂绳在一个 `preserve-3d` 的容器里放正反两层，`backface-visibility: hidden`。做几版给 owner 选，至少：
  - A：工牌翻面时挂绳跟着同一条曲线（530ms `cubic-bezier(.24,.74,.2,1)`）转过去：正面青绿，背面黑色带字；
  - B：像参考图那样两股各露一面：左边青绿，右边黑色带字；
  - C：同 B，但挂绳中段有一处翻折，露出另一面（参考图里织带扭转的样子），做不好看就不交这一版。
- 宽度在产品里调到合适即可（大约每股 9 到 14px），不必照参考图的比例。
- 用真实代码渲染：构建 UI 后用 `/home/operator/vonvon/claude-work/now-share-1108/capture.mjs` 的办法（假 client、910×808、DPR 2）截每一版的首屏和两张工牌的特写（DPR 3），A 版再录一段悬停翻面的短 GIF。图放 `claude-work/now-share-1108/out/lanyard/`，由 Claude 放进飞书文档给 owner 选；选定后删掉没选的几版。
- `prefers-reduced-motion` 下不转、不摆。

### N5 分享

- 分享框（UI）：`reference/components/ui/Dialog`，右边是 `SettingsGroup`/`SettingsRow`、`Toggle` 和现有的勾选样式（用量那一组每行带 Provider 图标），左边是预览。按钮：生成后「保存 GIF」「在访达中显示」。是否支持「复制」由 Mac 上实测决定：能把动图粘进飞书就做，不能就不放。
- 分享卡（UI，新组件 `ShareCard`）：页头（品牌、日期）、「我的 AI 团队」、副标题（N 位 AI 同事 · 在 N 个飞书群上班）、真实的 `NowBotList`（同一套工牌和挂绳）、选中的用量面板（N3 的组件，传 `progress`、`sections`）、可选的群动态、底部一行。宽度和 app 内容区一样排版，录制时整体缩放。
  - 打码用一个 `ShareContext`：工牌背面的群名、群动态的群名、直属上级和账号名渲染成马赛克块；工牌背面的二维码和"去飞书找我"在分享卡里不渲染。不在 DOM 上事后替换文字。
- 录制（桌面端，`packages/desktop`）：
  1. 主窗口的 renderer 把分享需要的数据（snapshot 里的 Bot、群、绑定，用量数据，判断次数，分享框的选项）整理成一个可序列化的 `ShareModel`，经 `vonvonShell.share.record(model)` 交给主进程。
  2. 主进程开一个不显示的离屏窗口（`webPreferences.offscreen`，固定帧率，固定缩放），加载同一份 UI，带一个只渲染 `ShareCard` 的入口；离屏窗口不连 daemon，数据只来自 `ShareModel`。
  3. 卡片渲染好后，renderer 报回各工牌的位置；主进程用 `webContents.sendInputEvent` 让鼠标从左到右依次经过每张工牌（停留到翻面完成再离开），触发 app 自己的悬停翻面、摆动、倾斜和高光，和真实使用完全同一套代码。用量的逐日累加由 `ShareCard` 自己的时钟驱动，和鼠标路径同时开始。
  4. 主进程收 `paint` 帧，记每帧的时间戳；结束后把最终画面放第一帧，按实际时间间隔设每帧延时，用 `gifenc`（MIT）在 worker 里编码，不卡主进程。目标 3 秒左右、5MB 以内；超了就降帧率或缩放，不降到看不清。
  5. 关掉离屏窗口，临时帧只在内存里，不落盘。
- 网页端（包括浏览器打开的网页 UI）不显示分享按钮。
- 测试：`ShareModel` 的组装和打码（打开/关闭各开关时群名、人名、二维码的出现与否）；底部一行；主进程录制流程用假的 BrowserWindow 测调用顺序和出错时离屏窗口一定关闭；GIF 编码对几帧假数据的输出可解码、帧数和延时正确。真机录制交给 Mac 上的 Codex 验收。

## 5. 验收要点

- 此刻页在 910×808 首屏能看到工牌和用量；用量在群动态上面。
- 三个面板的每个数字都能在 daemon 返回的数据里找到来源；老 daemon（没有新字段）不报错，相应部分降级或隐藏。
- Claude 本机统计和 Claude Code 自己 `/usage` → Stats 的数字一致（同一台机器、同一时刻对照，允许当天的差异）；不读写 Claude Code 的文件；不记录消息正文。
- Fable 一行正常显示成 7 天限额。
- 分享 GIF 里的工牌翻面、摆动和 app 里鼠标悬停时一样；打码开关各自生效；设备名、Bot 的飞书二维码、消息内容不出现。
- 关掉分享框或录制失败后没有残留的离屏窗口和进程。
- diff 里没有真实 id、密钥、本机路径。

## 6. 风险和行数

- N2 第一次扫的耗时和内存：JP-VPS 上约 2.9GB、1,800 多个文件。要流式、可中断、限并发，退出时停掉。
- N5 离屏渲染在 macOS 和 Windows 上的帧率、缩放和 `sendInputEvent` 行为要真机验证；Mac 先验，Windows 之后再说。
- 估计行数：N1 约 100，N2 约 600，N3 约 900，N4 约 300，N5 约 1,200（不含测试）。都在一个审查者读得完的范围内。
