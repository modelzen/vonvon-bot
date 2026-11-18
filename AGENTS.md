# vonvon-bot 分工规则

## 2026-10-30 起：开发分支 → dev → main → 发布

owner 2026-10-30 定。本节是开发、合入和 CI 的现行规则；与下文旧规则冲突时，以本节为准。旧规则中的任务交接、数据隔离、独立审查及 owner 本地验收规则，在不冲突的范围内继续适用。不得把过去某次验收或发布授权当作新改动的授权。

### 分支、验收和发布

1. 新功能、修复和流程调整，默认从最新 `origin/dev` 建独立的 `codex/<主题>` 分支，在隔离 worktree 中开发、自测。日常 PR 的目标是 `dev`；同步基线时 merge 最新 `dev`，不 force-push，不 rebase 已 push 的分支。未完成或暂不发布的功能留在开发分支。
2. 完成必要检查、审查及本次需要的验收后，才能合入 `dev`。owner 说“OK”“验收通过”“可以合入”，默认指把本次验收过的提交合入 `dev`；符合 2026-10-21 本地验收规则时，当前 Codex 可直接执行，不再要求额外人工或模型审查。认可不覆盖后续产品行为变化。
3. `dev` 用于集成、内部试用和集中验收，应保持可运行。单项功能通过不等于整批发布通过。合入后发现阻塞问题，先修复或通过新 PR revert，不通过挑选提交绕过问题。
4. owner 决定何时集中把 `dev` 提升到 `main`，可以每天一次，也可以隔几天；不存在每天自动合入或发版的授权。准备发布时，记录本批功能、验收结果和准确源码 SHA，再开 `dev → main` PR；若要在 `dev` 继续开发时固定本批候选，可从选定的 `dev` SHA 建 `codex/promote-<主题>` 分支。候选必须包含选定 SHA 的全部历史，不随意 cherry-pick。
5. `main` 是正式版本的源码基线。面向 `main` 的产品或流程 PR，重新执行本批最终提交的全量包检查，并完成集成验证：Linux 和 macOS 必须运行，Windows 仅在本批包含 Windows 相关改动或明确要求时运行；普通纯文档仍可走轻量检查。向 `main` 合入使用 merge commit，保留长期分支的共同历史，不 squash、不 rebase。不要删除长期 `dev` 分支。
6. 在 `main` 上产生的版本号、紧急修复等实际修改，要及时通过 PR 同步回 `dev`；仅有 merge commit、文件内容相同，不要求两个分支 SHA 相同。只有 owner 明确要求紧急修复时，才允许从 `main` 开修复分支直接进入 `main`，随后回同步 `dev`。
7. “合入 dev”“合入 main”“发布版本”是三个不同结果，汇报时分别说明。合入 `main` 不自动打版本 Tag、签名、公证、上传或切 stable；公开发布仍遵守下文发布任务的明确授权及证据要求。正式版本从确定的 `main` 提交构建，Git Tag（如 `v0.7.9`）只标识发布版本，不选择 CI。macOS 和 Windows 使用相同产品版本。

### CI 如何选择包和平台

- 每个面向 `dev` 或 `main` 的 PR 都先执行轻量任务：验证分流/执行/合入门槛脚本，收集整个 PR 相对共同祖先的累积差异，检查空白错误，再输出选择的包、平台和原因。不只看最后一个 commit；删除、重命名前后的路径也算变更。
- 普通说明文档（根 `README.md`、`docs/` 下的小写 `.md`）默认只跑轻量检查，不安装产品依赖。`AGENTS.md`、`CLAUDE.md`、skills、CI、脚本和构建规则会影响执行行为，不按普通文档免检。
- `dev` PR 按影响范围选择包：UI 改动检查 UI 和桌面集成，daemon 改动检查 daemon 和桌面集成，桌面改动检查桌面；公共 protocol/client、依赖、包配置、公共构建脚本、规则文件及未知路径执行全量。当前为保证包间构建依赖，代码任务先构建所有包，再对选中的包执行类型检查、测试和 lint，同时运行仓库脚本测试。
- Linux 是所有代码改动的基础平台。普通 UI 只需要 Linux；明确的 macOS 专属文件或目录增加 macOS，Windows 专属文件或目录增加 Windows；公共 daemon/桌面运行逻辑、protocol/client、依赖和公共构建/CI 配置会影响 Windows，检查三个平台。混合改动取平台并集。单独修改开发规则不因此运行 Windows；`main` 集成批次检查全部包和 Linux、macOS，只有累积差异确实影响 Windows 时才增加 Windows，不因“发布前全量”无条件消费 Windows runner。Windows CI 使用 x64 runner；ARM64 安装包与真实系统行为仍在发布验收中检查。
- 各平台执行适合该平台的检查：Linux/macOS 对选中的包运行完整自动化测试；Windows 保留全部包的构建、相应类型检查和 lint，protocol/client/UI 按选择运行包测试，daemon、桌面及仓库脚本复用 `scripts/build-windows.ps1` 已验证的 Windows 专项回归清单，覆盖 Windows 启动/进程/数据兼容/注册、桌面更新/托盘/依赖以及打包运行时工具。CI 不运行该发布脚本本身，不执行安装或发布；专项清单与发布脚本的一致性由回归测试检查。
- 平台由 `.github/scripts/ci-scope.mjs` 自动选择。PR 标签可扩大范围，不能缩小自动判定的必要检查：`ci:macos` 追加 macOS，`ci:windows` 追加 Windows，`ci:all` 强制全部包和三个平台。Linux 始终是代码检查的基础平台；多个标签取并集。没有平台标签时按自动结果执行。
- `frozen` 是 PR 的 Label，不是 Git Tag，只表示“本次已准备合入，允许运行较重检查”。开发中更新 PR 先跑轻量分析；非文档 PR 在加 `frozen` 前，最终合入检查保持失败，不能靠跳过产品测试合入。加 `frozen` 后运行选中的平台。若还要改代码，先去掉 `frozen`，push、完成必要审查/验收后再加回来；新提交必须取得自己的检查结果。普通文档不要求 `frozen`。不添加与工作无关的标签。
- CI 监听平台标签及 `frozen` 的添加和移除、代码更新、目标分支和 draft 状态变化。同一 PR 的旧运行自动取消。手动 `workflow_dispatch` 总是全量三平台，供排查和补充验证；手动运行不能替代 PR 自己的合入证据。
- `dev` 和 `main` 都要求 PR、与目标分支同步、解决评审线程，并通过固定名称的 **`CI gate`**。该任务始终执行，逐一确认所有选中的平台成功；未选平台可以跳过，选中平台失败、取消或跳过都不能合入。分流出错、变更列表不完整、runner 不可用、旧 SHA 或过期标签均不能当作通过。手动运行使用不同名称 `Manual CI result`，不提供必需的 PR 合入检查。自动平台选择不取代必要的真实系统和产品验收。
- 成本约定：公开仓库的 macOS CI 使用 GitHub 的标准 ARM64 runner，与 Linux、Windows 一样在托管环境中运行。私有仓库阶段的 macOS CI 使用专门的组织级自托管 runner，由无管理员权限的独立账户运行，禁止执行外部 fork 的代码。Windows 仅在相关改动或明确要求时运行。CI 仅执行构建、类型检查、自动化测试和 lint。签名、公证、安装或发布使用独立环境。

