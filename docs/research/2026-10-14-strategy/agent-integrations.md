# Linear 与 GitHub 上的编码代理接入调研（2026-10-14，针对 vonvon-bot 的双机分工）

## 结论

- **Linear 适合做"需要真桌面的任务"的人工队列，不适合替代 GitHub PR 流程。** Linear 原生接入的代理都跑在厂商云里，包括 Codex for Linear、Linear 自带的 coding sessions、Copilot、Cursor 和 Devin。它们碰不到 JP-VPS 上由 Paseo 驱动的 Claude，也碰不到 Mac 上由 Paseo 驱动的 Codex CLI，都没有 Computer Use，而且多数要额外花钱。
- **能接进现有机器的只有两条：官方 Linear MCP 和 Linear webhook。**
  - Claude Code 和 Codex（CLI 与桌面 app 共用配置）都能接官方 MCP `https://mcp.linear.app/mcp`，按订阅计费，不产生额外支出。
  - 唤醒 Claude 用 Linear webhook，经 Tailscale Funnel 打到 JP-VPS 上一个很小的接收器，接收器调 `paseo send`。也可以不开公网口，改成定时轮询。
- **最省事的执行方式：** 在跑 Codex 桌面 app 的那台 Mac 上配好 Linear MCP。主人只需对 Codex app 说一句"执行 DSK-12"，也可以从 iPhone 的 ChatGPT 远程发。Codex 自己读 issue，用 Computer Use 做完，把结果评论回 Linear。webhook 再把 Claude 叫醒。全程没有新增付费项。

## 本机核对（只读）

| 项 | 结果 |
|---|---|
| Claude Code 版本 | `claude --version` 输出 2.1.299 |
| 能否添加 MCP | 能。`claude mcp add` 支持 `--transport http`、`-H/--header`、`--scope local\|user\|project`、`--callback-port` |
| 无头机上的 OAuth | 能。`claude mcp login <name> --no-browser` 会打印授权 URL，然后要求把浏览器跳转后的地址粘回来 |
| 已配置的 MCP | `claude mcp list` 只有 `claude.ai Claude Docs ✔ Connected`，还没有 Linear |
| Paseo 怎么跑 Claude | Paseo 0.11.1 通过 `@anthropic-ai/claude-agent-sdk` 运行 Claude，`settingSources` 为 user、project、local（`~/.local/share/paseo-runtime/0.11.1/node_modules/@getpaseo/server/dist/server/server/agent/providers/claude/agent.js:39-43, 2722`） |
| Paseo 发图片 | `paseo send` 支持 `--image <path>` |
| handoff 脚本可复用部分 | `scripts/handoff.mjs` 导出了 `SIDES`（:20-31）、`sessionTitle`（:33）和 `notifyAction`（:51-58，会先等对方空闲再发）。:103-120 用到 `paseo wait/send`。接收器可以直接复用这些 |
| 仓库 | 私有仓库（`private: true`），组织是 GitHub Team 计划。没有 self-hosted runner，没有仓库 webhook，只有 `ci.yml` |
| 隧道工具 | 装了 Tailscale 1.102.4，支持 `funnel --bg`、`--set-path`，目前没有 funnel 配置。没有 cloudflared、ngrok、caddy 或 nginx |
| 内存 | 总共 3916 MB，可用约 1495 MB |

## 集成矩阵

