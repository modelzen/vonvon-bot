# 定时任务调研：内置 skill 交付实测（代码笔记）

2026-10-30 离线探测：Codex 0.156.1、0.163.0、0.166.0 的 `selectedCapabilityRoots`，Claude Agent SDK 0.3.296 的 `plugins`；隔离 HOME、假模型服务、没登录。基线 `e87a49c4`。计划见 `docs/plans/scheduled-tasks.md`。原文英文。

# Built-in "任务" skill: delivery to Codex and Claude, implementation notes

**Scope.** Everything below was read in the worktree `<worktree>` at `e87a49c4`. `D` means `packages/daemon/src` and `HM` means `D/bot/handle-message.ts`.

**How the provider facts were checked.** I ran offline probes with an isolated `HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, a fake model server, no login and no paid calls. The temp dir was made with `mktemp -d` and removed with `rm -rf -- "${T:?}"`.

- **Codex:** `@openai/codex` 0.156.1 (the managed install pin), plus 0.163.0 and 0.166.0 (npm latest on 2026-10-30). I used `app-server` with a fake Responses API provider.
- **Claude:** Agent SDK 0.3.296 / Claude Code 2.1.296, the repo pin, loaded from `<accept-worktree>/packages/daemon/node_modules`, with `ANTHROPIC_BASE_URL` pointing at a fake Messages API.

Anything I did not run is marked UNVERIFIED.

---

## 0. Verified facts that drive the design

### Codex (same results on 0.156.1, 0.163.0 and 0.166.0)

**1. Package shape and naming.** `thread/start.selectedCapabilityRoots` works on the minimum version 0.156.1. This answers the skill half of product.md §9 item 21; MCP inside the package was not tested.
- The shape is `{id, location:{type:'environment', environmentId:'local', path:<absolute>}}`.
- It points at a plugin-shaped directory: `.claude-plugin/plugin.json` with `{"name":"vonvon"}` plus `skills/<dir>/SKILL.md`. A `.codex-plugin/plugin.json` manifest also works.
- The skill is listed as `vonvon:<skill>` in its own developer block, `### Skill roots` with `e0 = skill://<id>/<path>`, as an "executor package". Only the description is listed; the body is not in the prompt.
- The model reads the body through the built-in namespace tool `skills.read`. The fake server sent `{type:'function_call', name:'read', namespace:'skills', arguments:'{"package":"e0/skills/<dir>"}'}` and got back the full `SKILL.md`.
- Two roots in one thread both work (`e0`, `e1`).

**2. Discovery is sandboxed.** This is the most important new finding.
- Under vonvon's real restricted permission profile (`default_permissions:'feishu'`, `filesystem {':minimal':'read', ':workspace_roots':{'.':'read'}, <ws>:{'.':'read'}}`), the skill disappears from the prompt. `skills.read` then returns `"skill package is not available"`.
- Adding `[<pkgPath>]: {'.':'read'}` to `permissions.feishu.filesystem` fixes it.
- So in the read-only and workspace-write tiers, the package must get an explicit read entry, on both start and resume.
- In full access (`danger-full-access`) and with the legacy read-only sandbox, no entry is needed.

**3. Capability-root skills cannot be disabled per session.** I tried `config.skills.config` by `path` (the absolute `SKILL.md` path), by `name:'vonvon:schedule'` and by `name:'schedule'`; all three leave it listed. The control case works: the same mechanism hides a user skill. `skills.bundled.enabled:false` hides only system skills.

**4. `skills/list` cannot show what a thread got.**
- Params are only `{cwds, forceReload}` (0.156.1 and 0.163.0), and it never lists capability-root skills.
- The `thread/start` response does not echo the roots.
- A nonexistent path or a bogus `environmentId` is silently accepted and the skill is simply absent. A relative path is rejected: `path 'pkg' is not absolute`.
- The only trace I found is internal: line 0 of the rollout (`session_meta.payload.selected_capability_roots`, path stored as `file://…`). The rollout is written lazily, after the first turn.

**5. Resume behaviour.**
- A new-process `thread/resume` without the field keeps the package and re-reads its contents (a changed description showed up).
- `thread/resume` carrying `selectedCapabilityRoots` is accepted but ignored. So a thread started without a package can never get one by resume.
- `dynamicTools` is also on `thread/start` only, not on `ThreadResumeParams` or `ThreadSettingsUpdateParams`.

