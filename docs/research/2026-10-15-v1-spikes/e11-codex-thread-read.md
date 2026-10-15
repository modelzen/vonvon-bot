# e11：用另一个 app-server 进程读 Codex 线程

`docs/v1-plan.md` 第 4 节的 e11，对应 product.md 第 9 节第 18 项的 Codex 一半，挡住 s48（vonvon 飞书 skill 的"按会话 id 读另一条会话"）。基于 `main` 的 `bfc01d7`。2026-10-15 北京时间 20:17 到 20:30 在 JP-VPS 上实测，用 `~/.local/bin` 下的 `codex-cli 0.162.1` 和 owner 的 ChatGPT 登录。对照版本借用 e05 装在临时目录的 0.139.0、0.148.0、0.156.1，只拿来起进程，没改那几份安装。

## 结论先行

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 另起一个 utility app-server 进程，不加载线程，能不能读到别的进程起的线程 | **能** | B 进程读的前后，`thread/loaded/list` 都是空的，返回的线程 `status` 是 `notLoaded`，没起回合，也不需要传 cwd。被读的线程在 A 里已关掉、仍加载着、A 整个退出，三种情况 B 都读得到。读一次 1 到 45 毫秒 |
| 2 | 能不能拿到用户消息和最终回答，不含工具步骤 | **能，而且服务端已经替你滤好**：用 `thread/turns/list` 加 `itemsView: "summary"` | summary 视图每一轮只留 `userMessage` 和 `phase: "final_answer"` 的 `agentMessage`。`commentary` 说明、`commandExecution`、`reasoning` 都去掉了。`full` 视图和 `thread/read` 加 `includeTurns: true` 返回全部条目 |
| 3 | `thread/read` 本身还能不能用 | **能，但 0.162.1 已经标成过时** | 新线程的 `historyMode` 是 `paginated`。对这种线程发 `includeTurns: true`，每次都会收到一条 `deprecationNotice`，内容是"Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`"。不带 `includeTurns` 时只返回元数据，`turns` 为空 |
| 4 | 正在跑的那条会话读出来是什么样 | **部分**：读得到已经结束的轮，正在跑的那一轮显示成 `interrupted` | 回合进行中从 B 读，最后一轮 `status` 是 `interrupted`，summary 只有用户消息，full 里多一条 commentary，正在执行的命令还没写进去。A 里那一轮后来正常完成，再读就是 `completed`。B 看到的 `status` 永远是 `notLoaded`，看不出线程在别的进程里正跑着 |
| 5 | "关掉一条"之后 | 不影响读 | A 发 `thread/unsubscribe`，马上回 `{"status":"unsubscribed"}`，但线程又留在 A 的已加载列表里约 60 秒，之后才收到 `thread/closed`。再发一次回 `notLoaded`。关掉前、关掉后、A 退出后，B 读到的内容都一样 |
| 6 | 还没跑过回合的线程、不存在的 id | 都读不到，报同一个错 | 两种都是 `-32600`，`thread not loaded: <id>`。只做过 `thread/start` 的线程在 `~/.codex/sessions` 下没有文件 |
| 7 | 旧版本建的线程（`legacy`） | **能**，`thread/turns/list` 的 summary 也一样 | 0.148.0 建的 T9 `historyMode` 是 `legacy`，0.148.0、0.156.1 和 0.162.1 用 summary 都读出用户消息和最终回答。full 视图里没有命令那一条，旧格式的记录里没存。`thread/items/list` 对旧格式的 T6 回 `-32601`，`thread/items/list is not supported yet` |
| 8 | 压缩、失败、归档过的线程 | 都能读 | 压缩以后，压缩前的轮仍然完整，压缩本身单独算一轮，summary 里条目为空，full 里只有一条 `contextCompaction`。失败的轮显示 `failed`，只有用户消息。`thread/archive` 以后文件移到 `~/.codex/archived_sessions/`，照样读得到 |

## 怎么测的

