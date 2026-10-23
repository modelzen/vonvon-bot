# 工作目录权限：接多个 provider 以后怎么设计（2026-10-23）

基于 `origin/dev` 的 `9b113b6`。`D/` 指 `packages/daemon/src/`。

owner 问：群设置里的"工作目录权限"（只读、读写、完全访问三档，加"允许网络访问"开关）沿用的是 bridge 的设计，接多个 provider 以后还合理吗？各家的权限设置能一致吗？以后还要接更多 provider。

## 1. owner 的决定（2026-10-23，两轮问答）

| 问题 | 决定 |
|---|---|
| 方向 | 透传各家原生设置。不由 vonvon 定一套统一档位，也不保留三档 |
| agent 要做超出设置的事 | 直接拒绝，把原因告诉 agent。不发审批卡 |
| 网络 | 看各家 provider 支持什么。provider 有网络设置就显示，没有就不显示 |
| vonvon 自己的外层沙箱（把 provider 进程整个包起来） | 不做，只做 provider 支持的事 |
| provider 原生挡不住读时（别的群的记忆、凭据） | 照实说明，照常能用。原生机制能挡多少就挡多少，群设置里写明这个 provider 读得到什么。`docs/plans/s31b.md` 里 vonvon 给 Claude 套 bubblewrap 的那一层不做 |
| Linux 上的 Codex | 先实测，能挡读就放开只读和 workspace-write |
| vonvon 的固定保护（原生配置文件不可写、记忆目录可写、挡数据目录） | 保留，用各家原生机制加 |
| 用户 `~/.codex/rules` 绕过沙箱 | 现在测，属实就单独修（#486） |

## 2. 调研结论

1. 三档就是 Codex 旧沙箱的三种模式（read-only、workspace-write、danger-full-access）。15 家里只有 Codex 和 DeepSeek Harness 把它当原生概念。其余各家是"问不问"和"沙箱"两个独立的设置，沙箱常常默认关，或者只包命令（`native-codex-claude-gemini.md` 第 6 节，`native-other-agents.md` 第 3 节）。
2. 能在系统层限制读的很少：Codex 能（权限 profile）；Cursor、Droid、Grok 部分能。Claude 的沙箱只包 Bash，Read、Write 这些文件工具靠规则，官方说规则限读只是尽力而为。
3. ACP 没有标准的权限档。mode 的名字和含义由各家自己定，Config Options 正在取代 Modes。v2 草案要删掉"客户端代办文件读写"（`hosts-and-sandboxes.md` 第 1 节）。
4. 几乎每家都读用户全局配置，用户的"总是允许"会放宽宿主设的限制。各家多数有换配置根的环境变量。
5. 别的宿主有三种做法：透传原生模式（Zed、Paseo 的 ACP 系）；自定统一档位再翻译（Happier，它自己承认 Pi 的档不是边界）；外层隔离当边界（Hermes、OpenClaw、Docker Sandboxes）。群聊里谁能批准，只有 OpenClaw 写得细（`hosts-and-sandboxes.md` 第 7、8 节）。
6. 无人回答"要问人"的请求时，各家的默认不一样：拒绝、卡住、放行都有。vonvon 要自己统一回拒绝；"总是允许"一律不转发，否则会写进用户的全局配置。

## 3. 实测（JP-VPS，Linux 6.8，codex-cli 0.163.0，单次）

做法：本机假模型接口（Responses API，SSE）让 Codex 执行指定命令。`HOME`、`CODEX_HOME` 都放在 `mktemp -d` 的临时目录里，不登录，不花额度。app-server 用例的 `thread/start` 参数照 `D/agent/codex-appserver/backend.ts` 的 `codexSessionParams` 构造。脚本见 #486。

