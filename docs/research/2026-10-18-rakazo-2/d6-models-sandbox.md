> 原始深挖，没有逐条复核；和 report.md 冲突时以 report.md 为准。

# 模型和沙箱的选择

Rakazo 固定在 b884f43（`<home>/vonvon/references/rakazo-b884f43`），对照 vonvon-bot main 7db621a（比任务里写的 898d3c5 多一个纯文档提交 #386），还对照了 s23c 的草稿分支 `origin/claude/s23c-judge-settings`（#366，没合入）。Rakazo 只读源码，没有运行它的任何代码，也没有装依赖、没有联网。vonvon-bot 只读，没改。

标注：【确认】是读源码确认的；【推断】是从代码推出来的，没跑过。Rakazo 的路径相对上面的目录。

## 0. 结论

1. Rakazo 说的"自选模型和沙箱"，两件事的分量很不一样。模型是每个用户、每个 bot 都能选，有完整的目录、登录、备用模型和推理档位。沙箱（它叫 computer）的 provider 由部署者用环境变量 `SANDBOX_PROVIDER` 定，整个部署只有一个。用户能选的只有两处：建 bot 时选 Team 或 Private 电脑；桌面版第一次打开时，部署所有者在 Docker 和"用这台 Mac"之间选一次。【确认】
2. 对我们最有用的一条不在模型上，在文件交付上（新提交 22aed2a）。Rakazo 每一轮都把最近 3 个用户轮的附件复制进 bot 电脑的 `attachments/`，并在提示词里列出来。我们收到的文件放在全局的 `~/.vonvon-bot/inbound`，1 小时后删掉。这个目录在 macOS 上 Codex 的只读、读写档读不到，而被拉进的已有群默认就是只读档；它又是所有 bot、所有群共用的。建议改成按会话放的收件目录，作为只读的额外根交给会话（发现 1）。
3. 判断模型这块，我们 s23 的设计比 Rakazo 好。Rakazo 的 team-chat 判断默认用 bot 自己的主模型，推理模型按 medium 思考。要换只能改部署级的环境变量，provider 和 model 两个必须一起填。能借的是两个小规矩：推理档位在调用时按模型支持的档位收口；模型目录读不到时，保存设置不能把已存的档位清掉（发现 3）。
4. 模型目录缓存：Rakazo 的 Codex 目录 15 分钟过期，失败结果缓存 60 秒，过期的旧目录最多再用 4 小时，按账号分开存。我们两个后端的模型列表都是进程内永久缓存，`model/list` 只取第一页 50 条（发现 4）。
5. Rakazo 的文档直接写明"每个 bot 的文件夹只用来整理，不是安全边界"。我们 product.md 3.3 拿"每个群一个目录"当隔离理由，但完全访问档和 Claude 的只读、读写档都读得到别的群的目录。要在规格里说清楚，并把 s31 的 denyRead 候选范围扩大（发现 5）。
6. 没有值得照搬的 Rakazo 代码。能用的都是十几二十行的纯函数，而且档位集合、成本取向和我们不同，重写比带 Apache-2.0 归属更省事（第 4 节）。

## 1. 纠正上一轮