- 探测脚本放在仓库外的临时目录 `<scratch>/e11/`，是一个不依赖仓库代码的 Node 脚本：起 `codex app-server --listen stdio://`，按行收发 JSON-RPC。`initialize` 的参数和 daemon 一样，`capabilities: { experimentalApi: true, requestAttestation: false }`。所有请求、回复和通知都记进临时目录的日志。没调 `account/read`，日志里没有凭据。
- 协议用 `codex app-server generate-ts` 从 0.162.1 生成，用来对照方法名和字段。
- 模型用 `gpt-6-luna`，`effort: "low"`，每个回合只让它回一个固定短语，或者先说一句话、跑一次 `echo`，再回固定短语。
- 线程的 cwd 都在临时目录下。A 是"bot 进程"，起线程、跑回合；B 是"utility 进程"，cwd 用另一个临时目录，只发读的请求。两个进程用同一个 `~/.codex`，不换 `CODEX_HOME`，和 product.md 3.6 一致。
- 一共起了 10 条线程，下文写 T1 到 T10：
  - T1：一轮，`read-only` 沙箱。模型没跑命令，直接回了固定短语（原因没查；当时 JP-VPS 上 bubblewrap 建不了用户命名空间，见"原始现象"第 9 条）。然后 A 发 `thread/unsubscribe`。
  - T2：两轮，留在 A 里不关。后来又让 A 跑第三轮，回合进行中从 B 读；最后压缩一次，再跑一轮。
  - T3：只发 `thread/start`，不跑回合。
  - T4：`danger-full-access`，第一轮有 commentary、`echo` 命令和最终回答，第二轮只有最终回答。然后 unsubscribe，每 5 秒查一次 A 的 `thread/loaded/list`。
  - T5：每轮跑 `sleep 12; echo …`。第一轮在命令执行时从 B 读，第二轮在命令执行时发 `turn/interrupt`。
  - T6 到 T8：用 0.139.0 建，三个模型都被服务端拒了，见"原始现象"第 6 条。
  - T9：用 0.148.0 和 `gpt-5.6-luna` 建，有 commentary、命令和最终回答。
  - T10：用 0.162.1 建，故意用一个 ChatGPT 账号不能用的模型，让回合失败。
- B 对每条线程依次发：`thread/read`（不带 `includeTurns`）、`thread/read`（`includeTurns: true`）、`thread/turns/list`（默认参数，以及 `itemsView: "full"`、`"summary"`、`"notLoaded"`，`limit: 1` 加 cursor 翻页）、`thread/items/list`、`thread/loaded/list`。
- 交叉版本：0.139.0、0.148.0、0.156.1、0.162.1 各起一个 utility 进程，读 T4（0.162.1 建的 `paginated`）和 T6（0.139.0 建的）；0.156.1 另外读了 T9、T5、T2。
- 这些测试线程留在 JP-VPS 的 `~/.codex/sessions` 里，cwd 都在临时目录下，没有删。

## 原始现象

下面的线程 id 截短了，路径里的家目录写成 `~`，临时目录写成 `<scratch>`。

**1. 线程元数据（B 读 T4，`thread/read` 不带 `includeTurns`）**

```json
{"id":"01a13f80-1ed1…","sessionId":"01a13f80-1ed1…","status":{"type":"notLoaded"},
 "historyMode":"paginated","ephemeral":false,
 "preview":"First write one short sentence …","name":null,
 "path":"~/.codex/sessions/2026/10/15/rollout-2026-10-15T12-18-47-01a13f80-1ed1….jsonl",
 "cwd":"<scratch>/e11/cwd/t4","cliVersion":"0.162.1","originator":"vonvon-e11-A",
 "source":"vscode","model":"gpt-6-luna","parentThreadId":null,"forkedFromId":null,"turns":[]}
```

`originator` 是起线程那个进程 `initialize` 时报的 `clientInfo.name`。

**2. 同一条 T4，三种视图（条目字段有删减）**

A 里实时收到的 `item/completed`，以及 B 用 full 视图读到的：

```
userMessage                       "First write one short sentence … Then reply with exactly: T4 DONE"
agentMessage  phase=commentary    "I will run the requested shell command."
commandExecution                  "/bin/bash -lc 'echo e11-probe'"  exitCode=0  "e11-probe\n"
agentMessage  phase=final_answer  "T4 DONE"
userMessage                       "Reply with exactly: T4 SECOND"
agentMessage  phase=final_answer  "T4 SECOND"
```

B 用 `thread/turns/list`、`itemsView: "summary"`、`sortDirection: "asc"` 读到的：

```json
[{"id":"01a13f80-2e64…","status":"completed","itemsView":"summary","items":[
   {"type":"userMessage","content":[{"type":"text","text":"First write one short sentence …"}]},
   {"type":"agentMessage","phase":"final_answer","text":"T4 DONE"}]},
 {"id":"01a13f80-476b…","status":"completed","itemsView":"summary","items":[
   {"type":"userMessage", …"Reply with exactly: T4 SECOND"},
   {"type":"agentMessage","phase":"final_answer","text":"T4 SECOND"}]}]
```

