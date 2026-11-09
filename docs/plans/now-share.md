# 此刻页改版和分享 GIF（now-share）

2026-11-08 起。设计讨论和效果图在 owner 的两份飞书文档里（此刻页改版和分享 GIF 效果图；分享图底部一行：文案和样式备选），本计划只写已定的结论和怎么做。集成分支 `claude/now-share-integration`，各片 PR 合进它，最后开一个集成 → dev 的 PR，`frozen` 只打一次。

**2026-11-09 owner：分享暂缓。** 看了真实发到飞书的 GIF 后说"感觉也没什么特别的，目前还不会勾起我分享的欲望"，此刻页的改动都要。N5（#750、#751、#752、#754）已从集成分支撤下，分两个提交（bc2bb0ba 撤回四个 PR；d8adda39 去掉接口和「分享」按钮）。N5c 里给飞书 SDK 错误日志去掉请求内容和 open_id 的改动单独留下（3256a000）。以后要做，先 revert d8adda39，再 revert bc2bb0ba；后者会碰到 `bridge-channel.ts` 里留下的日志打码，冲突时保留现有的打码和测试，并把这里和下文的"暂缓"标记一起去掉。此刻页（N1–N4、N2b）照常合入 dev。N5 的设计留在第 4 节备查。实测记下的：飞书收了 1582×1879 和 2100×160 的 GIF（文档写 GIF 不超过 2000×2000，上传时没拒）；默认 4 个 Bot 的 GIF 每秒 20 帧约 5 MB，JP-VPS 上录约 18 秒。

## 1. 做什么

此刻页：用量移到群动态上面；Codex、Claude Code、Jev 三个用量面板各按自己的数据重做；工牌去掉横贯的线，改成往上淡出的挂绳。（分享，暂缓）右上角加「分享」：生成一张约 3 秒的 GIF，内容和样式与 app 里一样，工牌翻面用 app 里真实的悬停效果，用量一天一天加上来。

## 2. 已定的产品行为（owner 2026-11-08）

- 此刻页顺序：工牌 → 用量 → 群动态。标题旁不加说明行。（分享，暂缓）右上角「分享」在「添加 Bot」左边。
- 用量面板：
  - Codex：左边四个数（累计 Token，下注会话数；连续活跃，下注最长；峰值单日；最长单任务），中间 13 周每日 Token 热力图，右边额度一栏（套餐、读取时间、每个窗口的百分比、进度条、重置时间，用到 90% 及以上变警示色）。下面一行：常用技能前 3、推理强度、Fast 模式。
  - Claude Code：左边四个数（累计 Token，下注最常用模型；连续活跃，下注最长和共活跃天数；会话，下注消息数；最长会话，下注消息数），中间 13 周每日消息热力图（分级按 Claude Code 的 p25/p50/p75），右边额度一栏（含 Fable 7 天限额，修掉现在"暂不可用"的错）。下面一行：各模型 Token 占比条、24 小时会话开始分布和"最常在 N 点开工"。数据按 Claude Code 自己 `/usage` → Stats 的算法从本机记录统计（N2）。
  - Jev：Tab 前加 TypeSafe AI 的 logo。左边四个数：今天判断（截至几点）、14 天合计（日均）、最忙一天（日期）、昨天。中间 14 天柱状图（紫色，今天加深并标数）。右边按 Bot 分 14 天只算 Jev 的次数，只有一个 Bot 或 daemon 太旧拿不到分来源时不显示。底下一行说明 Jev 是什么。所有数都来自 daemon 的判断记录，不臆造。
  - app 里没有逐日累加的动效。（分享，暂缓）分享时才有；除此之外，分享图里的用量和 app 里内容、样式一样。
