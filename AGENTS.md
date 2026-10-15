# vonvon-bot 分工规则

2026-10-14 起生效，取代 2026-10-13 的版本，适用于 v1 开发。两台机器读同一份规则。本文的 owner 指用户本人；旧的 `owner:` 标签不再使用。Claude 的非平凡任务用 Ultracode 工作流编排。Claude 侧的会话、模型和通知格式另见 JP-VPS 上的 `/home/operator/.claude/vonvon-collaboration.md`，这个文件不在仓库里，Mac 上没有。

## 分工

- JP-VPS 上的 Claude Code 负责 v1 的设计、实现、独立审查、测试和合入。它写 `docs/product.md` 和 `docs/v1-plan.md`，写产品代码和测试，在 JP-VPS 上跑构建、typecheck、lint、定向测试和无头网页界面检查。飞书一侧的行为也在 JP-VPS 上自测：用 lark-cli 以 owner 的用户身份、只在测试群里做，改设置用 `vonvon` 命令行。每个里程碑的验收，不需要 Mac 的步骤由 Claude 先在 JP-VPS 上做完，见 `docs/v1-plan.md` 第 7 节。重命令一律加 `flock /tmp/vonvon-heavy.lock`。全量测试交给 CI 的 Linux 和 macOS 任务。Claude 是唯一的合入入口。
- Mac 上的 Codex 做 Claude 做不到的桌面事项：Mac 上的网页端连 Mac 上的 daemon，真实 macOS 窗口、托盘、菜单、登录项和系统权限弹窗，飞书客户端里卡片的实际显示，真实 Codex provider 的运行，用 Mac 钥匙串签名打包预览版。短检查和预览版由 Claude 经 Paseo 发起；长的、需要人来判断的验收交给 owner。公证和对外发布由 owner 在发布前决定谁来做。
- Codex 可以改代码，按下面两种情况提交：
  - Claude 发起的 Mac 检查里发现问题，Codex 直接修，在被检查的 `claude/*` 分支上 commit 和 push，不 force-push，不 rebase。回复里写清改了什么、为什么改和提交号。回复之后 Codex 不再 push 这个分支。
  - owner 在 Mac 上验收已合入的预览版时发现问题，Codex 从 `main` 开 `codex/fix-<问题>` 分支和自己的 PR，不 push 到任何 `claude/*` 分支。`codex/fix-*` 分支只有 Codex push。开这个 PR 的 Codex 会话和它的 Mac worktree 留到 PR 合入或关闭。Claude 审查发现问题时，把发现写进 PR 评论，再经 Paseo 通知这个会话去修；会话已经不在了，Claude 新建一个修复会话（见"工具和同步"）。2026-10-14 之前开的 `codex/*` PR 是旧桌面版的参考栈，不是修复 PR。
- Codex 的改动和 Claude 的一样过合入门槛：另一个模型的独立审查、CI 在准确 head 上通过、由 Claude 合入。改动让行为和 `docs/product.md` 不一致时，Codex 在 PR 里写明，Claude 在同一个 PR 里改 `docs/product.md`。
- Codex 不能直接通知 owner。卡住时，Codex 在文字回复的第一行写"卡住了："加原因，由 Claude 转告 owner。
- 每个产品 PR 的描述写清这几项：用户能看到的变化、试用步骤、Claude 跑过的命令和结果、独立审查结论，以及还没在真实 Mac 上验过的项。没有用户可见变化的 PR，要说明为什么现在必须做。

## 范围和资料

- v1 的范围以定稿的 `docs/product.md` 为准。owner 在 `docs/product.md` 的 PR 里认可后即为定稿；"定稿"只指这份文档，`frozen` 只指 PR 标签。定稿之前是产品设计环节，不写产品代码。定稿后的新想法写进其中"v1 之后"一节，发布前不实现。
- v1 的切片和里程碑写在 `docs/v1-plan.md`。它随代码在同一个 PR 里更新，不另开文档 PR。
- `docs/plan.md`（V1 到 V11）和 `docs/roadmap.md` 从 2026-10-14 起停止执行，只作历史参考。
- 调研结果放在 `docs/research/`。开始调研之前，先读其中的 `README.md`，已经查过的不再重查。新一轮调研放进新的日期目录，并在 `README.md` 里加一行。