| 方案 | 怎么触发 | 在哪里运行 | 能否驱动 JP-VPS 上的 Claude 或 Mac 上的 Codex CLI | 计费 | 是否适合本方案 |
|---|---|---|---|---|---|
| 官方 Linear MCP + Claude Code（JP-VPS） | Claude 主动调用工具 | 本机会话 | 能 | Linear 任何计划都可用，加 Claude Max | 核心 |
| 官方 Linear MCP + Codex CLI 或桌面 app（Mac） | Codex 主动调用工具 | 本机，配置文件共用 | 能 | ChatGPT 计划 | 核心，用来让 Codex app 自己读任务、回结果 |
| Linear webhook（Issue、Comment）+ 自建接收器 + `paseo send` | issue 或评论变化 | JP-VPS | 能 | 0 | 推荐的唤醒方式 |
| 自建 Linear Agent（OAuth `actor=app`，AgentSession） | 在 Linear 里 @ 它或委派给它 | JP-VPS | 能 | 0，代理不占席位 | 第二阶段可选；API 仍是 Developer Preview |
| Codex for Linear（指派或 @Codex，2025-12-04 上线） | 指派或 @ | Codex 云 | 不能 | 付费 ChatGPT 计划，云任务消耗的额度比本地多 | 不适合：在云里跑，没有 Computer Use，会绕过 owner 标签规则 |
| Linear coding sessions（Linear Agent 调 Claude Code 或 Codex） | 委派给 Linear | Linear 云 | 不能 | 付费计划（GitHub 集成页写的是 Business 及以上），扣 Linear AI credits | 不适合：额外花钱 |
| Copilot cloud agent for Linear（2026-07-23 GA） | 指派 | GitHub Actions | 不能 | 付费 Copilot，加 AI credits 和 Actions 分钟 | 不适合 |
| Cursor、Devin、Factory 等 | 指派 | 厂商云 | 不能 | 厂商计费（具体价格未逐个核实） | 不适合 |
| Cyrus（Apache-2.0，可自托管） | 指派 | 自己的机器，需要公网 URL | 会另起自己的 Claude 或 Codex 会话和 worktree | 自带订阅，例如 `CLAUDE_CODE_OAUTH_TOKEN` | 不适合：和 Paseo、AGENTS.md 冲突，只适合当参考实现 |
| Merlin | 指派或 @ | 本地桌面 app 或 Linux daemon | 会另起会话 | 免费版最多 5 人、每月 1000 次请求，用你自己的 Claude Code 和 Codex 登录 | 不适合：又多一个 daemon，同样和规则冲突 |
| GitHub @codex | PR 评论 | Codex 云 | 不能 | ChatGPT 计划 | 只能做评审，本方案不需要 |
| Claude Code GitHub Actions（@claude） | 评论、标签、指派 | GitHub runner | 不能 | 可以用订阅 token，但占 Actions 分钟（Team 计划每月 3000 分钟，和三平台 CI 共用）。self-hosted runner 免费，但 JP-VPS 内存不够 | 不适合 |
| Claude Code routines（API 或 GitHub 触发） | `/fire` 接口、GitHub 事件 | Anthropic 云 | 不能 | 订阅额度 | 不适合：碰不到 JP-VPS 上的 worktree |
| Claude Code channels | 推送消息进正在运行的会话 | 本机 CLI | 需要 CLI 加 `--channels` 启动，Paseo 用的是 SDK，能否用未验证 | 订阅额度 | 暂不考虑 |

## 最省钱且稳的接线

```
Claude（Paseo 会话 PR #N, JP-VPS）
  │  Linear MCP：在 DSK 团队建 issue，指派给主人，打 codex-app 标签，附 PR 链接
  ▼
Linear（Free）──推送到 iPhone 和 Mac 上的 Linear app
  │  主人在 Codex 桌面 app（Mac 本机，或从 iPhone 的 ChatGPT 远程）输入"执行 DSK-12"
  ▼
Codex app：通过 Linear MCP 读 issue → Computer Use 执行 → 评论回结果（截图由主人手动拖进评论）
  │  Linear webhook（Issue、Comment，DSK 团队）
  ▼
Tailscale Funnel https://<vps>.ts.net/linear-webhook → JP-VPS 上的接收器（systemd 用户服务）
  │  校验 HMAC，只放行主人这个 actor，从标题里的 "[PR #N]" 解析 PR 号
  ▼
复用 handoff.mjs 的 notifyAction，等对方空闲后 paseo send：只发"DSK-12 有新结果 <url>"
  ▼
Claude 通过 MCP 读结果，把摘要写进 PR 评论（状态仍以 PR 为准）
```

