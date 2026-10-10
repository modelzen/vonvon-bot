# vonvon-bot 分工规则

- vonvon-bot 在两类机器上开发：没有桌面的 Linux 服务器上用 Claude Code，有桌面的 Mac 上用 Codex。
- Linux 上的 Claude Code 负责设计和计划。它调研现有代码，把架构说明、详细方案和执行计划写在 `docs/` 下，push 到功能分支并开 PR。Claude Code 不写产品代码，也不跑实现和测试。
- Mac 上的 Codex 负责实现和测试。它按 `docs/` 里的计划写代码，跑 typecheck、测试和构建，启动应用在真实窗口里检查，把结果写进对应的 PR。打包、签名、公证也由 Codex 负责。
- 用户已授权连续执行后续版本。每个版本通过计划要求的全部验证、独立审查和准确 head 的 Shipping 检查后，Codex 受控合入并继续下一个版本，不在版本边界要求用户逐个确认。
- 只有需要用户决策、提供意见或补充信息，或者必须由用户操作时，才暂停相应工作并说明具体原因。能自行解决的问题继续处理，不依赖用户操作的工作继续推进。
- 实现时发现计划有错或有缺口，Codex 在 PR 里写明。不影响设计的小偏差由 Codex 决定，并在 PR 里写明理由。要改架构、数据形状或 PR 顺序的问题交回 Claude Code 更新计划。
- 一个功能只用一个分支。开始前先 pull，停下时 push，不要 force-push。
- 各台机器只通过 Git 同步，各自运行 npm ci，不要拷贝 node_modules、dist、build、release。