- 挂绳（owner 2026-11-08 看了四版渲染后定）：去掉横线，每张工牌挂两股缎面挂绳，往上渐渐淡出，颜色照参考图。一股青色、一股黑色，黑色那股印青色斜体字。正面和背面的字合起来是「Vonvon More than a bot」（例如正面 `Vonvon`，背面 `More than a bot`）。工牌翻面时挂绳也要看得出翻过去了：每股在原地翻到另一面，所以青、黑两股换边，字换成另一面的；不拧转。1 倍屏上字太小，不印。
- （分享，暂缓）分享框（用 app 现有的设置分组、开关、勾选组件）：
  - 显示：工牌（开）；用量多选 Codex / Claude Code / Jev（最近 7 天有用量的 Provider 默认勾选，Jev 默认不勾）；使用习惯（关）；额度和套餐（关）；群动态（关，最近 3 条）。
  - 打码：群名称（开，工牌背面和群动态都管；群头像不打码）；人名（开：直属上级、账号名；Bot 名不打码）。
  - 始终不出现：设备名、窗口外框、Bot 的飞书二维码和"去飞书找我"、消息内容。标题固定「我的 AI 团队」。
- （分享，暂缓）分享图底部一行（owner 2026-11-08 定）：用第一份文档里分享 GIF 的那版底部，调得不显眼。
  - 左边两行：`vonvon.cc`；「给你的 飞书 也招几位 AI 同事」，"飞书"用官网带图标的写法，没有"群"字。
  - 右边：两行小字「扫码了解 Vonvon Bot」「在电脑上下载使用」，旁边一个小二维码，扫到 `https://vonvon.cc/?utm_source=share`。
  - 上面一条很淡的分隔线。文字全用灰色系，网址也不用正文黑。二维码约 42px，保持能扫。
  - 参考图：`claude-work/now-share-1108/out/foot/share-still-lanyard-final.png`。
- （分享，暂缓）多设备（owner 2026-11-08 定）：只分享当前设备，也就是此刻页左上角选中的那台设备上的 Bot 和用量；不做多设备合并，图里也不出现设备信息。
- GIF 里没有鼠标光标：看图的人只看到工牌自己依次翻面、摆动，Bot 多于 4 个时工牌栏自动往后滚，最后滚回开头。
- （分享，暂缓）GIF：先做桌面端，网页端不显示分享按钮。约 3 秒循环，第一帧是最终画面。
- （分享，暂缓）GIF 的做法（owner 2026-11-08 同意）：不是录屏幕。app 在看不见的离屏窗口里用自己的组件画分享卡，用模拟的指针和滚动触发真实的翻面、摆动和高光；动画时钟放慢后取帧，再按真实时间拼成 GIF，所以电脑忙也不掉帧。生成时显示进度。不另写一套绘图代码。
- （分享，暂缓）分享出口（owner 2026-11-08 定）：只做「复制」和「发到飞书」两个按钮。
  - 不做「保存」按钮、不做系统分享菜单（电脑上没有手机那样通用的分享框）、不在 app 里做飞书会话选择（Vonvon 只有 Bot 的身份，发不进用户自己的聊天）。
  - 复制：GIF 先写成文件放在 app 自己的目录，再以文件的形式放进剪贴板，粘进飞书、微信电脑版。复制成功的提示里带一个小的「在访达中显示」（Windows「在资源管理器中显示」）。粘进去是不是会动的图，Mac 和 Windows 实测；有一边只能粘成附件，告诉 owner。
  - 发到飞书：由所选 Bot 私聊发给它的一位管理员。Vonvon 不知道坐在电脑前的是谁，所以弹窗写明「由 <Bot> 私聊发给 <名字>」。默认 Bot 是上次用的，否则第一位；默认收件人是创建者（仍是管理员时），否则名单第一位；有几位管理员时点名字换人；本机记住上次的选择。只列已连接、有管理员的 Bot；一个都没有时按钮不可用，说明原因。
  - 飞书返回成功才显示「已发到 <名字> 和 <Bot> 的私聊」，旁边「打开飞书」直接打开这个 Bot 的聊天（复用工牌背面「去飞书找我」的链接）。失败写明原因（Bot 没连上、这个人不在应用的可用范围里、图太大等），不显示成功。
  - （分享，暂缓）GIF 不超过 10 MB（飞书图片上限）。