- **Slack 和外部渠道。** 上一轮说"没有 Slack 一类外部渠道"（`docs/research/2026-10-17-rakazo/product-ux.md:112`；上一轮的交接笔记（本机，不在仓库） §2），这是错的。e55263f 里已经有 `apps/api/src/team-chat-bridge.ts`（1297 行）和 `team-chat-judge.ts`（342 行），我用 `git show e55263f:` 核过行数。这不是后来加的功能，是上一轮漏看了。除 team-chat 外，还有 iMessage、SMS、WhatsApp、Telegram、飞书（只有私聊）这些个人线路，以及 Composio 的 Slack 连接器工具。
- **"有 model OAuth（`packages/core/src/model-oauth.ts`）"**（交接笔记 §2）不准确。这个文件只有 47 行，是界面轮询登录结果的小工具（`waitForModelOAuthCompletion` `:28-43`）。真正的订阅登录在 `packages/adapters/src/pi-oauth.ts`（1225 行，`SUBSCRIPTION_SIGN_IN_PROVIDERS` `:35-70`：ChatGPT Plus/Pro 和 Copilot、xAI 走设备码，Claude Pro/Max 走授权链接）和 `pi-anthropic-oauth.ts`（152 行）。
- **沙箱"没有列出具体有哪些 provider"**（交接笔记 §2）：工厂在 `packages/adapters/src/sandbox-factory.ts:43-100`，有 none、e2b、daytona、createos、box、railway、docker、desktop、fake，另有三个 emulator。provider 是部署级的环境变量，不是用户按 bot 选的（`docs/self-host-sandbox-providers.md:3-15`）。
- **"provider fallback 没审计"**（`runtime-state.md:71`）：这次审了，见发现 6。
- **判断的"低成本"**（`product-ux.md:49` 只说上下文受限、没工具、默认不说话）：漏了它用的是哪个模型。`team-chat-judge.ts:198-228` 依次取环境变量覆盖（`.env.example:209-211`，provider 和 model 两个都填才生效）、bot 自己的模型、凭据默认模型、部署默认模型。调用时不传思考档位，推理模型按 `pi-runtime.ts:128-136` 用 medium。所以"low-cost"只指上下文短，模型并不小。【确认】
- **任务里的"中途换模型"**：Rakazo 没有用户在一轮跑着时换模型的入口。改 bot 的模型从下一轮生效（`model-selection.ts:358-379` `runModelChoice`，只有 routine 的运行会钉住创建时的模型）。一轮里换模型只有一种情况：自动切到备用模型（发现 6）。【确认】

## 2. Rakazo 怎么做

### 2.1 模型

- **目录**：常用 provider 排前面（`packages/core/src/model-providers.ts:46-75`，openrouter、openai-codex、anthropic、openai、google、vercel-ai-gateway），当前选中的 provider 一定显示。选中 provider 后预选的模型先按完整 id 匹配，再按去掉厂商前缀的 basename 匹配（`:87-102`）。展示名会换算成 API id，比如 DeepSeek 的"DeepSeek-V4.1-Flash"换成 `deepseek-flash`，目录里没有的 id 原样保留（`:176-195`）。【确认】
- **按登录方式过滤**：ChatGPT 订阅登录调不了 `gpt-5.3-codex-spark`，用 API key 才能调（`packages/adapters/src/pi-catalog-availability.ts:6-44`）。Codex 的实时目录直接问 ChatGPT 后端 `chatgpt.com/backend-api/codex/models`，按账号缓存（`pi-codex-catalog.ts:12-37`）：15 分钟过期，失败结果缓存 60 秒，冷读最多等 1.5 秒；刷新一直失败时，过期的旧目录最多再用 4 小时，之后退回静态目录，"免得后端下架的模型一直能选"。【确认】
- **OpenAI 兼容端点**：填服务器地址后"Find models"，探测 `/models`（`pi-openai-compatible-provider.ts:432-483`）。5 秒超时，不跟随重定向，带 key 时要求 HTTPS，响应体和条数都有上限，失败提示改成手填。eae4a98 把上限从 64 KiB、500 条放大到 2 MiB、4000 条（`:45-56`），因为聚合类端点的目录被截断后会报"too many"。7f9b9ad 只是给这段补了注释。每个模型能不能看图片，按模型 id 单独存（`model-connect.ts:54`、`:78`，`model-vision.ts:22-50`）。【确认】
- **选择规则**：`selectConfiguredModel`（`model-selection.ts:433-472`）规定 provider、model、凭据三者一起生效；凭据里存的思考档位只在它绑定的那个模型上用；覆盖项不可用时，档位丢掉、不带到默认模型上。界面上，模型目录加载失败时不把 ready 标记设上，免得保存时把已有的思考档位覆盖成空（`apps/web/src/pages/shell/bot-panel.tsx:296-299`）。【确认】
- **档位收口**：`clampCatalogThinkingLevel`（`model-providers.ts:24-44`）先找完全相同的档；没有就往高找，再往低找；模型不在目录里时原样保留。运行时 `thinkingLevelFor`（`pi-runtime.ts:128-136`）还会再收口一次。【确认】
- **界面**：模型设置顶上一行写"Active model · provider · Thinking: X"；用的是部署默认时写"Configured by deployment"（`apps/web/src/pages/ModelSettingsOverlay.tsx:1163-1181`）。【确认】

### 2.2 沙箱（computer）

