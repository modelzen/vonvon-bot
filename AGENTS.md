# vonvon-bot 分工规则

2026-10-14 起生效，取代 2026-10-13 的版本，适用于 v1 开发。2026-10-15 起，Mac 上的 Codex 改由 owner 转发启动：Claude 把 Mac 上要做的事贴进任务队列 issue #322，owner 转发一次，Codex 按顺序做完，结果贴回 GitHub，见"工具和同步"。两台机器读同一份规则。本文的 owner 指用户本人；旧的 `owner:` 标签不再使用。Claude 的非平凡任务用 Ultracode 工作流编排。Claude 侧的会话、模型和通知格式另见 JP-VPS 上的 `/home/ops/.claude/vonvon-collaboration.md`，这个文件不在仓库里，Mac 上没有。

## 分工

- JP-VPS 上的 Claude Code 负责 v1 的设计、实现、独立审查、测试和合入。它写 `docs/product.md` 和 `docs/v1-plan.md`，写产品代码和测试，在 JP-VPS 上跑构建、typecheck、lint、定向测试和无头网页界面检查。飞书一侧的行为也在 JP-VPS 上自测：用 lark-cli 以 owner 的用户身份、只在测试群里做，改设置用 `vonvon` 命令行。每个里程碑的验收，不需要 Mac 的步骤由 Claude 先在 JP-VPS 上做完，见 `docs/v1-plan.md` 第 7 节。重命令一律加 `flock /tmp/vonvon-heavy.lock`。全量测试交给 CI 的 Linux 和 macOS 任务。Claude 是唯一的合入入口。
- Mac 上的 Codex 做 Claude 做不到的桌面事项：Mac 上的网页端连 Mac 上的 daemon，真实 macOS 窗口、托盘、菜单、登录项和系统权限弹窗，真实 Codex provider 的运行，用 Mac 钥匙串签名打包预览版。短检查和预览版由 Claude 贴进 #322 的任务队列，owner 在 Mac 上转发给 Codex；长的、需要人来判断的验收交给 owner。公证和对外发布由 owner 在发布前决定谁来做。
- Codex 可以改代码，按下面两种情况提交：
  - Claude 发起的 Mac 检查里发现问题，Codex 直接修，在临时 worktree 里 commit，用 `git push origin HEAD:<分支>` 推到被检查的 `claude/*` 分支，不 force-push，不 rebase。结果评论里写清改了什么、为什么改和提交号。贴出这个任务的结果、或者看到它被取消之后，Codex 不再 push 这个分支。
  - owner 在 Mac 上验收已合入的预览版时发现问题，Codex 从 `main` 开 `codex/fix-<问题>` 分支和自己的 PR，不 push 到任何 `claude/*` 分支。`codex/fix-*` 分支只有 Codex push。Claude 审查发现问题时，把发现写进 PR 评论，在这个 PR 里贴一份修复提示词，再往 #322 贴一个修复任务指过去（见"工具和同步"）。2026-10-14 之前开的 `codex/*` PR 是旧桌面版的参考栈，不是修复 PR。
- Codex 的改动和 Claude 的一样过合入门槛：另一个模型的独立审查、CI 在准确 head 上通过、由 Claude 合入。改动让行为和 `docs/product.md` 不一致时，Codex 在 PR 里写明，Claude 在同一个 PR 里改 `docs/product.md`。
- Codex 不能直接通知 owner。卡住时，Codex 在 #322 的结果评论第二行写"卡住了："加原因；Claude 后台轮询 #322，看到后原样转告 owner。
- 每个产品 PR 的描述写清这几项：用户能看到的变化、试用步骤、Claude 跑过的命令和结果、独立审查结论，以及还没在真实 Mac 上验过的项。没有用户可见变化的 PR，要说明为什么现在必须做。

## 范围和资料

- v1 的范围以定稿的 `docs/product.md` 为准。owner 在 `docs/product.md` 的 PR 里认可后即为定稿；"定稿"只指这份文档，`frozen` 只指 PR 标签。定稿之前是产品设计环节，不写产品代码。定稿后的新想法写进其中"v1 之后"一节，发布前不实现。
- v1 的切片和里程碑写在 `docs/v1-plan.md`。它随代码在同一个 PR 里更新，不另开文档 PR。
- `docs/plan.md`（V1 到 V11）和 `docs/roadmap.md` 从 2026-10-14 起停止执行，只作历史参考。
- 调研结果放在 `docs/research/`。开始调研之前，先读其中的 `README.md`，已经查过的不再重查。新一轮调研放进新的日期目录，并在 `README.md` 里加一行。