**6. Fallback for old threads.** Calling `skills/extraRoots/set {extraRoots:[<pkg>/skills]}` on the thread's own process, before or after resume, makes the next turn list `vonvon:schedule`. It is qualified by the manifest, but shown as a `file:` entry, so the model reads it through the shell and the read entry is needed. vonvon runs one app-server process per thread (`D/agent/codex-appserver/backend.ts:997-1020`, `1023-1049`), so process-level is in effect per thread.

### Claude (SDK 0.3.296 / Claude Code 2.1.296)

**7. Naming and loading.**
- `plugins:[{type:'local', path}]` loads the plugin as `{"name":"vonvon","source":"vonvon@inline"}`.
- The skill appears as `vonvon:schedule` in `init.skills`, in `supportedCommands()` and in `initializationResult().commands` (`sdk.d.ts:2994`).
- It is listed in the first user message's `<\system-reminder>` ("The following skills are available for use with the Skill tool: - vonvon:schedule: <description>"); the body is not listed.
- The `Skill` tool returns "Launching skill…" followed by "Base directory for this skill: <pkg>/skills/<dir>" and the body.
- `SdkPluginConfig.skipMcpDiscovery?: boolean` exists (`sdk.d.ts:5650-5664`).

**8. The SDK `skills` whitelist hides plugin skills.** With `skills:['cwsk']` the built-in is not listed and the `Skill` call fails with "Skill vonvon:schedule is not in this session's skills allowlist". With `['cwsk','vonvon:schedule']` both are listed.

**9. `enabledPlugins` (product.md §9 item 22, answered).**
- A workspace `.claude/settings.json` with `{"enabledPlugins":{"vonvon@inline":false}}` removes the plugin. The user's `~/.claude/settings.json` does too.
- SDK `settings:{enabledPlugins:{'vonvon@inline':true}}` (the flag layer) restores it in both cases.
- `.claude/settings.local.json` with `false` had no effect under `settingSources ['user','project']`.

**10. Skill overrides.** A workspace `skillOverrides {"vonvon:schedule":"off"}` did not hide it. A flag `settings.skillOverrides {loop:'off'}` does hide the bundled `loop` skill.

**11. Read and write isolation.**
- With the package in the sandbox `denyRead`, the `Skill` tool still loads the body (the CLI reads it itself), while sandboxed Bash cannot read it.
- On Linux bwrap, sandboxed Bash cannot write the plugin dir ("Read-only file system") on 2.1.296. The 2.1.299 fix concerns this; macOS Seatbelt is UNVERIFIED.

**12. Native scheduling tools (input for item 14).** The default tool list included `CronCreate`, `CronDelete`, `CronList` and `ScheduleWakeup`. `RemoteTrigger` was absent with a fake API key; with a real claude.ai login it is UNVERIFIED, as is a bundled `schedule` skill.

---

## 1. What the plans decided, and what is done

### Decided

**Plan entries:**
- `docs/v1-plan.md:1293` s39 is the umbrella: capability packages are plugin-shaped directories under `bots/<appId>/` that sessions cannot write. Codex gets them through `selectedCapabilityRoots`, Claude through `plugins`, with Claude raised to ≥2.1.299. The bot directory is never a root.
- `:1296` s39d: generate the one plugin-shaped package, deliver it natively, check names and the `enabledPlugins` override, versions, SDK, catalog and lock; keep the restore/re-read behaviour.
- `:1382-1387` is the owner's decision (2026-10-16, 1A):
  - layout: `.claude-plugin/plugin.json`, read by Codex too, plus `skills/` and `.mcp.json`;
  - exact location: to be decided by s39;
  - verification: `skills/list` and `mcpServerStatus/list {threadId}`. My probes show `skills/list` cannot do this (fact 4);
  - Claude: bump the SDK to ≥0.3.299, editing `D/agent/catalog.ts:31` and `packages/daemon/package.json`;
  - test `"<名>@inline": false` (now answered, fact 9).
