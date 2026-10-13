# vonvon-bot 分工规则

2026-10-13 起生效，取代之前的版本。两台机器读同一份规则。两边的非平凡任务都先进入 pstack 的 poteto-mode。

## 分工

- 没有桌面的 Linux 服务器（JP-VPS）上的 Claude Code 负责设计和实现。它写 `docs/` 下的架构、数据形状和计划，按计划写产品代码和测试，在 Linux 上跑构建、typecheck、lint 和改动相关的定向测试，push 到功能分支并开 PR。JP-VPS 内存小，不跑全量测试、live 和性能。
- 有桌面的 Mac 上的 Codex 负责完整测试、独立审查和验收。它拉取 PR，在 macOS 跑全量测试，在真实窗口、真实系统服务、真实 provider 和飞书里验收，需要时跑 live 和性能，验收方法由 Codex 定，做独立代码审查，打 `frozen` 标签并触发完整 CI，做准确 head 的 Shipping 检查并受控合入。打包、签名、公证、发布和 issue #122 看板由 Codex 负责。
- Codex 可以直接修复验证范围内的问题：只在 macOS 或 Windows 上出现的平台差异、Electron 窗口和原生服务的接线、测试夹具和构建配置。改动写进 PR 并说明理由。涉及设计、数据形状、协议或跨平台逻辑的问题交回 Claude，不自行改写。
- Claude 看不到 Mac。PR 描述必须列出 Claude 在 Linux 上跑过的命令和结果，以及验收要确认的结果和已知缺口，例如只用假对象测过、没在真实系统上跑过的代码。这一节写验收什么，不写跑哪些命令。没有这一节 Codex 不接。

## 一个 PR 的流程

1. Claude 从 `main` 开 `claude/<任务>` 分支，开 PR 并打 `owner:claude`。实现、Linux 验证、push，PR 描述写清改动、Linux 证据和验收要点，然后换成 `owner:codex`。
2. Codex pull，审查和验证。通过则打 `frozen`、跑完整 CI、做 Shipping 检查、合入。发现问题，在验证范围内就修并记录；超出范围就在 PR 评论里写复现命令、输出和平台，换回 `owner:claude`。
3. Claude 修复后只回答该评论，push，换回 `owner:codex`。Codex 只重验改动涉及的项，冻结时再跑一次完整链。
4. 合入后两台机器各自删除该分支的 worktree。

## 硬限制

- 只有 `owner:` 标签指向的一方可以 push 该分支。换 owner 前先 push，换 owner 后先 pull。不 force-push，不 rebase 已 push 的分支。
- 产品 PR 同时在飞最多两个。dependabot 和纯文档 PR 不计。第三个要等一个合入。
- 一个 PR 对应一个任务分区，大小以 Codex 一个会话能审完并验完为准，不含 lockfile 和生成文件时以 1500 行改动为上限。超过就先拆。
- 每个功能分支在每台机器上只有一棵 worktree。合入即删。
- 在飞 PR 的设计不另开文档 PR 修改。缺口在该 PR 的评论里提出，Claude 在同一 PR 里同时改代码和 `docs/` 里的计划。设计文档只为尚未开始的版本写，最多领先实现一个版本。
- 进度只看 issue #122 看板和 PR 状态。不做本地进度页、会话映射文件或定时刷新。Codex 在交接和合入时更新看板。
- 每台机器一个在飞 PR 一个会话。并行在会话内部用子代理，不开根会话加多个工作会话。
- 完整三平台 CI 只在 `frozen` head 跑一次。冻结前 Claude 在 Linux 上只跑构建、typecheck、lint 和定向测试。全量测试、macOS 检查、真实环境验收、live 和性能由 Codex 在 Mac 上做。
- 没有 Windows 原生环境。每个 PR 的 Windows 验证只看 `frozen` head 完整 CI 的 Windows 任务，不等人工验收。只在 Windows 上出现的行为，例如进程树回收和服务注册，由 Claude 写成能在 CI Windows 任务里运行的真实进程或真实注册表测试。必须有 Windows 桌面才能验的项，例如登录后自启、Electron 窗口和托盘，在 PR 里记为 Windows 未验，不阻塞合入，等有 Windows 环境时集中验收。

## 工具和同步

- 调用 JP-VPS 上的 Claude 通过 Paseo CLI 创建和管理会话。daemon 为 `10.0.0.10:6767`，项目为 `/home/operator/vonvon/vonvon-bot`，provider 为 `claude`。不通过 SSH 执行 `claude -p`。
- 各台机器只通过 Git 同步，各自运行 npm ci，不拷贝 node_modules、dist、build、release。
- 用户已授权连续执行后续版本。每个 PR 通过验证、独立审查和准确 head 的 Shipping 检查后，Codex 受控合入并继续，不在版本边界等用户确认。只有需要用户决策、补充信息或用户操作时才暂停并说明原因。