### 常用 CLI

```bash
# 从最新 dev 开发；命令在本任务的隔离 worktree 中执行。
git fetch origin dev
git switch -c codex/<主题> origin/dev
git push -u origin HEAD
gh pr create --base dev --title "<标题>" --body-file <说明文件>

# 默认按改动自动选平台；准备合入时开始执行所需检查。
gh pr edit <PR号> --add-label frozen

# 需要明确补充平台时，可与 frozen 一起添加。
gh pr edit <PR号> --add-label "ci:macos,frozen"
gh pr edit <PR号> --add-label "ci:windows,frozen"
gh pr edit <PR号> --add-label "ci:all,frozen"

# 查看选择结果和检查状态；成功后用准确提交 SHA 合入。
gh pr checks <PR号>
gh pr merge <PR号> --merge --match-head-commit <完整head-SHA>
```

示例：只改 macOS 专属代码，默认就是 Linux + macOS；添加 `ci:macos` 可明确表达要求。若同时修改公共运行逻辑，即使只加 `ci:macos`，也仍执行三个平台。无需 owner 每次手工选择；执行开发任务的代理应根据差异检查自动结果，必要时加标签扩大范围，并在 PR 中说明。

## 默认发布流程（owner 2026-10-30 定）

本节覆盖下文旧发布规则。owner 要求发版时默认读取 `.agents/skills/release-mac/SKILL.md`，使用 `release-all.mjs` 构建/续跑、`release-publish.mjs` 生成计划/并行上传/提升并收集官网回执；不要求 owner 再点名技能、加速方案或手写命令。固定已验收 main SHA，两平台同版本；默认不做历史问题的公证彩排，不因上传失败重建候选。

完整发布请求包括该轮签名、公证、版本化上传、公网核验和官网更新，不为已授权的每个阶段重复提问。先准备候选和计划、展示结果，最终 stable 仍按下文的候选绑定确认规则执行；明确只做候选或只做调研时保持该范围。发布队列/其他代理不能替 owner 作最终决定。正常使用现有脚本并保存状态和计时，异常才诊断，不现场重写上传器。CI 平台选择继续遵守当前 CI 规则；本节不跳过检查。

## 2026-10-30 起：Claude 自己开发，多片的功能最后统一跑 CI

owner 2026-10-30 定。本节和下文"2026-10-19 起：Claude 出计划，Codex 写代码""2026-10-19 晚起"，以及"硬限制"里每个在飞 PR 一个会话的规定冲突时，以本节为准。分支、验收和发布照"开发分支 → dev → main → 发布"一节，只有一处例外：多片的功能，各片 PR 以集成分支为目标，合入集成分支时不跑 CI、不打 `frozen`。这是对那一节第 1 条"日常 PR 的目标是 `dev`"、CI 一节"加 `frozen` 前最终合入检查保持失败"和"一个 PR 的流程"里合入条件中 CI 一项的例外。集成分支到 `dev` 的 PR 仍要满足这些条件。

- Claude 能做的开发自己做：开 `claude/<主题>` 分支，在 JP-VPS 的隔离 worktree 里实现，会话内用工作流并行。JP-VPS 上的验收 daemon、Bot 6/7/8、真 Claude 和已登录的 Codex CLI，Claude 直接用，不经 Codex。
- 只有必须用 Codex 或 Mac 的事才派任务：Mac 上的网页端和桌面验收，桌面外壳、托盘、菜单和系统弹窗，Mac 上的签名打包，以及只有 Mac 上的 Codex 碰得到的东西（ego-browser、飞书开发者后台）。派法照旧：Mac 走 #322，JP-VPS 走 #422。任务属于集成分支上的功能时，任务里写明 base 分支：Codex 从那条集成分支开分支（或检查它的某个 sha），PR 以它为目标，不以 `dev` 为目标。
- Claude 自己的 PR 照旧由另一个模型独立审查。风险一栏有子进程、并发、关闭清理、错误路径、macOS 原生、数据迁移或合入门禁的，再加一轮多角度审查。每条发现先由另一个代理尝试驳回，驳不倒的再复现（规则和文档类的发现，确认属实即可），确认了才改；修完再做一轮增量审查。
- 多片的功能不每片跑 CI（owner："ci 不要过多触发，可以最后统一触发"）：
  - 从最新 `origin/dev` 开 `claude/<功能>-integration`。各片 PR 以它为目标；`ci.yml` 只监听目标是 `dev`、`main` 的 PR，所以不触发 CI。前后依赖的片可以叠加，PR 的目标是前一片的分支；前一片合入、分支删掉后，GitHub 自动把目标改成集成分支。
  - 集成分支只经审查过的片 PR 改动，不直接 push。例外只有两种提交：把 `dev` merge 进来（包括解决冲突的改动），和 CI 失败后的修复，见下面"这个 PR 不受 5000 行的上限"一条。
  - 片 PR 照样计入在飞产品 PR，上限 6 个（"2026-10-19 晚起"），计数照旧在 `flock /tmp/vonvon-pr-slot.lock` 里做。一个功能的各片 PR 可以由同一个 Claude 会话负责。
  - 各片审查、自测完合入集成分支，不打 `frozen`。
  - 全部做完，再开一个集成分支到 `dev` 的 PR。这个 PR 不早开：开着时每合入一片、每改一次描述，都会重跑检查。描述（含独立审查结论）写齐后再加 `frozen`，按自动选择的平台跑一次 CI。
  - 这个 PR 不受 5000 行的上限，也不按"硬限制"里的大 PR 做法再拆审查，各片已经分别审过。有两种提交没经过片 PR：把 `dev` merge 进来，和 CI 失败后的修复。merge 里解决冲突的改动和 CI 修复，由另一个模型按增量 diff 审查，结论贴进这个 PR；没有冲突的 merge 不用另审。CI 失败要修时照 `frozen` 的规矩：先去掉 `frozen`，push，做完增量审查再加回来。
  - 汇报时分清"合入集成分支"和"合入 dev"。

## 2026-10-21 起：owner 在 Mac mini 本地验收后直接合入

owner 2026-10-21 定。本节优先于下文关于独立审查、合入入口和交接的规定。

