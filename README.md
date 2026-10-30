# vonvon-bot

V1 contains the `@vonvon/protocol` package. It extracts the pinned desktop request families and adds machine handshake, correlated RPC envelopes, and snapshot events. The bridge project store has a separate reader-compatible schema; it is not the client project view.

Development requires Node.js 22.12 or later in the 22.x series, 24.x, or 26 and later.

Run `npm ci`, `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` from the repository root. `npm run verify:built -w packages/protocol` checks all command variants and times 1000 full settings parses. Import runtime schemas from `@vonvon/protocol` after the build. `PROTOCOL_VERSION` is 1; a positive newer version parses so a caller can negotiate it.

The port is based on `modelzen/vonvon-bot` commit `fab5237`. `packages/protocol/test/fixtures/agent-settings.json` comes from that commit. The generated project-store fixture follows `scripts/native-fixtures.mjs` there and the reader in `modelzen/feishu-codex-bridge` commit `446b2a4`.

双平台发布可使用[发布编排说明](docs/release-orchestration.md)：固定版本与 main SHA，同步调度 Windows 和串行 Mac 候选，查询状态、恢复中断并收集官网交接回执。正常发版默认使用该流程，Mac/Windows 上传由发布编排器并行处理；最终 stable 确认绑定展示过的候选，无需手抄 SHA。
