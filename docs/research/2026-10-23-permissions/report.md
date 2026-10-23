# 工作目录权限：接多个 provider 以后怎么设计（2026-10-23）

基于 `origin/dev` 的 `9b113b6`。`D/` 指 `packages/daemon/src/`。

owner 问：群设置里的"工作目录权限"（只读、读写、完全访问三档，加"允许网络访问"开关）沿用的是 bridge 的设计，接多个 provider 以后还合理吗？各家的权限设置能一致吗？以后还要接更多 provider。

## 1. owner 的决定（2026-10-23，几轮问答）

最终的样子写在 `docs/product.md` 3.8"权限（2026-10-23 重新设计）"，这里按问答的先后记。

第一、二轮：

| 问题 | 决定 |
|---|---|
| 方向 | 透传各家原生设置 |
| agent 要做超出设置的事 | 直接拒绝，把原因告诉 agent。不发审批卡 |
| 网络 | 看各家 provider 支持什么 |
| vonvon 自己的外层沙箱（把 provider 进程整个包起来） | 不做，只做 provider 支持的事 |
| provider 原生挡不住读时（别的群的记忆、凭据） | 照实说明，照常能用。原生机制能挡多少就挡多少，群设置里写明这个 provider 读得到什么。`docs/plans/s31b.md` 里 vonvon 给 Claude 套 bubblewrap 的那一层不做 |
| Linux 上的 Codex | 先实测，能挡读就放开只读和 workspace-write |
| vonvon 的固定保护（原生配置文件不可写、记忆目录可写、挡数据目录） | 保留，用各家原生机制加 |
| 用户 `~/.codex/rules` 绕过沙箱 | 现在测，属实就单独修（#486）。后来 Mac 实测属实、没有原生开关，owner 改成不修（owner 2026-10-23："点过总是允许为啥还要限制""也不必说明"） |

看了"改完以后的样子"，owner 改了方向（"我想用户的体验更简单。连联网这个设置都不要有。你就不能自行划分 3 档位，然后各自代表一组设置，每个 provider 代表的设置不同。当然也支持高级设置，用户可以完全自己设置"），之后几轮定下：

| 问题 | 决定 |
|---|---|
| 档位 | vonvon 定三档，每一档在各家展开成它自己的一组原生设置 |
| 网络 | 不单独设置。只读不联网，工作区可写联网，完全访问不限制 |
| 档名 | 中文，最多 5 个字。效果一样的用同一个简单的名字：只读、工作区可写、完全访问；效果不一样的另起短名字。说明里可以带这家的原名 |
| 做不到的档 | 置灰，写一句原因 |
| 高级设置 | 要。列这家自己支持的设置，中文名加原名，预填当前档展开的值，改过显示"自定义"，能一键回到某一档；桌面端、网页、私聊、命令行都能改 |
| 换 provider | 档不变，高级设置清掉 |
| 已有的群 | 网络和档一致的留在原档；不一致的转成高级设置里等价的设置，行为不变 |
| 默认值 | 不变 |

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

- **用户 rules 绕过沙箱：属实。** 在 vonvon 实际走的 app-server 路径上，用户层一条 allow 规则就让只读群读到了工作区以外的文件。#486 在 Mac（0.162.1）上也测到了，用户层和工作区层都会；app-server 没有关规则的开关（`--ignore-rules` 只有 `codex exec` 有），换 `CODEX_HOME` 又带不走登录。owner 定不修（owner 2026-10-23："点过总是允许为啥还要限制""也不必说明"）。
- **Linux 上的 Codex 能挡读了。** 0.163.0 的权限 profile 在 Linux 上也能挡读。`D/agent/codex-appserver/full-only.ts` 和 `backend.ts` 里"Linux 只挡写、不限读"的注释，对 profile 方式已经过时。要放开 Linux 上的只读和读写，还要先补两件事：
  - profile 里要把 Codex 自己的安装目录设成可读，不然沙箱里一条命令都跑不起来（R3）。
  - 读写档给不存在的受保护路径加只读条目时，Linux 的 bubblewrap 挂载会失败（W0）。要么只给已经存在的路径加，要么换别的写法。代价是新建 `.mcp.json` 这类文件挡不住，要写明，由 owner 定。
- 以上都只跑过一次，没有在 macOS 上重跑。

## 4. 计划

按第 1 节最后的决定，实现分四片，计划在 `docs/plans/`：

| 片 | 内容 |
|---|---|
| s31c | 每个 provider 一张权限表；联网并进档位；群加 `custom`，旧群网络和档不一致的读成自定义；网页、私聊卡、命令行跟着改 |
| s31d | 高级设置的编辑器；Claude 加先出方案、自动判断（看实测）、命令沙箱开关、只允许这些网站 |
| s31e | Linux 上的 Codex：profile 放开安装目录、处理不存在的受保护路径，放开只读和工作区可写；不依赖 #486 |
| s31b（改过） | Claude 挡配置文件、限读；Linux 上不套外层，名单里 cwd 的上级换成兄弟项 |

## 5. 文件

| 文件 | 内容 |
|---|---|
| [native-codex-claude-gemini](native-codex-claude-gemini.md) | Codex、Claude Code、Gemini CLI、Qwen Code 的原生权限模型，对旧调研的更正 |
| [native-other-agents](native-other-agents.md) | Cursor、Grok、Pi、OpenCode、Goose、Kimi、Copilot、Amp、Droid、Cline 类、DeepSeek Harness |
| [hosts-and-sandboxes](hosts-and-sandboxes.md) | ACP、Zed、Paseo、其他多 agent 宿主，sandbox-runtime 等外层沙箱，群聊里谁来批准 |

这三份由 Sonnet 子代理写成，只依据官方文档和源码，各家都没装也没跑。它们没有核实记录，用之前先核对关键事实；Qwen 只读了文档。第 3 节的实测由 Claude 自己做。