- owner 在 Mac mini 本地验收时提出的建议、意见和修改需求，由当前 Mac 上的 Codex 完成本地修改，交给 owner 验收。
- owner 对这次修改明确表示“OK”“验收通过”“可以合入”等认可后，当前 Codex 可以直接合入对应 PR；不再要求其他模型的独立审查、多角度审查、Claude 或 JP-VPS 总管审核，也不用另派队列任务或再请 owner 确认一次合入。
- PR 描述记录 owner 提出的需求、本地修改和验收结果，以及认可所对应的提交。独立审查结论填写“owner 已在 Mac mini 本地验收通过，按 2026-10-21 规则直接合入”。认可只覆盖 owner 验收过的改动；后续再改产品行为时，仍需交给 owner 验收。
- 自动化检查、`frozen` 和 GitHub 分支保护照旧执行；这些不属于额外人工或模型审核。未经过上述本地验收和 owner 明确认可的 PR，仍按下文原流程处理。

2026-10-17 到 10-18，Claude 额度用完期间，owner 把开发临时交给 JP-VPS 上的 Codex（#367）。这期间的 PR（#364 到 #385）由 Codex 推进和合入，其中 #364、#365 的主体是 Claude 之前写的；独立审查主要由 gpt-6-astra 做，实现也是 Codex。2026-10-18 owner 停下 Codex、交还职责，下文的分工照旧生效。

2026-10-14 起生效，取代 2026-10-13 的版本，适用于 v1 开发。2026-10-16 起，Mac 上的 Codex 由 Claude 经 Paseo 直接开会话，一个任务一个会话，结果贴回 GitHub；Paseo 用不了时（连不上、开不了会话，或者 #322 上还有活着的队列会话），才把任务贴进队列 issue #322 请 owner 转发，见"工具和同步"。2026-10-19 起又以 #322 为主：owner 在 Codex App 里开队列会话，Claude 往 #322 贴任务，经 Paseo 开 Mac 会话只在 owner 要求时用（见"2026-10-19 起"）。两台机器读同一份规则。本文的 owner 指用户本人；旧的 `owner:` 标签不再使用。Claude 的非平凡任务用 Ultracode 工作流编排。Claude 侧的会话、模型和通知格式另见 JP-VPS 上的 `/home/operator/.claude/vonvon-collaboration.md`，这个文件不在仓库里，Mac 上没有。

## 2026-10-19 晚起：Codex 审查、合入和派活

owner 2026-10-19 晚定。当时 Claude 的周额度只剩约 25%，还要撑 5 天，owner 要在这 5 天里把 v1 全部做完、发布。这是"Claude 额度用完时"那一节的 owner 指定，和下文冲突的以本节为准。

- **总管：** JP-VPS 上一个 Codex 会话，模型 gpt-6-astra，由 Claude 经 Paseo 开。它负责：
  - 审查 PR，产品 PR 和文档 PR 都审；
  - 往 #322、#422 贴改 PR 的任务；
  - 同步 `main`、打 `frozen`、等 CI、合入、清理；
  - 派下一片、发里程碑预览版任务。

  做法全在 #436 正文。
- **实现：** 照旧是 Mac（#322）和 JP-VPS（#422）上的 Codex，模型 gpt-6.1-sol。审查者和作者不是同一个模型。
- **计划：**
  - s31、s35、s46、s61、s62 由 Claude 写，走文档 PR。
  - 其余没有计划的片，由实现者先照 `docs/plans/README.md` 写计划，计划和代码放在同一个 PR 里，由总管一起审。
- **Claude：** 只写上面那几份计划，把总管在 #436 贴的 `codex-need-claude` 转告 owner，发布前把关。不再审查每个 PR。
- **在飞：** 产品 PR 最多 6 个（原来 4 个），计数方法照旧。
- **v1 的范围：** 照 `docs/v1-plan.md` 全部做（owner 2026-10-19）。
- **交还：** 由 owner 指定。额度恢复不会自动切回。

## 2026-10-19 起：Claude 出计划，Codex 写代码

owner 2026-10-19 定（Claude 的周额度用到一半）：从 s27a 起，新切片由 Mac mini 上 Codex App 里的 Codex 写代码；Claude 写设计和详细计划、审查、合入。在飞的 #419 由 Claude 收尾（#420 已合入）。本节和下文冲突时，以本节为准。

- **Claude（JP-VPS）：**
  - 每一片写一份详细计划 `docs/plans/<片>.md`，格式见 `docs/plans/README.md`。难的片（并发、队列、关闭清理）由 Fable 起草、Opus 审稿。计划走纯文档 PR 合入。
  - 计划先写到 M7，M7 做到一半再写后面的。
  - 把开发任务贴进 #322（Mac）或 #422（JP-VPS）。
  - 审查 Codex 开的 PR：另一个模型的子代理做独立审查；风险一栏有子进程、并发、关闭清理、错误路径、macOS 原生、数据迁移或合入门禁的，再加一轮多角度审查。发现贴进 PR，再往这一片的队列（#322 或 #422）贴一个改 PR 的任务。
  - PR 描述里"独立审查结论"一项，Codex 写的是"待 Claude 审查"，Claude 审完用 REST 改。
  - 打 `frozen`，等 CI，合入。里程碑预览版和通知 owner 照旧。
  - Claude 不再自己实现新切片。往 Codex 的分支上 push，只限下面"分支"一条说的同步。
- **Codex（Mac mini 上的 Codex App，owner 开会话）：**
  - owner 在 Codex App 里发一句"按 modelzen/vonvon-bot#322 正文做"。
  - Codex 按 #322 的队列做开发任务、改 PR 的任务和检查任务：照计划写代码和测试，在 Mac 上跑检查，用 Mac 自己的测试 bot 做真飞书自测，开 PR，按审查改。
  - 它有 Computer Use，桌面端的窗口、托盘、系统弹窗这类验收也由它做。界面验收优先用 Codex 自带的网页控制（owner 2026-10-19：桌面端只是包了一层网页端，网页控制成熟得多）：在 Codex 的浏览器里打开网页端操作，不写 Playwright 脚本；只有桌面外壳自己的行为（窗口、停止和启动 daemon 这类外壳逻辑）、托盘、菜单、系统弹窗、真浏览器的密码管理器这类网页端碰不到的，才用 Computer Use。
  - 飞书里的操作一律用 lark-cli，不点飞书客户端（owner 2026-10-19）。
  - 计划里写不清、要定产品行为的地方，不猜，结果里写"卡住了"。纯技术的取舍自己定，写进 PR 描述"和计划不一样的地方"。
  - Mac 上 Codex 的额度充足（owner 2026-10-19），尽量并行：一个任务里开子代理分头写代码、写测试、开 PR 前照验收要点自审；队列里有几个开发任务时一起做。测试环境、Computer Use、打包装 app 同一时间只给一个任务用。规矩见 #322 正文"并行"。