- **唤醒的兜底方案：**
  - 不开公网口：用 systemd timer 每 10 分钟查一次 Linear GraphQL 的 `issues(filter: updatedAt > 游标)`，每小时约 6 次，远低于 API key 每小时 2500 次的上限。Linear 官方不鼓励轮询，但这个量可以忽略。
  - 完全手动：主人在 Paseo iOS app 里直接给 `PR #N` 会话发一句话。
- **Claude 在 Linear 里的身份，推荐用独立身份：**
  - 用独立身份，主人才收得到通知，接收器也才能靠 actor 过滤 Claude 自己的评论，防止回环。
  - 首选新建一个成员（Free 计划成员数不限），给它开 personal API key，权限限定为 Read 和 Write，并限定在 DSK 团队。
  - 次选 OAuth app 的 `client_credentials` token：以 app 身份行动，有效期 30 天，没有 refresh token，需要定期轮换。
- **零 token 的快速起步：** 在 claude.ai 的 connectors 页面添加 Linear 并在浏览器里完成 OAuth。Claude Code 用订阅登录时会自动加载 claude.ai 的 connectors，SDK 会话也会。代价是 Claude 以主人的身份行动。

## 主人需要做的设置

1. **建 Linear 工作区（Free 计划）。** 建团队 `DSK`，状态设为 Todo、In Progress、Needs Claude、Done，建标签 `codex-app`。在 iPhone 和 Mac 上装 Linear app，打开"指派给我"和"评论"的推送。
2. **给 Claude 开身份。** 按上面推荐建独立成员和受限 API key，把 key 放在 JP-VPS 上一个只有 `operator` 能读的文件里，并让 Paseo daemon 的环境里有这个变量，然后执行 `paseo restart`。
3. **在 JP-VPS 上接 MCP，三种方式选一：**
   - Bearer token（单引号让变量在运行时才展开）：
     ```
     claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp -H 'Authorization: Bearer ${VONVON_LINEAR_KEY}'
     ```
   - OAuth：先执行 `claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp`，再用 `ssh -t` 登录 JP-VPS 执行 `claude mcp login linear --no-browser`。在 MacBook 浏览器里打开打印出的 URL 完成授权，把跳转后的完整地址粘回终端。
   - claude.ai connector：在 claude.ai/customize/connectors 添加 Linear。

   配好后执行 `claude mcp get linear` 检查，再在一个 Paseo 会话里确认能看到 Linear 工具。
4. **在 Mac 上给 Codex 接 MCP。** 在跑 Codex app 的那台 Mac 上执行 `codex mcp add linear --url https://mcp.linear.app/mcp`，会在浏览器里登录。也可以手写 `~/.codex/config.toml` 的 `[mcp_servers.linear]` 段（`url = "https://mcp.linear.app/mcp"`，可选 `bearer_token_env_var`），再执行 `codex mcp login linear`。CLI、IDE 扩展和桌面 app 共用这份配置。
   - 先跑一下 `codex mcp --help` 确认参数。Linear 的文档还写着要开 `experimental_use_rmcp_client = true`，但 Codex 自己的文档已经不提这个开关，可能过时了。
   - 可以用 `enabled_tools` 限制 Paseo 下 Codex 审查会话能用的工具。
5. **在 iPhone 上开远程控制（可选）。** 在 Mac 的 ChatGPT 桌面 app 里打开 Settings → Connections → Control this Mac，用 iPhone 扫码配对。被控的 Mac 要保持唤醒。
6. **配 Funnel 和 webhook。**
   - 在 tailnet 策略里给 JP-VPS 加 `funnel` 节点属性，确认 MagicDNS 和 HTTPS 证书已开。
   - 执行 `tailscale funnel --bg --set-path /linear-webhook 8787`（具体写法以 `--help` 为准）。
   - 在 Linear 的 Settings → Administration → API 里新建 webhook，资源类型选 Issue 和 Comment，团队选 DSK，记下 signing secret。
   - 接收器本身由 Claude 开 PR 实现。
