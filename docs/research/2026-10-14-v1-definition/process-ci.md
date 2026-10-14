# v1 开发流程设计（分工、测试、预览版、通知、规则改动）

## 先说明范围

- 这份报告**不研究是否开源**。owner 2026-10-14 已决定：v1 闭源，以后再考虑开不开源，不再做开源调研（本目录 `owner-updates.md` 的 update 4）。
- 计算任务第 (2) 项问到"仓库公开后自托管 runner 的风险"。按 owner 的决定，这一项不展开，只在 2.2 节末尾留一行。
- 仓库现在是私有的：`gh api repos/modelzen/vonvon-bot` 返回 `"private":true`。
- 计算任务说 JP-VPS 没有 swap。这已经过时：`free -h` 显示有 4.0 GiB swap（`/swapfile`），见记忆 `vonvon-heavy-lock.md`。
- 上下文里注入的 `vonvon-collaboration.md` 是旧版。磁盘上的版本已改成 Ultracode，并要求"另一个模型的子代理做独立审查"（`/home/operator/.claude/vonvon-collaboration.md:12,14`）。下文行号都按磁盘版本。

## 结论

1. **分工**：设计、实现、独立审查、测试、合入都由 Claude 做。Mac 上的 Codex 只做 Claude 做不到的桌面事项。owner 只做里程碑验收和方向确认。Claude 和 Codex 之间不再交接 PR，`owner:` 标签和 `scripts/handoff.mjs` 可以退役。
2. **Codex 短检查由 Claude 直接经 Paseo 发起**，有三个前提：
   - Mac 没锁屏。锁屏时 Computer Use 会失败，见 getpaseo/paseo#3346（仍 open）。
   - 会话模式用 `auto`，不用 `full-access`。`full-access` 会自动批准 MCP 权限请求，#257 验收时就因此对着真实的 `~/.vonvon-bot` 启动了应用。
   - 每次都用隔离的数据根。
3. **CI 改成两个平台**：
   - 删掉 Windows 任务（`.github/workflows/ci.yml:84-117`）。
   - Linux 用 GitHub 托管，跑一次完整链约 $0.03。
   - macOS 用 Mac mini 上的自托管 runner，不收费，再加一个 Playwright `_electron` 桌面冒烟测试。
   - `frozen` 标签保留，改由 Claude 打。
   - 建议把 `macOS checks` 也设成必需检查。这要 owner 在 GitHub 设置里改。
4. **预览版**：
   - 在 Mac mini 的 `clay` 账户里本机构建，用已有的 Developer ID 签名，装成单独的 `Vonvon Bot Preview.app`。
   - 数据根、userData 和飞书测试机器人都和日常 bridge 分开。
   - 本机构建、本机安装不需要公证（推断）。要给别人或在 MacBook Air 上用时才需要公证。
5. **通知**：
   - 主渠道是 owner 已在用的 Paseo app。会话一回合结束，Paseo 就推送"Agent finished"，正文是最后一条消息的前 220 个字符。
   - 所以 Claude 的最后一条消息，第一行必须写明要 owner 做什么。
   - Claude Code 的 PushNotification 工具要靠交互终端或 Remote Control 才有去处。在 Paseo 驱动的会话里它能不能送达未知，不能当主渠道。
6. **#281 和 #285 继续挂起**，等 `docs/product.md` 冻结后再定。默认建议两个都关闭不合入（推断，依据 `v2-fit.md` 第 6、7 节）。`docs/plan.md` 改成历史参考，另写一份短的 v1 计划。#122 看板停止更新。
7. **去掉 Codex 独立审查的最大风险**：作者和审查者都是 Claude 系模型，可能有相同的盲点（推断）。而且没人再在真实 Mac 上跑真实飞书和真实 Codex。对策有四条：
   - 换模型审查，审查者不拿作者的推理过程。
   - 高风险类别加一轮多角度审查，并逐条复现。
   - macOS CI 加真实进程测试和桌面冒烟测试。
   - 在里程碑上做真实环境验收。
   - v1 不做 Windows，也暂停 holder 和系统服务这几条线，过去最容易被退回的那几类代码大部分不再写。

---

## 1. 新分工

### 1.1 Claude（JP-VPS）

| 环节 | 做什么 | 依据或限制 |
|---|---|---|
| 设计 | 主持产品设计问答，写 `docs/product.md` 并冻结 v1 范围，再写一份短的 v1 计划（按切片列，每片写用户可见结果和验收点） | owner 要求"第一版的想法这一次全部确认，之后不再加"（计算任务原话）；记忆 `design-interview-proactive.md` |
| 实现 | 用 Ultracode 工作流编排子代理，每个工作流不超过 10 个代理，同时只跑 2 个 | `vonvon-collaboration.md:12` |
| 独立审查 | 合入前由**另一个模型**的子代理审查：普通 PR 用 Sonnet，高风险 PR 用 Fable（Fable 限额单独计，只用于"关键审查"这类最难的判断）。审查者只拿 diff、PR 描述和验收要点 | `vonvon-collaboration.md:14,26` |
| 高风险加审 | 涉及子进程、并发、关闭或清理顺序、错误路径、数据迁移或原生代码时，再加一轮多角度审查，每条发现先复现或驳回，再动手改 | `vonvon-collaboration.md:14` |
| 测试 | JP-VPS 上跑构建、typecheck、lint、定向测试，再用 playwright-cli 做无头网页界面检查，一律加 `flock /tmp/vonvon-heavy.lock`。全量测试交给 CI | 记忆 `vonvon-vps-browser.md`、`vonvon-heavy-lock.md` |
| 合入 | Linux 和 macOS 两个 CI 任务在准确 head 通过、审查结论已贴进 PR、评审线程都已解决之后，由 Claude 合入 | 规则集要求 `required_review_thread_resolution: true`、必需检查 `linux`、`strict` 跟上 main（`gh api repos/modelzen/vonvon-bot/rulesets/24838891`） |
| 预览版 | 有用户可见变化的 PR 合入后，更新 Mac 上的预览版；到里程碑时通知 owner | 见第 3 节 |
| Mac 短检查 | 经 Paseo 让 Codex 用 Computer Use 看一眼桌面 | 见 1.2 |

- **合入权限要 owner 先处理（未解决的前提）。** 2026-10-13，Claude Code 的自动模式分类器把"Claude 自己合入"当成绕过 CI 拦了下来（记忆 `vonvon-docs-self-merge.md`）。owner 需要在 Claude Code 设置里加一条允许规则，或者确认一次。Claude 不能自己改这个配置。
- 两台机器用的是同一个 GitHub 账户：#284、#276、#277、#238、#239 的创建者和合入者都是 `ClayCheung`（`gh api repos/.../pulls/<n>`），本机 `gh api user` 也是 `ClayCheung`。规则集要求的批准数是 0（`required_approving_review_count: 0`）。所以 Claude 合入时，GitHub 这边没有额外障碍（推断）。
- 规则集里还有一项 `require_extra_approval_for_unattributed_changes: true`，它的含义**未知**：搜索没找到官方说明。过去 23 个产品 PR 都在这个规则集下正常合入了（`../2026-10-14-strategy/process.md` 第 2 节）。

