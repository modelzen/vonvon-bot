# vonvon-bot 分工规则

- vonvon-bot 在两类机器上开发：没有桌面的 Linux 服务器上用 Claude Code，有桌面的 Mac 上用 Codex。
- Linux 上的 Claude Code 负责设计和计划。它调研现有代码，把架构说明、详细方案和执行计划写在 `docs/` 下，push 到功能分支并开 PR。Claude Code 不写产品代码，也不跑实现和测试。
- 调用 JP-VPS 上的 Claude 参与 vonvon-bot 任务时，通过 Paseo CLI 创建和管理远端会话，不再直接通过 SSH 执行 `claude -p`。目标 Paseo daemon 为 `10.0.0.10:6767`，远端项目目录为 `/home/operator/vonvon/vonvon-bot`，provider 为 `claude`。模型与 pstack 要求仍按用户指令执行。
- 所有新的设计决定都由 Claude 做出。架构、数据形状、线上协议、存储格式、PR 顺序、验证门槛、计划没有定下的签名，以及编译器契约的具名例外，都先写进 `docs/`，再实施。Codex 只实现、测试和独立审查。遇到计划没有覆盖的缺口，Codex 不自行发明设计来绕过，而是在 PR 或 issue 里写明缺口和证据，交回 Claude 更新计划。计划已经定下的单元照原设计继续推进，不因等待新设计而停下。
- Mac 上的 Codex 负责实现和测试。它按 `docs/` 里的计划写代码，跑 typecheck、测试和构建，启动应用在真实窗口里检查，把结果写进对应的 PR。打包、签名、公证也由 Codex 负责。
- Claude provider 的真实推理验证不在 Mac 上做。有额度时在 JP-VPS 上做，用当时最便宜的 Haiku 模型。Mac 上的原生桌面、服务和打包检查不变，不用远端测试代替。
- 用户已授权连续执行后续版本。每个版本通过计划要求的全部验证、独立审查和准确 head 的 Shipping 检查后，Codex 受控合入并继续下一个版本，不在版本边界要求用户逐个确认。
- 只有需要用户决策、提供意见或补充信息，或者必须由用户操作时，才暂停相应工作并说明具体原因。能自行解决的问题继续处理，不依赖用户操作的工作继续推进。
- 实现时发现计划有错或有缺口，Codex 在 PR 里写明。不影响设计的小偏差由 Codex 决定，并在 PR 里写明理由。要改架构、数据形状或 PR 顺序的问题交回 Claude Code 更新计划。
- 一个功能只用一个分支。开始前先 pull，停下时 push，不要 force-push。
- 各台机器只通过 Git 同步，各自运行 npm ci，不要拷贝 node_modules、dist、build、release。