| 用例 | 路径 | 设置 | 用户 rules | 结果 |
|---|---|---|---|---|
| A0 | `codex exec` | `-s read-only` | 无 | 写工作区外：Read-only file system |
| A1 | `codex exec` | `-s read-only` | allow `touch` | **写成了** |
| A2 | `codex exec` | 只读档形状的 `feishu` profile | allow `touch` | **写成了** |
| B1、B2 | `codex exec` | `feishu` profile，加不加 `":root" = "deny"` 都试了 | 无 | 工作区外的文件读不到，工作区内读得到 |
| B3 | `codex exec` | `-s read-only` | 无 | 工作区外的文件读到了 |
| R1 | app-server（只读档） | `feishu` profile，回显 `activePermissionProfile.id=feishu` | 无 | 工作区外的文件读不到 |
| R2 | app-server（只读档） | 同上 | allow `cat` | **读到了** |
| R3 | app-server（只读档） | profile 里没放开 Codex 的安装目录 | 无 | 每条命令都失败：`bwrap: execvp …/codex-linux-x64/vendor/…/codex: No such file or directory` |
| W0 | app-server（读写档） | 根可写，八个受保护路径设成只读 | 无 | `thread/start` 失败：`bwrap: Can't bind mount … on …/ws/.claude: No such file or directory`（工作区里没有 `.claude`） |

由此得出：

- **用户 rules 绕过沙箱：属实。** 在 vonvon 实际走的 app-server 路径上，用户层一条 allow 规则就让只读群读到了工作区以外的文件。修复见 #486。
- **Linux 上的 Codex 能挡读了。** 0.163.0 的权限 profile 在 Linux 上也能挡读。`D/agent/codex-appserver/full-only.ts` 和 `backend.ts` 里"Linux 只挡写、不限读"的注释，对 profile 方式已经过时。要放开 Linux 上的只读和读写，还要先补两件事：
  - profile 里要把 Codex 自己的安装目录设成可读，不然沙箱里一条命令都跑不起来（R3）。
  - 读写档给不存在的受保护路径加只读条目时，Linux 的 bubblewrap 挂载会失败（W0）。要么只给已经存在的路径加，要么换别的写法。代价是新建 `.mcp.json` 这类文件挡不住，要写明，由 owner 定。
- 以上都只跑过一次，没有在 macOS 上重跑。

## 4. 下一步（还没开工）

一片计划，写进 `docs/plans/`，内容：

- 每个 provider 的适配器报一份原生设置表：原名、可选值、中文说明、网络设置有没有、能挡读写到什么程度、运行中能不能改。vonvon 照表显示。ACP 系的从 `configOptions`、`availableModes` 运行时读出来。
- 所有"要问人"的请求统一回拒绝并说明原因，不转发"总是允许"。选项题、计划确认照旧发卡。
- 旧的三档一次性换成各家原生值：Codex 直接对应；Claude 只读换成 default 加沙箱，读写换成 acceptEdits 加沙箱，完全访问换成 bypassPermissions。群换 provider 时设置不翻译，新的 provider 用它自己最保守的默认值。
- 删掉三档的名字和界面，以及没接进运行路径的 `D/provider/policy/enforcement.ts`。
- Linux 上的 Codex 按第 3 节补齐后放开只读和读写。

## 5. 文件

| 文件 | 内容 |
|---|---|
| [native-codex-claude-gemini](native-codex-claude-gemini.md) | Codex、Claude Code、Gemini CLI、Qwen Code 的原生权限模型，对旧调研的更正 |
| [native-other-agents](native-other-agents.md) | Cursor、Grok、Pi、OpenCode、Goose、Kimi、Copilot、Amp、Droid、Cline 类、DeepSeek Harness |
| [hosts-and-sandboxes](hosts-and-sandboxes.md) | ACP、Zed、Paseo、其他多 agent 宿主，sandbox-runtime 等外层沙箱，群聊里谁来批准 |

这三份由 Sonnet 子代理写成，只依据官方文档和源码，各家都没装也没跑。它们没有核实记录，用之前先核对关键事实；Qwen 只读了文档。第 3 节的实测由 Claude 自己做。