### 1.2 Codex（Mac mini）

**只做 Claude 做不到的事：**

1. 真实 macOS 原生界面：窗口边框、托盘、菜单栏、登录项、系统权限弹窗、通知。Playwright 录不到原生菜单和窗口边框（`../2026-10-14-strategy/process.md` 第 4 节，#257 的视频"不包含原生菜单或窗口边框"）。
2. 飞书桌面客户端里卡片的实际显示。#281 的会话用 `cua_repl` 读过 `com.electron.lark`（`../2026-10-14-strategy/process.md` 第 4 节）。
3. 真实 Codex provider 的运行。JP-VPS 上没装 `codex`（`which codex` 找不到），Paseo 的 codex provider 也是 disabled（`paseo provider ls`）。
4. 用 `clay` 钥匙串里的 Developer ID 签名打包。#257 里 Codex 已做过签名，并用 `codesign --verify --deep --strict` 校验通过（#257 评论 2026-10-13 15:12、17:03）。

**Claude 自己经 Paseo 调 Codex 的 Computer Use（短检查）：**

- **定义。** 短检查是一个问题、一个应用、十分钟左右能做完的事。比如"预览版启动后托盘图标在不在，菜单有没有'退出'"。长的、要人判断好不好用的验收交给 owner。
- **怎么发。**
  - 用 `paseo run --host <Mac 的 Tailscale 地址>:6767 --provider codex/gpt-6.1-sol --mode auto --title "Mac 检查 PR #<号>" ...` 新建会话。
  - 用 `paseo wait` 等它结束，再用 `paseo logs` 读结果。
  - Codex 请求权限时，Claude 用 `paseo permit` 逐条批准（`paseo --help` 里有 `permit`）。
  - 不用 `handoff.mjs` 里写死的 `--mode full-access`（`scripts/handoff.mjs:29`）。
- **锁屏会失败。**
  - Paseo.app 没有 `com.apple.security.automation.apple-events` entitlement。TCC 把 Apple Event 记在 `sh.paseo.desktop` 名下并拒绝，Mac 锁屏时报 `-10005 cgWindowNotFound`。
  - 这个 issue 2026-08-14 提出，至今 open（`gh api repos/getpaseo/paseo/issues/3346`；记忆 `codex-cua-via-paseo.md`）。
  - 规则：一旦遇到这个错误就停下，通知 owner 解锁，或者请他在 Codex 桌面应用里做。不重试。
- **`full-access` 的风险。** 这个模式会自动接受 MCP 权限请求。#257 验收时，应用就是这样对着真实的 `~/.vonvon-bot` 启动的（记忆 `codex-cua-via-paseo.md`）。所以每次检查都要指定隔离的 `HOME`、`VONVON_HOME`、userData，并设置 `VONVON_DESKTOP_TEST_HOME`。设了它，打包版启动时就不会往真实 home 注册 CLI（`packages/desktop/src/main.ts:162`）。
- **Codex 不改代码，不 push。** 发现问题时写清复现步骤、看到的结果和平台，Claude 读到后修。
- **不确定的地方。**
  - 会话停在"Selected model is at capacity"时没人重启。#281 的 Mac 会话卡过至少 1 小时 51 分钟（`../2026-10-14-strategy/process.md` 第 2 节第 5 条）。Claude 发起检查后要设超时，超时就通知 owner。
  - 推断：Paseo terminal 也能在 Mac 上直接跑 shell 命令，完全不经过 Codex 推理（`paseo terminal create/send-keys/capture`，见 `paseo terminal --help`）。可以用它跑预览版构建脚本。但它等于在 owner 的日常账户里远程执行命令，而且两台 daemon 都没有认证（记忆 `vonvon-paseo-handoff.md`）。用不用要 owner 决定，本次也没试。

### 1.3 owner

| 做什么 | 频率（推断） |
|---|---|
| 产品设计问答，冻结 `docs/product.md` | 开发前一次 |
| 里程碑验收：在 Mac 上用预览版和测试飞书机器人走一遍，回答"像不像想要的" | 每完成一个产品主题一次，预计每周 2 到 3 次 |
| 方向确认：Claude 给出两三个选项和推荐，owner 选 | 遇到 `product.md` 没写清的地方 |
| Codex 桌面应用操作：Mac 锁屏、或者检查太长时，把 Claude 写好的提示词贴进 Codex 桌面应用 | 少量 |
| 一次性准备：给 Claude 合入的权限规则；建一个测试飞书应用（App ID 和日常 bridge 不同）；把 `macOS checks` 设成必需检查；以后决定公证用哪个账号 | 一次 |
| 决定 #281 和 #285 的去留 | 设计冻结时 |

### 1.4 一个 PR 的新流程

1. Claude 从 `main` 开 `claude/<切片>` 分支和 PR。PR 描述写用户可见变化、试用步骤、跑过的命令和结果、还没在真实 Mac 上验过的项。
2. 实现，在 JP-VPS 上检查，push。
3. 让另一个模型的子代理做独立审查，结论贴成 PR 评论。属于高风险类别的，加一轮多角度审查。
4. Claude 打 `frozen`，等 `linux` 和 `macOS checks` 在准确 head 通过。head 变了就去掉 `frozen`，改完再打。
5. 有桌面专属项时做 Mac 短检查。做不了的，在 PR 里记为"待 owner 验收"，不阻塞合入。
6. Claude 合入（规则集要求跟上 main；落后时先合并 main，再跑一次 CI），然后删 worktree。
7. 有用户可见变化时更新 Mac 预览版。到里程碑时通知 owner。

在飞上限保留两个产品 PR，1500 行上限也保留。原来 PR 排队平均要等 7.7 小时，主要是在等 Codex 验证的名额（`../2026-10-14-strategy/process.md` 第 2 节第 1 条）。现在 Claude 自己合入，这个排队应该会大幅缩短（推断）。

---

## 2. 测试在哪跑

### 2.1 三个地方对比