## 一个 PR 的流程

1. Claude 从 `main` 开 `claude/<切片>` 分支。开产品 PR 时，把复查在飞产品 PR 数和创建 PR 放进同一个 `flock /tmp/vonvon-pr-slot.lock` 里执行，数到两个就不开。实现，跑 JP-VPS 上的检查，push。
2. 由另一个模型的子代理做独立审查，结论写进 PR 评论。改动涉及子进程、并发、关闭或清理顺序、错误路径、macOS 原生代码、数据迁移或合入门禁（CI 和本文的规则）时，再加一轮多角度审查。每条发现先复现或驳回，再改。
3. 有桌面专属项时，Claude 把 Mac 检查的提示词贴进 PR，再往 #322 贴一个检查任务指过去，规则见"工具和同步"。Mac 检查只在没带 `frozen` 的 PR 上发起。Codex 改了代码，它的改动回到第 2 步审查；审查后如果改动碰到桌面行为，Claude 再贴一份检查提示词和一个新任务。做不了的项，在 PR 里记为"待 owner 验收"。
4. 审查和 Mac 检查都完成后，Claude 打 `frozen`，等 `linux` 和 `macOS checks` 在准确 head 上都显示成功。合入规则只强制 `linux`，`macOS checks` 由 Claude 用 `gh pr checks` 确认；它显示跳过、排队或 runner 离线都不算通过，这时通知 owner。打了 `frozen` 之后还要 push，先去掉 `frozen`，push 后让改动回到第 2 步，再重新打。去掉 `frozen` 后再加任何标签，`linux` 都会变红，重新打 `frozen` 才恢复。合入规则要求分支和 `main` 同步，所以冻结后 `main` 前进了，要先把 `main` merge 进分支，这也算一次 push，按同样的步骤走。
5. Claude 用准确 head 的 sha 合入，删除 JP-VPS 上的 worktree。

合入产品 PR 的条件：两个 CI 任务在准确 head 上成功，独立审查结论已贴进 PR，评审线程都已解决，PR 描述各项齐全。

纯文档 PR 不打 `frozen`。独立审查结论贴进 PR、`linux` 在准确 head 上通过后，Claude 合入。dependabot PR 改依赖，按产品 PR 的条件审查、冻结和合入，或者直接关闭。

## 硬限制

- `claude/*` 分支平时只有 Claude push。Claude 往 #322 贴出某个分支的检查任务后，就不 push 这个分支，直到下面三件事有一件发生：这个任务的结果贴出了；Claude 在它开始之前取消了它，也就是取消贴出后再看一次，#322 里没有比这条取消更早贴的这个任务的开始评论；Claude 按"工具和同步"通知 owner 后，owner 确认 Mac 上没有会话在处理 #322；这时这个任务还没取消的，Claude 先贴取消再 push，免得睡着的 Mac 醒来后旧会话接着推。开始以后才取消的，仍要等结果或 owner 确认。之后 Claude 先 pull 再改。什么时候通知 owner，见"工具和同步"里"转发一次，做完一批"的第 4 条。还要做这次检查，Claude 先取消旧任务，再贴一份新的提示词和一个新任务，按"工具和同步"请 owner 转发。任何人都不 force-push，不 rebase 已 push 的分支。
- 除了 `frozen`，不给 PR 加别的标签。每次加标签都会按 PR 当时的标签重跑 CI，PR 已带 `frozen` 时会再跑一遍完整平台链。
- 产品 PR 同时在飞最多两个，第三个要等一个合入。计数方法：开放、非 draft、head 分支以 `claude/` 开头、改动里有 `.github/`、`scripts/`、`AGENTS.md`、`docs/` 和其他 Markdown 以外文件的 PR，再去掉暂停的 #281 和 #285。所以纯文档 PR 和只改 CI、脚本、规则的流程 PR 不计；dependabot PR 和 Codex 的 `codex/fix-*` 修复 PR 不在 `claude/` 分支上，也不计。修复 PR 由 Claude 优先审查和合入。本规则生效前开的 PR 全部暂停：#281（V6b 的 Codex 子进程迁移）、#285（V5 的启动路由），以及 `codex/` 分支上的 #110（V5 的桌面外壳）等。它们的去留在 `docs/product.md` 定稿时由 owner 决定。
- 一个 PR 对应一个切片，大小以一个审查子代理能读完整个 diff 为准。不含 lockfile 和生成文件时，以 1500 行改动为上限，超过就先拆。
- 每个功能分支在每台机器上只有一棵 worktree，合入即删。GitHub 在合入时自动删除远端分支。Mac 上的 Codex 每做一个任务，自己建一棵 detach 的临时 worktree，留到整个队列结束时再删。开 `codex/fix-*` PR 的 Codex 会话，push 完、PR 开好就删掉它的 Mac worktree，之后的修改走 #322 里的修复任务。
- 进度看 `docs/v1-plan.md` 里的清单、PR 状态，以及 Claude 会话里的里程碑消息。issue #122 看板和 `docs/program-graph.json` 停止更新。不做本地进度页、会话映射文件或定时刷新。
- Claude 每个在飞 PR 一个会话，标题为 `PR #<号>`。并行放在会话内部，不开根会话加多个工作会话。
- 完整 CI 是 Linux 和 macOS 两个平台，只在 `frozen` head 上跑。macOS 任务跑在 Mac mini 的自托管 runner 上。`linux` 任务不加任务级的 `if:`：名称固定的任务被跳过时算作通过，未冻结的 PR 就能绕过必需检查。真实飞书和真实 Codex 的验收按里程碑做，不是每个 PR 都做。
- v1 不支持 Windows，不跑 Windows CI，也不写新的 Windows 专属代码。已有的 Windows 代码留不留，写在 `docs/v1-plan.md` 里。