- **谁选**：部署者用 `SANDBOX_PROVIDER` 选 provider。用户能选的只有两处：
  - 建 bot 时选 Team 或 Private 电脑（`bot-panel.tsx:54-87`），默认 Team（`:107`）。界面上只有两个词，不解释差别。
  - Electron 桌面版第一次打开时，一个必须选的对话框问"Where should bots run?"（`apps/web/src/pages/HostComputerPrompt.tsx:88-127`）。不预选。说明写了后果："Docker limits access to your computer… Using this Mac lets bots work with your local files and tools"，以及"Local access lets bots run commands without asking. Avoid it on shared or public servers."。只有部署所有者、并且 `SANDBOX_PROVIDER=docker` 时才出现（`apps/api/src/router.ts:6400`、`:1061-1068`）。网页里写这个设置的只有这个对话框，之后没有改的地方（grep `deployment.update` 只命中这里）。【确认】
- **"this Mac" 是什么**：`host-aware-sandbox.ts:19-48`。选了 this-mac，就换成 `DesktopSandboxProvider`，`hostRoots: [homedir()]`，命令的起始目录可以是 home 下任何地方。【确认】
- **desktop provider 的边界**：
  - 命令只检查起始目录在允许的根下面（`desktop-sandbox.ts:131-136`），然后 `spawn(..., { shell:false, env: sandboxCommandEnvironment(request, process.env) })`（`:717-722`）。子进程拿到 API/worker 进程的全部环境变量，只去掉明确列出的几个。
  - 文件工具的防逃逸做得细：realpath 检查、`O_NOFOLLOW`、持有父目录 fd、检查 inode，测试覆盖了符号链接、硬链接、lstat 之后被换、mkdir 过程中父目录被换等竞争（`desktop-sandbox-write-containment.test.ts:83-316`）。
  - 结论和上一轮一样：shell 不受限，不是隔离。【确认】
- **Team 电脑**：`docs/computer-runtime.md:17` 写明"These folders organize work but are not security boundaries: every Team bot can access the full Team workspace"；`:34` 写"The computer container is the security boundary… Use separate computers when workloads require isolation"。【确认，文档】
- **出网**：Docker 下有 `SANDBOX_COMPUTER_EGRESS=restricted`。它用 iptables 挡住宿主机、RFC1918、CGNAT、链路本地和云元数据地址，公网照常能访问（`infra/compose/restrict-computer-egress.sh:2-24`）。【确认】
- **文件放到电脑上（22aed2a）**：
  - `materializeThreadFiles`（`thread-artifacts.ts:134-199`）把附件写成 `attachments/<artifactId><ext>`。
  - `materializeRecentThreadFiles`（`:201-231`）每一轮再复制最近 3 个带附件的用户轮的文件（`executor.ts:9270`），最多 4 个（`packages/contracts/src/attachments.ts:3`），已存在的不覆盖，读不到的跳过。
  - `currentTurnFilesInstruction`、`recentThreadFilesInstruction`（`:261-275`）把文件名（JSON 转义）、MIME、大小和路径列进提示词。调用处在 `executor.ts:3959-3995`。
  - 提交说明里的起因：bot 要把 Slack 里的图片附到工单上，电脑里却没有文件，它就去浏览器里登录 Slack。【确认】
- **看不了图的模型**：`modelAcceptsImageInput`（`model-vision.ts:87-106`）把目录里不认识的模型当成纯文本模型。纯文本模型的历史只保留 `[image:]` 标记，不放图片块，因为"Putting image parts in history makes the provider reject a follow-up that used to be text"（`executor.ts:6864-6871`）。截图类工具直接拒绝（`:4327-4329`）。【确认】

## 3. 发现与建议

