# Rakazo reuse engineering — source inspection, not runtime verification

Rakazo pin: `e55263f5fdfee9b2c48680a78e4487d37b4c04a8`; Vonvon baseline: `bbb329b9a9eef0dd809ee9468e0b6d1b9bf4a769`. All recommendations below are proposals. No dependency install, upstream script, service, provider, live Feishu, GUI or test was run. No code was ported.

## Main judgment

The highest-return reuse is its **failure-scenario vocabulary and small boundary utilities**, not its runtime or web-chat architecture. Vonvon already has a pure event reducer, real JSON-RPC transport fixtures, guarded settings patches, and a substantially more specific Feishu question lifecycle. Replacing these with Rakazo would discard useful domain constraints. The best near-term work attaches to M6/s33–35 and M7/s38–41, without adding features to the finalized v1 scope.

Ranked recommendations:

1. **M6/s33–35: adapt deterministic protocol scenarios and explicit fixture-completion assertions.** Exercise the real native transport, coordinator, reducer and fake card sink together. Extend existing fixtures; do not create a parallel runtime or import Pi.
2. **M7/s38–40: adapt bounded, no-follow file reads to the planned memory boundary.** Rakazo supplies a short concrete example, but Vonvon's required hardlink rejection, quarantine and concurrent-edit reconciliation exceed it.
3. **M6/s33: adapt answer-label presentation, preserve authoritative request identity and FIFO ownership.** Never select a question by scanning for the newest visible ask across runs.
4. **M7/s41: preserve small field-level settings edits and dirty drafts.** Existing Vonvon revision-bearing patches are a stronger foundation than Rakazo's profile helper; borrow regression scenarios, not another patch API.
5. **Only when a concrete cancellation caller is changed: direct leaf extraction of `abortableDelay`.** Its semantics must be explicit: abort resolves the delay; it does not throw or itself prevent subsequent work.
6. **v1-after only: HTML artifact preview and remote-instance setup.** The preview sandbox is a useful reference; the connector marketplace, hosted artifact store and Docker local stack are not v1 dependencies.

## Components and actual flows

Rakazo's runtime emits progress/tool/ask/subagent events. `packages/core/src/events.ts` projects them into `MessageBlock`/`ThreadMessage`; `apps/web/src/lib/thread-events.ts` combines these with run/computer snapshots. `thread-subscription.ts` acquires a cursor, retries head/snapshot loads, buffers events until the snapshot is ready, reconnects on stream EOF/error/45-second inactivity, and ignores heartbeat frames for cursor advancement. These are durable web-thread semantics, not Feishu card-push semantics. See [core projection and progress reducer](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/events.ts#L243), [web imports and snapshot model](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/web/src/lib/thread-events.ts#L1), [subscription lifecycle](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/thread-subscription.ts#L10).

Vonvon already folds normalized `AgentEvent` into `RunState` in `packages/daemon/src/card/run-state.ts:145`, then uses a coalescing card pump with shared per-chat pacing and monotonically increasing Feishu sequences in `packages/daemon/src/card/run-card-stream.ts:24–115`. Its event identity is native thread/turn/item, not Rakazo's database event sequence and synthetic `progress:<runId>` message. Preserve this separation.

Rakazo's scripted runtime emits tool and question events from explicit scripts (`packages/adapters/src/scripted-runtime.ts:25–127`), while its model emulator keeps the real Pi HTTP/SSE transport and replaces the remote model with a loopback server. `expect` checks request structure before returning fragments, disconnects, held streams or errors; `assertComplete()` catches swallowed fixture failures and unconsumed steps. See [emulator contract](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/testkit/src/model-emulator.ts#L18), [completion and connection cleanup](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/testkit/src/model-emulator.ts#L148). This tests runtime handling, not whether a model chooses a correct action.

Vonvon already exercises real transport with a fake executable in `packages/daemon/test/turn-stream-isolation.test.ts:10–63`: host, child, stale and pre-response notifications are intentionally interleaved. `:88–114` asserts isolation and rejected-start cleanup. Thus the proposed improvement is reusable scenario assertions and composed boundary coverage, not claiming Vonvon lacks offline tests.

## Module reuse ledger