- 不传 `sortDirection` 时默认是新的在前（`desc`）；不传 `itemsView` 时默认是 `summary`。
- `itemsView: "notLoaded"` 只返回轮的 id 和状态，`items` 为空。
- `limit: 1` 时回 `nextCursor`，带上它再请求，拿到第二轮，之后 `nextCursor` 为 `null`。
- 每一轮还带 `rootTurnId`、`startedAt`、`completedAt`、`durationMs`、`error`。

**3. unsubscribe 和 `thread/closed`（A 里的 T4）**

```
thread/unsubscribe -> {"status":"unsubscribed"}
+0s 到 +55s   A 的 thread/loaded/list 里还有 T4，没有 thread/closed
+60s          列表里没有了，收到 thread/closed {"threadId":"01a13f80-1ed1…"}
再发一次 thread/unsubscribe -> {"status":"notLoaded"}
```

T1 也一样：unsubscribe 后 15 秒内没收到 `thread/closed`，仍在 A 的已加载列表里。

**4. 回合进行中从 B 读（T5 第一轮，命令正在 `sleep`）**

```
summary: [{"status":"interrupted","items":[userMessage]}]
full:    [{"status":"interrupted","items":[userMessage, agentMessage(commentary)]}]
A 里这一轮最后：completed；之后 B 再读：completed，summary 有 final_answer "T5 DONE"
```

T2 第三轮（数 1 到 40）在进行中读，也是 `interrupted`、只有用户消息。用 `turn/interrupt` 真正打断的 T5 第二轮，读出来同样是 `interrupted`，只有用户消息和 commentary，被打断的命令那一条不在 full 视图里。所以只看读到的内容，分不出"正在跑"和"被打断"。

**5. 读不到的情况**

```
T3（只 thread/start）  thread/read、thread/turns/list -> {"code":-32600,"message":"thread not loaded: 01a13f7e-cbf6…"}
                       thread/items/list            -> {"code":-32601,"message":"thread/items/list is not supported yet"}
不存在的 UUID          thread/read -> {"code":-32600,"message":"thread not loaded: 019a0000-…"}
```

**6. 交叉版本**

| utility 进程的版本 | 读 T4（0.162.1 建，`paginated`） | 读旧格式线程 |
|---|---|---|
| 0.139.0 | `thread/read` 和 `thread/turns/list` 都返回两轮，但每一轮的 `items` 都是空的；没有 `thread/items/list`（报 `unknown variant`），有 `thread/turns/list` 和 `thread/turns/items/list` | T6：只有用户消息（回合失败了，见下） |
| 0.148.0 | 正常，summary 和 full 都对 | T9（自己建的 `legacy`）：summary 有用户消息和最终回答；full 有 commentary，没有命令。T6 的 `thread/items/list` 回 `-32601` |
| 0.156.1 | 正常；`includeTurns: true` 也会收到 `deprecationNotice` | T9：summary 正常 |
| 0.162.1 | 正常 | T6、T9：summary 正常；T6 的 `thread/items/list` 回 `-32601` |