| # | 题目 | 建议 | 影响切片 | 改承诺 | 把握 |
|---|---|---|---|---|---|
| 1 | 收到的文件放进会话读得到、按会话隔开的目录 | 采纳思路 | s37、s39、s31、s49、e03 | 是 | 高 |
| 2 | 按模型能不能看图决定图片怎么交 | 采纳思路 | s16 的后续、s42、s50 | 是 | 中 |
| 3 | 推理档位在调用时按模型收口，目录失败时不清档位 | 采纳思路 | s23c、s23d、s41、s42、s50、s54a | 否 | 高 |
| 4 | 模型列表缓存要过期，换登录要失效，`model/list` 要翻页 | 采纳思路 | s23c、s23d、s41、s42、s50 | 否 | 高 |
| 5 | 每个群一个目录不等于隔离 | 采纳思路 | s36、s31、s42、e03 | 是 | 高 |
| 6 | 备用模型、自动换模型 | 不采纳（v1） | 无 | 否 | 高 |
| 7 | 判断模型的默认值和覆盖层 | 我们已有 | s23c、s23d | 否 | 高 |
| 8 | "bot 跑在哪里"的选择和后果说明 | 我们已有 | s41、s42、s50 | 否 | 高 |
| 9 | 主机执行器的文件防逃逸 | 我们已有 | s40、s56a | 否 | 高 |
| 10 | s46 的会话令牌在运行卡里打码 | 采纳思路 | s46 | 否 | 中 |
| 11 | "使用默认模型"写明现在是哪个、从哪来 | 采纳思路 | s41、s42、s50 | 否 | 中 |
| 12 | 订阅登录、API key、兼容端点探测 | 不采纳 | 无 | 否 | 高 |
| 13 | 决策模型（Jev）的接口形状 | 不采纳（v1），留作 §10 参考 | 加决策模型的那片 | 否 | 中 |
| 14 | "只挡内网"的出网中间档 | 不采纳 | 无 | 否 | 高 |

### 发现 1：收到的文件放进会话读得到、按会话隔开的目录

- **Rakazo**：见 2.2 最后一条（`thread-artifacts.ts:134-275`、`executor.ts:3959-3995`、22aed2a）。文件按 bot 放进电脑的工作区；每一轮都重新列出最近 3 个用户轮的附件；文件本身作为 Artifact 长期保存，可以重新复制。
- **我们**：
  - `packages/daemon/src/bot/media.ts:241-246` 的注释写着：文件放在全局临时目录 `paths.inboundDir`（`packages/daemon/src/config/paths.ts:122-125`，即 `~/.vonvon-bot/inbound`），在任何项目 cwd 之外，"codex can read these files ONLY under the 'full' tier"，并说这是接受的限制。
  - `codex-appserver/backend.ts:52-73` 的 `sandboxParams` 在 macOS 上用 `:minimal` 加 `:workspace_roots`，读也限制在根里。
  - 文件 1 小时后删掉：`media.ts:33`、`:213-230`。`handle-message.ts:1922-1924` 把绝对路径织进触发消息，这条消息进了原生会话历史（`docs/product.md:222`）。
- **问题**：
  - (a) 【确认，代码加注释】被拉进的已有群默认只读档（`docs/product.md:461`）。在 macOS 上，用 Codex 的群里有人发 PDF 再 @bot，bot 读不到这个文件。
  - (b) 【确认】目录是所有 bot、所有群共用的。完全访问档，以及 Claude 的只读、读写档（读不受限，`claude-agent/permission.ts:22-28`），都读得到别的群上传的文件，和 3.3"每个群的文件和记忆分开"矛盾。
  - (c) 【推断】会话历史里留着路径，1 小时后文件没了，后面一轮再提到"刚才那个文件"就会失败。
- **建议**：
  - 按会话位置建收件目录，比如 `bots/<appId>/groups/<chatId>/inbox/`，私聊用 `bots/<appId>/inbox/dm/<open_id>/`。因为 3.3 规定 vonvon 不往工作区写文件（`docs/product.md:109`），所以放在 bot 目录下。
  - 照 3.6 记忆目录的办法（`docs/product.md:358`），由 s37 的 profile 作为只读的额外根交给会话，每一档都放行。Claude 一侧在 s31 的 denyRead 方案里给它 allowRead。
  - 保留时间跟着会话走，不用 1 小时，比如到 `/new` 或 7 天。
  - 学 Rakazo 每轮重列：触发消息下面列出最近 3 轮的文件，写清哪些还在、哪些已经清掉。
  - 文件名按 file_key 取，原名只出现在清单里。
- **工作量**：`media.ts` 约 80 行，s37 的 profile 加一个根约 20 行，Claude 沙箱的 allowRead 约 10 行，测试约 100 行。e03 在 Mac 上验 Codex 只读档读得到。