### 1. `packages/core/src/async.ts:1–15` — DIRECT leaf candidate, opportunistic

[Source](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/async.ts#L1). Zero imports, uses timers and AbortSignal only. Clears the timer and removes its listener on completion/abort; checks an already-aborted signal before and after listener registration. Relevant to avoiding delayed shutdown while a retry waits.

Do not add a package dependency: `@rakazo/core/package.json:52–62` also depends on plotting, cron, markdown and contracts packages. Extract this one file with provenance only if a real browser/shared polling caller needs it. On Node-only paths first consider existing Node timers with explicit abort handling. Do not blindly replace `ChatPacer.wait` (`run-card-stream.ts:44`): cancelling a reserved pacing slot and discarding a terminal-card retry are separate domain decisions. No current bug is established.

Isolation checks: abort before entry; abort during delay; normal timeout; repeated abort; no retained timer/listener; caller does no further work after resolved cancellation. Existing upstream `async.test.ts:8–21` covers only the first two.

### 2. `packages/core/src/events.ts`, `thread-subscription.ts` — ADAPT invariants, REJECT direct replacement

Imports are `MessageBlock`/`ThreadMessage` contracts and a cloud-agent block converter; the web reducer adds many core helpers and run/computer schemas. They are not transport-neutral leaves. Stream buffering/replay is useful for a future durable console transcript, but Vonvon does not need to acquire Rakazo's event store to improve Feishu rendering.

Specific incompatibility: `reduceLiveMessageBlocks` flushes tools at sentence boundaries; `endsSentence` at `events.ts:319–323` recognizes ASCII `. ! ?`, not Chinese `。！？`. It also works on cumulative progress text, whereas Vonvon upserts item-scoped deltas/finals (`run-state.ts:127–153`). Copying it would make Chinese progress and tool boundaries worse without preserving native item reconciliation.

M6/s34–35 target: extend current `AgentEvent`, `run-state.ts`, `run-render.ts` and existing isolation fixtures for child identity, parent completion before child terminal, and stale child events. Tests should assert final visible card state and that a terminal parent is not resurrected. Do not add web snapshot replay or change streaming defaults. Rakazo's optional streaming preference defaults off (`events.ts:172–183`); this is a product choice, not a universally preferable implementation.

Subscription caveat: the idle race waits on `iterator.next()` and a timer (`thread-subscription.ts:65–74`), not directly on abort. Its caller must ensure abort closes transport promptly; its background snapshot retry and pending buffer deserve lifecycle/bounds review before adoption. No live failure was demonstrated here.

### 3. `packages/core/src/answerable-ask.ts:11–46` and web `ChoiceCard` — ADAPT tiny presentation logic, REJECT selection/lifecycle copy

[Pure ask helpers](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/answerable-ask.ts#L11) have no imports. `resolveAskChoice` matches stable ID first, then trimmed case-insensitive label; `selectedAskActionLabel` shows the label. This is useful for M6/s33 typed answers, but duplicate labels are ambiguous (first match wins), multiple questions need question-scoped answers, and free text is not permission.

`latestAnswerableAskMessageId` scans backward across active waiting runs. Vonvon instead owns FIFO per session and checks the current carrier/request/actor. Keep `packages/daemon/src/bot/ask-coordinator.ts:23–39,56–94,157–173` and `card/ask-card.ts:17–81` authoritative. Integrate any text matching behind a coordinator entry point, after actor/session/current-request validation. Test duplicate labels, multiple waiting runs, stale card, repeat answer, admin revocation, queued second ask, and late send completion. No text matcher may grant permission based on a matching label alone.

[ChoiceCard](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/web/src/pages/shell/message-cards.tsx#L15) is specifically onboarding RPC (`onboarding.choose`, `dismissFocus`), not generic agent question UI. It brings Lingui, Rakazo UI primitives, icons, RPC and broader artifact imports. Copying its JSX cannot implement Feishu CardKit or coordinator authorization. Only its pending/error/answered presentation states are transferable.

### 4. `apps/desktop/src/setup-store.ts:24–71` — ADAPT in M7/s38–40

[Source](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/desktop/src/setup-store.ts#L24). The read uses lstat, O_NOFOLLOW/O_NONBLOCK, fstat inode/device comparison, bounded allocation/read and finally-close. Write uses exclusive creation, 0600, file sync and rename. Node builtins plus setup parsing/type imports; extract an algorithm rather than import desktop setup types.

Vonvon has `packages/daemon/src/server/atomic-file.ts:7–17`, already attributed to Paseo, and stronger **planned** memory requirements in `docs/product.md:355–364`, `docs/v1-plan.md:843`: nlink==1, bounded regular file, quarantine if replacement is obstructed, concurrent-edit reconciliation and undo. Rakazo's helper does not check nlink; neither this function nor O_NOFOLLOW alone proves ancestor containment. It is a useful compact starting point, not a finished security primitive for agent-writable directories. Preserve the existing writer unless new durability requirements justify changes.

Isolation proof for future s40: temporary isolated roots only; normal file, final symlink, hardlink, FIFO, directory, oversized content, swap between lstat/open, rename obstruction, and concurrent edits; assert no out-of-root bytes read or modified, no hang, recoverable original content and defined quarantine capacity. No provider needed. The concurrent-edit algorithm is still Vonvon's work; Rakazo's setup writer does not solve it.

### 5. `model-emulator.ts` / `scripted-runtime.ts` — ADAPT harness architecture in M6/s31–35

The emulator imports only Node builtins at runtime and an `AgentRunRequest` type, but its protocol and returned model configuration are OpenAI-compatible HTTP/SSE/Pi-specific. The scripted runtime imports Rakazo adapter contracts and core helpers and owns a module-global `running` map. Do not install `@rakazo/testkit`: its manifest includes adapters, database and PostgreSQL testcontainers.

Target existing `packages/daemon/test/turn-stream-isolation.test.ts`, `ask-coordinator.test.ts`, `run-card-stream.test.ts`, and fake executable helpers. Add explicit expected-request steps/failure accumulation/terminal `assertComplete`, then scenarios for ask→answer→continue, stop during answer transport, two child streams, unknown request, partial output→disconnect, and stale event after replacement. Use synthetic messages and temp VONVON_HOME; deny network except an explicitly required loopback fixture; no real provider/auth. Assert user-visible card terminal status, no duplicate provider response and no leaked process/read. This validates our execution code, not live provider compliance or Feishu rendering. Real acceptance remains required.

### 6. Attachment and artifact modules — mostly DEFER / ADAPT

[Attachment decode](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/attachments.ts#L16) avoids recursive grouped regex, caps encoded length before Buffer decoding and validates decoded size. Imports contract MIME lists/limits and MessageBlock; Node Buffer means it is not wholly browser-neutral. The default is 10 MiB and four attachments (`packages/contracts/src/attachments.ts:1–7`), which should not become Vonvon limits accidentally.

Vonvon `packages/daemon/src/bot/media.ts:7–33,69–93` obtains Feishu resources into local paths, with nine-image cap and expiry; native providers consume localImage or their own base64 representation. No browser-upload endpoint needs replacement. Browser `pending-attachments.ts` is a dependency-free DOM helper candidate only if a future composer is approved: distinguish text paste from real files and revoke object URLs. It does not validate server ownership or download paths.

Reject direct `apps/api/src/artifacts.ts` import: actor/space/bot/group ownership, Prisma versioning and `ArtifactStore` are integral (`:1–55`). Likewise `packages/adapters/src/artifacts.ts` local store partitions on spaceId and returns byte length as its adapter hash (`:27–42`), while API separately hashes bytes. Treating the adapter alone as a complete authorized content-addressed store is incorrect.

[Core CSP helper](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/artifact-sandbox.ts#L1) is a direct zero-import leaf candidate for a **v1-after** artifact viewer, but CSP alone is explicitly not isolation. Actual [web viewer](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/web/src/components/SandboxedHtmlViewer.tsx#L1) uses nested sandboxed iframes, navigation guard, outer frame-src restriction, no-referrer and escaped script embedding; mobile calls the core helper with a separate WebView boundary. Do not claim these are one shared web implementation. Future tests need a real browser: network requests, parent storage, top navigation, forms, popup, malformed doctype, `</script>` payload, external images/fonts, and local fragment navigation. String assertions in the current upstream test are not browser security proof.

### 7. Profile/settings — ADAPT invariant, retain Vonvon API

[bot-profile-patch.ts](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/web/src/lib/bot-profile-patch.ts#L1) imports only a max-length constant and omits description if unchanged; profile edits intentionally preserve instructions. It silently slices overlong descriptions. Vonvon already has section-specific partial patches plus revision (`packages/daemon/src/admin/settings-types.ts:177–188`) and `DraftGuard.tsx:18–59`, preserving drafts on failure. M7/s41 should reuse those for personality/rules/memory instead of whole-bot saves. Test stale revisions, save one section while another is dirty, absent field versus explicit clear, failed save retaining input, and rejected rather than silently truncated over-limit memory. No new helper library is justified.

### 8. Integration contracts and remote desktop — REJECT current implementation import, v1-after proposal

[Integration settings](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/contracts/src/integration-settings.ts#L1) models Composio/Pipedream credentials with Zod discriminants. [Catalog](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/api/src/integration-catalog.ts#L7) bounds responses and rejects redirects, but its configured private bases are intentionally allowed. This is not a drop-in public-URL fetch policy. Vonvon M8/s43–45 is a local skill/MCP library and allowlists (`docs/v1-plan.md:874–876`), not a hosted connector catalog. Borrow explicit setup states and bounded validation only; do not inherit SaaS services, credentials, billing or vendor assets.

[Desktop setup-config](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/desktop/src/setup-config.ts#L11) separates new managed local versus existing origin, canonicalizes origin, rejects embedded credentials and public cleartext. `maySendDesktopStackToken` restricts cleartext token delivery to loopback. [local-stack.ts](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/desktop/src/local-stack.ts#L1) depends on Docker Compose and generates Postgres/auth/encryption/sandbox secrets. Vonvon `docs/product.md:44` explicitly limits v1 to loopback; its `packages/ui/src/client-context.tsx:5–23` already separates shell capabilities from client, and `setup/SetupChecklist.tsx:42–60` handles native tools/service readiness. Keep the lightweight architecture. A future remote-management proposal needs a separate credential/origin/trust design and explicit user value, not just a server URL field.

### 9. Approval effect keys / visibility / mentions — REJECT semantic substitution

[approval-effect-key.ts](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/approval-effect-key.ts#L7) depends only on Node crypto and provides strict stable JSON plus run/tool/argument/occurrence hashing. The mechanism is concrete, but durable replay requires executor occurrence accounting and `recordEffect` (`packages/adapters/src/executor.ts:4586–4614`). A hash alone is not exactly-once execution. Vonvon delegates tool execution to native providers and owns ask request IDs; replacing request identity with argument hashes risks conflating legitimate repeated questions. `stableJsonValue` is extractable if an actual future daemon-owned effect store needs it, with malformed JSON/cycle/sparse-array/order/occurrence tests; no v1 feature needs to be invented for it.

[message-visibility.ts](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/message-visibility.ts#L35) retains input cards from background runs and optionally hides peer receipts. Good M6/s35 presentation invariant: an actionable child ask remains visible when activity is collapsed. It is **not authorization or redaction**: filtering retains entire message rows if one block qualifies, and type imports are Rakazo MessageBlock. Do not use it to protect private tool data.

[group-mentions.ts](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/group-mentions.ts#L30) wakes all members on @everyone and falls back to first member when no target. Explicit DO NOT COPY for Vonvon M5: product 3.4 suppresses @all and arbitrates locally. Even the small Unicode-aware `hasMentionToken` should only complement, never replace, authoritative structured Feishu mention IDs.

## License, provenance and dependency boundary

Inspected root LICENSE header (Apache-2.0), core/testkit manifests declaring Apache-2.0, candidate leaf source headers/imports, and tracked-path searches for LICENSE/NOTICE/vendor/third-party. The file listing exposed root LICENSE and no separate NOTICE/license path; this is not a full ownership audit. Selected leaf sources inspected above contain no differing per-file license marker. Desktop asset README points to `packages/ui-tokens/assets` as editable source, which is not evidence of third-party trademark/artwork clearance. No assets are proposed for copying.

For a future extraction, retain upstream pin, filename and relevant notices in our existing attribution mechanism; mark changes and include applicable license text as root's license review determines. Do not import the barrel package simply to obtain a 15-line utility. Licenses of npm dependencies, third-party connector APIs/services, model access and brand assets remain separate. No blanket permission claim is made here.

## Files read / limits

Rakazo source (some long files read only in the cited ranges): `packages/core/src/{async,thread-message-updates,thread-subscription,answerable-ask,attachments,artifact-sandbox,tool-activity,events,approval-effect-key,message-visibility,group-mentions}.ts`; tests `async.test.ts`, `artifact-sandbox.test.ts`, `answerable-ask.test.ts`; `packages/contracts/src/{attachments,integration-settings}.ts`; `packages/testkit/src/{model-emulator,pi-offline.test}.ts`; `packages/adapters/src/{scripted-runtime,artifacts,executor}.ts`; `apps/api/src/{artifacts,integration-catalog}.ts`; `apps/web/src/lib/{response-streaming,pending-attachments,bot-profile-patch,thread-events}.ts`; `apps/web/src/pages/shell/message-cards.tsx`; `apps/web/src/components/SandboxedHtmlViewer.tsx`; `apps/desktop/src/{setup-config,setup-store,local-stack}.ts`; desktop assets README; core/testkit package manifests; root LICENSE header. Search-only results included mobile CSP consumer and executor effect-key call sites.

Vonvon: relevant excerpts from `docs/product.md`, `docs/v1-plan.md`; `packages/daemon/src/{bot/ask-coordinator,bot/media,card/ask-card,card/run-card-stream,card/run-state,server/atomic-file,admin/settings-types}.ts`; `packages/daemon/test/{turn-stream-isolation.test,helpers/bot-fixture}.ts`; `packages/ui/src/{client-context,settings/DraftGuard,setup/SetupChecklist}.tsx`; scoped searches in settings implementation/tests. Skill reads: how, explorer prompt, Codex mapping, TypeScript and type-system discipline.

Unknowns: live artifact browser isolation, actual shutdown timing under half-open streams, upstream test pass status, complete transitive license provenance, real provider/native-card acceptance. The proposed tests remain specifications. No performance/safety improvement is claimed measured, and no existing Vonvon bug is claimed solely from comparison.

## Root's additional isolated proof (reported after this inspection)

Root reports `source-probes.mjs` / `source-probes.log` in this research artifact directory passed eight assertions using direct Node TypeScript imports without dependencies or services: @everyone/all/fallback-first behavior, canonical argument ordering and effect occurrences/non-JSON rejection, waiting ask selection and choice ID/label resolution. This is root-executed leaf evidence; I did not run it. It does not prove authorization, durable replay or real provider/UI behavior. Also, Rakazo has model OAuth support (`packages/core/src/model-oauth.ts`, found by import search); the architectural distinction is Pi-owned tool execution versus Vonvon's native CLI-owned sessions, not an assertion that Rakazo is API-key-only.

## 核实记录

独立 gpt-6-astra 核实（2026-10-17）： 已按固定 Rakazo commit 和 Vonvon 基线复查主要候选源码、实际调用点和依赖 manifests；未运行服务、模型或测试。复核支持“小函数择机摘取、协议失败场景移植到现有夹具、保留 Vonvon 的 ask/FIFO 与原生会话边界”的主要结论。安全文件读取、HTML 预览、effect key 和可见性过滤均不能脱离调用方当作完整安全方案。根 LICENSE 与已读候选的许可证标记相容，但不覆盖第三方依赖、服务或品牌资产。另读取 root 的八组叶子探针脚本与通过日志：它们支持对应函数行为，不是产品验收；新版出版探针已加入 ID 与另一选项标签冲突的案例；本复查者核对了更新源码、主会话通过记录及另一名分析者的独立执行记录，ID 优先已有对应执行证据，本人未重跑。历史 source-probes 脚本未包含该新增案例。文件 sync+rename 不应宣传为已证明断电持久性；stable JSON 只应用于已解析 JSON 参数，不应充当任意 JS 对象净化器。未发现阻止采纳报告主要建议的问题，未声称任何代码已移植或新功能已完成。
