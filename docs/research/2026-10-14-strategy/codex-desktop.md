# Codex desktop app in 2026: can a task reach it with less copy-paste?

## Bottom line

- **Computer Use only works in the desktop app.** Since 2026-07-09 (build 26.707) the Codex app is part of the ChatGPT desktop app on macOS and Windows. Computer Use is a desktop-app feature there. In the CLI it is unofficial and fragile, and it has not been tested through Paseo.
- **Nothing documented lets Claude start or send a task in the desktop app.** The options are:
  - `codex://new?prompt=…&path=…` deep links. These only fill in the composer, and the owner still has to press Send.
  - The `codex mcp-server` command, which was removed on 2026-09-05.
  - Event-triggered scheduled tasks (GitHub PR activity, Slack, Gmail). These run on web and mobile only, cannot touch local folders, and are not available in the desktop app.
  - The GitHub, Linear and Slack `@Codex` integrations. These start cloud chats, which have no access to the Mac.
- **The biggest documented saving is Codex Remote (generally available since 2026-06-25).** The owner starts a thread on the Mac mini from the ChatGPT app on the iPhone, and that thread can use the host's Computer Use, including after the Mac locks if the owner turns that on (26.519).
  - Pair it with a repo skill that reads the task from the PR. The owner then types a short trigger such as `$desktop-acceptance 285` instead of pasting a prompt.
  - Results go back to GitHub through `gh`, the same as today.