- 手机网页（之后做网页远程连接时再定）：手机浏览器录不了和 app 一样的动图；手机上可能只出静态图，或者请电脑上的 Vonvon 录好再发到飞书。这次不做。

## 3. 切片

| 片 | 内容 | 依赖 |
|-|-|-|
| N0 | 本计划和协议字段（`profile.localStats`、`dailyBuckets[].messages`、`judgeUsage` 的 `bots[].sources`） | — |
| N1 | daemon：判断次数按 Bot 分来源 | N0 |
| N2 | daemon：Claude Code 本机统计 | N0 |
| N2b | daemon 和 UI：Claude 用量补上 Claude Code 清理掉的历史；没有订阅额度时照常显示统计，额度一栏写明原因 | N2、N3 |
| N3 | UI：此刻页顺序、三个用量面板、Fable 一行、Jev 图标 | N0；数据来自 N1、N2，没有时降级 |
| N4 | UI：挂绳几版，owner 选后定稿 | — |
| N5a | UI：`ShareModel`、打码、`ShareCard`、离屏窗口的分享卡入口、分享框（选项、预览、复制、发到飞书、收件人）（暂缓，已撤下） | N3；接口见 N5 |
| N5b | 桌面端：离屏录制、GIF 编码、复制成文件、在访达中显示（暂缓，已撤下） | 接口见 N5 |
| N5c | daemon：可发的 Bot 和收件人、分块上传、由 Bot 私聊发图（暂缓，已撤下） | 接口见 N5 |

N1 小，和 N3 一起做（同一个 PR 也可以）。N2、N3、N4 并行。N5 拆成三片并行，接口（协议、`vonvonShell.share`、离屏窗口的 `vonvonShareCard`）先由 Claude 提交到集成分支，三片照着接；N5a 用 N4 定稿后的工牌，不需要等 N4 合入也能开始。

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
- 缓存：放 Vonvon 自己的数据目录（`config/paths` 里找合适的位置），按文件路径、大小、mtime 增量；到昨天为止的天数结果缓存，今天每次重算。不写 Claude Code 自己的 `stats-cache.json`（N2b 起只读它补历史，见下）。
- 第一次扫在后台跑（流式读行、让出事件循环、限并发），期间 `state: 'scanning'`，UI 显示"正在统计本机 Claude Code 记录"；找不到配置目录或没有记录时 `state: 'unavailable'`。出错只记一行日志（不带路径以外的内容），额度照常返回。
- 远程设备和 Linux 服务器：统计的是 daemon 所在机器的 Claude Code，和执行任务的位置一致。
- 测试：用测试目录里手写的几份 jsonl（含子代理、sidechain、跨 UTC 日界、多个模型），断言每天 Token、消息数、会话数、连续天数、最常用模型、24 格；改一个文件的 mtime 后只重扫这个文件；扫描进行中返回 `scanning`。如果本机 `~/.claude/stats-cache.json` 存在，可以只读地拿它的数字和自己的结果对照，结果写进 PR，测试里不依赖它。

### N2b Claude 用量补历史、没有额度照常显示

owner 2026-11-08 同意的方向。