- **Codex（JP-VPS 上的 Codex CLI，Claude 开会话）：**
  - owner 2026-10-19 让 Claude 也用 JP-VPS 上已登录的 Codex。
  - Claude 经 Paseo 在 JP-VPS 上开会话：provider codex，模式 auto-review，一片一个会话。任务和规矩在 #422。命令：`paseo --host 10.0.0.10:6767 run -d --provider codex/gpt-6.1-sol --mode auto-review --cwd /home/operator/vonvon/vonvon-bot --title "开发 <片> 任务 <号>" "按 <评论链接> 做，任务号 <号>"`。
  - 经 Paseo 是为了会话不随 Claude 的会话结束，owner 在 Paseo 里看得到、接得上，Claude 能 wait、logs、stop。
  - 任务号和 #322 共用一套，用同一个取号脚本：任务号存在 JP-VPS 的 `/home/operator/vonvon/local-tools/mac-task-seq`，Claude 用同目录的 `next-mac-task.sh` 在 `flock /tmp/vonvon-mac-task.lock` 里取下一个。标记见 #422：开始 `codex-vps-start`，结果 `codex-vps-result`，取消 `claude-vps-cancel`。
  - 它做要用 JP-VPS 测试环境自测的片：Bot 6、7、8，`accept-home2` 的验收 daemon，已经绑好的测试群，Jev 的 key。Mac 上的 Codex 做要 Mac 和桌面验收的片。
  - 做法和 Mac 上的开发任务一样：照计划，分支 `codex/<片>`，开 PR，改 PR 的任务。
  - 它在 JP-VPS 上建的 worktree 留到 PR 合入，Claude 看到 MERGED 后用 `git worktree remove` 删（#422）。
  - 用 auto-review 而不用 full access，是因为 Claude 这边拦 `rm` 的钩子管不到 Codex。2026-10-16 的误删就发生在这台机器上，删除文件的硬规矩照样适用。
- **验收 daemon（JP-VPS 的 `accept-home2`）：**
  - 共用它的是 JP-VPS 上的 Claude 和 JP-VPS 上的 Codex。Mac 上的 Codex 用自己的测试环境，不碰它。
  - 用之前拿目录锁：`mkdir /tmp/accept-user.d`。失败就是有人在用，过几分钟再来；超过一小时还拿不到，在结果里写"卡住了：验收 daemon 被占"。
  - 拿到后写上是谁：`echo "<任务号或 claude> $(date -u +%FT%TZ)" > /tmp/accept-user.d/owner`。
  - 用完放锁：`rm -f /tmp/accept-user.d/owner && rmdir /tmp/accept-user.d`。
  - 锁里记的任务已经没有会话在跑时（Claude 用 `paseo ls`、`paseo inspect` 确认），Claude 可以替它放锁；Codex 不放别人的锁。
  - 不用 `flock`：Codex 每次调用工具都是新 shell，`exec 8>…; flock 8` 在命令结束时就放了锁。
  - Codex 自测完、换回 `main` 之前，验收 daemon 跑的是没审查的代码。Claude 用它做别的验收前，先用 `git -C /home/operator/vonvon/worktrees/accept rev-parse HEAD` 确认它跑的是哪个 sha。
- **删除文件：** 两台机器的 Codex 都守删除文件的硬规矩，原文在 #322 和 #422 正文，改一边要改另一边。
- **owner：** 在 Mac 的 Codex App 里开会话、转发那一句（Claude 会在通知里写明要发什么）；扫码、注销再登录这类只有人能做的事。
- **Mac 的测试环境：**
  - Codex 在 Mac 上用隔离的数据目录跑自己的两个测试 bot，和 JP-VPS 的 Bot 6、7、8 分开，放在专门的测试群里。
  - 不碰 owner 的 `~/.vonvon-bot`、`com.vonvon.bot.daemon`、bridge 和 `/Applications/Vonvon Bot.app`。
  - 环境由 #322 的第一个任务建好，数据目录、bot 和群写在 #322 正文"Mac 的测试环境"一节。
- **分支：**
  - 开发分支叫 `codex/<片>`，例如 `codex/s27a-bot-wake`，从 `main` 开。开发分支不叫 `codex/fix-*`。
  - 开发任务、改 PR 的任务在做时，只有 Codex push。
  - 没有在做的任务时，只有 Claude push，只限两件事：把 `main` merge 进来，以及合入前的同步。push 前先看这个分支的任务所在的队列（#322 或 #422）：看到开始了还没有结果的任务，按"硬限制"第一条处理。
  - Claude 同步的做法：Codex 贴出了结果、这个分支没有在做的任务时，Claude 在自己的 detach worktree 里把 `main` merge 进来，`git push origin HEAD:codex/<片>`，不 force。
  - Codex 打勾、写"<片> 做法"时先不写 PR 号。Claude 同步时顺手把 PR 号补进 `docs/v1-plan.md`，合入前补齐。
  - `codex/fix-*` 照旧。
- **在飞：**
  - 在飞产品 PR 最多四个（owner 2026-10-19 从两个放宽，两台 Codex 都不闲着）。计数加上 `codex/<片>` 开发 PR；`codex/fix-*` 和 2026-10-19 以前开的 `codex/*` PR 不算。
  - Codex 的开发 PR 不开 draft，免得计数漏掉。
  - Claude 贴开发任务时（#322 或 #422），已贴出、还没开出 PR 的开发任务也算一个，总数不超过四个。Codex 开 PR 时不用再数。
  - Claude 数在飞和贴开发任务放在同一个 `flock /tmp/vonvon-pr-slot.lock` 里。计数脚本只数开放的 PR，已贴出还没开 PR 的开发任务在锁里手数。
  - 一片只发给一台机器的 Codex。贴任务前，Claude 先查远端没有 `codex/<片>` 分支。
- **Mac 检查：**
  - #322 有活着的队列会话时，Mac 上的检查也贴进 #322，不开 Paseo 会话，免得两个会话抢 Computer Use。
  - Codex 写的片，Mac 上的验收在开发任务里一起做，不另开检查。
- **Claude 额度用完时：**
  - Claude 在 #322 和通知里写明。
  - owner 指定后，照 #367 那次的做法，由 Codex 审查和合入。交还也由 owner 指定。
  - 审查者必须和作者是不同的模型，例如作者是 gpt-6.1-sol，审查用 gpt-6-astra。审查者只拿 diff、PR 描述和验收要点。
  - 谁打 `frozen`、谁合入，由 owner 指定时点名。
  - 没有合格的审查者就不合入，等 Claude 恢复或 owner 来审。

## 三平台发布版本（owner 2026-10-28 定，2026-10-31 加 Linux 服务端包）

