# vonvon-bot 分工规则

- vonvon-bot 在两类机器上开发：没有桌面的 Linux 服务器上用 Claude Code，有桌面的 Mac 上用 Codex。
- Linux 上的 Claude Code 负责设计和计划。它调研现有代码，把架构说明、详细方案和执行计划写在 `docs/` 下，push 到功能分支并开 PR。Claude Code 不写产品代码，也不跑实现和测试。
- 调用 JP-VPS 上的 Claude 参与 vonvon-bot 任务时，通过 Paseo CLI 创建和管理远端会话，不再直接通过 SSH 执行 `claude -p`。目标 Paseo daemon 为 `100.121.117.46:6767`，远端项目目录为 `/home/ops/vonvon/vonvon-bot`，provider 为 `claude`。模型与 pstack 要求仍按用户指令执行。
- Mac 上的 Codex 负责实现和测试。它按 `docs/` 里的计划写代码，跑 typecheck、测试和构建，启动应用在真实窗口里检查，把结果写进对应的 PR。打包、签名、公证也由 Codex 负责。
- 用户已授权连续执行后续版本。每个版本通过计划要求的全部验证、独立审查和准确 head 的 Shipping 检查后，Codex 受控合入并继续下一个版本，不在版本边界要求用户逐个确认。
- 只有需要用户决策、提供意见或补充信息，或者必须由用户操作时，才暂停相应工作并说明具体原因。能自行解决的问题继续处理，不依赖用户操作的工作继续推进。
- 实现时发现计划有错或有缺口，Codex 在 PR 里写明。不影响设计的小偏差由 Codex 决定，并在 PR 里写明理由。要改架构、数据形状或 PR 顺序的问题交回 Claude Code 更新计划。
- 一个功能只用一个分支。开始前先 pull，停下时 push，不要 force-push。
- 各台机器只通过 Git 同步，各自运行 npm ci，不要拷贝 node_modules、dist、build、release。
- 创建工作树前运行 `python3 scripts/worktree-preflight.py create --target <新工作树绝对路径>`，安装依赖前运行 `python3 scripts/worktree-preflight.py install --target <安装工作树绝对路径>`。协调者串行执行这两类操作。检查失败时先复用或清理闲置资源，不提高上限来绕过检查。
- 只读审查共用现有源码，不创建工作树，不安装依赖。需要改代码的并行 agent 各用独立源码树，仅在实际运行构建或测试时安装依赖。
- 每个功能保留一个开发工作树。同一版本临时验证最多保留三个已安装依赖的工作树，验证结束后及时回收；计划要求独立或全新验证时仍按计划执行。
- 回收前把原始日志、截图和报告保存到协调者的 `.audit/`，记录原路径与归档路径，并校验归档内容。保留未提交代码、未跟踪文件、锁定树、仍被会话或进程使用的树和指定的参考源码。只删除确认闲置的工作树或可重建依赖。