## 工具和同步

- 两台机器的 Paseo daemon 通过 Tailscale 互通。JP-VPS 为 `100.121.117.46:6767`，provider `claude`，项目 `/home/ops/vonvon/vonvon-bot`。Mac 为 `100.127.134.58:6767`，provider `codex`。owner 自己的会话照旧经它们跑。不通过 SSH 执行 `claude -p`。
- 2026-10-15 起，Claude 不经 Paseo 在 Mac 上新建会话。Mac 上的事都进 issue #322（Mac mini 上 Codex 的任务队列）：owner 在 Mac mini 上开一个 Codex 会话，转发一次，Codex 按顺序做完。要改回 Paseo，先改本文。Claude 和 Codex 之间不再交接 PR。
- #322 的正文是给 Codex 的完整说明：怎么认作者、心跳和开始评论、任务和结果的格式、取消、轮询和结束、每个任务都要守的规矩，包括临时 worktree、push 的写法和预览版任务能碰什么。改队列的规矩时，正文和本文一起改。
- Mac 上的事分三种任务，都贴成 #322 的评论。第一行是 `<!-- claude-mac-task:<任务号> -->`，任务号接着上一个往上数；第二行是标题，下面是内容。长的提示词贴在相关的 PR 里，任务里给出那条评论的链接（带评论 id），写明哪一步不做、结果贴到哪里。Codex 只照链接指的那一条做；任务只给了标记、找到不止一条时，不猜，结果写"卡住了：提示词有几份"。旧记录里说的检查会话、预览版会话和修复会话，指 Codex 在队列里做的这三种任务：
  - 检查任务：提示词贴在 PR 里，第一行是 `<!-- claude-mac-check-prompt-<PR号>-<任务号> -->`；提示词里防重复的开始和结果标记也带任务号，例如 `<!-- codex-mac-check-<PR号>-<任务号>-start -->` 和 `<!-- codex-mac-check-<PR号>-<任务号> -->`。同一个 PR 再查一轮，比如 Codex 改了代码之后，就是新任务号的新提示词，标记不和旧的重名。#320 的第一份（任务 1）是这条规矩之前贴的，没带任务号。Codex 在临时 worktree 里取这个分支，在本机构建和检查。只接短检查：一个任务大约 30 分钟以内，结果能用文字说清对错。
  - 预览版任务：没有 PR，提示词整份写在任务里，结果也贴在 #322，不再另开 `Mac 预览版 <里程碑名>` issue。Codex 在临时 worktree 里取 Claude 给的 `main` sha，在 Mac 本机构建；先用隔离的数据目录查 Mac 上的网页端连 Mac 上的 daemon，有问题就停下贴结果，不打包，不 push；过了再用真实 `HOME` 下的钥匙串签名，装到本机给 owner 验收。owner 做完一步、要 Codex 接着查时，Claude 贴一个新任务，按步骤号只列这几步，用已经装好的 app，不重新构建、打包和安装，除非任务写明。
  - 修复任务：提示词贴在 `codex/fix-*` PR 里，第一行是 `<!-- claude-mac-fix-prompt-<PR号>-<任务号> -->`。Claude 审查这个 PR 发现问题时贴。Codex 在临时 worktree 里取这个分支，按 PR 评论修，push。