7. **（可选）装 Linear 的 GitHub 集成。** 需要 GitHub 组织 owner 加 Linear 管理员。PR 描述里关联 Linear issue 时用 `Refs DSK-12`。
8. **由主人决定是否把这套流程写进 `AGENTS.md`。** 现行规则写的是"进度只看 #122 看板（issue #122）和 PR 状态"。

## 坑

- **OAuth 不能在会话里完成。** `claude -p` 和 Agent SDK 会话（也就是 Paseo 会话）没有 `/mcp` 面板，没法走 OAuth。必须事先在交互终端里登录好，或者改用 bearer token。
- **不要在 JP-VPS 上设 `CLAUDE_CODE_OAUTH_TOKEN`**（比如为了试 Cyrus）。它会让 claude.ai connectors 失效，有报告说它还会悄悄覆盖 Max 登录、把用量记到 API 账户上（anthropics/claude-code#16238）。
- **header 里的变量可能被置空。** Claude Code 会把一部分凭据类环境变量在远程 server 的 url 和 header 里展开成空值。用自己起的变量名，并且这个变量必须在 Paseo daemon 的环境里。
- **webhook 的硬性要求：**
  - 只有管理员能建。
  - 必须是公网可达的 HTTPS 地址。
  - 5 秒内要返回 200。
  - 失败会在 1 分钟、1 小时、6 小时后各重试一次，一直不通会被停用。
  - 要用原始请求体做 HMAC-SHA256 校验，`webhookTimestamp` 要在 60 秒之内。
  - Claude 自己发的评论也会触发 webhook，必须按 actor 过滤。
- **防注入。** issue 和评论内容都是不可信输入。接收器只转发 issue 编号和链接，并且只放行主人这个 actor。
- **`paseo send` 默认会打断对方正在进行的回合。** 必须复用 `notifyAction` 先等空闲。接收器不要自己建会话：`AGENTS.md` 只允许 handoff 脚本跨机建会话，在飞 PR 也有两个的上限。
- **Free 计划的限制：** 最多 250 个 issue、2 个团队、单个上传 10 MB。做完的任务要定期归档（归档的 issue 算不算进 250 未验证）。triage rules 要 Business 及以上。
- **GitHub 集成的自动状态。** 默认 PR 打开时把 issue 移到 In Progress，合入时移到 Done。用 fixes、closes 这类关闭词会在合入时把验收任务自动关掉，用 `Refs` 就不会。Linear 还会往 PR 里回帖，增加噪音。
- **云端代理会破坏现有规则。** 云端代理会从云里直接 push 分支，违反"只有 owner 标签指向的一方能 push"和"在飞最多两个产品 PR"。不要把 vonvon-bot 的 issue 委派给它们。
- **Computer Use 的限制。** 它不能批准系统安全和隐私弹窗，不能做管理员认证，也不能操作终端类 app。所以 TCC 授权、登录项批准这类步骤仍然要人手。任务描述里要写清楚哪几步需要人工。
- **从 iPhone 远程发起的线程能不能用 Computer Use，官方文档没写。**
- **Linear 的 Agent API 还是 Developer Preview，接口可能变。**
- **订阅条款一直在变。** 2026 年 2 月禁止第三方用订阅 OAuth；10 月 7 日的帮助文档又写明 Agent SDK、`claude -p` 和第三方 app 仍可使用订阅额度。Paseo 本身就是基于 Agent SDK 的。
- **JP-VPS 只剩约 1.5 GB 可用内存。** 接收器必须很轻，不要跑 Cyrus 或 Merlin 这类会另起会话的 daemon。

## 未验证的点

- Linear 的收件箱会不会通知你自己做的操作。文档只在视图订阅里写明不通知。
- 通过 MCP 能不能上传附件或截图。2026-02-05 的更新只提到能"读取图片"。
- Paseo 的 SDK 会话会不会加载 `~/.claude.json` 里 user 作用域的 server。
- Linear webhook 的出口 IP 列表。