- 每次发布 Vonvon Bot 时，macOS、Windows 安装包和 Linux 服务端包（linux-x64、linux-arm64）使用同一个新版本号；即使某个平台没有内容变化，也要构建并发布该版本的平台安装包。0.9.0 是第一个三平台版本：从 0.9.0 起，没有服务端发布配置（`cos-server.json`）或 `release-all` 没打好服务端包时，`release-publish.mjs plan` 直接拒绝，不能只发 macOS 和 Windows（Claude 2026-11-02 定）。
- 发版前核对三个平台的产品版本和产物版本（`scripts/product-version.mjs` 连服务端包的构建记录一起核）；发布后核对官网显示、下载链接、服务端安装命令及各平台实际安装包的版本一致。平台各自的签名、更新和发布门禁仍照各自流程执行；还没全部同步时，不报告三平台发布完成。
- 2026-10-28 现有的 macOS 0.7.4 与 Windows 0.7.5 不一致，owner 同意本次先保留；下次发布时同步。

## Mac 发布任务（owner 2026-10-26 定）

owner 可直接指定 Mac Codex 按 `.agents/skills/release-mac/SKILL.md` 做发布任务，范围按 owner 每次的要求分别限定为工具修改、本地候选、公证验收、版本化上传和 stable 提升；不存在由“调用者授权”自动包办公开发布的规则。helper 会提交 Apple 公证，owner 本轮直接要求完整发布已包括该阶段；只要求分析或工具修改时不提交。

- 发布任务仅碰独立源码 worktree、专用持久产物目录、外部发布配置和获准签名／公证 profile；一律不碰 owner 的 `/Applications/Vonvon Bot.app`、`~/.vonvon-bot`、`com.vonvon.bot.daemon`、bridge 和默认数据。
- 安装依赖和构建使用单条命令前的隔离 HOME；签名、公证、git、gh 使用正常账号。构建和打包仍须遵守单任务占用及文件删除硬规矩。
- 开始前、push 前检查本任务取消；获准上传时在上传前和切 manifest 前重查。经 #322／Paseo 执行须沿用该渠道的任务、作者、开始／结果和取消规则；如要在 #322 派新的发布任务，先同步队列正文，不借本节绕过队列协议。
- 版本化对象准备并公网验证后，先展示版本、准确 SHA、公证 ID、最终哈希和 URL。**stable 确认绑定已展示候选：owner 在自己打开的 Codex App 会话里，看过版本、准确源码 SHA、产物和计划哈希后，可以回复“确认”“发布当前候选”或“发布到 stable”，不要求手抄 SHA。代理原样保存回复，以 --reviewed-plan 和准确计划哈希绑定该候选。确认只覆盖展示过的计划；版本、来源、字节或计划改变时重新展示并确认。代理转述、队列消息和预填确认不算 owner 的回复。**计划、工作流或其他代理转述也不算。COS/CDN 具体写入工具和命令亦须先准备供 owner 审阅；没有工具时不临场执行。
- Linux 服务端的签名 stable 清单和 `install.sh`、`uninstall.sh` 与 macOS/Windows 的 stable 同一道门，只由 `release-publish.mjs promote` 带同一个计划哈希和 owner 的确认一起切，排在 macOS、Windows 之后；经 #322／Paseo 的发布任务，服务端也做到版本化上传加公网复核就停。服务端签名私钥只放在 `cos-server.json` 的 `updatePrivateKeyFile` 指的文件里（0600），不贴、不进仓库。
- 公证、上传与公网验证结果分别记录；GitHub 输出按原打码规则，并不贴 Key ID、Issuer ID、Team ID、Apple ID 或 COS 密钥。

## 分工

- JP-VPS 上的 Claude Code 负责 v1 的设计、实现、独立审查、测试和合入（2026-10-19 起实现交给 Codex，见上一节）。它写 `docs/product.md` 和 `docs/v1-plan.md`，写产品代码和测试，在 JP-VPS 上跑构建、typecheck、lint、定向测试和无头网页界面检查。飞书一侧的行为也在 JP-VPS 上自测：用 lark-cli 以 owner 的用户身份、只在测试群里做，改设置用 `vonvon` 命令行。每个里程碑的验收，不需要 Mac 的步骤由 Claude 先在 JP-VPS 上做完，见 `docs/v1-plan.md` 第 7 节。重命令一律加 `flock /tmp/vonvon-heavy.lock`。全量测试交给 CI 的 Linux 和 macOS 任务。Claude 是唯一的合入入口。
- Mac 上的 Codex 做 Claude 做不到的桌面事项：Mac 上的网页端连 Mac 上的 daemon，真实 macOS 窗口、托盘、菜单、登录项和系统权限弹窗，真实 Codex provider 的运行，用 Mac 钥匙串签名打包预览版。短检查和预览版由 Claude 按"工具和同步"交给 Mac 上的 Codex；长的、需要人来判断的验收交给 owner。公证和对外发布由 owner 在发布前决定谁来做。
- Codex 可以改代码，按下面两种情况提交：
  - Claude 发起的 Mac 检查里发现问题，Codex 直接修，在临时 worktree 里 commit，用 `git push origin HEAD:<分支>` 推到被检查的 `claude/*` 分支，不 force-push，不 rebase。结果评论里写清改了什么、为什么改和提交号。贴出这个任务的结果、或者看到它被取消之后，Codex 不再 push 这个分支。
  - owner 在 Mac 上验收已合入的预览版时发现问题，Codex 从 `main` 开 `codex/fix-<问题>` 分支和自己的 PR，不 push 到任何 `claude/*` 分支。`codex/fix-*` 分支只有 Codex push。Claude 审查发现问题时，把发现写进 PR 评论，在这个 PR 里贴一份修复提示词，再按"工具和同步"开一个修复任务。2026-10-14 之前开的 `codex/*` PR 是旧桌面版的参考栈，不是修复 PR。
- Codex 的改动和 Claude 的一样过合入门槛：另一个模型的独立审查、CI 在准确 head 上通过、由 Claude 合入。改动让行为和 `docs/product.md` 不一致时，Codex 在 PR 里写明，Claude 在同一个 PR 里改 `docs/product.md`。
- Codex 不能直接通知 owner。卡住时，Codex 在结果评论第二行写"卡住了："加原因；Claude 看到后原样转告 owner。Claude 自己停下的 Paseo 会话，通知里写明是 Claude 停的、为什么。
- 每个产品 PR 的描述写清这几项：用户能看到的变化、试用步骤、Claude 跑过的命令和结果、独立审查结论，以及还没在真实 Mac 上验过的项。没有用户可见变化的 PR，要说明为什么现在必须做。

## 范围和资料