### 发现 2：按模型能不能看图决定图片怎么交

- **Rakazo**：`model-vision.ts:87-106`（不认识的模型当成纯文本模型）、`executor.ts:6864-6871`（纯文本模型的历史只留标记）、`model-connect.ts:54,78`（兼容端点按模型 id 记能不能看图）。
- **我们**：
  - Codex 的 `model/list` 回包里有 `inputModalities`（`packages/daemon/src/agent/codex-appserver/protocol/generated/v2/Model.ts`），但 `mapModel`（`codex-appserver/backend.ts:861-871`）把它丢了。
  - Claude 一侧 `claude-agent/thread.ts:209-220` 总是把图片转成 base64 图片块。SDK 0.3.296 的 `ModelInfo` 没有能不能看图的字段。
  - 手填 id 和网关（DeepSeek、Kimi 走 `ANTHROPIC_BASE_URL`，`docs/product.md:582`、s16）都没有图片能力的信息。
- **风险**【推断，要实测】：图片发给看不了图的网关模型，这一轮会报错。图片块进了原生会话以后，后面的纯文字轮可能也一直被拒，等于这条会话坏了。Rakazo 的注释说它们的 provider 就是这样。
- **建议**：
  - 先在 Mac 的 Bot 4（Claude 经 DeepSeek 网关）发一张图，看这一轮和下一轮的结果。用的是 M3 验收时已有的那个 bot。
  - 如果会话会坏：Codex 一侧保留 `inputModalities`，模型没有 `image` 就把图片当文件，走发现 1 的清单，交路径不交图片块；Claude 一侧在用网关、并且是手填 id 时，同样按文件交。设置页给手填的模型加"能看图片"开关，按模型 id 存。
- **工作量**：约 80 到 120 行。

### 发现 3：推理档位在调用时按模型收口，目录失败时不清档位

- **Rakazo**：`model-providers.ts:24-44`、`pi-runtime.ts:128-136`、`bot-panel.tsx:296-299`。
- **我们**：
  - s23c 草稿的 `resolveJudgeModel`（分支 `claude/s23c-judge-settings`，`packages/daemon/src/judge/model.ts:111-124`）设了档位就原样传。
  - `parseStoredJudge`（同文件 `:87-109`）只按后端的档位集合校验（`getSessionTitleEfforts`），不看这个模型支持哪几档。
  - main 的 `judge/model.ts:6` 写着 gpt-6-luna 只有 low 到 max，没有 minimal。
  - 会话侧的 `pickDefault`（`handle-message.ts:367-381`）遇到模型不支持的档位，退回模型的默认档，不找最近的一档。
- **问题**【推断】：存的判断设置是 `{gpt-6-luna, minimal}` 时会被原样发出，服务端很可能拒绝。如果这个错误被分类成结构化的 model 错，就会按"后端加模型"冷却 5 分钟（`docs/v1-plan.md:1061`），这个智能群隔几分钟就停一次。
- **建议**：调用判断前，模型在缓存的列表里，就把档位收进它支持的范围；手填的、不在列表里的照旧原样传，和 s16 的规矩一致。判断要省钱，所以方向和 Rakazo 相反：先完全相同，再往低，再往高。会话侧可以保持往高。桌面、网页和 `vonvon settings` 保存时，如果模型目录的 `state` 是 `fallback` 或 `unavailable`（`packages/daemon/src/admin/settings-types.ts:266-274`），不要因为选项列表为空就丢掉已存的档位。
- **工作量**：`judge/model.ts` 约 20 行，测试约 40 行，放进 s23c 或 s23d。

### 发现 4：模型列表缓存要过期，换登录要失效，`model/list` 要翻页

- **Rakazo**：`pi-codex-catalog.ts:12-37`，按账号缓存（`CodexLiveCatalog.read(userId, account)`）；eae4a98 的教训是上限设得太紧，聚合类目录会被截断。
- **我们**：
  - `codex-appserver/backend.ts:584-604` 和 `claude-agent/backend.ts:337-361` 拿到一次就永久缓存，失败时用静态列表、不缓存。
  - `model/list` 只发一次 `{ limit: 50 }`，没看 `nextCursor`（`backend.ts:589`；协议见 `protocol/generated/v2/ModelListResponse.ts`）。
  - s16 留下的问题写着"改了用户设置里的 ANTHROPIC_MODEL 要重启 daemon 才进模型列表"（`docs/v1-plan.md:578`）。