- `:1420` s44a: base isolation and the built-in package boundary.
- `:1421` s44b: list composition, which extends the same generator.
- `:1436` s44a/b, s48 and s54a share s39's single package generator. s54a owns the settings skill and its DM/switch filter; s48 owns the Feishu skill content. "不另建 profile 或打包器" (do not build a separate profile or packager).
- `:1438` "s48：飞书 skill 的 SKILL.md 随 daemon 包发，每个会话都装" (the Feishu skill's SKILL.md ships with the daemon package and is installed in every session).
- `:1427` s48 and `:1467` s54a ("内置设置 skill 只交授权 DM", the built-in settings skill goes only to authorised DMs).

**Product spec (`docs/product.md`):**
- `:476` two built-in vonvon skills: the Feishu skill is preinstalled in every session; the settings skill only in DMs, and not at all when "聊天改设置" (chat changes settings) is off.
- `:480-481` package generated from the effective list, under `bots/<appId>/`, never as a root.
- `:490` the delivery table.
- `:495` verify on our side; experimental-field failures are errors, with no silent fallback.
- `:500-502` the package runs outside the sandbox; the 2.1.296 hole; the `enabledPlugins` risk.
- `:512` list changes take effect at the next session or after the process restarts and resumes.

### Done vs not done

- **Done:** s37 (#457: profile with `capabilityPackages` and `mcpServers` fields that throw); s39a (#470: Codex multi-root); s46 (#464: Claude in-process MCP `vonvon_bot`); s46c; s47 (#469).
- **Not done:** s39, s39c (Claude multi-root and the SDK bump; the pin is still 0.3.296 / 2.1.296), s39d (no package generator exists), s39b, s44a/b, s46b (Codex has no tool channel), s48, s54a, s49 (DM work; no `p2p` place is issued anywhere in HM today).
- **Built outside the s-series (b967e981, 2026-10-23):** a per-group skill disable list, `project.skills.disabledPaths`, used by the group 能力 (capabilities) tab.

---

## 2. Today's plumbing (exact anchors)

**`D/agent/session-profile.ts`**
- `SessionProfile` (lines 4-15) has `skills?`, `capabilityPackages: {path}[]` and `mcpServers`.
- `SessionProfileCapabilities` (17-28) declares `capabilityPackages: false` and `mcpServers: false`.
- `resolveSessionProfile` (30-45) throws `额外根、能力包和 MCP profile 交付尚未支持（s39）` ("extra roots, capability packages and MCP profile delivery not yet supported") when either list is non-empty (31-33). It always returns `capabilityPackages: []` (41).

**`D/agent/group-skills.ts`**
- `discoverLocalGroupSkills` (9-79): an offline scan. Claude selectors are `claude:<name>`; Codex selectors are realpaths, and it honours `config.toml` `skills.config` disables.
- `discoverGroupSkills` (82-89) calls `backend.listSkills`.
- `groupSkillProfile` (92-99): returns `undefined` when nothing is disabled. Codex gets `{disabledPaths}`. Claude gets `{disabledPaths, enabledNames}`, a whitelist built from discovery. That discovery does not pass plugins, so any built-in would be dropped from the whitelist (fact 8).

**Codex backend (`D/agent/codex-appserver/backend.ts`)**
- `codexSessionParams` (78-104) is shared by start and resume. Its skills config is at :101 (`skills.config` = disabledPaths, `enabled:false`).
- The filesystem profile comes from `codexFilesystem` (`D/agent/codex-appserver/workspace-policy.ts:119-136`, `':minimal':'read'`).
- `profileCapabilities` (757-763) declares `capabilityPackages:false, mcpServers:false`.
- `listSkills` (772-779) calls `skills/list {cwds:[cwd], forceReload:true}` through `utilityRequest` and will never show capability-root skills.
- `startThread` (997-1020): `thread/start` then `verifyCodexWorkspaceEcho`.
- `resumeThread` (1023-1049): `thread/resume {threadId, ...params}`.
- The protocol generated in the repo (`D/agent/codex-appserver/protocol/generated`, 2026-10-10) already has `SkillsListParams`. Regenerate with `generate-ts --experimental` to get `SelectedCapabilityRoot`, `CapabilityRootLocation` and `DynamicToolSpec`; all of these are present in 0.156.1.

**Claude backend (`D/agent/claude-agent/backend.ts`)**
- `BRIDGE_SETTING_SOURCES=['user','project']` at :68.
- `helperQueryOptions` (112-131): `skills:[]`, no plugins.
- `profileCapabilities` (332-338).
- `listSkills` (446-458): a helper query with `skills:'all'` and no `plugins`, filtering out builtins from `supportedCommands()`; selector `claude:<name>`, source `provider`.
- `startThread` (647-674) and `resumeThread` (676-706) pass `skills` only when `enabledNames` is set (667, 698).

**Claude thread (`D/agent/claude-agent/thread.ts`)**
- `ClaudeThreadConfig` (25-60).
- In-process MCP `vonvon_bot` (327-343).
- The `options` object (345-372): `skills` at :357, `settings` = `AUTO_COMPACT_SETTINGS` (defined at :87) or the plan variant at :360-361, `mcpServers` at :362.
- No init or plugin verification exists anywhere.

**Read scope and tiers**
- `D/config/read-scope.ts:9-19`: denies `bots/`, `projects/`, `library/` and root secrets. Line 16 allows only `bots/<appId>/skills`.
- Built in `turnPerm` (HM:2990-2994). Codex restricted tiers make the data root unreadable through `:minimal`.

**Session creation (HM)**
- `profileOf` (HM:1114-1124): returns `undefined` unless the opening was assembled or group skills exist (`:1120`).
- `executionSessionProfile` (`D/config/execution.ts:217-254`) already carries `capabilityPackages` through.
- Every start and resume goes through `createWithPermission` (HM:1339-1363). It issues the grant at `entries?.issue(place)` (`:1347`) right before `create`. `startWith` is at `:1368`, `resumeWith` at `:1375`.

**Grants and tools (`D/agent/entry/registry.ts`)**
- `AgentPlace` at :6 is `{kind:'group'|'p2p'|'doc'}`.
- Tools are filtered by place at :294: read for all; memory unless doc; settings only p2p.
- Tool naming follows `<area>_<verb>` (`D/agent/entry/command-tools.ts`, `memory-tools.ts`).

**Settings and UI**
- Settings view: `D/admin/settings.ts:696-704`. It is offline (`discoverLocalGroupSkills`) or online (`discoverGroupSkills`).
- Patch: `:914`. Parse: `D/admin/settings-parse.ts:112`.
- Protocol: `packages/protocol/src/settings.ts:111` (`skills.disabledPaths`) and `:333` (skill row, `source: workspace|user|provider`).
- UI: `packages/ui/src/settings/GroupDesignSettings.tsx`, 能力 tab at 117-123 and `SkillsList` at 227-249 (source labels 本群工作区 / 用户目录 / Provider).

**Paths and atomic writes**
- `D/config/paths.ts:19-21` (`botDir`) and `33-58` (`botPaths`); no capabilities path yet.
- `D/server/atomic-file.ts:7` `writeFileAtomic` (dirs 0700, files 0600).

**Precedents for native probes and live tests**
- `packages/daemon/scripts/probe-codex-linux.py`: a manual probe with a fake model server.
- `packages/daemon/test/session-profile.live.test.ts`, gated by `SESSION_PROFILE_LIVE=1` with an isolated home.

---

## 3. Proposed delivery (complete and reusable by s48 and s54a)

### 3.1 Content source, shipped with the daemon

**New directory `D/agent/builtin-skills/`.**
- `registry.ts`:
  - `interface BuiltinSkill { name: string; title: string /*UI: 任务*/; description: string; body: string; tools: readonly string[] /*tool names that must be in the grant*/ }`
  - `BUILTIN_SKILLS`: s48 adds the Feishu skill, s54a the settings skill.
  - `builtinSkillsFor(toolNames: ReadonlySet<string>)` returns the skills whose `tools` are all present.
  - Rule: **skill present if and only if its tools are in the grant.** Place, DM switch and role filtering then come for free from `registry.ts:294`-style tool filtering. That is exactly how s54a's "DM only, off when the switch is off" should behave.
- `scheduled-tasks.ts`: the content as a TS constant. This matches the repo practice (`bridge-instructions.ts`) and avoids adding a `.md` loader to tsup and vitest.

**Skill name: `scheduled-tasks`**, qualified as `vonvon:scheduled-tasks`. The UI title is "任务".
- Agent Skills names must be `[a-z0-9-]`, ≤64 characters, and match the directory name, so "任务" cannot be the name.
- Avoid `tasks`, which collides conceptually with Claude's TaskCreate/TaskList todo tools.
- Avoid bare `schedule`, which is close to Claude's bundled `loop` skill (recurring prompts) and a possible claude.ai `schedule` skill (UNVERIFIED).

**Frontmatter: only `name` and `description`.**
- No `allowed-tools`: plugin skills delivered through `--plugin-dir` keep their `allowed-tools`, per the `sdk.d.ts` note near :7359.
- No `hooks`, no `disable-model-invocation`, no `` !`cmd` `` in the body. This matches the AGENTS.md skill-review checklist.
- Keep the description to about 300 characters or less. Claude did not truncate a 1447-character line on 2.1.296, but the Agent Skills spec caps it at 1024.

Description draft:

> 定时任务和稍后跟进：用户要你定时或周期性做事（每隔 N 分钟/小时、每天/每周几点、某个时刻一次）、要你过一会儿提醒或回来跟进，或要查看、修改、暂停、删除本群的定时任务时使用；你自己答应"稍后再看"时也用它给自己建一次性任务。只用 vonvon 的任务工具，不用 Claude/Codex 自带的定时、cron 或自动化功能。

(English gist: use it for timed or recurring jobs, reminders and follow-ups, and for viewing, editing, pausing or deleting this group's tasks; also when the bot promises to check back later; use only vonvon's task tools, never the providers' own scheduling.)

**Body outline, one file.**
1. When to use it and when not (versus memory and versus native cron).
2. The tools, by bare name, for example `task_list` and `task_create`. Note that they may appear with a provider prefix (`mcp__vonvon_bot__…`, or a Codex namespace or deferred tool), and say to search for them with `tool_search` / ToolSearch if they are not visible.
3. Who may do what: owner/admin edit all tasks of this group and bot; a member edits only their own; an unattended run may only reschedule or finish its own task and cannot create. On refusal, explain; do not retry.
4. Time: local timezone, stored as IANA; minimum 1 minute; always confirm back with an absolute date and time plus the next run.
5. Writing a self-contained instruction, since no one is present at run time. Include where results go and the "开个话题发" (post in a new topic) option.
6. One-off follow-ups for itself.
7. Behaviour inside a scheduled run: nobody is present, do not ask.
8. Reply format after create or edit.

**Keep it to one file.** Codex reads extra files through `skills.read` resources, but Claude's `Read` of extra files would hit the `bots/` deny in `read-scope.ts` unless allowed. Add a unit test that every tool name in the body exists in the task tool registry, and the reverse.

### 3.2 Materialisation: per bot, written only by the bot child process

**Generator.** `D/agent/builtin-skills/package.ts` exports `ensureBuiltinPackage({appId, slot, skills})`, which returns `{id:'vonvon-builtin', path, plugin:'vonvon', names:['vonvon:scheduled-tasks',…]}`.

**Path:** `bots/<appId>/capabilities/builtin/<slot>/`. Validate `appId` with `SafeAppIdSchema` (as in `read-scope.ts:16`). Add `capabilitiesDir` to `botPaths`.

**Slot.** A stable semantic key, for example `group`, `p2p-admin`, `p2p-member`. It should not be a content hash: Codex resumes re-read the stored path (fact 5), so regenerating a stable per-slot path is what makes "恢复以后生效" (takes effect after resume, product §3.6/§3.7) true.

**Tree:**
```
.claude-plugin/plugin.json   {"name":"vonvon","version":"<daemon version>","description":"Vonvon Bot 内置能力"}
skills/scheduled-tasks/SKILL.md
```
There is no `.mcp.json`; tools come through the SDK MCP server and Codex dynamic tools.

**Run it on every start and resume** (cheap, and it heals the package):
- Rewrite any file whose content differs, using `writeFileAtomic`.
- Walk the tree with `lstat`. Delete anything not in the manifest (a stray `.mcp.json`, `hooks/`, `agents/`, `commands/`) and any symlink.
- Create the slot dir 0700 if it is missing.
- Serialise per path inside the process.

**Why integrity matters.** A full-access group's session can write `bots/<appId>/`. A planted `hooks/` or `.mcp.json` would then run outside the sandbox in the same bot's restricted-tier sessions. Residual risk: a race with a concurrent full-access session remains; document it as accepted for the full-access tier.

**Why it is never writable in restricted tiers.**
- Codex `:minimal` plus the read-only entry.
- Claude: not in `allowWrite`, and `decide()` refuses writes outside the workspace.

### 3.3 Wiring: one choke point

**In `createWithPermission` (HM:1339)**, after `const entry = entries?.issue(place)` (`:1347`):
1. `names = new Set(entry.tools().map(t => t.name))`.
2. `skills = builtinSkillsFor(names)`.
3. If non-empty, `pkg = await ensureBuiltinPackage(...)`.
4. Set `opts.profile = withPackage(opts.profile, pkg)`.

The profile must exist even when `profileOf` returned `undefined` (HM:1120). Doc places get no task tools, so no package.

**`D/agent/session-profile.ts`**
- Extend `capabilityPackages` to `{id, path, plugin, skills:string[]}`.
- Allow it when the backend declares `capabilityPackages:true`.
- Keep throwing for `mcpServers` until s44b.
- Both backends set `capabilityPackages:true` at Codex :758 and Claude :332.

**Codex adapter**
- In `codexSessionParams`, add `selectedCapabilityRoots` on start only. Strip it on resume; it is ignored there anyway (fact 5).
- Pass `extraRead: profile.capabilityPackages.map(p => p.path)` into `codexFilesystem` and emit `{[path]:{'.':'read'}}` for qa/write, on both start and resume (fact 2). Windows MXC is UNVERIFIED.
- Pre-flight: `stat` the path, because a missing path is silently ignored (fact 4).
- Never put built-in paths into `skills.config` (it would not work anyway, fact 3).
- Record `capabilityRoots: [path]` (plus a tools marker) on the SessionRecord at start.
- Verification is best-effort: after the first turn, read line 0 of `thread.path` and compare `session_meta.payload.selected_capability_roots` (internal format, 0.156.1). On mismatch, use `log.fail` and diagnostics.
- **Old threads** (recorded without roots), choose one:
  - (a) Leave as is: the skill appears after `/new`.
  - (b) Call `skills/extraRoots/set {extraRoots:[<pkg>/skills]}` on the thread's own client after resume (fact 6). The read entry is still needed.
  - Decide this together with the tools channel. Dynamic tools also cannot be added on resume, and a skill without its tools is useless.

**Claude adapter**
- Add `plugins?: SdkPluginConfig[]` to `ClaudeThreadConfig` and pass `[{type:'local', path, skipMcpDiscovery:true}]` from both `startThread` and `resumeThread`.
- Merge into `settings` at `thread.ts:360-361`:
  - `enabledPlugins: {'vonvon@inline': true}` (fact 9);
  - `skillOverrides: {loop:'off'}` (fact 10; item 14; also `schedule:'off'` if that bundled skill exists, UNVERIFIED).
- When `profile.skills.enabledNames` exists, append the package's qualified names, in `group-skills.ts:98` or the backend (fact 8).
- Verify right after `cfg.query(...)` (`thread.ts:373`): `void query.initializationResult()` and check that `commands` contains each `vonvon:<name>`. Alternatively check that the init message `plugins` contains `source:'vonvon@inline'` and that `plugin_errors` is absent. On failure, log and record a diagnostic; do not block the turn.
- The SDK bump to ≥0.3.299 stays in s39c. Product.md:501 allows the alternative "保证会话写不到能力包" (guarantee sessions cannot write the package), which holds here (fact 11, Linux). Put a macOS Seatbelt check on the Mac task.

**Group disable list**
- Built-ins are not toggleable per group. Codex physically cannot filter them (fact 3); the skill follows the tools; and product.md:476 defines built-ins by location.
- `settings-parse.ts:112` and the patch at `D/admin/settings.ts:914` should reject or strip built-in selectors (`claude:vonvon:*`, any path under `capabilities/builtin`).
- If the owner wants tasks off for a group, that is a tasks feature switch that removes the tools and the skill together. It is not in the settled design (open question).

### 3.4 Group 能力 (capabilities) tab and Bot page

**Protocol (`packages/protocol/src/settings.ts:333`):** add `source:'builtin'`, plus an optional `title`.

**Daemon view (`D/admin/settings.ts:696-704`, online and offline):**
- Prepend rows from `builtinSkillsFor(<tool names for place 'group'>)`: `{path:'builtin:scheduled-tasks', name:'vonvon:scheduled-tasks', title:'任务', description, source:'builtin', enabled:true}`.
- Drop any provider row named `vonvon:*`.
- The Codex `listSkills` never returns these, and neither does the Claude helper, since it passes no plugins.

**UI (`GroupDesignSettings.tsx:227-249`):**
- Sort builtin first.
- Source label "Vonvon 内置" (built into Vonvon).
- Toggle shown on and disabled, with the tooltip "内置技能，随任务工具提供，不能在群里关闭" (built-in skill, comes with the task tools, cannot be turned off per group).
- The detail dialog shows "随 Vonvon 提供" (ships with Vonvon) instead of the internal path.
- `enabledCount` includes it.

**Bot page:** no Bot-level skill page (product.md:116 note). The Bot page only gets the tasks aggregate, which is another area.

### 3.5 Tests

**Offline unit tests (vitest).** Use `HOME=$T/home VONVON_HOME=$T/vh` on the single command.
- **Registry:** name regex and directory match; description ≤1024 and single line; frontmatter keys are exactly `{name, description}`; no `` !` ``; tool names cross-checked against the registry.
- **`ensureBuiltinPackage`:** exact tree and modes; idempotent; repairs an edited `SKILL.md`; removes an injected `.mcp.json` and `hooks/`; replaces a symlinked dir or file; rejects a bad `appId`.
- **`codexSessionParams`:** start has `selectedCapabilityRoots` (absolute path); resume does not; the qa/write filesystem has the read entry; full is unchanged; `skills.config` never contains built-ins.
- **Claude thread** (injected `query` capture, as in existing tests): `plugins` on start and resume with `skipMcpDiscovery`; `settings.enabledPlugins['vonvon@inline'] === true`; `skillOverrides.loop === 'off'`; the whitelist includes built-ins when present.
- **`resolveSessionProfile`:** accepts packages and still throws for `mcpServers`.
- **`createWithPermission`:** package present if and only if the grant has the task tools; doc gets none.
- **Settings view:** has the builtin row; a disable patch is refused.

**Native offline probe** (manual or Mac task, no login), modelled on `scripts/probe-codex-linux.py`.
- **Codex:** fake `/v1/responses` with `-c model_providers.fake={…wire_api="responses",env_key=…}`. Assert:
  - turn 1 lists `vonvon:scheduled-tasks` and does not contain the body;
  - a namespace call `skills.read` returns the body under the profile actually built by `codexSessionParams` for qa/write;
  - a new-process resume still lists it.
- **Claude:** fake `/v1/messages` (SSE), with `ANTHROPIC_API_KEY` fake and `ANTHROPIC_BASE_URL`. Assert:
  - `init.plugins` has `vonvon@inline`;
  - the listing contains the skill without the body;
  - a `Skill` tool_use returns the body;
  - it still loads with a workspace `.claude/settings.json` setting `false`.

**Live test** (authenticated, gated like `session-profile.live.test.ts`): a real Codex and a real Claude session in each tier. Ask "每天早上9点提醒大家站会" (every day at 9am remind everyone of stand-up) and expect a skill read (Codex `skills.read`, Claude `Skill vonvon:scheduled-tasks`) followed by the create-tool call. On Mac, check that qa/write still lists the skill and that Bash cannot write the package.

### 3.6 Open questions, UNVERIFIED items and deviations to record

- **Two-package layout (a deviation).** I recommend the built-ins as their own plugin `vonvon` (reserved namespace, cannot collide with bot skills). s44b would then add a second root or plugin for bot and library skills. This departs from the "唯一能力包" (single package) wording at v1-plan `:1296`. It is a technical choice; record it under "和计划不一样的地方" (differences from the plan). Two roots and two plugins both work (fact 1; for Claude, multiple plugins are supported by the API, but I did not test two together).
- **DMs (s49):** whether `p2p` sessions get task tools, and so the skill, is a product decision. Today no `p2p` place exists.
- **Codex threads that predate the feature:** extraRoots fallback or `/new`. Decide this together with the tools plan.
- **UNVERIFIED:**
  - Windows MXC and capability discovery or the read entry;
  - macOS Seatbelt for both providers;
  - Claude 2.1.296 plugin-dir write on macOS;
  - a claude.ai-login bundled `schedule` skill and `RemoteTrigger`;
  - whether Codex's system skill `openai-docs`, whose description mentions "scheduled tasks…automations", competes with ours (could be hidden with `skills.bundled.enabled:false`, which also hides imagegen and others);
  - MCP inside the package under `approvalPolicy:never` (not needed for this design);
  - the research claim that `skills/list` "列得出" (can list) package skills — not reproduced on 0.156.1 or 0.163.0.