| 地方 | 资源和成本 | 适合跑什么 | 限制 |
|---|---|---|---|
| **JP-VPS** | 2 CPU，3.8 GiB 内存，4 GiB swap（`nproc`、`free -h`）；空闲时已用 2.4 GiB。实测 npm ci 470 s、build 33 s、typecheck 46 s（峰值 1.1 GB）、lint 14 s、全量 test 257 s（记忆 `vonvon-two-host-setup.md`） | 构建、typecheck、lint、一两个定向测试；无头网页界面检查（每个页面约 300 MB） | 不跑 Electron，没有显示器。不装 codex。用户说过不要在这台机器上大范围跑测试（记忆 `vonvon-mac-real-lark-cli.md`） |
| **GitHub 托管 Linux** | $0.006/分钟，每个 job 按分钟向上取整（`docs/ci-costs.md:29,33`）；linux job 中位数 4.5 分钟（`../2026-10-14-strategy/ci.md` 第 2 节），一次完整运行名义约 $0.03。Team 套餐每月 3000 免费分钟（`docs/ci-costs.md:52`；`gh api orgs/modelzen` 显示 `plan: team`） | 必需检查 `linux` 的完整链 | 去掉 Windows 后不再有"按两倍计"的分钟（`docs/ci-costs.md:51`）。每月 100 次完整运行约 500 分钟，在免费额度内（推断，按上面的数字算）。目前的账单状态**未知**，`docs/ci-costs.md:58` 记过 10-12 付款失败 |
| **Mac mini 自托管 runner** | GitHub 不收费（`docs/ci-costs.md:31`）；macOS job 中位数 1.8 分钟（`../2026-10-14-strategy/ci.md` 第 2 节） | macOS 全量测试、桌面冒烟测试 | 一次只跑一个 job，和 notelet 共用（`docs/self-hosted-ci.md:24,42`）。Mac 睡眠、关机，或 `ci-user` 账户退出登录时，runner 离线，job 排队（`docs/self-hosted-ci.md:55`）。和 Codex、日常 bridge 在同一台机器上，会不会抢资源**未知**，Mac mini 的配置也没有记录（`../2026-10-14-strategy/resources.md` 表 1） |

### 2.2 自托管 runner 的注册现状（2026-10-14 用 `gh api` 只读核对）

- runner 名为 `mac-mini-isolated`，状态 `online`，标签是 `self-hosted, macOS, ARM64, modelzen-macos, modelzen-macos-isolated`（`gh api orgs/modelzen/actions/runner-groups/3/runners`）。
- runner 组 `private-ci`（id 3）`visibility: selected`，只放了 `modelzen/notelet` 和 `modelzen/vonvon-bot`，两个都是私有仓库，`allows_public_repositories: false`。
- 仓库变量 `ENABLE_SELF_HOSTED_MACOS_CI=true`（`gh api repos/.../actions/variables`）。
- 账户 `ci-user` 是标准用户，不是管理员。没有 Developer ID、公证凭据或 sudo（`docs/self-hosted-ci.md:21`）。对 日常用户的家目录 设了拒绝访问的 ACL（`:9`）。
- 服务是 LaunchAgent，去掉了 `SessionCreate`，所以继承图形会话，能读屏幕、建 AppKit 窗口（`:9,25-28`），并用 `caffeinate -i` 防止闲置睡眠（`:55`）。
- 工作流开头先检查账户名和管理员组（`ci.yml:129-140`），只接同仓库 PR 和手动触发，不接 fork（`ci.yml:122-125`）。
- 关于公开仓库：按 owner 的决定不展开。只记一点，这个 runner 组本来就不接公开仓库。

### 2.3 推荐的 CI 布局（v1 只支持 macOS）

```
on: pull_request [opened, synchronize, reopened, labeled]，workflow_dispatch   # 不变
jobs:
  linux          必需。范围分类、空白检查；打了 frozen 才跑 npm ci / build / typecheck / test / lint   # 不变
  macos          建议设为必需。依赖 linux；打了 frozen 才跑完整链，再加桌面冒烟测试
  windows        删除
```

**改动点：**

1. 删除 `ci.yml:84-117` 的 `windows` 任务，改 `ci.yml:76` 的结果说明文字。
   - Windows 在 frozen 运行里失败率 35%，18 次失败中 9 次是 PR 没碰过的测试超时或 EBUSY（`../2026-10-14-strategy/ci.md` 第 2 节）。
   - owner 已确定 v1 不支持 Windows。
2. `handoff.mjs` 退役后，从 `ci.yml:35` 去掉 `scripts/handoff.test.mjs`。
3. `frozen` 的逻辑不改（`.github/scripts/ci-scope.mjs` 的 `isFullRunEligible`），只是改由 Claude 打标签。这样不用改代码和分类回归测试。
   - 以后想省掉打标签这一步，可以改成"非草稿 PR 的每次 push 都跑完整链"。改动在 `isFullRunEligible` 和 `ci-scope.test.mjs`。
   - 去掉 Windows 后，一次完整运行的墙钟时间大约 6.5 分钟，原来是 14.8 分钟（`../2026-10-14-strategy/ci.md` 第 2 节）。
4. 把 `macOS checks` 加进规则集 "Protect main" 的必需检查（现在只有 `linux`）。
   - 纯文档 PR 会跳过 macOS 任务。GitHub 文档说，跳过的 job "will report its status as Success"，"It will not prevent a pull request from merging, even if it is a required check"（[docs.github.com 条件控制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions)），所以不会卡住文档 PR。
   - 代价是 Mac 离线时产品 PR 合不进去。v1 只支持 macOS，这个代价可以接受（推断）。
   - 改规则集要组织管理员操作，由 owner 改或明确授权。
5. 同步修改 `docs/ci-costs.md`（:5,13-15,36,46-58 的 Windows 部分）和 `docs/self-hosted-ci.md:3,15,61`。`docs/plan.md:212-232` 的 CI 政策随 plan.md 一起作废（见第 5 节）。

### 2.4 在 macOS runner 上用 Playwright `_electron` 跑桌面冒烟测试

**可行的依据：**