## 一个 PR 的流程

1. Claude 从 `main` 开 `claude/<切片>` 分支。开产品 PR 时，把复查在飞产品 PR 数和创建 PR 放进同一个 `flock /tmp/vonvon-pr-slot.lock` 里执行，数到两个就不开。实现，跑 JP-VPS 上的检查，push。
2. 由另一个模型的子代理做独立审查，结论写进 PR 评论。改动涉及子进程、并发、关闭或清理顺序、错误路径、macOS 原生代码、数据迁移或合入门禁（CI 和本文的规则）时，再加一轮多角度审查。每条发现先复现或驳回，再改。
3. 有桌面专属项时，Claude 经 Paseo 让 Codex 做 Mac 检查，规则见"工具和同步"。Mac 检查只在没带 `frozen` 的 PR 上发起。Codex 改了代码，它的改动回到第 2 步审查；审查后如果改动碰到桌面行为，Claude 再发起一次检查。做不了的项，在 PR 里记为"待 owner 验收"。
4. 审查和 Mac 检查都完成后，Claude 打 `frozen`，等 `linux` 和 `macOS checks` 在准确 head 上都显示成功。合入规则只强制 `linux`，`macOS checks` 由 Claude 用 `gh pr checks` 确认；它显示跳过、排队或 runner 离线都不算通过，这时通知 owner。打了 `frozen` 之后还要 push，先去掉 `frozen`，push 后让改动回到第 2 步，再重新打。去掉 `frozen` 后再加任何标签，`linux` 都会变红，重新打 `frozen` 才恢复。合入规则要求分支和 `main` 同步，所以冻结后 `main` 前进了，要先把 `main` merge 进分支，这也算一次 push，按同样的步骤走。
5. Claude 用准确 head 的 sha 合入，删除 JP-VPS 上的 worktree。

合入产品 PR 的条件：两个 CI 任务在准确 head 上成功，独立审查结论已贴进 PR，评审线程都已解决，PR 描述各项齐全。

纯文档 PR 不打 `frozen`。独立审查结论贴进 PR、`linux` 在准确 head 上通过后，Claude 合入。dependabot PR 改依赖，按产品 PR 的条件审查、冻结和合入，或者直接关闭。

## 硬限制

- `claude/*` 分支平时只有 Claude push。Claude 发起 Mac 检查后，到 Codex 回复之前，Claude 不 push 这个分支；Codex 回复后，Claude 先 pull 再改。检查会话超过一小时没有回复，Claude 通知 owner，等 owner 确认会话已停下，再 pull 并恢复 push。任何人都不 force-push，不 rebase 已 push 的分支。
- 除了 `frozen`，不给 PR 加别的标签。每次加标签都会按 PR 当时的标签重跑 CI，PR 已带 `frozen` 时会再跑一遍完整平台链。
- 产品 PR 同时在飞最多两个，第三个要等一个合入。计数方法：开放、非 draft、head 分支以 `claude/` 开头、改动里有 `.github/`、`scripts/`、`AGENTS.md`、`docs/` 和其他 Markdown 以外文件的 PR，再去掉暂停的 #281 和 #285。所以纯文档 PR 和只改 CI、脚本、规则的流程 PR 不计；dependabot PR 和 Codex 的 `codex/fix-*` 修复 PR 不在 `claude/` 分支上，也不计。修复 PR 由 Claude 优先审查和合入。本规则生效前开的 PR 全部暂停：#281（V6b 的 Codex 子进程迁移）、#285（V5 的启动路由），以及 `codex/` 分支上的 #110（V5 的桌面外壳）等。它们的去留在 `docs/product.md` 定稿时由 owner 决定。
- 一个 PR 对应一个切片，大小以一个审查子代理能读完整个 diff 为准。不含 lockfile 和生成文件时，以 1500 行改动为上限，超过就先拆。
- 每个功能分支在每台机器上只有一棵 worktree，合入即删。GitHub 在合入时自动删除远端分支。Mac 上为检查或预览版建的 worktree，用完就删；`codex/fix-*` 的 Mac worktree 在 PR 合入或关闭后，由 Claude 经 Paseo 让对应会话删除并归档。
- 进度看 `docs/v1-plan.md` 里的清单、PR 状态，以及 Claude 会话里的里程碑消息。issue #122 看板和 `docs/program-graph.json` 停止更新。不做本地进度页、会话映射文件或定时刷新。
- Claude 每个在飞 PR 一个会话，标题为 `PR #<号>`。并行放在会话内部，不开根会话加多个工作会话。
- 完整 CI 是 Linux 和 macOS 两个平台，只在 `frozen` head 上跑。macOS 任务跑在 Mac mini 的自托管 runner 上。`linux` 任务不加任务级的 `if:`：名称固定的任务被跳过时算作通过，未冻结的 PR 就能绕过必需检查。真实飞书和真实 Codex 的验收按里程碑做，不是每个 PR 都做。
- v1 不支持 Windows，不跑 Windows CI，也不写新的 Windows 专属代码。已有的 Windows 代码留不留，写在 `docs/v1-plan.md` 里。