## 来源

- Linear MCP：https://linear.app/docs/mcp ；2026-02-05 更新：https://linear.app/changelog/2026-02-05-linear-mcp-for-product-management
- Linear Agent：https://linear.app/developers/agents.md 、https://linear.app/developers/agent-interaction.md 、https://linear.app/docs/agents-in-linear 、https://linear.app/docs/assigning-issues 、https://linear.app/integrations/agents
- Linear webhook、OAuth、限流：https://linear.app/developers/webhooks.md 、https://linear.app/developers/oauth-2-0-authentication.md 、https://linear.app/developers/rate-limiting.md 、https://linear.app/docs/api-and-webhooks
- Linear 价格、triage、GitHub 集成、coding sessions、移动端：https://linear.app/pricing 、https://linear.app/docs/triage 、https://linear.app/docs/github 、https://linear.app/integrations/github 、https://linear.app/docs/coding-sessions 、https://linear.app/mobile
- Codex：https://learn.chatgpt.com/docs/third-party/linear 、https://linear.app/changelog/2025-12-04-openai-codex-agent 、https://learn.chatgpt.com/docs/extend/mcp?surface=cli 、https://learn.chatgpt.com/docs/pricing 、https://learn.chatgpt.com/docs/computer-use.md 、https://learn.chatgpt.com/docs/mobile 、https://developers.openai.com/codex/integrations/github
- Claude Code：https://code.claude.com/docs/en/mcp 、https://code.claude.com/docs/en/github-actions 、https://code.claude.com/docs/en/routines 、https://code.claude.com/docs/en/channels 、https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan （2026-10-07 更新）
- Copilot 与 GitHub 计费：https://github.blog/changelog/2026-07-23-copilot-cloud-agent-for-linear-is-now-generally-available/ 、https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/ 、https://docs.github.com/en/billing/concepts/product-billing/github-actions
- self-hosted runner 收费推迟（二手报道）：https://www.techzine.eu/news/devops/137396/github-bends-to-criticism-and-delays-paid-self-hosting-of-runners/
- 第三方工具：https://github.com/ceedaragents/cyrus 、https://github.com/ceedaragents/cyrus/blob/main/docs/SELF_HOSTING.md 、https://linear.app/integrations/merlin 、https://usemerlin.ai/pricing
- Tailscale Funnel：https://tailscale.com/kb/1223/funnel
- `CLAUDE_CODE_OAUTH_TOKEN` 覆盖问题：https://github.com/anthropics/claude-code/issues/16238


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：The report holds up well against official sources. Of the 12 claims re-checked, 9 are confirmed, sometimes with nuance worth adding. One is wrong: it says GitHub @codex only does code review, but non-review mentions start cloud tasks that can push to the branch. One is overstated: it says Linear coding sessions need Business and above, but Linear's own docs and pricing table say Basic and above, opt-in, with prepaid credits. One is unsupported: that claude.ai connectors load in Paseo's Agent SDK sessions, which no doc says and the report's own 'unverified' list contradicts.

The local read-only checks reproduce:
- Claude Code 2.1.299; `claude mcp login --no-browser` exists.
- Paseo 0.11.1 has `send --image`. In agent.js, lines 39-43 set user, project and local settingSources, and line 2722 passes them to the SDK.
- handoff.mjs exports SIDES (line 20), sessionTitle (33) and notifyAction (52-58). Lines 103-120 call `paseo wait` and then `paseo send`.
- The repo is private and the org is on GitHub Team (1 seat), with 0 repo hooks, 0 self-hosted runners and only ci.yml.
- Tailscale 1.102.4 supports `funnel --bg` and `--set-path`.
- Available memory is about 1.3 GB now; the report saw about 1.5 GB.

Funnel's documented rules are MagicDNS, HTTPS certificates and a funnel node attribute in the tailnet policy. It is available on all plans and listens only on 443, 8443 and 10000.