- **One experiment could remove the owner from the loop entirely:** making the Codex that Paseo already launches on the Mac mini call the Computer Use plugin. Some users report it working from the app-bundled CLI. Others report it failing from a Homebrew CLI (#19544, still open). It is untested under Paseo.
- **Linear does not add any desktop reach.** Codex in Linear only creates cloud chats.

## How Paseo launches Codex (local inspection)

- **CLI on JP-VPS.** `readlink -f $(which paseo)` resolves to `/home/operator/.local/share/paseo-runtime/0.11.1/node_modules/@getpaseo/cli/bin/paseo` (version 0.11.1).
- **Spawn command.** `codex-app-server-agent.js:5765-5783` runs `args = [...launchPrefix.args, "app-server"]` through `spawnProcess` with `stdio: ["pipe","pipe","pipe"]`. That is `codex app-server` over stdio JSON-RPC (`thread/start` at :4090, `thread/resume` at :3051). There is no `codex exec`.
- **Session store.** `CODEX_HOME` defaults to `~/.codex` (:375), the same store the desktop app and CLI use.
- **Client name.** Paseo connects with `clientInfo` name `codex_app_server_daemon` (:54-58), described in the code as a "reserved Codex name [that] is non-originating".
- **Binary override.** The binary can be replaced through the provider command config (`mode: "replace"`, `argv`), in `provider-launch-config.js:27-35`.
- **The Mac mini's daemon** (`paseo --host 10.0.0.11:6767 status` and `provider diagnostic codex`):
  - Daemon version 0.11.2, running inside `/Applications/Paseo.app`.
  - Codex is enabled and Claude is disabled.
  - The Codex binary is `~/.nvm/versions/node/v24.14.1/bin/codex`, `codex-cli 0.162.1`, an npm install rather than the copy bundled with the app.
- **Claude provider.** Paseo drives Claude through `@anthropic-ai/claude-agent-sdk` (`providers/claude/query.js:1`), which is not an interactive session.
- **Not inspected:** whether the ChatGPT desktop app or the Computer Use plugin is installed on the Mac mini. There is no SSH alias from JP-VPS, and I did not create a Paseo terminal.

## Capability table

| Capability | ChatGPT/Codex desktop app (macOS) | Codex CLI | Codex via Paseo on the Mac mini | Claude on the Mac |
|---|---|---|---|---|
| **Computer Use** (Electron window, tray, system dialogs) | Yes. macOS since 26.415 (2026-04-16), Windows since 26.527. Needs Screen Recording and Accessibility, plus per-app approval ("Always allow" is possible). Available in "supported regions"; Enterprise added 2026-06-11. | Unofficial. The Homebrew CLI fails with `Apple event error -10000: Sender process is not authenticated`, while the app-bundled `codex` works (#19544, open). The feature request is #20851, open. A 2026-07-21 comment says "the CLI alone does not include the MCP"; the app and its Computer Use plugin must be installed. | Unverified. It spawns the npm CLI under Paseo.app, which is the same failure risk. Pointing Paseo at the app-bundled binary is possible but untested. | Claude Code CLI: macOS only, Pro/Max, research preview, interactive sessions only (not `-p`). Desktop app: macOS and Windows, Pro/Max. Paseo's SDK-driven Claude probably cannot use it (inference). |
| **Mac locked** | "Locked use" is opt-in. Codex unlocks the Mac during active turns and relocks it on local input (26.519, 2026-05-21). | n/a | Unknown | Not documented |
| **Browser** | In-app browser, Chrome extension, settings at `codex://settings/browser-use` | Browser skill or MCP | Paseo browser tools (http/https only) plus skills | Claude in Chrome |
| **Scheduled tasks** | Time-based (RRULE), run locally or in a worktree. The app must be running. They run unattended with the default sandbox; read-only and workspace-write modes fail calls that "work with apps on your computer". Whether Computer Use works inside them is not documented. | No Scheduled interface | Paseo has its own `schedule` | Desktop scheduled tasks; CLI loop or cron |
| **Event triggers** (GitHub PR activity, label filters) | Web and mobile only. "They aren't available in the ChatGPT desktop app, Codex CLI, or the IDE extension", and web tasks "can't work directly in a folder on your computer". Added 2026-08-25. | No | No | n/a |
| **Cloud tasks** (`@codex` in GitHub, Linear, Slack) | Cloud chats only | `codex cloud` (experimental) | n/a | Claude Code on the web, Slack (cloud) |
| **Worktrees, plugins, skills, MCP** | Yes. Skills live in `.agents/skills`, MCP in `~/.codex/config.toml`. | Yes | Yes (same `CODEX_HOME`) | Yes |
| **Prefilled new thread** | `codex://new?prompt=…&path=<abs>&originUrl=…`: "It doesn't send the prompt automatically." | n/a | n/a | n/a |
| **Open the app from a terminal** | n/a | `codex app [PATH]` opens the app or a workspace. It takes no prompt. | n/a | n/a |
| **Shared thread store** | Uses `~/.codex`. A forum report (2026-07-19) says CLI and `codex exec` sessions appear in the app's Recents. | Same store | Same store. Whether Paseo threads (`codex_app_server_daemon`) appear in the app is unverified; `thread/list` defaults to `cli` and `vscode` sources. `paseo import <id> --provider codex` can pull an existing thread into Paseo. | n/a |
| **Phone control** | Codex Remote (GA 2026-06-25) uses the host's projects, plugins, Computer Use and browser. Setup must start in the app. Home Screen shortcuts (2026-08-26). | `codex remote-control start`/`pair` (experimental) | n/a | Remote Control (Pro/Max). Dispatch can spawn sessions that use Computer Use, but it is a limited beta "not available to new users". |
| **API for another program to send a task** | None documented. App-server is meant for your own clients. | App-server `thread/start` and `turn/start`, but in your own process | `paseo send` uses this | Channels (research preview) push webhooks or chat messages into a running interactive session. No Dispatch API. |

## Most automated realistic path for a desktop-only acceptance task

### Path 1: works today with documented features

GitHub stays the queue, a repo skill holds the procedure, and Codex Remote is the trigger.

1. **Claude** writes the task as a PR comment with a fixed marker, for example `<!-- desktop-task -->`. The comment lists the steps, the expected results and what to capture. Claude adds a label such as `needs:desktop`, and the GitHub mobile app notifies the owner. `scripts/handoff.mjs` keeps working unchanged.
2. **The repo skill** `.agents/skills/desktop-acceptance/SKILL.md` tells Codex to:
   - read the newest marked comment with `gh pr view <N> --comments`;
   - open the PR head in a worktree, then build and launch the app;
   - run each step with Computer Use;
   - post a pass/fail comment per step and remove the label.

   Repo skills are visible to the app, the CLI and the IDE extension. That remote threads see them is an inference from "uses the connected host's … plugins … and local tools".
3. **The owner** opens ChatGPT on the iPhone, goes to Codex Remote, picks the Mac mini host and the vonvon-bot project, and types `$desktop-acceptance 285`. There is no paste. The owner watches and approves on the phone.
4. **Results** go back to the PR through `gh` from the same thread. Two extras help:
   - a read-only snapshot link of the thread (macOS, 2026-08-20);
   - Appshots: pressing both Command keys sends the frontmost window to Codex, useful when the owner wants to point at something.

**Still manual:**
- the trigger message;
- the first approval for each app (can be set to "Always allow");
- any password or Touch ID dialog;
- judging subjective visuals, such as whether the tray icon looks right;
- one-time host setup: install the desktop app, grant permissions, turn on locked use, keep the Mac awake, and keep a display or session available.

### Path 2: experiment that could take the owner out of the loop

The goal is for the Codex that Paseo already runs to call the Computer Use plugin. A one-time test on the Mac mini:

1. Install the ChatGPT desktop app and turn on Computer Use.
2. Confirm that `codex plugin list` shows `computer-use@openai-bundled` in the `CODEX_HOME` that Paseo uses.
3. Ask a Paseo Codex session to list the open apps through Computer Use.
4. If it fails with `-10000`, switch the Paseo Codex command to the binary bundled with the app (`mode: "replace"`) and retry. The path was `/Applications/Codex.app/Contents/Resources/codex` before the ChatGPT merge; the current path is unknown.

If it works, desktop acceptance becomes part of the normal handoff. The risks:
- It is unsupported (#20851 is open) and could break on any app update.
- macOS permissions may attach to Paseo.app as the launching process (inference).

### Path 3: fallback

A scheduled task in the desktop app polls `needs:desktop` every 15 to 30 minutes. Only time-based triggers are supported. It needs full-access sandbox to work with apps, and Computer Use inside scheduled tasks is not documented.

### Deep link

`codex://new?path=…&prompt=%24desktop-acceptance%20285` saves the paste but still needs a click and Send. It only works on the Mac where the app and that path live.

GitHub comments will probably not make it clickable. The open-source html-pipeline sanitizer allows only `http, https, mailto, xmpp, relative, github-windows, github-mac, irc, ircs` in links (`sanitization_filter.rb:38`, fetched today); GitHub's production allowlist may differ. A clickable link would need an https redirect page. It is worth less than Path 1 from the phone.

### Linear

Codex in Linear "creates a cloud chat", which cannot reach the Mac. The Linear MCP lets a local thread read an issue. So Linear could replace the PR comment as the queue in Path 1, but it adds a second tracker without adding any desktop capability.

### Claude on the Mac mini

- **Option:** Claude Code CLI with Computer Use, run as a persistent interactive session with `--channels`. JP-VPS would push the task by webhook, and the permission relay forwards prompts to the owner.
  - It is a research preview with one Computer Use lock per machine and per-session app approvals.
  - Whether the Computer Use app-approval dialogs go through the relay is unknown.
- **Other options:** Claude Desktop Computer Use, Dispatch (only for existing beta users) or Remote Control.
- **Rule conflict:** all of these break the current rule at `/home/operator/.claude/vonvon-collaboration.md:9` ("不在 Mac 上做 Claude 推理", no Claude inference on the Mac), and the Mac's Paseo Claude provider is disabled. Using any of them is the owner's decision.

## Still unknown (needs checking on the Mac)

- Whether the ChatGPT desktop app and Computer Use are installed on the Mac mini, and whether the owner's desktop app runs on the Mac mini or the MacBook Air. Computer Use acts on the screen of the machine running the app, so the Electron app under test has to run there.
- Whether Computer Use works on a Mac mini with no display attached. The docs only mention adding an external display for a laptop with the lid closed.
- Whether Paseo-started threads show up in the app, and whether `codex://threads/<id>` opens them.
- Which ChatGPT plan the owner has, and whether their region is supported.
- Whether Computer Use works inside scheduled tasks.

## Sources

Fetched 2026-10-14. developers.openai.com now redirects with a 308 to learn.chatgpt.com.

- [Codex changelog](https://learn.chatgpt.com/codex/changelog)
- [Deep links and shortcuts](https://learn.chatgpt.com/docs/reference/commands.md)
- [CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Computer Use](https://learn.chatgpt.com/docs/computer-use.md)
- [Remote connections](https://learn.chatgpt.com/docs/remote-connections.md)
- [Scheduled tasks](https://learn.chatgpt.com/docs/automations.md)
- [App server](https://learn.chatgpt.com/docs/app-server)
- [Skills](https://learn.chatgpt.com/docs/build-skills)
- [Linear integration](https://learn.chatgpt.com/docs/third-party/linear)
- [openai/codex#19544](https://github.com/openai/codex/issues/19544)
- [openai/codex#20851](https://github.com/openai/codex/issues/20851)
- [Forum: CLI sessions in the app sidebar](https://community.openai.com/t/codex-cli-and-agent-sessions-flood-the-desktop-app-sidebar-with-no-way-to-scope-them/1387453)
- [html-pipeline sanitizer](https://raw.githubusercontent.com/gjtorikian/html-pipeline/v2.14.3/lib/html/pipeline/sanitization_filter.rb)
- [Claude Code Computer Use](https://code.claude.com/docs/en/computer-use.md)
- [Claude Code channels](https://code.claude.com/docs/en/channels.md)
- [Claude Desktop](https://code.claude.com/docs/en/desktop.md)
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control.md)
- [Dispatch](https://support.claude.com/en/articles/13947068)
- Local Paseo files: `/home/operator/.local/share/paseo-runtime/0.11.1/node_modules/@getpaseo/server/dist/server/server/agent/providers/codex-app-server-agent.js` and `.../agent/provider-launch-config.js`


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：The report holds up on most points. I re-checked 13 claims against official docs fetched 2026-10-14 (learn.chatgpt.com, code.claude.com, support.claude.com, the Linear changelog and docs), GitHub issues via `gh`, and local Paseo files and status commands. Nine are confirmed: the ChatGPT app merge, Computer Use dates, mcp-server removal, deep links not auto-sending, event triggers being web/mobile only, Codex Remote GA with host Computer Use and locked use, the Claude Computer Use/Dispatch/Channels limits, the Paseo internals and the sanitizer allowlist line.

Corrections:
- **CLI Computer Use (overstated):** the evidence is stale. #19544's Homebrew-vs-bundled split is from April. Later comments (2026-07-10, 2026-08-17) report a non-bundled CLI using Computer Use once the desktop app and plugin are installed. Path 2 (Paseo's npm codex 0.162.1, which is the current release) is more promising than the report says, but still unsupported (#20851 open) and untested under Paseo.
- **"Nothing documented" (overstated):** dots (Oct 2026) can create local Codex tasks on a connected computer and react to events or schedules. That is a candidate dispatcher the report never mentions, though GitHub event support and Computer Use inside those tasks are undocumented.
- **"Linear adds no desktop reach" (overstated):** @Codex in Linear is cloud-only, but Linear's 2026-02-26 'open in coding tool' deeplink hands an issue's full context to Codex or Claude Code with a prefilled prompt. Linear agents are not billable seats.
- **Claude Remote Control (wrong):** it is Pro, Max, Team and Enterprise, not Pro/Max only.

The most important omission: Computer Use cannot approve macOS security or privacy permission prompts or act as an administrator. The 'system dialogs' part of desktop acceptance therefore stays manual on every path.

Still unknown and needing checks on the Mac: whether the ChatGPT desktop app and Computer Use are installed on the Mac mini, whether it works headless, the owner's plan and region, whether dots are available to the owner, and Computer Use inside scheduled or dot-created tasks.


### 逐条复查

- **属实**：Since 2026-07-09 (build 26.707) the Codex app is part of the ChatGPT desktop app on macOS and Windows.
  - 依据：Codex changelog (https://learn.chatgpt.com/codex/changelog), 2026-07-09, build 26.707: "Codex is now part of the ChatGPT desktop app on macOS and Windows." Fetched 2026-10-14.
- **属实**：Computer Use: macOS since 26.415 (2026-04-16), Windows since 26.527, Enterprise added 2026-06-11; available in 'supported regions'; needs Screen Recording + Accessibility; per-app approval with 'Always allow'.
  - 依据：Changelog: 2026-04-16 build 26.415 (macOS; not in EEA/UK/CH at launch); 2026-05-29 build 26.527 "now works on Windows"; 2026-06-11 build 26.609 Enterprise outside EEA/UK/CH; 2026-06-16 "available on macOS and Windows in these regions" (EEA/UK/CH). computer-use.md: "In supported regions ... available on macOS and Windows with ChatGPT Work and Codex", Screen Recording + Accessibility, "Always allow".
- **说过头了**：Computer Use from the CLI is unofficial and fragile. Some users report it working from the app-bundled CLI and others report it failing from a Homebrew CLI (#19544, still open).
  - 依据：gh issue view 19544 -R openai/codex: OPEN, opened 2026-04-25. The failure was on Homebrew codex-cli 0.125.0, while the app-bundled 0.125.0-alpha.3 worked. A 2026-07-10 comment says a native (non-brew) CLI picked up Computer Use after it was activated in the app. In #20851 (OPEN, no maintainer reply beyond labeling), a 2026-08-17 comment reports that the standalone Codex CLI drove Finder via Computer Use with Codex.app and the plugin installed (path: Codex CLI -> codex-code-mode-host -> SkyComputerUseClient). The 2026-07-21 comment says "the CLI alone does not include the MCP".
- **属实**：The `codex mcp-server` command was removed on 2026-09-05.
  - 依据：Changelog 2026-08-24: "now deprecated"; 2026-09-05: "The `codex mcp-server` command and standalone `codex-mcp-server` binary have been removed". developer-commands.md and codex-sdk.md say the same and point to the app server.
- **属实**：`codex://new?prompt=…&path=…` deep links only fill the composer; the owner must press Send.
  - 依据：reference/commands.md (Deep links): `prompt=` "Sets the initial composer text"; `path` must be an absolute local directory; "It doesn't send the prompt automatically." `codex://threads/<thread-id>` is also documented.
- **属实**：Event-triggered scheduled tasks (Gmail, Slack, GitHub PR activity with label filters) run on web and mobile only, are not available in the desktop app, CLI or IDE, cannot work in a local folder, and were added 2026-08-25.
  - 依据：automations.md: "Event-triggered tasks are available in ChatGPT on the web and mobile. They aren't available in the ChatGPT desktop app, Codex CLI, or the IDE extension." Web tasks "can't work directly in a folder on your computer". The GitHub trigger can filter by label. Changelog 2026-08-25. The desktop sandbox rule is also confirmed: read-only and workspace-write fail calls that need "working with apps on your computer".
- **属实**：Codex Remote is generally available since 2026-06-25. A phone-started thread uses the host's Computer Use, works after the Mac locks if locked use is enabled (26.519), and setup must start in the app.
  - 依据：Changelog 2026-06-25: "Codex Remote has reached general availability"; 2026-05-21 build 26.519 locked use. remote-connections.md: "Remote access uses the connected host's projects, chats, files, credentials, permissions, plugins, Computer Use, browser setup, and local tools"; "Mobile setup starts from the app; you can't set it up from the Codex CLI or IDE extension." computer-use.md: locked use is macOS-only and installs an Apple authorization plug-in.
- **说过头了**：Nothing documented lets Claude (or any outside trigger) start a task in the desktop app.
  - 依据：No direct API exists, which is correct. But learn.chatgpt.com/docs/dots/computers-and-apps.md and tasks-and-memory.md describe dots, an always-on cloud agent (update dated 2026-10-05..09), that "can create local Work or Codex tasks and continue existing local Codex tasks" on one connected computer, and can respond to events from "a connected service [that] supports event monitoring". Availability (dots.md): Pro $100/$200/$500 outside EEA/UK/CH, Business Premium, Enterprise; "rolling out gradually".
- **说过头了**：Linear does not add any desktop reach; Codex in Linear only creates cloud chats.
  - 依据：third-party/linear.md: "Codex creates a cloud chat" (paid plans; needs a Codex cloud environment and GitHub connection), so that part is correct. However, Linear changelog 2026-02-26 "Deeplink to AI coding tools" (https://linear.app/changelog/2026-02-26-deeplink-to-ai-coding-tools): "launch your preferred coding tool directly from a Linear issue, with a prefilled prompt that includes the issue ID and all relevant context". Supported tools include Codex and Claude Code, with a customizable prompt template and Cmd+Option+. as a shortcut. Linear docs (agents-in-linear): "Agents are not counted as billable seats."
- **属实**：Claude Code CLI Computer Use is macOS only, Pro/Max, research preview, interactive only (not -p); Claude Desktop Computer Use is macOS and Windows, Pro/Max; Dispatch is limited beta 'not available to new users'; Channels are a research preview that push webhooks into a running session with a permission relay.
  - 依据：code.claude.com/docs/en/computer-use.md line 10: "research preview on macOS that requires a Pro or Max plan. It is not available on Team or Enterprise plans... not available in non-interactive mode with the `-p` flag"; one-session lock (line 101-103). desktop.md line 274: macOS and Windows, Pro/Max, research preview. support.claude.com/en/articles/13947068: "Dispatch isn't available to new users." channels.md: research preview, webhook receiver, permission relay.
- **有误**：Claude Remote Control requires Pro/Max.
  - 依据：code.claude.com/docs/en/remote-control.md line 28: "available on Pro, Max, Team, and Enterprise plans. API keys are not supported." Team and Enterprise need an Owner to enable it.
- **属实**：Paseo spawns `codex app-server` over stdio (codex-app-server-agent.js:5765-5783), uses clientInfo `codex_app_server_daemon` (:54-58), and CODEX_HOME defaults to ~/.codex (:375). The Mac mini daemon is 0.11.2 inside /Applications/Paseo.app, with Codex enabled, Claude disabled, and the npm codex-cli 0.162.1.
  - 依据：sed on /home/operator/.local/share/paseo-runtime/0.11.1/.../codex-app-server-agent.js shows the cited lines. `paseo --host 10.0.0.11:6767 status`: daemonVersion 0.11.2, daemonNode under /Applications/Paseo.app. `provider diagnostic codex`: ~/.nvm/versions/node/v24.14.1/bin/codex, codex-cli 0.162.1. `provider ls`: claude Disabled, codex Enabled. `npm view @openai/codex version` = 0.162.1, so it is current as of 2026-10-14. The CLI docs label `codex app-server` (and `remote-control`, `cloud`) "experimental" and say app-server "may change without notice".

### 正文遗漏的事实

- Computer Use cannot accept system security prompts. computer-use.md: it "can't automate terminal apps or ChatGPT itself" and "can't authenticate as an administrator or approve security and privacy permission prompts on your computer." The owner wants 'system dialogs' covered, so macOS TCC, login-item and Accessibility prompts for Vonvon stay manual on every path. This is bigger than the 'password or Touch ID' item the report lists.
- Dots (learn.chatgpt.com/docs/dots*.md, rolled out Oct 2026): an always-on cloud agent reachable from ChatGPT, Slack, Teams or a call. It can connect one personal computer and create or continue local Codex tasks there, and it supports event monitoring and recurring tasks. Plans: Pro $100/$200/$500 outside EEA/UK/CH, Business Premium, Enterprise. This is the closest documented thing to an inbound dispatcher into the Mac's desktop Codex. Unknown: support for GitHub events, and Computer Use inside dot-created local tasks.
- Linear's 2026-02-26 'Deeplink to AI coding tools' opens Codex or Claude Code from an issue with a templated prompt that carries the issue context. Linear also documents that agents are not billable seats. Both bear directly on the owner's Linear question.
- remote-connections.md: a Mac can control another host through Settings > Connections > Control other devices. The owner could therefore trigger the Mac mini from the MacBook Air desktop app, not only from the iPhone, with 'thread handoff between local and remote hosts' (changelog 2026-06-18, 26.616).
- The CLI docs label `codex app-server`, `codex remote-control` and `codex cloud` 'experimental'. The app-server is 'primarily for development and debugging and may change without notice', which is a stability risk for Paseo itself.
- GPT-5.5 retires from ChatGPT, Work and Codex on all plans on 2026-10-14, today (automations.md). Any scheduled task or Paseo default still pinned to GPT-5.5 needs a replacement such as gpt-6-sol.
- Skill invocation differs by surface. build-skills.md: in ChatGPT you type `@` to pick a skill, while `$` is used in Codex CLI and the IDE; scheduled tasks in the desktop app accept `$skill-name`. Whether `$desktop-acceptance 285` typed in Codex Remote on the iPhone resolves the repo skill is undocumented.
- Codex GitHub Action (github-action.md) runs `codex exec` on Linux or macOS runners with an OpenAI API key. A self-hosted macOS runner on the Mac mini is another label-triggered path, but it uses API billing and API-key mode has 'No cloud-based features'. Computer Use there is untested.
- Claude Code CLI and Desktop Computer Use, and Dispatch, are not available on Team or Enterprise plans (computer-use.md line 10, desktop.md lines 274 and 451).