## 工具和同步

- 两台机器的 Paseo daemon 通过 Tailscale 互通。JP-VPS 为 `10.0.0.10:6767`，provider `claude`，项目 `/home/operator/vonvon/vonvon-bot`。Mac 为 `10.0.0.11:6767`，provider `codex`。不通过 SSH 执行 `claude -p`。
- Claude 和 Codex 之间不再交接 PR。Claude 经 Mac 的 daemon 新建三种 Codex 会话，这是唯一允许的跨机创建：
  - 检查会话，标题 `Mac 检查 PR #<号>`。Codex 在 Mac 上 pull 这个分支，在本机构建和检查。只接短检查：Codex 一个回合内能做完，大约 30 分钟以内，结果能用文字说清对错。
  - 预览版会话，标题 `Mac 预览版 <里程碑名>`。Codex 从 `main` pull，在 Mac 本机构建；先用隔离的数据目录查 Mac 上的网页端连 Mac 上的 daemon，有问题就停下回复，不打包，不 push；过了再用真实 `HOME` 下的钥匙串签名，装到本机给 owner 验收。
  - 修复会话，标题 `Mac 修复 PR #<号>`。只在开 `codex/fix-*` PR 的会话已经不在、审查又发现问题时新建。Codex pull 这个分支，按 PR 评论修，push。
- 三种会话都按下面的规则跑：
  - 模式用 `auto`，不用 `full-access`；
  - 隔离的 `HOME`、`VONVON_HOME`、userData 和 `VONVON_DESKTOP_TEST_HOME` 只写在启动被测应用或测试的那一条命令前面，例如 `HOME=<临时目录> VONVON_HOME=<临时目录>/vonvon npm test`，不 export。git、gh 和签名命令不带这些变量，用 Mac 上的正常账号和钥匙串。不碰 owner 在用的 bridge 和数据；
  - `auto` 模式拦住了 push、签名或打开应用时，Codex 停下并在回复里写明，不改成 `full-access`；
  - Mac 锁屏时 Computer Use 会失败（getpaseo/paseo#3346）。遇到就停下，不重试，回复第一行写"卡住了："，由 Claude 通知 owner；
  - Codex 用文字回复结果，Claude 把结论贴进 PR。做完删除 worktree，归档会话。
- 对方会话正在运行时不发 `paseo send`，因为它默认会打断对方当前的回合。
- 各台机器只通过 Git 同步，各自运行 npm ci，不拷贝 node_modules、dist、build、release。预览版在 Mac 本机构建、本机安装，不跨机器拷贝。
- v1 按定稿的范围连续开发。每完成一个里程碑，Claude 开预览版会话在 Mac 上装好预览版，通知 owner 验收。等验收期间可以继续下一个切片，但不改已验收的行为。需要 owner 决策、补充信息或操作时，Claude 按 `vonvon-collaboration.md` 的格式通知。