- **问题**：主人升级 Codex、在 ChatGPT 登录和 API key 之间切换、改 `~/.claude/settings.json` 以后，`/model` 卡、设置页和判断默认值（`codexJudgeDefault` 用列表找 `*-luna` 和最低档）都还用旧列表，直到 daemon 重启。
- **建议**：成功的结果 15 分钟过期，失败的 60 秒；登录状态变了，或者 codex 二进制指纹变了（s23b 已经在算），就作废缓存。`peekModels` 保持"只看缓存、不等"的语义，判断路径不受影响。`model/list` 按 `nextCursor` 翻页，设一个宽松的总上限，比如 500。超了就把 `ModelCatalog.state` 标成 `fallback`，并写明原因，不悄悄截断。
- **工作量**：两个后端合计约 50 行，测试约 60 行。

### 发现 5：每个群一个目录不等于隔离

- **Rakazo**：`docs/computer-runtime.md:17`、`:34`，文档直说文件夹不是边界，容器才是。
- **我们**：`docs/product.md:106` 拿"每个群默认有自己的目录"当理由，说共用目录 B 群就能看到 A 群的文件。实际能不能读到，要看权限档和后端：
  - Codex 的只读、读写档只在 macOS 上限制读（`codex-appserver/backend.ts:39-50`）。
  - Claude 的只读、读写档不限读（`claude-agent/permission.ts:22-28`）。
  - 完全访问档什么都能读，而 bot 自己建的群默认就是完全访问（`docs/product.md:461`）。
  - 第 9 节第 20 项给 s31 的 denyRead 候选只挡数据目录里的 `bots/` 和凭据，没包括 `projects/<bot 名>/groups/` 下别的群的默认目录。
- **建议**：
  - 3.3 补一句：分目录只在限读的档位下起隔离作用，完全访问档的群互相读得到。
  - s31 定 denyRead 时一并挡 `projects/`，再 allowRead 这一次会话的根。
  - 群详情页（s42）在权限档旁写一行后果，比如"完全访问：这台电脑上的文件都能读，包括别的群的目录"。
  - e03 在 Mac 上验一次。
- **工作量**：文档约 10 行，s31 的沙箱配置约 10 行，界面文案 2 行。

### 发现 6：备用模型、自动换模型（不采纳 v1）

- **Rakazo**：
  - Space 级的备用模型最多 10 个（`apps/web/src/pages/ModelBackupsSettings.tsx:329`），运行时在 `executor.ts:6936-6957` 读取。
  - 只在还没输出任何文字、工具调用或思考，并且错误是可重试的"provider 不可用"时才切（`pi-runtime.ts:2546-2566`）。
  - 候选模型要装得下当前上下文，图片和推理能力也要满足（`:2369-2420`）。
  - 切了以后推一条进度"Provider unavailable. Switched to backup model X."（`:380-403`）。【确认】
- **我们**：没有备用模型的承诺。网络类错误给［重试］（`agent/error-kind.ts:4-9`，product 3.12）。Claude Agent SDK 0.3.296 自带 `fallbackModel` 选项：注释说"primary model is re-tried at the start of each user turn"；settings 里也能写 `fallbackModel` 数组。我在 worktree 的 node_modules 里看过 `sdk.d.ts` 第 1684 到 1689 行和第 6920 到 6922 行。
- **理由**：v1 范围已定稿。真要做，也该用 SDK 的原生选项，不要自己重写。可以借两条规矩：只在没有任何可见输出时切；运行卡上写明"主模型不可用，这一轮改用 X"。
- **一个要留意的点**【推断】：今天的会话 `settingSources` 是 `['user','project']`（`claude-agent/backend.ts:57`），主人在 `~/.claude/settings.json` 里写的 `fallbackModel` 大概已经生效。s44a 计划让新 bot 只读 project 层，那么新建的 bot 和导入的 bot 在这一点上会不一样。s44a 开工时顺手确认一下，不新增切片。

### 发现 7：判断模型的默认值和覆盖层（我们已有）