- 0.156.1 新建的线程是 `paginated`，0.148.0 新建的是 `legacy`。默认格式是在这两个版本之间换的，具体哪一版没查。
- 0.139.0 用 owner 的 ChatGPT 登录跑不了回合。它的 `model/list` 只有 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex`、`gpt-5.2`。试了 `gpt-6-luna`、`gpt-5.4-mini`、`gpt-5.5`，都是 `turn/completed` 为 `failed`，错误是 `400 invalid_request_error`："The '<模型>' model is not supported when using Codex with a ChatGPT account."。旧格式线程里这种失败的轮，读出来是 `completed`、只有用户消息；0.162.1 建的 T10 失败的轮，读出来是 `failed`。

**7. 压缩以后（T2，A 用 `thread/resume` 接回来，再发 `thread/compact/start`）**

```
summary: 轮1 FIRST / 轮2 SECOND / 轮3 1..40 T2 THIRD / 轮4 items=[] / 轮5 "T2 AFTER COMPACT"
full:    同上，轮4 是 [{"type":"contextCompaction"}]
```

**8. 用时**（B 进程，所有版本合起来）

| 请求 | 次数 | 最短 | 中位数 | 最长 |
|---|---|---|---|---|
| `initialize`（起进程到握手完成） | 13 | 230 ms | 644 ms | 1486 ms |
| `thread/read` | 26 | 1 ms | 26 ms | 551 ms |
| `thread/turns/list` | 40 | 1 ms | 11 ms | 41 ms |
| `thread/items/list` | 12 | 1 ms | 2 ms | 9 ms |

**9. 顺带看到的**

两个进程起来时都推一条 `configWarning`："Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces."。这件事 `docs/v1-plan.md` 第 7 节已经记了，这里没再查。

## 对设计的影响

- **s48 按会话 id 读 Codex 会话**：用 daemon 已有的常驻 utility 进程（`D/agent/codex-appserver/client-pool.ts`）发 `thread/turns/list`，带 `itemsView: "summary"` 和 `sortDirection: "asc"`，按 `nextCursor` 翻页，要最近几轮就用默认的 `desc` 加 `limit`。不要求那条会话的进程活着，不用 resume，不花额度，也不用传 cwd。`thread/turns/list` 从 0.139.0 起就有；0.148.0 以上读新旧两种格式都对（0.139.0 读新格式见下面的版本问题）。`thread/items/list` 对旧格式不支持，不要用。
- **自己再滤一遍**：summary 已经去掉工具步骤，但还要跳过 `items` 为空的轮（压缩），并把 `status` 不是 `completed` 的轮单独标出来。要是退回 `thread/read` 加 `includeTurns: true`，就必须按 `phase === "final_answer"` 取回答。今天的 `mapTurn`（`D/agent/codex-appserver/backend.ts:723`）把所有 `agentMessage` 拼在一起，commentary 也会混进去，s48 不能直接复用它。`MessagePhase` 的注释说有的 provider 不填 phase，为 `null` 时要退回取这一轮最后一条 `agentMessage`（推断，这次没碰到 `null`）。
- **正在跑的会话**：读到的最后一轮会是 `interrupted`、没有回答。daemon 自己知道哪条会话正在跑，这时把最后一轮写成"这一轮还在进行"，不要写"被打断"。卡片上"读了话题 T1、T2 的会话"不受影响。
- **还没跑过回合的会话**：会报 `thread not loaded`，和 id 不存在的错误一样。s13 登记表里有、但还没说过话的会话，按"空会话"返回，不当成错误。
- **协议类型**：仓库里的生成协议（`D/agent/codex-appserver/protocol/generated/`）比 0.162.1 旧，没有 `ThreadTurnsListParams`、`TurnItemsView` 和 `ThreadHistoryMode`，`ThreadReadParams.includeTurns` 还是必填。s48 要按 s03 定的版本重新生成，或者手写这几种类型。
- **今天的 `readHistory` 和 `readSessionTitle`**（`backend.ts:597-641`）用的是 `thread/read`。在 0.162.1 上还能用，但每次都会多一条 `deprecationNotice`；`includeTurns: true` 将来可能被去掉。不是 e11 的范围，给 s48 或 s39 顺手换掉的人参考。
- **product.md 3.5**：写着"背后是 Codex 的 `thread/read`"，按 4.2 的第 2 类（换一种做法，承诺不变）改成 `thread/turns/list`（summary 视图），并补一句"正在进行的那一轮只有用户的消息"。"返回用户的消息和 bot 的最终回答，不含工具步骤"这条承诺能兑现。
- **给 e05 和 s39 的版本问题**（不是 e11 要回答的，顺带发现）：
  - 0.139.0（今天的 `CODEX_MIN_VERSION`）用 ChatGPT 登录跑不了任何回合，它认识的模型全被服务端拒了。0.148.0 用 `gpt-5.6-luna` 能跑。0.139.0 和 0.148.0 之间的版本没试，最低版本抬到哪一版由 e05 定。
  - 0.139.0 读新格式线程时每一轮的 `items` 都是空的。用户一旦换回旧的 codex，新会话就读不出内容。Mac 上 ChatGPT.app、Codex.app 里各带一份 codex，daemon 找 codex 的结果要是在新旧之间跳，会碰到这个问题。

## 没测到的

- **Mac 和应用里带的 codex**：只在 JP-VPS 上测了 CLI。协议和平台无关，推断 Mac 上一样。s39 的 Mac 检查用应用里那份 codex 顺带跑一次 summary 视图就够了。
- **子 agent**：没起子 agent，没看 `collabAgentToolCall` 条目和子线程（`parentThreadId` 不为空的线程）在 summary 里怎么显示。推断 summary 会滤掉前者。s35 或 s48 做的时候再看。
- **`phase` 为 `null` 的模型**：这次所有回答都带 `phase`，没测到不带的。
- **很长的会话**：只有 1 到 5 轮。几百轮时翻页的用时、`limit` 有没有上限都没测。
- **两个进程同时写同一条线程**：e11 只读不写。B 发 `thread/resume`、两边一起写的情况属于 e14（第 8 项）。
- **换了 `CODEX_HOME` 的读者**：product.md 定了不换 `CODEX_HOME`，没测。