- 补历史：Claude Code 按 `cleanupPeriodDays`（默认 30 天）删掉旧记录，它自己的 `/usage` 靠配置目录里的 `stats-cache.json` 留着全部历史。Vonvon 第一次扫描以前删掉的记录，从这个文件补。
  - 只读：不写、不锁、不另存，只取用到的数（不取会话 id 和费用）。用 zod 校验形状（版本 1 到 5）；文件不在、读不了、形状不对或超过 16 MiB 时只用记录，记一行带错误码的日志，原因不变就不再记。
  - 合并：到它的 `lastComputedDate` 为止（最晚到昨天，今天总是重算），它和 Vonvon 各自只数了自己读到的记录，所以每一项取两边较大的那个，不会重复计数。逐天的消息数和每个模型的 Token 逐天取大；会话总数和 Vonvon 在那天以前开始的会话比；24 小时分布没有按天的数，整组取会话多的那边；最长会话取更长的；各模型累计 Token 取它的 `modelUsage` 和逐天加总中较大的。之后的天只用 Vonvon 自己的统计，和 `/usage` 的算法一样。
  - `dailyModelTokensVersion` 低于 5 的逐天 Token，Claude Code 会用剩下的记录重建，这里不用，只用它的模型合计。本机一份记录都没有时照旧是 `unavailable`，Claude Code 这时也不显示统计。
- 没有订阅额度：用 API 接入（API key、Bedrock、Vertex、自定义地址）、没读到订阅登录、凭据过期或者读取失败时，Claude 用量照常返回本机统计，`usage.unavailable` 写明原因（`reason` 是 daemon 的 `UsageErrorKind`，`message` 是额度一栏的那句话），额度一栏不显示读取时间和空的限额。读取失败、同一份凭据 10 分钟内读到过额度时，照旧给上次的额度和它的读取时间。此刻页对 API 接入的 Claude 也读用量。
- 兼容：老 daemon 照旧报错，新界面显示它给的原因；老界面收到新 daemon 的回复，额度一栏显示成限额暂不可用，统计照常。
- 测试：补历史没有重复计数、缓存不在、形状不对、缓存比记录新或旧、逐天 Token 版本旧；每种没有额度的情况有统计和没统计各一遍；额度一栏的文案。真实数据只读对照，并用部分记录加缓存副本模拟删掉的历史，结果写进 PR。

### N3 此刻页和用量面板

- `TodayHome.tsx`：`NowUsage` 挪到 `NowActivity` 前面；右上角在「添加 Bot」左边加「分享」按钮，只在 `window.vonvonShell?.share` 存在时显示（N5 接上之前先不显示；按钮已随 N5 撤下）。
- `NowUsage.tsx` 和 `management/UsageContent.tsx`：按第 2 节重做三个面板。拆成可复用的组件（例如 `CodexUsagePanel`、`ClaudeUsagePanel`、`JevUsagePanel`、`QuotaColumn`），接受：
  - `progress?: number`（0 到 1，默认 1）：只显示前 `progress` 比例的天，累计数按已显示的天累加。N5 的分享卡用它做逐日累加；app 里不传。
  - `sections?: {habits?: boolean; quota?: boolean}`：默认都开；分享卡按分享框的开关传。
- 热力图沿用 `UsageHeatmap`，Claude 用消息数分级。Fable 等 `extras` 只有 `secondary` 时显示成正常的「<名字> 7 天限额」一行。
- Jev 图标：TypeSafe AI 官网 logo（`https://typesafe.ai` 的图标，品红圆底），缩到 64px 放 `packages/ui/public/agent-icons/typesafe.png`，`THIRD-PARTY-NOTICES.txt` 和 `agent-icons/README.md` 照现有格式补来源。
- 窄窗口（默认 910×808，以及更窄）下额度一栏换到下方，不挤压数字；按 `break-ui` 的思路试长技能名、0 用量、只有一个 Bot、老 daemon 没有新字段。
- 测试：沿用现有 UI 测试的写法，覆盖三个面板在完整数据、缺字段（老 daemon）、`scanning`、`progress=0.5` 下的输出，Jev 按 Bot 一栏在没有 `sources` 时不显示。

### N4 挂绳