- Playwright 对 Electron 是"experimental"支持，支持 v21 以上（[playwright.dev/docs/api/class-electron](https://playwright.dev/docs/api/class-electron)）。仓库用的是 Electron 44.4.5（根 `package.json:27`），Playwright 1.64.0 已在 `packages/ui/package.json:28`。
- 文档说启动超时时要确认 `nodeCliInspect` fuse 没被关掉。仓库里没有任何 fuse 配置（`git grep -i fuse` 在 desktop 和 scripts 里没有结果）。
- runner 的会话能建 AppKit 窗口（`docs/self-hosted-ci.md:9`），所以 Electron 窗口应该能打开（推断）。
- Codex 在 #257 里已经用 `_electron.launch` 驱动过真实打包应用（#257 评论 2026-10-13 18:35）。

**测试做什么（建议）：**

- 先 `npm run build`，再用 `_electron.launch` 启动应用。
- 设置隔离的 `HOME`、`VONVON_HOME`、userData 和 `VONVON_DESKTOP_TEST_HOME`。
- 断言三件事：窗口打开；daemon 进程在隔离数据根下起来；机器人列表页渲染出来。最后正常退出，确认 daemon 也停了。
- 失败时保存一张截图。

**不确定的地方：**

- 能不能直接对未打包的 `packages/desktop` 启动，**未知**。`main.ts:137,157` 按 `app.isPackaged` 走不同的资源路径，桌面测试里还有一条"refuses a development runtime"（`packages/desktop/test/daemon-dependencies.test.ts:81`）。如果非打包不行，就要先跑 `package:dir`，耗时**未知**。这一点在做 CI 的那个 PR 里先确认。
- 截图要不要上传成 artifact？`docs/self-hosted-ci.md:65` 写着"没有新增 GitHub 构建产物上传"，上传等于改这条约定。私有仓库的存储费另计（`docs/ci-costs.md:40`）。建议只在失败时上传一张小 PNG。
- 覆盖不到的部分：原生菜单、托盘、窗口边框。这些仍然靠 Codex 短检查或 owner 验收。
- 网页界面部分，大多数检查可以先在 JP-VPS 上用 playwright-cli 做。界面是同一个 React 应用，daemon 会直接提供构建好的界面（`.agents/skills/verify/SKILL.md` Launch 一节）。

---

## 3. owner 怎么拿到中间版本

| 问题 | 建议 | 依据 |
|---|---|---|
| 谁构建 | Mac mini 的 `clay` 账户里跑一个固定脚本（例如 `scripts/mac/preview.sh <sha>`）：fetch、开 worktree、npm ci、build、`npm run package:dir -w packages/desktop`，用 Developer ID 签名，再跑 `codesign --verify --deep --strict` 校验 | #257 里 Codex 已在 `clay` 做过 Developer ID 签名打包并校验通过（#257 评论 15:12、17:03） |
| 谁触发 | 首选：Claude 经 Paseo 让 Codex 只跑这个脚本（短任务）。如果 owner 同意，也可以由 Claude 经 Paseo terminal 直接跑，完全不用 Codex 推理（推断，没试过） | 1.2 节 |
| 备选 | 自托管 runner 在 `ci-user` 账户里构建，产物写到 `/Users/Shared/`，owner 自己拷到"应用程序"文件夹。这个账户没有签名凭据，所以只能是未签名或 ad-hoc 签名的应用（推断） | `docs/self-hosted-ci.md:21` |
| 应用放在哪 | `~/Applications/Vonvon Bot Preview.app`。bundle id、产品名和以后的正式版分开，两个可以同时存在 | 现在的 appId 是 `com.vonvon.bot.desktop`（`packages/desktop/electron-builder.yml:1`），预览版需要单独的 id（要写代码） |
| 签名 | 用 Developer ID 签名 | 同上 |
| 公证 | 本机构建、本机安装的预览版不需要公证（推断：浏览器下载的文件才带隔离标记 `com.apple.quarantine`，见 [eclecticlight 2024-05-09](https://eclecticlight.co/2024/05/09/how-does-sonoma-check-an-app-before-launch/)）。在 MacBook Air 上用或给外部用户时：要么公证，要么在"系统设置 → 隐私与安全性"里点"仍要打开"（[Apple 102445](https://support.apple.com/en-us/102445)）。公证要 Apple 开发者账号的凭据，`ci-user` 里没有 | `docs/self-hosted-ci.md:21`；#257 评论 17:03："本地包未公证" |
| 数据 | 预览版用单独的数据根（例如 `~/.vonvon-bot-preview`）和单独的 userData，CLI 不注册，或者注册成另一个名字 | 双击打开的应用拿不到 `VONVON_HOME` 环境变量。现在的默认数据根是 `~/.vonvon-bot`（`packages/daemon/src/config/data-root.ts:24`），打包版启动时会注册 CLI（`main.ts:162`），userData 跟着产品名走（`main.ts:148`）。所以要在构建时区分出预览渠道（要写代码，推断） |
| 飞书 | 用测试飞书应用，App ID 必须和日常 bridge 的不同 | "Two processes on the same Bot split its events"，"The test bot's App ID must differ from the daily bridge's App ID"（`docs/native-acceptance-hosts.md:406`） |
| 迁移测试 | 从 bridge 迁移只在 bridge 数据的副本上测，日常 bridge 照常运行。等迁移这条路径通过 owner 验收后，owner 再决定哪天把日常使用切到 vonvon-bot | 计算任务里 owner 要求老用户迁移时保留大部分体验 |
| 多久一次 | 每个有用户可见变化的 PR 合入后都静默更新预览版，不通知。到里程碑时才通知 owner 验收。owner 不想看现在的界面，不做 Demo 0，所以第一版预览等第一个 v1 切片合入后再出 | `owner-updates.md` update 5 第 (4) 条 |

---

## 4. Claude 怎么通知 owner

### 4.1 渠道

| 渠道 | 怎么到 owner | 条件和限制 | 用途 |
|---|---|---|---|
| **Paseo app 里 Claude 会话的最后一条消息**（主渠道） | 回合结束时，Paseo daemon 生成"Agent finished"通知，正文是最后一条助手消息去掉 Markdown 后的前 220 个字符（`@getpaseo/protocol/dist/agent-attention-notification.js:1,105-108`，0.11.1 已安装版本） | 180 秒内没有客户端活跃时才推到手机；有活跃客户端时只在 app 里提示；正盯着这个会话时完全不提示（`agent-attention-policy.js` 中 `PRESENCE_THRESHOLD_MS = 180000` 和 `computeNotificationPlan`）。**会话出错不推送**：`isPushEligibleAttentionReason` 对 `error` 返回 false（同文件 :33-35）。推送订阅 48 小时到期（`push/index.js:3`）；JP-VPS 上现在有 1 个订阅，`expiresAt` 在一天后（具体时间已略去）（`~/.paseo/push-tokens.json`），推断 owner 打开 Paseo app 时会续期（`token-store.js:18-27` 的 `renewToken`） | 所有要 owner 做的事 |
| **Paseo app 的会话状态** | 每个会话一个状态点：运行中、完成待看、要权限、出错（Paseo 文档 `docs/agent-lifecycle.md:185-195`，`docs/data-model.md:102-104` 的 `attentionReason`） | 只有状态，没有内容 | owner 扫一眼就知道哪个会话在等他 |
| **PushNotification 工具** | 在用户终端弹桌面通知；连着 Remote Control 时也推到手机（工具说明） | Remote Control 要求交互式 `claude`、`claude --remote-control` 或 `claude remote-control` 服务模式（[Remote Control 文档](https://code.claude.com/docs/en/remote-control)，Requirements 和 Mobile push notifications 两节）。Paseo 是用 Agent SDK 的 `query` 驱动 Claude，不是交互会话（`../2026-10-14-strategy/process.md` 第 4 节）。所以在 Paseo 会话里这个工具多半没有去处（推断），实际能不能送达**未知** | 不当主渠道。可以试一次，记下返回的是"sent"还是"not sent" |
| 不用的 | Linear、GitHub 手机端、飞书 | owner 的要求（计算任务原话；记忆 `no-feishu-dev-channel.md`） | — |

- 另一个可选方案：在 JP-VPS 上用 tmux 跑 `claude remote-control` 服务模式，owner 改用 Claude 手机 app，这样能拿到 Claude 原生的推送。但这等于把 Claude 侧的会话从 Paseo 换走，改动大，暂不建议。
- **噪音风险**：每个 PR 会话每结束一个回合都会推送。手机上能否按会话静音**未知**。对策：PR 会话尽量用长回合（一个工作流跑完再结束），最后一行用下面的标签开头，让 owner 只看第一行就知道要不要理。

### 4.2 每条消息写什么

规则：最后一条消息的**第一行**就是推送正文，不超过 200 字。开头写标签，然后写要 owner 做什么、要多久。后面写细节。不为日常进度发消息。

| 标签 | 何时用 | 第一行示例 | 后面写 |
|---|---|---|---|
| 【需要你验收】 | 里程碑完成，预览版已装好 | 【需要你验收】预览版 3 已装在 Mac mini：建 bot 和关联工作区，约 15 分钟 | 这次能做什么（用 owner 的话说）；3 到 5 步试用步骤；重点看哪里；应用位置、数据根、测试机器人；已知问题；怎么回复（直接在会话里说哪里不对）；在等你的期间我做什么 |
| 【需要你决定】 | `product.md` 没写清，或出现方向分歧 | 【需要你决定】群里多个 bot 同时被 @ 时谁先回？两个方案，我推荐 A | 场景说明；选项 A/B 各自的结果；推荐哪个、为什么；不回复时的默认做法和期限 |
| 【需要你操作 Codex】 | Mac 锁屏，或检查太长 | 【需要你操作 Codex】Mac 锁屏，Computer Use 失败，请解锁或把下面的提示贴进 Codex 应用 | 原因（paseo#3346）；要粘贴的完整提示词；在哪台 Mac 上做；要 Codex 回什么 |
| 【需要你处理】 | 权限、凭据、设置 | 【需要你处理】Claude 合入被权限规则拦住，需要你加一条允许规则 | 具体要点哪里、填什么；做完后我会做什么 |
| 【卡住了】 | 额度耗尽、CI 跑不起来、Mac 离线 | 【卡住了】Claude 周额度用完，约 14:00 恢复，PR #301 停在审查 | 卡在哪；已经试过什么；预计恢复时间；要不要 owner 做什么 |
| 【无需处理】 | 普通回合结束 | 【无需处理】PR #302 已合入，预览版已更新，继续下一片 | 一两句结果 |

- owner 在 Claude Code 终端里看不了图片（计算任务原话）。所以通知只用文字，截图只作为证据保存在 Mac 或 PR 里。

---

## 5. #281、#285 和 `docs/plan.md` 怎么处理

**现状（`gh api`，2026-10-14 只读）：**

- #281（V6b 1/14，把 Codex 子进程挪到 ProcessHost）：open，`owner:codex`，head `a1bc7ee`，+822/-348。
- #285（V5 12/15，拿锁前检查，并把 daemon start 改走 manager）：open，`owner:codex`，head `3950f90`，+1135/-47。
- 两个都在 05:50Z 贴了"暂停冻结和合入"（见 #281、#285 的 PR 评论）。
- owner 已决定：设计结束前不写产品代码；V6b 第 2 到 6 块留在本地，不 push、不删；#281 上的 holder 缺口不修；合入还是关闭等设计定了再说（记忆 `vonvon-2026-10-14-pause.md`）。

**建议：** 继续挂起。在设计问答里加两个问题，`product.md` 冻结后按答案处理。

| PR | 决定它的问题 | 默认建议（推断） |
|---|---|---|
| #285 | 桌面主题：daemon 由桌面应用自己管（加 Electron 登录项开机启动），还是装成 launchd 系统服务？ | 如果由应用自己管：关闭 #285 不合入，V5 第 13 到 15 块不再开，#110（V5 拆分来源，`owner:claude`）一起关闭。依据：`v2-fit.md` 第 7 节，launchd 事务这条线只有坚持"系统服务"才需要；Paseo 本身也没有 launchd 代码（`../2026-10-14-strategy/methods.md` A5） |
| #281 | v1 建在 main 上旧的 `agent/` 路径上，还是先完成 V6 的新 engine 层？ | 如果用旧路径：关闭 #281 不合入，v1 冻结后删掉本地 V6b 第 2 到 6 块。依据：#281 合入后打包版的 Codex 会因为缺 `vonvon-holder` 而失败（`hold-281.md`）；V6b 共 14 个 PR 外加一个删除阶段（`v2-fit.md` 第 6 节） |

- 关闭时去掉 `owner:codex` 标签，在 PR 里写一句"按 v1 范围关闭，分支保留作参考"。关闭不会删远端分支，`delete_branch_on_merge` 只在合入时生效（`gh api repos/...`）。
- 顺带清理（推断，依据 `v2-fit.md` 第 7 节）：旧桌面 PR 栈 #2、#9 到 #19 可以关闭，`docs/roadmap.md:107` 本来就说 V4 合入后关闭。#234、#226、#100 等 v1 计划确定后一起看。

**`docs/plan.md`（2128 行，V1 到 V11）：**

- 加一行文件头："v2 计划，2026-10-14 起停止执行。v1 以 `docs/product.md` 和 v1 计划为准。"也可以挪到 `docs/archive/`。
- 它的第 9 行还写着"Codex owns all code… Claude Code… writes no product code"，早就和 `AGENTS.md:7` 矛盾（`../2026-10-14-strategy/methods.md` A6）。
- 另写一份 v1 计划，建议 200 行以内。每个切片写四样：用户可见结果、试用步骤、验收点、高风险类别。计划随代码在同一个 PR 里更新（保留 `AGENTS.md:25` 的原则）。
- `docs/program-graph.json`、`scripts/program-graph-sync.mjs` 和 #122 看板停止更新。v1 计划落地后，关闭 #122，或者把它改成 v1 清单。
- `docs/native-acceptance-hosts.md`（685 行，腾讯云 Linux 验收和 Fallback VM）和 `docs/roadmap.md`：同样标为历史参考。

---

## 6. 规则改动清单（旧 → 新）

### 6.1 仓库 `AGENTS.md`

| 位置 | 旧规则 | 新规则 |
|---|---|---|
| :3 | 2026-10-13 起生效，取代之前的版本。两台机器读同一份规则。两边的非平凡任务都先进入 pstack 的 poteto-mode。 | 2026-10-14 起生效，取代 2026-10-13 的版本，适用于 v1 开发。两台机器读同一份规则。Claude 的非平凡任务用 Ultracode 工作流编排，见 `vonvon-collaboration.md`。Codex 只接短的桌面任务，不要求进入 poteto-mode。（Codex 这一侧要 owner 确认） |
| :7 | 没有桌面的 Linux 服务器（JP-VPS）上的 Claude Code 负责设计和实现。……JP-VPS 内存小，不跑全量测试、live 和性能。 | JP-VPS 上的 Claude Code 负责 v1 的设计、实现、独立审查、测试和合入。它写 `docs/product.md` 和 v1 计划，写产品代码和测试，在 JP-VPS 上跑构建、typecheck、lint、定向测试和无头网页界面检查，重命令一律加 `flock /tmp/vonvon-heavy.lock`。全量测试交给 CI 的 Linux 和 macOS 任务。 |
| :8 | 有桌面的 Mac 上的 Codex 负责完整测试、独立审查和验收。……打包、签名、公证、发布和 issue #122 看板由 Codex 负责。 | Mac 上的 Codex 只做 Claude 做不到的桌面事项：真实 macOS 窗口、托盘、菜单、登录项和系统权限弹窗，飞书客户端里卡片的实际显示，真实 Codex provider 的运行，用 Mac 钥匙串签名打包预览版。短检查由 Claude 经 Paseo 直接发起；长的、要人判断的验收交给 owner。公证和对外发布在发布前由 owner 决定谁做。 |
| :9 | Codex 可以直接修复验证范围内的问题：……涉及设计、数据形状、协议或跨平台逻辑的问题交回 Claude，不自行改写。 | Codex 不改代码，不 push。发现问题时写清复现步骤、看到的结果和平台，回给 Claude，由 Claude 修。 |
| :10 | Claude 看不到 Mac。PR 描述必须列出 Claude 在 Linux 上跑过的命令和结果，以及验收要确认的结果和已知缺口……没有这一节 Codex 不接。 | 每个产品 PR 的描述写：用户能看到的变化、试用步骤、Claude 跑过的命令和结果、独立审查结论、还没在真实 Mac 上验过的项。没有用户可见变化的 PR，要说明为什么现在必须做。 |
| :14-17（流程 1 到 4） | 1. Claude 开 PR、打 `owner:claude`……用 `handoff.mjs` 交接。2. Codex 审查和验证，打 `frozen`、跑完整 CI、做 Shipping 检查、合入……3. Claude 修复后只回答该评论……4. 合入后两台机器各自删除 worktree。 | 1. Claude 从 `main` 开 `claude/<切片>` 分支和 PR，实现，跑 JP-VPS 检查，push。2. 合入前由另一个模型的子代理做独立审查，结论写进 PR 评论；高风险类别加一轮多角度审查，每条发现先复现或驳回再改。3. 审查通过后 Claude 打 `frozen`，等 `linux` 和 `macOS checks` 在准确 head 通过；head 变了就去掉 `frozen`，改完再打。4. 有桌面专属项时，Claude 经 Paseo 让 Codex 做短检查，做不了的在 PR 里记为"待 owner 验收"。5. Claude 合入，删 worktree；有用户可见变化时更新 Mac 上的预览版。 |
| :21 | 只有 `owner:` 标签指向的一方可以 push 该分支。换 owner 前先 push，换 owner 后先 pull。不 force-push，不 rebase 已 push 的分支。 | 只有 Claude push 功能分支，不再用 `owner:` 标签。不 force-push，不 rebase 已 push 的分支。 |
| :22 | 产品 PR 同时在飞最多两个。…… | 不变。 |
| :23 | ……大小以 Codex 一个会话能审完并验完为准，不含 lockfile 和生成文件时以 1500 行改动为上限。超过就先拆。 | 一个 PR 对应一个切片。大小以一个审查子代理能读完整个 diff 为准，不含 lockfile 和生成文件时以 1500 行改动为上限。超过就先拆。 |
| :24 | 每个功能分支在每台机器上只有一棵 worktree。合入即删。 | 不变。Mac 上为短检查或预览版建的 worktree，用完就删。 |
| :25 | 在飞 PR 的设计不另开文档 PR 修改。……设计文档只为尚未开始的版本写，最多领先实现一个版本。 | v1 的范围以冻结后的 `docs/product.md` 为准。冻结后的新想法写进其中"v1 之后"一节，发布前不实现。v1 计划随代码在同一个 PR 里更新，不另开文档 PR。 |
| :26 | 进度只看 issue #122 看板和 PR 状态。不做本地进度页、会话映射文件或定时刷新。Codex 在交接和合入时更新看板。 | 进度看 v1 计划里的清单、PR 状态和 Claude 会话里的里程碑消息。#122 看板和 `program-graph.json` 停止更新。不做本地进度页、会话映射文件或定时刷新。 |
| :27 | 每台机器一个在飞 PR 一个会话，会话标题为 `PR #<号>`。…… | Claude 每个在飞 PR 一个会话，标题 `PR #<号>`。Mac 上的 Codex 检查会话标题为 `Mac 检查 PR #<号>`，用完归档。并行放在会话内部，不开根会话加多个工作会话。 |
| :28 | 完整三平台 CI 只在 `frozen` head 跑一次。……全量测试、macOS 检查、真实环境验收、live 和性能由 Codex 在 Mac 上做。 | 完整 CI 是 Linux 和 macOS 两个平台，只在 `frozen` head 跑。macOS 任务跑在 Mac mini 的自托管 runner 上，包括桌面冒烟测试。真实飞书和真实 Codex 的验收按里程碑做，不每个 PR 都做。 |
| :29 | 没有 Windows 原生环境。每个 PR 的 Windows 验证只看 `frozen` head 完整 CI 的 Windows 任务……等有 Windows 环境时集中验收。 | v1 不支持 Windows，不跑 Windows CI，不写新的 Windows 专属代码。已有 Windows 代码留不留，写在 v1 计划里。 |
| :33 | 两台机器的 Paseo daemon 通过 Tailscale 互通。……不通过 SSH 执行 `claude -p`。 | 前半不变。补一句：Claude 可以经 Mac 的 daemon 新建 Codex 会话或给它发消息，做短的桌面检查。 |
| :34 | 交接只用 `scripts/handoff.mjs`。…… | Claude 和 Codex 之间不再交接 PR。Mac 检查用 Paseo 发起：模式用 `auto`，不用 `full-access`；每次指定隔离的 `HOME`、`VONVON_HOME`、userData 和 `VONVON_DESKTOP_TEST_HOME`；Mac 锁屏时 Computer Use 会失败（getpaseo/paseo#3346），遇到就停下通知 owner，不重试。Codex 用文字回复结果，Claude 把结论贴进 PR。 |
| :35 | 会话按标题 `PR #<号>` 查找……这是唯一允许跨机创建会话的情况。…… | Claude 只为短检查在 Mac 上新建 Codex 会话，这是唯一允许的跨机创建。对方会话正在运行时不发 `paseo send`，因为它默认会打断当前回合。 |
| :36 | 各台机器只通过 Git 同步，各自运行 npm ci，不拷贝 node_modules、dist、build、release。 | 不变。补一句：预览版在 Mac 本机构建、本机安装，不跨机器拷贝。 |
| :37 | 用户已授权连续执行后续版本。……不在版本边界等用户确认。…… | v1 按冻结的范围连续开发。每完成一个里程碑，Claude 在 Mac 上装好预览版并通知 owner 验收。等验收期间可以继续下一个切片，但不改已验收的行为。需要 owner 决策、补信息或操作时，按 `vonvon-collaboration.md` 的格式通知。 |
| 新增 | — | Claude 合入产品 PR 的条件：两个 CI 任务在准确 head 通过、独立审查结论已贴进 PR、评审线程都已解决、PR 描述各节齐全。 |

### 6.2 `/home/operator/.claude/vonvon-collaboration.md`（按磁盘版本的行号）

| 位置 | 旧规则 | 新规则 |
|---|---|---|
| :3 | 2026-10-13 用户决定把 Claude 订阅升到 Max 20x，设计和开发都放在 Claude，审查、验证和验收放在 Codex。本文件取代 2026-10-11 的版本。 | 2026-10-14 起，v1 的设计、实现、审查、测试和合入都在 Claude。Codex 只做 Claude 做不到的桌面事项。本文件取代 2026-10-13 的版本。 |
| :9 | ……不通过 SSH 执行 `claude -p`，不在 Mac 上做 Claude 推理。 | 不变。补一句：Claude 可以经 Paseo 在 Mac 上开 Codex 会话做短检查，规则见仓库 `AGENTS.md`。 |
| :14 | 每个 PR 交接或合入前，由另一个模型的子代理做独立审查……再加一轮多角度审查和挑错核实。…… | 每个 PR 合入前，由另一个模型的子代理做独立审查：普通 PR 用 Sonnet，高风险 PR 用 Fable。审查者只拿 diff、PR 描述和验收要点，不拿作者的推理过程，结论写进 PR 评论。改动涉及子进程、并发、关闭或清理顺序、错误路径、数据迁移或原生代码时，再加一轮多角度审查，每条发现先复现或驳回再改。2026-10-13 被退回的 18 次里，这类缺陷占了大多数。 |
| :15 | 会话停下前收尾：push，在 PR 评论里写明状态和下一步，换 owner 标签。交接记录只写在 PR 里，不写本机文件。 | 会话停下前收尾：push，在 PR 评论里写明状态和下一步。不再换 owner 标签。记录只写在 PR 里，不写本机文件。 |
| :20 | Codex 的模型表独立保留。审查和验证用 Sol，并发、性能和难故障判断用 Astra。 | Codex 的模型表独立保留。Claude 发起的 Mac 短检查用 Sol。 |
| :21 | Mac 上一个在飞 PR 对应一个 Codex 会话。JP-VPS 侧的 Paseo Codex provider 处于 disabled…… | Mac 上的 Codex 会话按需新建，标题 `Mac 检查 PR #<号>`，模式用 `auto`，做完归档。会话停在"model at capacity"或超时没回，就通知 owner，不反复重发。JP-VPS 侧的 Codex provider 仍为 disabled。 |
| :27 | 额度耗尽时停止对同一失败反复试探，不切换到 API 付费，不增加支出。不依赖新代码的 Codex 验证继续。 | 额度耗尽时停止对同一失败反复试探，不切换到 API 付费，不增加支出。在会话里用【卡住了】格式说明卡在哪、预计何时恢复。 |
| :28 | 每个 PR 的交接次数和等待额度造成的阻塞记在 PR 里。…… | 每个 PR 在描述末尾记：Mac 检查次数、等 owner 的时长、等额度的时长。运行一周后用这些数据决定是否调整订阅；没有数据时不承诺节省比例。 |
| 新增 | — | 通知 owner：只在需要他时发。最后一条消息的第一行写成要他做的事，不超过 200 字，以【需要你验收】【需要你决定】【需要你操作 Codex】【需要你处理】【卡住了】【无需处理】之一开头，因为 Paseo 推送只带最后一条消息的前 220 个字符。不为日常进度发消息。不用 Linear、GitHub 手机端或飞书。 |

### 6.3 同一个流程 PR 里的其他文件

- `.github/workflows/ci.yml`：删 `:84-117`，改 `:35`、`:76`，桌面冒烟测试加在 `macos` 任务末尾。
- `scripts/handoff.mjs` 和 `scripts/handoff.test.mjs`：删除，或者先标为停用。它写死了 `--mode full-access`（`:29`），新建会话时发的第一句话是"先进入 pstack:poteto-mode"（`:107`），都和新规则冲突。
- `docs/ci-costs.md`、`docs/self-hosted-ci.md`：去掉 Windows。
- `docs/plan.md`：加文件头，见第 5 节。
- 规则集 "Protect main" 加必需检查 `macOS checks`：owner 来改。

---

## 7. 去掉 Codex 独立审查的风险和对策

**过去 Codex 抓到了什么：**

- `vonvon-collaboration.md:14`：2026-10-13 被退回 18 次，大多是子进程、并发、关闭或清理顺序、错误路径和 Windows 原生代码的问题。
- `../2026-10-14-strategy/ci.md` 第 3 节统计了 #237 到 #285 的 24 次退回：
  - 跨平台的进程、并发、关闭或生命周期问题 12 次；
  - TLS 2 次；
  - 只在 Windows 上出现的 4 次；
  - 设计或范围缺口 2 次；
  - 工具或文档 4 次。
- `../2026-10-14-strategy/process.md` 第 2 节：23 个合入的 PR 中，有 12 个被退回过，共 20 次。`owner:codex` 名下累计 34.9 小时，`owner:claude` 名下 2.4 小时。
- 退回时开的 issue，大部分在 V6a 的 holder 和 ProcessHost 代码里：
  - #243（子代理文本折叠，可重入的停止）
  - #245（写端关闭后挂起的请求没收尾）
  - #260（holder 在 macOS 上的组信号）
  - #263、#267（并发关闭泄漏 holder）
  - #273（stderr 没读导致阻塞）
  - #282、#283（并发重建）
  - #258（daemon 重启后窗口没重连，是在真实窗口里用 CUA 发现的）

| 风险 | 说明 | 对策 |
|---|---|---|
| R1 盲点相同 | 作者和审查者都是 Claude 系模型，训练相近，错误可能一起出现（推断）。Codex 是另一家的模型 | 审查者换模型（Sonnet 或 Fable，不用 Opus 审 Opus）；不给审查者看作者的推理；高风险类别做多角度审查，每条发现逐个复现。数据迁移、删除用户数据这类最高风险的 PR，可以额外请 Mac 上的 Codex 只读审查 diff，由 Claude 经 Paseo 发起、不用 owner 操作，但这算新规则的例外，要 owner 同意（推断） |
| R2 没有真实环境 | Codex 一直在真实 Mac、真实 lark-cli、真实飞书和真实 Codex 里验证（`AGENTS.md:8`；记忆 `vonvon-mac-real-lark-cli.md`）。#258 就是在真实窗口里发现的 | macOS CI 跑全量测试和桌面冒烟测试；子进程和并发相关的测试用真实进程，不用假对象；里程碑时由 owner 用预览版和测试飞书机器人走真实流程。JP-VPS 已经能用 lark-cli 发飞书消息（`../2026-10-14-strategy/resources.md` 主要发现第 4 条），可以在 Linux 上用测试机器人跑真实飞书流程。但 JP-VPS 没有 codex，Codex provider 的真实运行只能在 Mac 上做，或者以后在 JP-VPS 装 codex 并登录（要 owner 决定） |
| R3 自审自合，门槛被放松 | 同一方写、审、合，赶进度时容易提前宣布完成。Anthropic 观察到，智能体只跑了单元测试就把功能标成完成（`../2026-10-14-strategy/methods.md` P2 引用的 [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)） | 用机制卡住：必需检查 `linux` 和 `macOS checks`；审查结论必须贴进 PR；PR 描述各节齐全才能合入；`strict` 跟上 main。owner 的里程碑验收是最后一道门 |
| R4 v1 仍有高风险代码 | v1 还会写子进程（Codex、Claude 和子代理）、并发（多个 bot 和智能回复判定，见 `owner-updates.md` update 1）、关闭顺序（daemon 和 Electron 退出）、错误路径和数据迁移 | 继续执行 `vonvon-collaboration.md:14` 的加审规则；v1 计划给每个切片标出属于哪类高风险；能复用 main 上已验证过的旧 `agent/` 路径就复用，不新起一层 |
| R5 Windows 这类退回没了 | 24 次退回中 4 次只在 Windows 出现，18 次 Windows CI 失败里 9 次是噪音（`../2026-10-14-strategy/ci.md`） | 这是好处。前提是 v1 真的不写新的 Windows 代码（6.1 节 :29） |
| R6 设计缺口没人提 | Codex 提过 2 次设计或范围缺口（#255、#257，`../2026-10-14-strategy/ci.md` 第 3 节） | `product.md` 冻结，加上 owner 的方向确认；审查子代理的提示里加一条"对照 `product.md` 和验收点检查范围" |
| R7 全压在 Claude 额度上 | 额度用完，所有工作都停（`vonvon-collaboration.md:27`）；Fable 限额单独计（`:26`） | Fable 只用于高风险审查，普通审查用 Sonnet；等额度的时长记进 PR；卡住时用【卡住了】通知 |
| R8 合入权限 | 自动模式分类器拦过自合入（记忆 `vonvon-docs-self-merge.md`） | owner 一次性加允许规则；Claude 不去绕开它 |
| R9 会话出错没人知道 | Paseo 对 `error` 不推送（`agent-attention-policy.js:33-35`）；Mac 会话卡在 capacity 时，曾经至少 1 小时 51 分钟没人发现（`../2026-10-14-strategy/process.md`） | Claude 发起的每个 Mac 检查都设超时，超时就通知；Claude 自己的会话出错，只能靠 owner 看 Paseo 的状态点（这个缺口**未知**怎么补） |

---

## 未知项

- 规则集里 `require_extra_approval_for_unattributed_changes: true` 的含义。
- 在 Paseo 驱动的 Claude 会话里，PushNotification 工具能不能送达。
- Paseo 手机 app 能不能按会话静音；推送订阅是不是打开 app 就自动续期（现在这个订阅一天后到期，具体时间已略去）。
- 未打包的 `packages/desktop` 能不能直接被 `_electron.launch` 启动并拉起 daemon；`package:dir` 在 runner 上要跑多久。
- Mac mini 的 CPU 和内存；runner、Codex、预览版、日常 bridge 同时运行时会不会互相拖慢。
- Paseo terminal 在 Mac 上跑构建脚本是否可行（没试过），owner 是否允许。
- 测试飞书应用用哪个 App ID；V2 当年用的"saved inactive Bot"是哪个（`../2026-10-14-strategy/resources.md` P1）。
- GitHub 组织当前的账单和付款状态。
- owner 在 Mac mini 上试用，还是在 MacBook Air 上试用。如果是 Air，预览版需要公证，或者每次都点"仍要打开"。

## 主要来源

- 仓库：`AGENTS.md`、`.github/workflows/ci.yml`、`.github/scripts/ci-scope.mjs`、`scripts/handoff.mjs`、`docs/self-hosted-ci.md`、`docs/ci-costs.md`、`docs/plan.md`、`docs/native-acceptance-hosts.md`、`packages/desktop/src/main.ts`、`packages/desktop/electron-builder.yml`、`packages/daemon/src/config/data-root.ts`、`.agents/skills/verify/SKILL.md`
- 本机配置：`/home/operator/.claude/vonvon-collaboration.md`、`/home/operator/.claude/pstack-models.md`、`~/.paseo/push-tokens.json`、`~/.local/share/paseo-runtime/0.11.1/node_modules/@getpaseo/{protocol,server}/dist/...`
- 早先的报告：`../2026-10-14-strategy/` 下的 ci、process、methods、codex-desktop、resources，本目录的 owner-updates 和 v2-fit，#281、#285 的 PR 评论
- 记忆：`codex-cua-via-paseo.md`、`vonvon-vps-browser.md`、`vonvon-2026-10-14-pause.md`、`vonvon-heavy-lock.md`、`vonvon-docs-self-merge.md`、`vonvon-paseo-handoff.md`、`no-feishu-dev-channel.md`、`vonvon-mac-real-lark-cli.md`
- GitHub（只读）：`repos/modelzen/vonvon-bot`、`rulesets/24838891`、`pulls/281`、`pulls/285`、`actions/variables`、`orgs/modelzen/actions/runner-groups/3/{runners,repositories}`、`issues/257/comments`、`getpaseo/paseo/issues/3346`
- 网页：[Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)、[Playwright Electron](https://playwright.dev/docs/api/class-electron)、[GitHub 跳过的 job 与必需检查](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions)、[Apple 102445 安全打开应用](https://support.apple.com/en-us/102445)、[Eclectic Light：Sonoma 启动前检查](https://eclecticlight.co/2024/05/09/how-does-sonoma-check-an-app-before-launch/)