- **Rakazo**：`team-chat-judge.ts:131-228`。不带工具，历史为空，20 秒超时，出错一律不说话，用量记成 setup。模型取 bot 的主模型，或者部署级环境变量的覆盖；不按频道或 bot 单独设；不传档位，推理模型按 medium。
- **我们**：
  - main 的 `judge/model.ts` 默认 Codex 用 gpt-6-luna 最低档、Claude 用 haiku。
  - 决策表（`docs/v1-plan.md:1062`）写明了为什么不跟主模型走：判断用 Opus，额度要高一个数量级。
  - s23c 草稿还有群、bot、默认三层，网关时用网关的小模型（`claudeJudgeDefault`），以及结构化错误冷却。
- **结论**：不改。Rakazo 是反例，说明"跟着主模型走"在每条群消息都判断的场景下成本不可控。

### 发现 8："bot 跑在哪里"的选择和后果说明（我们已有）

- **Rakazo**：`HostComputerPrompt.tsx:88-127`，必须选、不预选、两句话写清后果；之后网页里没有地方能改。
- **我们**：
  - 权限档有 bot 默认，群可以覆盖，私聊默认读写、开网，理由写在决策表（`docs/v1-plan.md:1053`）。
  - Linux 首次运行清单有专门一步说明 Codex 只能用完全访问（`:1054`）。
  - 权限档随时能改，中途改不用重开会话（product 3.8）。
- **只借一点**：设置页的权限档选择旁边，学它用一两句话写后果，并入发现 5 的文案。

### 发现 9：主机执行器的文件防逃逸（我们已有）

- **Rakazo**：`desktop-sandbox.ts:300-330`、`:410-640`，以及 `desktop-sandbox-write-containment.test.ts:83-316` 的竞争用例。
- **我们**：
  - 发文件时 `provider/outbound/policy.ts:83-119` 用 realpath 判断在不在根里；`bot/outbound-files.ts:122-138` 用 `O_NOFOLLOW` 打开，并比对 size、mtime、ino、dev。
  - 记忆文件按 product 3.6 用 `O_NOFOLLOW`，要求硬链接数为 1，写新文件再 rename（`docs/product.md:359`）。
- **小补强**：`server/atomic-file.ts:10-12` 的临时文件用的是 `writeFile` 的默认 flag。s40、s56a 往 agent 写得到的记忆目录里写回时，可以改成 `flag: 'wx'`，存在就失败，不跟随。临时文件名带 UUID，被抢先的可能已经很小，所以只是补强。约 2 行。

### 发现 10：s46 的会话令牌在运行卡里打码

- **Rakazo**：bot 的命令变量按环境变量交给 shell。值本身、base64 形式和百分号编码形式都登记成要打码的串，命令输出里出现就替换掉（`packages/adapters/src/bot-secrets.ts:40-49`、`:155-180`）。【确认】
- **我们**：s46 每条会话发一个令牌，经环境变量交给 agent（`docs/v1-plan.md:927`），群会话也有。运行卡会显示工具输出，daemon 里还没有任何打码（grep `redact` 只命中无关的三处）。
- **问题**【推断】：agent 跑 `env` 或 `echo $VAR`，令牌就会出现在群里的运行卡上。
- **建议**：s46 生成令牌时，把令牌和它的 base64、URL 编码形式登记下来；运行卡渲染工具输出和最终回答前替换成"（会话令牌）"。约 30 行，放在 s46。

### 发现 11："使用默认模型"写明现在是哪个、从哪来

- **Rakazo**：`ModelSettingsOverlay.tsx:1163-1181`，显示"Active model · provider · Thinking"；继承部署默认时写"Configured by deployment"。
- **我们**：`packages/ui/src/settings/SettingsPanel.tsx:519` 只有"使用默认模型"；`ModelSelection` 的 `{kind:'default'}` 不带解析后的模型。默认模型可能来自 Claude 设置里的 `ANTHROPIC_MODEL`，s16 已经把它排到第一。
- **建议**：设置视图的 effective 里带上解析后的模型和来源（群覆盖、bot 默认、Claude 设置、后端默认），界面写成"使用默认模型（现在是 X，来自 …）"。s23c 草稿给判断已经有 `modelSource`，主模型照着做。约 40 行，放在 s41、s42、s50。

### 发现 12：订阅登录、API key、兼容端点探测（不采纳）