**定稿（owner 2026-11-08 看了 A 到 D 四版后定，以本段为准，下面的几版只是过程）：**一股青色、一股黑色（B 的排法），不拧转。黑色那股印字，正面和背面合起来是「Vonvon More than a bot」（正面 `Vonvon`，背面 `More than a bot`，正面可以露一点后面的字再淡出）。工牌翻面时，每股挂绳在原地翻到另一面：随工牌的 530ms 曲线压扁成一条边再展开，青、黑两股换边，字换成另一面的；`prefers-reduced-motion` 下直接换。悬停时工牌还会左右摆：挂绳、夹子和工牌作为一个整体，绕两股挂绳在顶上汇合的点摆动，像挂在脖子上的工牌；任何一帧挂绳都和夹子连着；挂绳跟着工牌小幅的偏转和俯仰，但不跟着翻面转 180°；挂点变高、绳变宽以后，摆动的弹簧和幅度按"布挂绳"的感觉重新看一遍。没选的几版删掉。

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

### N5 分享（2026-11-09 暂缓，代码已撤下）

**接口**（Claude 先提交到集成分支，三片照着写；要改形状，先在 PR 里说明）：

- 协议（`packages/protocol/src/admin.ts` 的 admin 请求，daemon 先答 unsupported，N5c 实现）：
  - `shareTargets` → `{kind:'shareTargets', bots:[{agentId, name, connected, recipients:[{openId, name?, creator}]}]}`。`recipients` 是这个 Bot 的管理员名单，名字和管理员页同一来源。
  - `shareStart {agentId, openId, bytes, sha256}` → `{kind:'shareUpload', uploadId, received:0}`；`sharePart {uploadId, index, data}`（base64，每块原始数据不超过 `SHARE_PART_BYTES` 即 1 MiB，从 0 按序）→ `{kind:'shareUpload', uploadId, received}`；`shareSend {uploadId}` → `{kind:'shareSent', messageId}`。失败一律 `refused`，`code` 见 N5c。
  - 分块是因为 WebSocket 每帧上限 4 MB（`server/ws.ts`、`secure-socket.ts`），GIF 最大 10 MB；而且当前设备可能是远程设备，不能传本机路径。
- 桌面外壳：`ShellCapabilities.share`（类型 `ShareShell`、`ShareRecording`，在 `packages/ui/src/client-context.tsx`），N5b 在 preload 里实现：`record(model, onProgress)`、`copy(id)`、`reveal(path)`、`bytes(id)`、`discard(id)`。
- 离屏窗口的分享卡入口：离屏窗口加载同一份 UI，地址带 `#share-card`，页面（N5a）只渲染 `ShareCard`，数据只从 `window.vonvonShareCard`（类型 `ShareCardBridge`，N5b 的 preload 提供）拿，不连 daemon：`model()` 原样拿到 `record()` 收到的 `ShareModel`；首帧画完、图片和字体都好了以后调 `ready(layout)`（`ShareLayout`：卡片尺寸、各工牌和工牌栏的位置、栏的 `scrollWidth`/`clientWidth`），它 resolve 时录制开始，卡片从这时起跑用量累加的时钟。

**N5a（UI）**