The core recommendation still stands: Linear Free as the human queue, official MCP on both sides, a Linear webhook through Tailscale Funnel into a tiny receiver that reuses notifyAction, and no cloud agents. The pricing table confirms MCP access and API and webhook access on Free.

Add these to the report:
- **@codex:** list GitHub @codex among the cloud agents that must stay off this repo.
- **Agent timing:** note the 10-second activity rule if the Linear Agent API route is ever taken.
- **Webhook IPs:** the egress IP list is published, so the receiver can allowlist it.
- **Channels:** documented as a webhook path into a running local session, and they work in `-p` mode.
- **Shared Codex config:** Linear MCP on the Mac mini also reaches the Paseo Codex review sessions; restrict it with enabled_tools or the read-only endpoint.

Two items are still unknown from official sources: whether archived issues count toward the 250-issue limit, and whether Computer Use or MCP is available in threads started remotely from the iPhone. All web checks were made on 2026-10-14.


### 逐条复查

- **属实**：The official Linear MCP at https://mcp.linear.app/mcp works with Claude Code and Codex on any Linear plan, including Free. It can authenticate with a bearer API key instead of OAuth.
  - 依据：linear.app/docs/mcp gives https://mcp.linear.app/mcp (Streamable HTTP), plus /mcp/readonly and a deprecated /sse. It says an OAuth token or API key can be sent as an `Authorization: Bearer` header. Parsing the linear.app/pricing comparison table (fetched 2026-10-14) shows the 'MCP access' row and the 'API and webhook access' row checked for free, basic, business and enterprise.
- **属实**：The Codex CLI, IDE extension and desktop app share one config, and `codex mcp add linear --url https://mcp.linear.app/mcp` sets it up. Linear's docs still mention `experimental_use_rmcp_client = true`, but Codex's own docs no longer do.
  - 依据：learn.chatgpt.com/docs/third-party/linear gives the same command plus a manual `[mcp_servers.linear]` block followed by `codex mcp login linear`, and mentions no flag. learn.chatgpt.com/docs/extend/mcp says 'The ChatGPT desktop app, Codex CLI, and IDE extension all read the same MCP configuration'. It lists `bearer_token_env_var`, `http_headers`, `enabled_tools` and `disabled_tools`. linear.app/docs/mcp still tells first-time Codex MCP users to add `experimental_use_rmcp_client = true` under `[features]`. One caveat: on the Mac mini this shared config is also what the Paseo-driven Codex review sessions read.