- 两边都只认和本机 `gh api user` 同一个账号贴的标记评论：两台机器的 gh 登的都是 owner 的账号。别的账号和 bot 贴的，不管是任务、取消、结束、提示词还是结果，一律不理。任务指向的提示词评论，作者不是这个账号的，Codex 不做，在结果里写明。
- 转发一次，做完一批：
  1. Claude 先把手上能做的 Mac 任务都贴出来，再看 #322 最新的心跳评论，也就是 id 最大的那条：第一行是 `<!-- codex-mac-queue-session -->`，第二行是"心跳 <UTC 时间>"，会话结束后改成"已结束 <UTC 时间>"。
  2. 下面两种情况，说明 Mac 上有会话在处理队列，Claude 只贴任务，不找 owner：心跳在 10 分钟以内；或者有任务开始了还没有结果，心跳在一小时以内。
  3. 否则 Claude 通知 owner 一次，要转发的只有一行"按 modelzen/vonvon-bot#322 正文做"。owner 自己要做的事，比如 SSH 上的命令、扫码、验收步骤，写进同一条通知，不分几次发。有开始了没有结果的任务时，先按"硬限制"第一条请 owner 确认 Mac 上没有会话在处理 #322，Claude 取消这个任务、要重做就贴一个新任务，再请 owner 转发。
  4. Claude 后台轮询 #322。还有没结果、没取消的任务，第 2 条的两种情况却都不成立了，比如心跳写着"已结束"，或者会话断了、Mac 睡了，Claude 不等，按第 3 条通知 owner。开始以后才取消、一直没有结果的任务也一样：心跳写着"已结束"或者超过一小时没更新，Claude 通知 owner，请 owner 确认 Mac 上没有会话在处理 #322，这个分支才能再 push。通知以后一小时内还没出现新的心跳，再通知一次，不反复发。
  5. owner 在 Mac mini 上新开一个 Codex 会话，模式选 full access，把这一行发一次。同一时间只有一个会话处理队列：心跳还新，或者有任务开始了还没有结果、也没取消，后开的会话自己停下。两个会话同时开起来时，以 id 小的那条心跳为准，另一个把自己的心跳改成"已结束"，停下。
  6. Codex 按任务号从小到大一个一个做。开始一个任务前，先贴一条开始评论：第一行是 `<!-- codex-mac-start:<任务号> -->`，第二行写自己心跳评论的 id。贴完再看一次队列，这个任务有了取消，或者有比自己早贴的开始评论，就不做。做完一个先贴结果再做下一个。结果评论第一行是 `<!-- codex-mac-result:<任务号> -->`，第二行一句结论，卡住了写"卡住了："加原因。任务指向的提示词说结果贴在哪里，就先贴在那里，再在 #322 贴一条短结果，带上链接。
  7. 心跳：没有任务时，Codex 每 2 分钟看一次队列，同时更新心跳；做任务时，每做完一步也更新，两次之间尽量不超过 5 分钟。
  8. 有开始评论、没有结果也没取消的任务，新会话不接手，也不往后做：停下，回复 owner"任务 <号> 开始过但没有结果"。那个会话可能还在做，也可能中途断了；要重做，由 Claude 取消它，再贴一个新任务。这样会话断在装好 app 和贴结果之间时，预览版任务不会被重做，owner 装好的 app 不会再被换一次。
  9. 追问也是新任务。Claude 看完结果还要补查，就再贴一个任务，不在 PR 里等追问；提示词里"等追问"那一步不做。会话已经结束的，按第 1 到 3 条再请 owner 转发一次。
  10. 提示词自己的开始和结果标记照旧留着，带上任务号（见上面的检查任务），Codex 照提示词的第 0 步先查。要重做一份已经开始过的提示词，Claude 贴一份新的、带新任务号的。
  11. 任务不用做了，Claude 贴一条第一行是 `<!-- claude-mac-cancel:<任务号> -->` 的评论。取消和结果一样，算这个任务完了：Codex 跳过它，接着做后面的。任务开始以后才取消的，Codex 在 push 之前、替换装好的 app 之前各再看一次，看到取消就停下，贴一条结果，写明停在哪一步、改过什么。
  12. 连续 90 分钟没有新任务，或者 Claude 贴了第一行是 `<!-- claude-mac-queue-end -->` 的结束评论，Codex 就结束。结束评论只管贴出时在跑的会话：Codex 只认比自己心跳评论晚贴、而且后面没有更晚的任务评论的那条，早的不理；Claude 贴了结束评论又贴新任务，这条结束评论就作废。结束时先把心跳第二行改成"已结束 <UTC 时间>"，改完再看一次队列：这期间来了新任务，就把心跳改回来接着做；没有，就删掉各任务的临时 worktree，给 owner 回一行做了哪些任务。
  13. Codex 每个任务自己建临时 worktree：`git fetch` 后 detach 在任务给的分支或 sha 上，不动 Mac 上仓库原来的 checkout，留到整个队列结束时再删。要修的，在临时 worktree 里 commit，用 `git push origin HEAD:<分支>` 推，不 force。贴出这个任务的结果、或者看到它被取消之后，不再 push 这个分支。