- **Rakazo**：`pi-oauth.ts`（凭据刷新，终止性错误判断 `:157-181`，ChatGPT 换账号的检测）、`model-selection.ts:73-198`（按凭据算哪些模型可用）、`pi-openai-compatible-provider.ts:432-483`（端点探测）。
- **理由**：我们不托管模型，登录、刷新和网关凭据都在用户本机的 Codex 和 Claude 里。要探测网关的 `/v1/models`，就得读用户的 `ANTHROPIC_AUTH_TOKEN`，等于 vonvon 去碰用户的凭据，不值得。手填 id 已经覆盖这个需求（s16）。

### 发现 13：决策模型（Jev）的接口形状（不采纳 v1）

- **Rakazo**：Auto Review（`packages/adapters/src/auto-review.ts:34-120`）有 llm、jev、scripted 三种校验器，共用一个接口。选了 jev 但没配 key 时，悄悄退回 llm。置信度低于阈值（默认 0.5，`.env.example:157-163`）就去问用户。默认超时 1.5 秒。【确认】
- **我们**：product §10 把"专门做判断的模型（Decisions API、Jev）"放在 v1 之后。s23 存设置时已经给 `judge.selection.kind` 留了位（`docs/v1-plan.md:793`）。
- **以后加的时候可以参考**：
  - 留一个离线测试用的 scripted 类型。
  - 没配 key 时不要悄悄退回，要在设置视图里显示"没生效，原因"，和我们"不悄悄降级"的一贯做法一致。
  - 置信度阈值对应到"不回"。

### 发现 14："只挡内网"的出网中间档（不采纳）

- **Rakazo**：`restrict-computer-egress.sh:2-24`，iptables 挡宿主机和内网，公网照常。
- **理由**：我们的沙箱是 Codex 的权限配置和 Claude 的 Seatbelt/bwrap，没法表达"公网放行、内网禁止"。s46 还要靠 127.0.0.1 让 agent 调 vonvon。daemon 自己取远程图片时已经做了地址分类（`provider/outbound/address.ts`，`policy.ts` 的 `classifyAddress`）。

## 4. 复用代码

这次不建议复制 Rakazo 代码。候选和不复制的理由：

- `clampCatalogThinkingLevel`（`packages/core/src/model-providers.ts:24-44`，21 行，无依赖）：它的档位集合是 off 加 minimal 到 max，我们的是 `none` 到 `ultra`（`agent/types.ts:19`）；判断还要反过来先往低找。重写大约 15 行。
- `recentAttachmentBlocks`（`thread-artifacts.ts:233-259`，27 行）：依赖 Rakazo 的 `MessageBlock`、Artifact 表。我们的数据形状完全不同。
- `commandRedactionForms`（`bot-secrets.ts:40-45`，6 行）：太短，复制不划算。

真要复制时照 Paseo 的先例：

1. 文件开头写两行，格式同 `packages/daemon/src/server/atomic-file.ts:1-2`："Adapted from elie222/rakazo <路径> at b884f43. Copyright Rakazo contributors. Licensed under Apache-2.0; see NOTICE."。
2. 根目录 `NOTICE` 加一段，写明来源仓库、提交和改了什么。
3. 在包里放一份 `LICENSE.rakazo`（Apache-2.0 全文和 Rakazo 的版权行），和 `packages/daemon/LICENSE.paseo` 一样。

Rakazo 根目录没有 NOTICE 文件（上一轮已查），所以不用转载它的 NOTICE。

## 5. 没做的和待验证的

- 没有运行任何东西。下面几条要实测：
  - Codex 收到模型不支持的档位时是否报错、报成什么错（发现 3）。
  - DeepSeek 网关收到图片块以后，这一轮和下一轮会怎样（发现 2）。
  - Codex 只读档能不能读额外根里的收件目录（发现 1，在 e03 里加一项）。
  - `fallbackModel` 写在 user 层设置里时，bot 会话认不认（发现 6）。
- 没读：`pi-runtime.ts` 里 Pi 自己的 `clampThinkingLevel`（外部包 `@earendil-works/pi-ai`，不在仓库里）；`computer-lifecycle.ts`、`computer-workspace.ts` 和各远程 provider 的细节，它们和我们不托管电脑的模式无关。
- 移动端（`apps/mobile`）的模型和电脑设置没看。