- `ShareModel`（可序列化）：日期、Bot（工牌要的全部字段）、各 Bot 的群（名称、头像）、选中的用量（各 Provider 的用量返回、判断用量）、群动态（开了才带，最近 3 条）、选项（sections、打码开关）、底部二维码网址。由主窗口 renderer 从 snapshot 和已拉到的用量组装。打码在组装时就做：群名、人名换成同长度的占位，分享卡把占位画成马赛克块，真名不进离屏窗口。
- `ShareCard`：页头、「我的 AI 团队」、副标题、真实的 `NowBotList`（同一套工牌和挂绳）、选中的用量面板（N3 组件，传 `progress`、`sections`）、可选群动态、底部一行（§2）。工牌背面的二维码和"去飞书找我"不渲染。`progress` 由卡片自己的时钟驱动（`requestAnimationFrame`、`performance.now`，录制时放慢的就是它）。
- 分享框：`reference/components/ui/Dialog`。左边是活的 `ShareCard` 预览（缩放放进去，能悬停翻面）；右边 `SettingsGroup`/`SettingsRow`/`Toggle` 和现有勾选样式（默认值见 §2）。下面一行「由 <Bot> 私聊发给 <名字>」，Bot 和人可以换（§2），数据来自 `shareTargets`。按钮「复制」「发到飞书」（主按钮）。
- 点任一按钮：当前选项还没录过就先 `record`（按钮上显示进度），同一组选项复用同一份录制；改了选项就作废旧的；关掉分享框时 `discard`。
- 复制成功：提示「已复制，可以粘贴到飞书或微信」和「在访达中显示」（Windows 上是「在资源管理器中显示」）。发到飞书：`bytes` → `shareStart` → 逐块 `sharePart` → `shareSend`；成功提示「已发到 <名字> 和 <Bot> 的私聊」和「打开飞书」（`badgeUrl` 那条链接，经 `openExternalUrl`）；`refused` 显示 daemon 给的说明。
- 老 daemon（`shareTargets` 答 unsupported）：「发到飞书」不可用，写「这台设备上的 Vonvon Bot 升级后可用」；复制照常。
- 测试：组装和打码（每个开关开、关时群名、人名、二维码出不出现，真名不进 `ShareModel`）；默认值和记住上次的选择；录制复用和 `discard`；发送按块、失败提示；`#share-card` 入口只用 `vonvonShareCard` 的数据。

**N5b（桌面端，`packages/desktop`）**

- preload 实现 `share`，主进程一个 `ShareRecorder`。
- 离屏窗口：`show:false`、`webPreferences.offscreen`，自己的 preload 提供 `vonvonShareCard`；不连 daemon。卡片按 app 内容区的宽度排版，输出尺寸在 10 MB 内取看得清的最大值。
- 放慢时钟取帧：用 `webContents.debugger`（CDP）把 CSS 过渡和动画放慢（`Animation.setPlaybackRate`），同一倍数缩放页面的 `requestAnimationFrame` 时间戳、`performance.now` 和指针事件的时间戳；按动画时间等间隔取帧（约 20 帧每秒），每帧延时按动画时间算。要求：电脑再忙，帧与帧之间的动画时间也相等；翻面、摆动、挂绳翻面、名字滚动、用量累加都走同一个时钟。可以参考 N4 录悬停动图的办法（`claude-work/now-share-1108/n4/`），选在 Electron 里最稳的实现。
- 录制脚本：
  1. 卡片画好后，指针从左到右依次经过每张工牌，停留到翻面完成再离开，触发 app 自己的悬停翻面、摆动、倾斜和高光；用量逐日累加同时开始。
  2. Bot 多于 4 个（owner："GIF 是动图，可以横向滚动展示的呀，自动横向滚动"）：先经过开头 4 张，再用 `sendInputEvent` 的横向 `mouseWheel` 滚动工牌栏，指针继续经过新露出的每一张；全部经过后滚回开头，最后一帧和第一帧一样。用 app 自己的工牌栏和吸附，不另做动画；滚动停下后再挪一下指针，让悬停状态更新。
  3. 每张停留随数量缩短（约 0.35 到 0.5 秒）：4 个以内约 3 秒，8 个约 6 秒，最多约 10 秒。GIF 里没有光标。
- 编码：`gifenc`（MIT）在 worker 里；最终画面放第一帧；不超过 10 MB，超了先降帧率再降尺寸，不降到看不清；目标 5 MB 左右。
- `copy`：写到 `userData/share/` 下（文件名带日期时间），只留最近 10 个；Mac 把文件放进剪贴板（文件 URL，同时放 GIF 数据），Windows 放文件列表；`reveal` 用 `shell.showItemInFolder`。
- 清理：出错、超时（60 秒）或 `discard` 时离屏窗口一定关掉；帧和录制只在内存里，复制写出的文件除外。
- 测试：假 BrowserWindow 测调用顺序、超时和出错时窗口关闭；GIF 可解码、帧数和延时对；剪贴板按平台写对；JP-VPS 有 `xvfb-run`，能真录一次就看帧间隔。真机交给 Mac 上的 Codex 验收。