- v1 的范围以定稿的 `docs/product.md` 为准。owner 在 `docs/product.md` 的 PR 里认可后即为定稿；"定稿"只指这份文档，`frozen` 只指 PR 标签。定稿之前是产品设计环节，不写产品代码。定稿后的新想法写进其中"v1 之后"一节，发布前不实现。
- v1 的切片和里程碑写在 `docs/v1-plan.md`。它随代码在同一个 PR 里更新，不另开文档 PR。2026-10-19 起，每一片的详细计划写在 `docs/plans/<片>.md`，由 Claude 在纯文档 PR 里先合入，Codex 照着实现（见"2026-10-19 起"）。
- `docs/plan.md`（V1 到 V11）和 `docs/roadmap.md` 从 2026-10-14 起停止执行，只作历史参考。
- 调研结果放在 `docs/research/`。开始调研之前，先读其中的 `README.md`，已经查过的不再重查。新一轮调研放进新的日期目录，并在 `README.md` 里加一行。

## 一个 PR 的流程

Codex 写的片按"2026-10-19 起"一节走，下面第 1 步对它不适用。

1. Claude 从 `main` 开 `claude/<切片>` 分支。开产品 PR 时，把复查在飞产品 PR 数和创建 PR 放进同一个 `flock /tmp/vonvon-pr-slot.lock` 里执行，数到四个就不开。实现，跑 JP-VPS 上的检查，push。
2. 由另一个模型的子代理做独立审查，结论写进 PR 评论。改动涉及子进程、并发、关闭或清理顺序、错误路径、macOS 原生代码、数据迁移或合入门禁（CI 和本文的规则）时，再加一轮多角度审查。每条发现先复现或驳回，再改。
3. 有桌面专属项时，Claude 把 Mac 检查的提示词贴进 PR，再按"工具和同步"开一个检查任务。Mac 检查只在没带 `frozen` 的 PR 上发起。Codex 改了代码，它的改动回到第 2 步审查；审查后如果改动碰到桌面行为，Claude 再贴一份检查提示词和一个新任务。做不了的项，在 PR 里记为"待 owner 验收"。
4. 审查和 Mac 检查都完成后，Claude 打 `frozen`，等 `linux` 和 `macOS checks` 在准确 head 上都显示成功。合入规则只强制 `linux`，`macOS checks` 由 Claude 用 `gh pr checks` 确认；它显示跳过、排队或 runner 离线都不算通过，这时通知 owner。打了 `frozen` 之后还要 push，先去掉 `frozen`，push 后让改动回到第 2 步，再重新打。去掉 `frozen` 后再加任何标签，`linux` 都会变红，重新打 `frozen` 才恢复。合入规则要求分支和 `main` 同步，所以冻结后 `main` 前进了，要先把 `main` merge 进分支，这也算一次 push，按同样的步骤走。
5. Claude 用准确 head 的 sha 合入，删除 JP-VPS 上的 worktree。

合入产品 PR 的条件：两个 CI 任务在准确 head 上成功，独立审查结论已贴进 PR，评审线程都已解决，PR 描述各项齐全。