- 每个任务都按下面的规则跑，任务里写得更严的，照任务做：
  - 模式用 full access（owner 2026-10-15），owner 新开会话时选好。改文件、跑命令、联网都不再发申请，Computer Use 和 MCP 的权限申请也自动同意；
  - 隔离的 `HOME`、`VONVON_HOME`、userData 和 `VONVON_DESKTOP_TEST_HOME` 只写在启动被测应用或测试的那一条命令前面，例如 `HOME=<临时目录> VONVON_HOME=<临时目录>/vonvon npm test`，不 export。git、gh 和签名命令不带这些变量，用 Mac 上的正常账号和钥匙串。装卸后台服务、碰 launchd 的命令一定要带 `VONVON_HOME`，而且不能是 `$HOME/.vonvon-bot`：launchd 的任务按用户账号区分，只换 HOME 时数据目录还是默认的 `.vonvon-bot`，任务名就是 owner 在用的 `com.vonvon.bot.daemon`；换了 `VONVON_HOME`，任务名才带上数据目录的哈希。除了下一条允许预览版任务做的步骤，不碰 owner 在用的 bridge 和数据；
  - 没有申请拦着，范围靠任务和提示词管。Claude 写明这次用哪些隔离目录、哪些不碰：owner 的 bridge 和它的数据、owner 的飞书客户端；owner 的 `/Applications/Vonvon Bot.app`、`~/.vonvon-bot` 和 `com.vonvon.bot.daemon` 只有预览版任务能碰，而且只在替换装好的 app、做 `docs/v1-plan.md` 第 2 节标"Codex 先查""Codex 接着查"的步骤时碰，Claude 按步骤号列出这几步。Codex 只做这个任务要的事，要做任务以外的事就停下，在结果评论里写明；
  - Mac 锁屏时 Computer Use 会失败（getpaseo/paseo#3346），调用也可能超时。遇到就停下这个任务，不重试，结果第二行写"卡住了："加原因；后面要用 Computer Use 的任务也先写"卡住了：Computer Use 同上"，不用的任务照做。Claude 看到后通知 owner；
  - 贴到 GitHub 前打码。不贴凭据、令牌和 app secret，也不贴群号、群名和飞书的完整 id，和仓库里一样（`docs/v1-plan.md` 第 7 节）。`/Users/<名字>` 写成 `/Users/<u>`，签名身份只写"Developer ID Application"，不贴 IP、设备名和带凭据的网址；
  - Codex 的结果都在 GitHub 的评论里，Claude 把结论写进 PR 描述或给 owner 的通知。会话留给 owner 关。
- 用 Paseo 时，对方会话正在运行不发 `paseo send`，因为它默认会打断对方当前的回合。
- 各台机器只通过 Git 同步，各自运行 npm ci，不拷贝 node_modules、dist、build、release。预览版在 Mac 本机构建、本机安装，不跨机器拷贝。
- v1 按定稿的范围连续开发。每完成一个里程碑，Claude 往 #322 贴预览版任务，Codex 在 Mac 上装好预览版；Claude 看到结果后通知 owner 验收。等验收期间可以继续下一个切片，但不改已验收的行为。需要 owner 决策、补充信息或操作时，Claude 按 `vonvon-collaboration.md` 的格式通知。