**N5c（daemon）**

- `shareTargets`：本机每个 Bot 的 `agentId`、名字、是否已连接、管理员名单（顺序照存盘）和名字（管理员页的来源）、谁是创建者。
- `shareStart`：Bot 存在且已连接；`openId` 在这个 Bot 的管理员名单里；`bytes` 不超过 10 MiB。每个连接同时只有一个上传，2 分钟没动静作废，连接断开就丢掉。`sharePart` 按序号收，总量不超过声明的。`shareSend` 核对字节数、`sha256` 和 GIF 文件头，用现有的图片上传（`im.v1.image.create`）和发消息（`receive_id_type=open_id`、`msg_type=image`）发出，返回 `messageId`，释放内存。同一个 Bot 同时只发一张。
- `refused` 的 `code`：`unknown_bot`、`bot_offline`、`not_admin`、`too_large`、`bad_image`、`upload_missing`（作废或不存在）、`feishu_failed`。`message` 是给用户看的中文，例如「这个人不在 <Bot> 的可用范围里，收不到私聊。」飞书的原始错误只进日志；日志不带 open_id 和图片内容。
- 权限：只给桌面端、网页这类主机客户端，私聊、群和评论里的 Agent 都不能调（`server/authz.ts` 已写成 deny）。
- 测试：各种拒绝、分块拼装、作废和断开清理、假飞书客户端的上传和发送。不做真实飞书发送，真发由 Claude 验收时做。

## 5. 验收要点

- 此刻页在 910×808 首屏能看到工牌和用量；用量在群动态上面。
- 三个面板的每个数字都能在 daemon 返回的数据里找到来源；老 daemon（没有新字段）不报错，相应部分降级或隐藏。
- Claude 本机统计和 Claude Code 自己 `/usage` → Stats 的数字一致（同一台机器、同一时刻对照，允许当天的差异），Claude Code 清理过旧记录也一样（N2b）；不写 Claude Code 的文件，只读它的记录和 `stats-cache.json`；不记录消息正文。没有订阅额度时统计照常，额度一栏写明原因。
- Fable 一行正常显示成 7 天限额。
- （分享，暂缓）分享 GIF 里的工牌翻面、摆动和 app 里鼠标悬停时一样；打码开关各自生效；设备名、Bot 的飞书二维码、消息内容不出现。
- （分享，暂缓）关掉分享框或录制失败后没有残留的离屏窗口和进程。
- （分享，暂缓）「复制」后能粘进飞书和微信电脑版（Mac、Windows 各试，是不是会动的图如实记录）；复制提示里的「在访达中显示」能打开文件所在位置。
- （分享，暂缓）「发到飞书」写明发给谁；发出后对方私聊里是会动的 GIF，「打开飞书」进到这个私聊；Bot 没连上、收件人不是管理员、图太大时有明确说明，不显示成功。
- （分享，暂缓）GIF 不超过 10 MB；电脑忙时录出来也不掉帧。
- 挂绳：悬停时整体绕顶上的挂点摆，挂绳始终连着夹子；翻面时两股原地翻面、换边换字。
- diff 里没有真实 id、密钥、本机路径。

## 6. 风险和行数

- N2 第一次扫的耗时和内存：JP-VPS 上约 2.9GB、1,800 多个文件。要流式、可中断、限并发，退出时停掉。
- N5 离屏渲染在 macOS 和 Windows 上的帧率、缩放和 `sendInputEvent` 行为要真机验证；Mac 先验，Windows 之后再说。
- 估计行数：N1 约 100，N2 约 600，N3 约 900，N4 约 300，N5a 约 800，N5b 约 600，N5c 约 350（不含测试）。都在一个审查者读得完的范围内。
- 「复制」粘进飞书、微信后可能只是附件而不是会动的图，要真机试；不行就如实告诉 owner，不硬做。