纯文档 PR 指改动只有根目录的 `README.md`、`AGENTS.md`、`CLAUDE.md`，以及 `docs/` 和 `.claude/skills/` 下的 `.md` 文件（只认小写 `.md`，这两个目录下的其他文件不算），CI 照 `.github/scripts/ci-scope.mjs` 这样判断，只跑轻量检查。纯文档 PR 不打 `frozen`；其余 PR，包括只改 CI、脚本、规则的流程 PR，照常打。skill 文件会被代理加载，审查只改 skill 的 PR 时，查 frontmatter 里有没有 `hooks`、`allowed-tools`，正文里有没有 `` !` `` 开头的命令。独立审查结论贴进 PR、`linux` 在准确 head 上通过后，Claude 合入。dependabot PR 改依赖，按产品 PR 的条件审查、冻结和合入，或者直接关闭。

## 硬限制

- `claude/*` 分支平时只有 Claude push。Claude 为某个分支开了检查任务后，就不 push 这个分支，直到这个任务完了。之后 Claude 先 pull 再改。任何人都不 force-push，不 rebase 已 push 的分支。
  - 经 Paseo 的任务：会话贴出了结果；或者 Claude 用 `paseo stop` 停下会话，`paseo inspect` 确认它已经不在运行。停下的会话可能已经推过：Claude 先 pull，多出来的提交按"一个 PR 的流程"第 2 步审查，这次检查的结论作废，还要查就开一个新任务。连不上 Mac 的 daemon、确认不了会话停没停时（比如 Mac 睡着了），Claude 在提示词所在的地方贴一条第一行是 `<!-- claude-mac-cancel:<任务号> -->` 的取消，通知 owner；等 daemon 连上后 `paseo stop` 加 `paseo inspect` 确认，或者 owner 确认 Mac 上没有这个会话在跑，才 push。Codex 开始任务前、每次 push 前、替换装好的 app 前都看一次有没有这条取消，有就停下，贴结果写明停在哪一步。这几处要看取消写在每份提示词里，不靠 Mac 上那份可能过时的 AGENTS.md。
  - 经 #322 的任务：下面三件事有一件发生：这个任务的结果贴出了；Claude 在它开始之前取消了它，也就是取消贴出后再看一次，#322 里没有比这条取消更早贴的这个任务的开始评论；Claude 按"工具和同步"通知 owner 后，owner 确认 Mac 上没有会话在处理 #322；这时这个任务还没取消的，Claude 先贴取消再 push，免得睡着的 Mac 醒来后旧会话接着推。开始以后才取消的，仍要等结果或 owner 确认。什么时候通知 owner，见"工具和同步"里"转发一次，做完一批"的第 4 条。还要做这次检查，Claude 先取消旧任务，再贴一份新的提示词和一个新任务，按"工具和同步"请 owner 转发。
  - 上面的交接办法也适用于 `codex/<片>` 分支（"2026-10-19 起"）。任务在 #422 时：取消贴在 #422，第一行是 `<!-- claude-vps-cancel:<任务号> -->`；贴取消后 `paseo stop`，`paseo inspect` 确认它已经停了，才 push。
- 除了 `frozen`，不给 PR 加别的标签。每次加标签都会按 PR 当时的标签重跑 CI，PR 已带 `frozen` 时会再跑一遍完整平台链。
- 产品 PR 同时在飞最多四个（2026-10-19 起，原来是两个），第五个要等一个合入。计数方法：开放、非 draft、head 分支以 `claude/` 开头（2026-10-19 起还有 `codex/<片>` 开发分支，见"2026-10-19 起"）、改动里有 `.github/`、`scripts/`、`AGENTS.md`、`docs/` 和其他 Markdown 以外文件的 PR，再去掉暂停的 #281 和 #285。所以纯文档 PR 和只改 CI、脚本、规则的流程 PR 不计；dependabot PR 和 Codex 的 `codex/fix-*` 修复 PR 不计。修复 PR 由 Claude 优先审查和合入。本规则生效前开的 PR 全部暂停：#281（V6b 的 Codex 子进程迁移）、#285（V5 的启动路由），以及 `codex/` 分支上的 #110（V5 的桌面外壳）等。它们的去留在 `docs/product.md` 定稿时由 owner 决定。
- 一个 PR 对应一个完整的功能或修复，不按行数拆，diff 大了就拆审查（owner 2026-11-01 定，取代原来的 1500 行上限：小切片多出来的计划、审查轮次和在飞名额拖慢了开发，而审查子代理读得了更大的 diff）。行数都不含 lockfile 和生成文件：
  - 超过约 1500 行时，派一个审查子代理通读整个 diff，专看跨模块的问题，例如接口两端是否对得上，并发、关闭清理顺序和错误路径怎么穿过各模块；再按模块派几个审查子代理分头细看，每个读完自己那一块。这几份结论合起来算这个 PR 的独立审查，多角度审查的要求照旧。
  - 超过约 5000 行，或者有审查者报告读不完，才拆 PR。按能独立审查、独立验收的边界拆，不为凑行数拆。
  - 只删死样式（CSS）的纯删除 PR 不受 5000 行限制：diff 里只有删除的行，没有新增或改动的行，按文件一片；独立审查和 `frozen` 照旧，审查者用脚本和前后截图核，不逐行读（owner 2026-10-18 同意，见 `docs/research/2026-10-18-ui-foundation/report.md` 的 D7）。
  - `docs/plans/` 里旧计划写的"上限 1500 行"按本条理解，不再要求为行数拆分；计划里"过 1500 行就停下"或"卡住了：行数"的指令也不再触发。
- 每个功能分支在每台机器上只有一棵 worktree，合入即删。GitHub 在合入时自动删除远端分支。Mac 上的 Codex 每做一个任务，自己建一棵 detach 的临时 worktree：经 Paseo 的，留到 Claude 归档会话前让它删；经 #322 的，留到整个队列结束时再删。开 `codex/fix-*` PR 的 Codex 会话，push 完、PR 开好就删掉它的 Mac worktree，之后的修改走修复任务。
- 进度看 `docs/v1-plan.md` 里的清单、PR 状态，以及 Claude 会话里的里程碑消息。issue #122 看板和 `docs/program-graph.json` 停止更新。不做本地进度页、会话映射文件或定时刷新。
- Claude 每个在飞 PR 一个会话，标题为 `PR #<号>`。并行放在会话内部，不开根会话加多个工作会话。
- 完整 CI 是 Linux 和 macOS 两个平台，只在 `frozen` head 上跑。macOS 任务跑在 Mac mini 的自托管 runner 上。`linux` 任务不加任务级的 `if:`：名称固定的任务被跳过时算作通过，未冻结的 PR 就能绕过必需检查。真实飞书和真实 Codex 的验收按里程碑做，不是每个 PR 都做。
- v1 不支持 Windows，不跑 Windows CI，也不写新的 Windows 专属代码。已有的 Windows 代码留不留，写在 `docs/v1-plan.md` 里。

## 工具和同步

- 两台机器的 Paseo daemon 通过 Tailscale 互通。JP-VPS 为 `10.0.0.10:6767`，provider `claude`，项目 `/home/operator/vonvon/vonvon-bot`。Mac 为 `10.0.0.11:6767`，provider `codex`。owner 自己的会话照旧经它们跑。不通过 SSH 执行 `claude -p`。
- 2026-10-19 起 Mac 上的事以 #322 为主（见"2026-10-19 起"），下面"经 Paseo 开会话"几条只在 owner 要求时用。
- 2026-10-16 起，Mac 上的事由 Claude 经 Paseo 在 Mac mini 上直接开 Codex 会话，不再请 owner 转发（owner 2026-10-16 让 Claude 定）。issue #322 的队列留作备用：Paseo 连不上时（Mac 睡着、Tailscale 断了、daemon 没开）、`paseo run` 失败时，或者 #322 上还有活着的队列会话时才用，规则见下面"经 #322"的几条。Claude 和 Codex 之间不交接 PR。
- 经 Paseo 开会话：
  1. 这一节的 `paseo` 命令都由 Claude 在 JP-VPS 上执行，Codex 不用管。
  2. 取号：任务号存在 JP-VPS 的 `/home/operator/vonvon/local-tools/mac-task-seq`，Claude 在 `flock /tmp/vonvon-mac-task.lock` 里取下一个，两个 Claude 会话不会取到同一个号。文件不在了，以 GitHub 上出现过的最大任务号为起点重建。
  3. 开之前查，查和开放在同一个 `flock /tmp/vonvon-mac-task.lock` 里：`paseo ls` 里 Mac 上有 Claude 开的、没归档的任务会话还在跑，就放开锁，过几分钟再来，不在锁里等；#322 有活着的队列会话（见下面"经 #322 时"第 2 条），就只往 #322 贴任务，不开 Paseo 会话。追问用的 `paseo send` 也一样放在锁里先查。同一时间 Mac 上只有一个任务会话，免得两个任务同时构建、装 app 或用 Computer Use。
  4. Claude 先把提示词贴进 PR（预览版任务没有 PR，贴在 #322），格式见下面三种任务，再开会话：`paseo --host 10.0.0.11:6767 run -d --provider codex/gpt-6.1-sol --thinking medium --mode full-access --cwd <Mac 上的仓库> --title "<任务种类> PR #<号> 任务 <号>" "<一句话>"`。一句话只写"按 <提示词评论的链接> 做，任务号 <号>"。Mac 上仓库的路径记在 `vonvon-collaboration.md`。提示词的第 0 步查开始和结果标记，有就不重做，两条路都一样。
  5. cwd 用 Mac 上仓库的 checkout，不用临时 worktree：会话删掉自己的 cwd 以后就起不了子进程。cwd 只是会话的起点，任务照旧在 checkout 外的临时 worktree 里做；Codex 不在这个 checkout 里切分支、改文件或删东西。
  6. `paseo run` 报错或超时：先 `paseo ls` 看会话是不是其实已经建好了，建好了就照常等；`ls` 也连不上，按"硬限制"第一条连不上 daemon 的办法做，不改走 #322；`ls` 确认没有，才改走 #322，用同一个任务号，标记才能互相挡住。
  7. Claude 在后台用 `paseo wait` 等会话空闲，再读 GitHub 上的结果评论；没有结果评论时看 `paseo logs`。超过一小时还在跑，看 `paseo logs` 有没有进展。卡在"model at capacity"、Computer Use 失败或没有进展时，Claude 用 `paseo stop` 停下它，通知 owner 时写明是 Claude 停的、为什么，不反复重开。
  8. 追问：会话空闲时，Claude 可以用 `paseo send` 在同一个会话里接着问。追问算一个新任务号，提示词同样先贴进 PR。会话在跑时不 send，因为它会打断当前的回合。
  9. 不再追问时，Claude 先 `paseo send` 一句"用 `git worktree remove` 删掉这个会话建的临时 worktree"，等它空闲后用 `paseo archive` 归档。
  10. Paseo 恢复以后，#322 里还没有开始评论的任务，Claude 先贴取消，再经 Paseo 用新的任务号重开。
- 经 #322：#322 的正文是给 Codex 的完整说明：怎么认作者、心跳和开始评论、任务和结果的格式、取消、轮询和结束、每个任务都要守的规矩，包括临时 worktree、push 的写法和预览版任务能碰什么。改队列的规矩时，正文和本文一起改。
- 现有 Mac 队列协议登记以下三种任务；owner 直接指定的发布任务另见“Mac 发布任务（owner 2026-10-26 定）”，纳入队列前须同步队列正文。任务号只有一套，经 Paseo、经 #322 和 #422（JP-VPS 上的 Codex）的一起往上数，从 14 开始（#322 用到了 13）。经 #322 时，任务贴成 #322 的评论：第一行是 `<!-- claude-mac-task:<任务号> -->`，第二行是标题，下面是内容。长的提示词贴在相关的 PR 里，任务（经 Paseo 时是给会话的那一句话）里给出那条评论的链接（带评论 id），写明哪一步不做、结果贴到哪里。Codex 只照链接指的那一条做；任务只给了标记、找到不止一条时，不猜，结果写"卡住了：提示词有几份"。旧记录里说的检查会话、预览版会话和修复会话，指这三种任务：
  - 检查任务：提示词贴在 PR 里，第一行是 `<!-- claude-mac-check-prompt-<PR号>-<任务号> -->`；提示词里防重复的开始和结果标记也带任务号，例如 `<!-- codex-mac-check-<PR号>-<任务号>-start -->` 和 `<!-- codex-mac-check-<PR号>-<任务号> -->`。同一个 PR 再查一轮，比如 Codex 改了代码之后，就是新任务号的新提示词，标记不和旧的重名。#320 的第一份（任务 1）是这条规矩之前贴的，没带任务号。Codex 在临时 worktree 里取这个分支，在本机构建和检查。只接短检查：一个任务大约 30 分钟以内，结果能用文字说清对错。
  - 预览版任务：没有 PR，提示词和结果都贴在 #322。经 Paseo 时，提示词评论的第一行是 `<!-- claude-mac-preview-prompt-<任务号> -->`，不带 `claude-mac-task`，队列会话不会去领；不再另开 `Mac 预览版 <里程碑名>` issue。Codex 在临时 worktree 里取 Claude 给的 `main` sha，在 Mac 本机构建；先用隔离的数据目录查 Mac 上的网页端连 Mac 上的 daemon，有问题就停下贴结果，不打包，不 push；过了再用真实 `HOME` 下的钥匙串签名，装到本机给 owner 验收。owner 做完一步、要 Codex 接着查时，Claude 贴一个新任务，按步骤号只列这几步，用已经装好的 app，不重新构建、打包和安装，除非任务写明。
  - 修复任务：提示词贴在 `codex/fix-*` PR 里，第一行是 `<!-- claude-mac-fix-prompt-<PR号>-<任务号> -->`。Claude 审查这个 PR 发现问题时贴。Codex 在临时 worktree 里取这个分支，按 PR 评论修，push。
- 两边都只认和本机 `gh api user` 同一个账号贴的标记评论：两台机器的 gh 登的都是 owner 的账号。别的账号和 bot 贴的，不管是任务、取消、结束、提示词还是结果，一律不理。任务指向的提示词评论，作者不是这个账号的，Codex 不做，在结果里写明。
- 经 #322 时，转发一次，做完一批：
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
  - 模式用 full access（owner 2026-10-15）：经 Paseo 的由 Claude 用 `--mode full-access` 开，经 #322 的由 owner 新开会话时选好。改文件、跑命令、联网都不再发申请，Computer Use 和 MCP 的权限申请也自动同意；
  - 隔离的 `HOME`、`VONVON_HOME`、userData 和 `VONVON_DESKTOP_TEST_HOME` 只写在启动被测应用或测试的那一条命令前面，例如 `HOME=<临时目录> VONVON_HOME=<临时目录>/vonvon npm test`，不 export。git、gh 和签名命令不带这些变量，用 Mac 上的正常账号和钥匙串。装卸后台服务、碰 launchd 的命令一定要带 `VONVON_HOME`，而且不能是 `$HOME/.vonvon-bot`：launchd 的任务按用户账号区分，只换 HOME 时数据目录还是默认的 `.vonvon-bot`，任务名就是 owner 在用的 `com.vonvon.bot.daemon`；换了 `VONVON_HOME`，任务名才带上数据目录的哈希。除了下一条允许预览版任务做的步骤，不碰 owner 在用的 bridge 和数据；
  - 没有申请拦着，范围靠任务和提示词管。Claude 写明这次用哪些隔离目录、哪些不碰：owner 的 bridge 和它的数据、owner 的飞书客户端；owner 的 `/Applications/Vonvon Bot.app`、`~/.vonvon-bot` 和 `com.vonvon.bot.daemon` 只有预览版任务能碰，而且只在替换装好的 app、做 `docs/v1-plan.md` 第 2 节标"Codex 先查""Codex 接着查"的步骤时碰，Claude 按步骤号列出这几步。Codex 只做这个任务要的事，要做任务以外的事就停下，在结果评论里写明；
  - Mac 锁屏时 Computer Use 会失败（getpaseo/paseo#3346），调用也可能超时。遇到就停下这个任务，不重试，结果第二行写"卡住了："加原因；后面要用 Computer Use 的任务也先写"卡住了：Computer Use 同上"，不用的任务照做。Claude 看到后通知 owner；
  - 贴到 GitHub 前打码。不贴凭据、令牌和 app secret，也不贴群号、群名和飞书的完整 id，和仓库里一样（`docs/v1-plan.md` 第 7 节）。`/Users/<名字>` 写成 `/Users/<u>`，签名身份只写"Developer ID Application"，不贴 IP、设备名和带凭据的网址；
  - Codex 的结果都在 GitHub 的评论里，Claude 把结论写进 PR 描述或给 owner 的通知。经 #322 的会话留给 owner 关，经 Paseo 的由 Claude 归档。
- 用 Paseo 时，对方会话正在运行不发 `paseo send`，因为它默认会打断对方当前的回合。
- 各台机器只通过 Git 同步，各自运行 npm ci，不拷贝 node_modules、dist、build、release。预览版在 Mac 本机构建、本机安装，不跨机器拷贝。
- v1 按定稿的范围连续开发。每完成一个里程碑，Claude 按"工具和同步"开预览版任务，Codex 在 Mac 上装好预览版；Claude 看到结果后通知 owner 验收。等验收期间可以继续下一个切片，但不改已验收的行为。需要 owner 决策、补充信息或操作时，Claude 按 `vonvon-collaboration.md` 的格式通知。
