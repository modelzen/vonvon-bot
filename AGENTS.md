# vonvon-bot 分工规则

- vonvon-bot 在两类机器上开发：没有桌面的 Linux 服务器上用 Claude Code，有桌面的 Mac 上用 Codex。
- Linux 上的 Claude Code 负责设计和计划。它调研现有代码，把架构说明、详细方案和执行计划写在 `docs/` 下，push 到功能分支并开 PR。Claude Code 不写产品代码，也不跑实现和测试。
- Mac 上的 Codex 负责实现和测试。它按 `docs/` 里的计划写代码，跑 typecheck、测试和构建，启动应用在真实窗口里检查，把结果写进对应的 PR。打包、签名、公证也由 Codex 负责。
- 实现时发现计划有错或有缺口，Codex 在 PR 里写明。不影响设计的小偏差由 Codex 决定，并在 PR 里写明理由。要改架构、数据形状或 PR 顺序的问题交回 Claude Code 更新计划。
- 一个功能只用一个分支。开始前先 pull，停下时 push，不要 force-push。
- 各台机器只通过 Git 同步，各自运行 npm ci，不要拷贝 node_modules、dist、build、release。