- **说过头了**：Linear coding sessions run in Linear's cloud, need a paid plan (the GitHub integration page says Business and above), and draw on Linear AI credits.
  - 依据：Sources: linear.app/docs/coding-sessions ('supported on paid plans', 'draws from your workspace's AI credits'), linear.app/docs/ai-credits, the parsed pricing table (Coding sessions: free=no, basic, business and enterprise=yes), and linear.app/integrations/github.
- **属实**：Codex for Linear (launched 2025-12-04, assign or @Codex) runs in Codex cloud, needs a paid ChatGPT plan, and cloud tasks use more allowance than local ones.
  - 依据：linear.app/changelog/2025-12-04-openai-codex-agent dates the launch December 4, 2025 and says it needs a ChatGPT paid plan. learn.chatgpt.com/docs/third-party/linear says 'Codex creates a cloud chat' in a Codex cloud environment and 'available on paid plans'. learn.chatgpt.com/docs/pricing says 'Cloud tasks may use more of your allowance than local messages.'
- **有误**：GitHub @codex on PR comments can only do code review.
  - 依据：developers.openai.com/codex/integrations/github redirects with a 308 to learn.chatgpt.com/docs/third-party/github, which states this behavior.
- **属实**：Copilot cloud agent for Linear became generally available on 2026-07-23. It runs on GitHub Actions and costs a paid Copilot plan plus AI credits and Actions minutes.
  - 依据：github.blog/changelog/2026-07-23-copilot-cloud-agent-for-linear-is-now-generally-available says July 23, 2026, Copilot Pro, Pro+, Business and Enterprise, and an 'ephemeral development environment powered by GitHub Actions'. GitHub Docs say cloud agent uses Actions minutes plus premium requests. github.blog 'GitHub Copilot is moving to usage-based billing' says AI Credits replace premium requests from June 1, 2026. The changelog itself does not spell out billing.
- **属实**：Linear webhook rules: only admins can create them; the URL must be public HTTPS; Linear needs a 200 within 5 seconds; it retries at 1 minute, 1 hour and 6 hours, then may disable the webhook; the signature is HMAC-SHA256 over the raw body; webhookTimestamp must be within 60 seconds. The report lists the egress IP list as unknown.
  - 依据：linear.app/developers/webhooks: 'Only workspace admins, or OAuth applications with the admin scope', 'publicly accessible HTTPS, non-localhost URL', 5 s, retries at 1 m, 1 h and 6 h, 'must be re-enabled again manually', header `Linear-Signature` carrying a hex HMAC-SHA256 of the raw body, timestamp 'within a minute'. linear.app/docs/api-and-webhooks: Settings > Administration > API, admin only.
- **属实**：A self-built Linear Agent (OAuth actor=app, AgentSession) costs nothing, does not take a seat, and its API is still a Developer Preview.
  - 依据：linear.app/developers/agents: 'available as a Developer Preview', 'agents installed in your workspace do not count as billable users', `actor=app`, scopes `app:assignable` and `app:mentionable`, admin needed to install. linear.app/docs/agents-in-linear: 'not counted as billable seats'. linear.app/developers/agent-interaction: the 10-second rule; the Agent Plan API is a 'technology preview'.
- **属实**：Claude's Linear identity: on Free (unlimited members), a separate member gets a personal API key limited to Read and Write and to the DSK team. The fallback is an OAuth client_credentials token that acts as the app, lasts 30 days and has no refresh token. The polling fallback stays far under the 2,500-requests-per-hour limit.
  - 依据：linear.app/docs/api-and-webhooks: key permissions Read, Write, Admin, Create issues and Create comments, and keys 'can also be limited to specific teams'; admins can control whether members create keys. linear.app/developers/oauth-2-0-authentication: client_credentials 'valid for 30 days', no refresh token, an app-actor token, access to all public teams. linear.app/developers/rate-limiting: API key 2,500 requests/hour; 'we especially discourage ... polling'. Pricing: 'Unlimited members'.
- **属实**：Free plan limits: 250 issues, 2 teams, 10 MB per upload; whether archived issues count is unknown; triage rules need Business or above.
  - 依据：The parsed linear.app/pricing table gives File upload 10MB, Issues 250, Teams 2 (Basic gets 5). Triage rules, Triage responsibility, Triage Intelligence and Issue SLAs are checked only for Business and Enterprise; linear.app/docs/triage says the same. Linear Agent and Agent platform are checked on Free. Whether archived issues count is still not stated officially: no 'archive' text on the pricing page, and linear.app/docs/billing-and-plans says only that over 250 issues blocks new ones. Third-party sites claiming 'excluding Archive' could not be confirmed against the live page.
- **属实**：Computer Use cannot approve security and privacy prompts, cannot authenticate as an administrator, and cannot drive terminal apps. The iPhone remote path is ChatGPT desktop Settings → Connections → Control this Mac, and the Mac must stay awake. Whether remote threads can use Computer Use is undocumented.
  - 依据：learn.chatgpt.com/docs/computer-use.md: 'can't approve security and privacy permission prompts', 'can't authenticate as an administrator', 'can't automate terminal apps or ChatGPT itself', 'Locked use is for macOS'. learn.chatgpt.com/docs/mobile: 'Settings > Connections > Control this Mac or PC', QR pairing, 'Keep your computer awake and online'; Computer Use and MCP in remote threads are not covered.
- **unsupported**：claude.ai connectors (such as Linear added at claude.ai/customize/connectors) load automatically in Claude Code under a subscription login, and SDK sessions such as Paseo's load them too. CLAUDE_CODE_OAUTH_TOKEN disables connectors. OAuth cannot run inside -p or SDK sessions, so it needs `claude mcp login --no-browser` over `ssh -t`.
  - 依据：code.claude.com/docs/en/mcp: connectors are 'fetched only when your active authentication method is a claude.ai subscription login' and are not loaded when 'CLAUDE_CODE_OAUTH_TOKEN holds a token from claude setup-token'; 'A claude -p or Agent SDK run has no /mcp panel, so Claude Code can't run the OAuth flow there'; `claude mcp login` 'needs an interactive terminal ... connect with ssh -t'. Local `claude mcp login --help` (v2.1.299) shows `--no-browser`. `ps` shows Paseo running `/home/operator/.local/bin/claude --output-format stream-json --input-format stream-json ...`. In Paseo agent.js, lines 39-43 hold CLAUDE_SETTING_SOURCES (user, project, local) and line 2722 passes it to the SDK; both confirmed.

### 正文遗漏的事实

- GitHub `@codex` with any text other than `review` starts a cloud task that can push to the PR branch (learn.chatgpt.com/docs/third-party/github). Treat it like the other cloud agents: keep it off vonvon-bot PRs, or the owner-label rule breaks.
- Linear Agent API timing: after AgentSessionEvent `created`, the agent must emit an activity within 10 seconds or Linear marks the session unresponsive (linear.app/developers/agent-interaction). That decides the design if the 'self-built agent' phase-2 route is chosen.
- Linear's webhook egress IPs are published on linear.app/docs/security, so an IP allowlist on the Funnel receiver is possible on top of the HMAC check.
- Claude Code channels (code.claude.com/docs/en/channels, research preview): the docs include a webhook-receiver example and support non-interactive `-p` mode. Pro and Max users without an organization skip the enterprise gate. A channel still needs `--channels` at launch, Bun, and an allowlisted plugin, or `--dangerously-load-development-channels` for a custom one. Paseo launches the `claude` binary itself, so whether it can pass `--channels` is the open question, not the SDK as such.
- Claude Code routines can run on self-hosted environments, but only on Team and Enterprise (public beta, off by default). On the owner's individual Max plan they cannot reach JP-VPS, so the report's 'cannot' holds for this account (code.claude.com/docs/en/self-hosted-environments).
- Coding sessions and Loops are opt-in on Basic and above and require prepaid funds: minimum $10 ad-hoc, $50 for auto-reload (linear.app/docs/ai-credits). On Free they cannot be turned on by accident.
- The Linear GitHub integration posts linkback comments on PRs, and these can be turned off in integration settings, which addresses the 'noise' pitfall. Non-closing magic words include ref, refs, references, part of, contributes to and toward. 'relates to' and 'related to' only link the PR, with no status change (linear.app/docs/github).
- Computer Use on macOS needs a one-time human grant of Screen Recording and Accessibility to 'Codex Computer Use'. A macOS 'Locked use' setting lets it run after the Mac locks. Both matter if the Mac mini, rather than the MacBook Air, runs the desktop app.
- Shared config side effect: if Linear MCP is added to ~/.codex/config.toml on the Mac mini, the Paseo-driven Codex CLI review sessions get Linear write tools too, because the config is shared. Use `enabled_tools`/`disabled_tools`, the /mcp/readonly endpoint, or a separate CODEX_HOME for Paseo.
- Merlin's Linear integration page says it needs 'the Merlin desktop app or CLI running'. The report's 'Linux daemon' wording is not in official pages.
- anthropics/claude-code#16238 is one user's report. It was closed as not planned by the stale bot, with no maintainer reply, so the 'billed to API account' detail is anecdotal. The doc-backed reason to avoid the variable is that connectors stop loading.
- The Feb 2026 'third-party subscription OAuth ban' is sourced only to press (WinBuzzer and Gigazine, Feb 19-20, 2026). The official support article 15036540 has dated notices from June 15 and October 7, 2026 saying the Agent SDK, `claude -p` and third-party apps still draw from subscription limits.
