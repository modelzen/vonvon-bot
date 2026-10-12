# Bridge import: service control, executor, and wire contract (V8)

This document is the approved callable and wire contract for V8. It settles V8-T2 (#183, #225: old-service pause and restoration), V8-T3 (#184: protocol and CLI), and V8-T4 (#185: UI wiring). The phase order, data boundary, and marker name in [architecture.md](architecture.md) stay as approved. `plan.md` V8 *Files*, *Verify*, and *Shared files* reference this document. Baseline for this revision: `f1d1f27693820a225770cb53e04be066a67b7884` on `codex/v8-bridge-import`.

Codex implements against these shapes. A deviation that changes a type, a persisted file, or a wire field returns here first.

## 1. Rules that every adapter and the executor obey

1. **Absent is proven, unknown is reported.** A probe that fails, times out, or prints anything unexpected yields `unknown`, never `absent`. Only a probe that exits 0 and prints the adapter's own sentinel for "not there" yields `absent`.
2. **Identity is positive and fixed.** The label `ai.feishu-codex-bridge.bot`, the unit `feishu-codex-bridge.service`, the Run value `feishu-codex-bridge`, the task `feishu-codex-bridge-relaunch`, and the definition paths come from `service/control.ts`. No substring of a command line is ever ownership. A process is the bridge only when every field of the platform's positive identity (section 3) matches.
3. **Compare before the first mutation.** Every mutating call takes the `expected` snapshot. The adapter recaptures, compares identity (section 2.3), and returns `identity-changed` before it runs any command that writes. An externally replaced definition or registration is never deleted, disabled, or rewritten.
4. **A partial pause is a value, not an exception.** `pause` returns `partial` with the completed steps. The caller must call `restore(expected, partial)` and `restore` must converge from any adapter-created partial state. `restore` never refuses because the partial state fails a fresh capture.
5. **Every mutation is retry-convergent.** Running `pause`, `restore`, or `disable` twice with the same `expected` converges to the same end state. "Already done" is a success variant, not an error.
6. **Snapshots are in memory. The journal holds hashes and backups.** `FileSnapshot.bytes` is never serialized. Section 4.2 defines the persisted record. A restore after a crash re-reads the backup, recomputes its hash, and refuses on mismatch.
7. **Preservation beyond running or stopped.** launchd keeps loaded, running, and the disabled override apart. systemd keeps enabled and active apart. Windows keeps the Run value, the launcher file, the relaunch task, and the process apart.
8. **No foreign target is ever signaled.** Occupancy by an unmanaged bridge, another data root, or a pending runtime operation refuses the whole import; it never kills the occupant.
9. **Marker, verify, old-service-stop ordering holds.** Pause, copy, hooks, start, verify, disable autostart, marker. The marker is written last. Original bridge data under `~/.feishu-codex-bridge` is never modified or deleted.

## 2. Service-control callable contract

Files: `packages/daemon/src/import/bridge/service-control/types.ts`, `launchd.ts`, `systemd.ts`, `windows.ts`. The existing candidate under the same directory is revised to this contract. Its three platform adapters, test file, and fixed identities are reused.

### 2.1 Common types (`types.ts`)

```ts
export type Sha256Hex = string & { readonly __brand: 'Sha256Hex' };

export interface FileSnapshot {
  readonly path: string;            // absolute, fixed by control.ts installationPaths
  readonly bytes: Uint8Array;       // in memory only; never serialized
  readonly sha256: Sha256Hex;
  readonly mode: number;
  readonly size: number;
}

export type Observation<T> =
  | { readonly kind: 'observed'; readonly value: T }
  | { readonly kind: 'unknown'; readonly probe: string; readonly exit: number | null; readonly detail: string };

export type Definition = { readonly kind: 'absent' } | { readonly kind: 'present'; readonly file: FileSnapshot };

export type ServiceSnapshot =
  | {
      readonly platform: 'launchd';
      readonly label: 'ai.feishu-codex-bridge.bot';
      readonly domain: `gui/${number}`;
      readonly definition: Definition;
      readonly job:
        | { readonly state: 'not-loaded' }
        | { readonly state: 'loaded-idle' }
        | { readonly state: 'loaded-running'; readonly pid: number };
      readonly disabledOverride: boolean;       // launchctl print-disabled lists the label
    }
  | {
      readonly platform: 'systemd';
      readonly unit: 'feishu-codex-bridge.service';
      readonly unitPath: string;                // XDG_CONFIG_HOME env, else ~/.config, same as control.ts
      readonly definition: Definition;
      readonly fragmentPath: string | null;     // systemctl show -p FragmentPath, realpath-compared to unitPath
      readonly unitFileState: 'enabled' | 'disabled' | 'not-found';
      readonly activeState: 'active' | 'inactive' | 'failed';
      readonly mainPid: number | null;
    }
  | {
      readonly platform: 'windows-run';
      readonly runValue: { readonly kind: 'absent' } | { readonly kind: 'present'; readonly command: string; readonly launcherPath: string };
      readonly launcher: Definition;            // the file the Run value points at
      readonly relaunchTask: 'absent' | 'present';
      readonly process:
        | { readonly kind: 'absent' }
        | { readonly kind: 'running'; readonly identity: WindowsProcessIdentity };
    };

export interface WindowsProcessIdentity {
  readonly pid: number;
  readonly creationDate: string;    // Win32_Process.CreationDate, verbatim
  readonly executablePath: string;  // Win32_Process.ExecutablePath
  readonly scriptPath: string;      // argv[1] after normalization
  readonly installRoot: string;     // parent of bin/
}

export type Occupant =
  | { readonly kind: 'pending-operation'; readonly file: string }
  | { readonly kind: 'data-in-use'; readonly file: string; readonly pid: number }
  | { readonly kind: 'unmanaged-process'; readonly pid: number }
  | { readonly kind: 'other-data-root'; readonly root: string };

export type CaptureResult =
  | { readonly kind: 'captured'; readonly snapshot: ServiceSnapshot; readonly occupants: readonly Occupant[]; readonly capturedAt: number }
  | { readonly kind: 'unknown'; readonly probe: string; readonly exit: number | null; readonly detail: string };

export type PauseStep =
  | 'remove-definition' | 'bootout' | 'disable-unit' | 'stop-unit' | 'daemon-reload'
  | 'delete-run-value' | 'kill-process' | 'await-exit';

export type PauseResult =
  | { readonly kind: 'paused'; readonly steps: readonly PauseStep[]; readonly quiescentAt: number }
  | { readonly kind: 'already-paused' }
  | { readonly kind: 'identity-changed'; readonly current: ServiceSnapshot }
  | { readonly kind: 'occupied'; readonly occupants: readonly Occupant[] }
  | { readonly kind: 'partial'; readonly completed: readonly PauseStep[]; readonly failed: PauseStep; readonly detail: string }
  | { readonly kind: 'unknown'; readonly probe: string; readonly exit: number | null; readonly detail: string };

export type RestoreResult =
  | { readonly kind: 'restored'; readonly verified: ServiceSnapshot }
  | { readonly kind: 'already-restored' }
  | { readonly kind: 'identity-changed'; readonly current: ServiceSnapshot }
  | { readonly kind: 'manual-recovery'; readonly completed: readonly PauseStep[]; readonly reason: string; readonly instructions: readonly string[] };

export type DisableResult =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'already-disabled' }
  | { readonly kind: 'identity-changed'; readonly current: ServiceSnapshot }
  | { readonly kind: 'unknown'; readonly probe: string; readonly exit: number | null; readonly detail: string };

export interface ServiceControl {
  readonly platform: ServiceSnapshot['platform'];
  capture(): Promise<CaptureResult>;                                           // read-only, always
  pause(expected: ServiceSnapshot): Promise<PauseResult>;
  restore(expected: ServiceSnapshot, progress?: Extract<PauseResult, { kind: 'partial' }>): Promise<RestoreResult>;
  disable(expected: ServiceSnapshot): Promise<DisableResult>;
}

export interface ServiceControlOptions {
  readonly home: string;                     // the calling user's HOME; data roots and definition paths derive from it
  readonly run: CommandRunner;               // argv only, no shell; fixed executables
  readonly files: FileAccess;                // read, exclusive-create, rename, fsync, unlink, lstat
  readonly clock: () => number;
  readonly knownOwnersStopped: (home: string) => readonly Occupant[]; // wraps control.ts assertKnownOwnersStopped, returns instead of throwing
}
```

`CommandRunner` returns `{ status: number | null; stdout: string; stderr: string; error?: Error }`. Adapters never interpolate values into shell text. The only PowerShell scripts are fixed strings that take values through `-EncodedCommand`-free argv or environment variables parsed inside the script.

### 2.2 Caller responsibilities (the executor)

- Call `capture()` in preflight and again as the first step of `execute`. Preflight capture is read-only and is the only service observation shown to the user before confirmation.
- Pass the preflight-time snapshot as `expected` to `pause`. `identity-changed` becomes the executor outcome `stale-source`; the user must run preflight again.
- `occupied` and `unknown` refuse before any mutation. Neither is retried automatically.
- On `partial`, call `restore(expected, partial)` immediately, then record the restore result. `manual-recovery` becomes the terminal executor state of the same name with the instructions surfaced verbatim.
- Hold `expected` only in memory during the run. Persist its `ServiceSnapshotRecord` (section 4.2) in the journal before `pause` so a crash can restore.
- Call `disable(expected)` only after `verify` succeeds. Call `restore(expected)` on any failure before that.
- Never call `capture()` as a precondition of `restore`. The adapter owns that comparison and must tolerate its own partial states.

### 2.3 Identity comparison per platform

Identity is "the same registration the user confirmed". It is compared field by field, with the dynamic fields excluded as listed.

| Platform | Compared | Excluded, preserved separately |
| --- | --- | --- |
| launchd | definition kind, `sha256`, `mode`; `disabledOverride` | job state and pid (restore must reproduce `loaded-idle` vs `loaded-running`, not the pid) |
| systemd | definition kind, `sha256`, `mode`; `fragmentPath` equals `unitPath` after realpath; `unitFileState` | `activeState`, `mainPid` |
| windows-run | runValue kind, `command`, `launcherPath`; launcher `sha256`, `mode`; `relaunchTask`; process `executablePath`, `scriptPath`, `installRoot` | process pid and `creationDate` |

When `expected.definition` is `absent` and the current definition is `present`, that is `identity-changed`. There is no path where a newly appeared file is deleted.

## 3. Platform rules

### 3.1 launchd

- Probes: `/bin/launchctl print gui/<uid>/<label>` for `pid =` and `state =`; `/bin/launchctl print-disabled gui/<uid>` for the override; `lstat` and bounded read of the plist. Exit code 113 or the "Could not find service" text with exit non-zero and no other stderr is the sentinel for `not-loaded`. Any other failure is `unknown`.
- `pause`: if `job` is `not-loaded`, check occupants, then `remove-definition`. Otherwise `remove-definition`, fsync the directory, `bootout`, then `await-exit` polling `print` until `not-loaded` within 10 s. Occupants are checked before the first mutation and again after `await-exit`; a new occupant after unload is `partial` at `await-exit`.
- `restore`: recreate the plist from the in-memory bytes (exclusive create of a temp file, chmod to `mode`, rename, directory fsync) when absent; if present, compare hash and return `identity-changed` on mismatch. If `expected.job` is `loaded-idle` or `loaded-running`, `bootstrap`. Then verify: `loaded-running` requires a pid within 10 s; `loaded-idle` requires loaded with no pid, and a pid that appears from `KeepAlive` is reported in `verified` but is not a failure. `not-loaded` requires no bootstrap. `disabledOverride` is compared before and after and never changed by any command; a difference is `manual-recovery`.
- `disable`: compare, then `remove-definition` and `bootout` if loaded. Never touches `print-disabled` state.

### 3.2 systemd

- Unit path: `process.env.XDG_CONFIG_HOME || join(home, '.config')`, identical to `control.ts installationPaths`. The adapter has no other default.
- One probe `systemctl --user show -p FragmentPath,LoadState,UnitFileState,ActiveState,SubState,MainPID <unit>` plus `is-system-running`. `LoadState=not-found` with exit 0 is the sentinel for an unregistered unit. `masked`, `static`, `linked`, `activating`, `deactivating`, `reloading` are `unknown`. `FragmentPath` must realpath-equal `unitPath` when the unit is loaded; otherwise `unknown` with detail `foreign-fragment`.
- Occupancy: `knownOwnersStopped(home)` runs before `pause` mutates and before `restore` starts the unit. A live `MainPID` that is not dead after `stop-unit` is `partial` at `await-exit`.
- `pause`: `disable-unit`, `stop-unit`, `await-exit` (poll `ActiveState` to `inactive` or `failed`, 10 s), `remove-definition`, `daemon-reload`.
- `restore`: write the unit bytes when absent (same exclusive-create and rename as launchd), `daemon-reload` always (not conditioned on whether the file was written), `enable` if `unitFileState` was `enabled`, `start` if `activeState` was `active`, then verify `UnitFileState` and `ActiveState`. Verify `sha256` of the file before `daemon-reload`.
- `disable`: compare hash and `unitFileState` first, then `disable-unit`, `remove-definition`, `daemon-reload`. A missing file with `expected.definition.kind === 'present'` after a previous successful `disable` is `already-disabled` when `LoadState=not-found`.

### 3.3 Windows Run key

- Probes are fixed PowerShell scripts with `$ErrorActionPreference='Stop'` that print exactly `present <json>` or `absent`. Exit 0 and one of those lines is required. Everything else, including non-empty stderr, is `unknown`. `reg.exe` and `schtasks.exe` exit codes are not interpreted.
- Positive process identity: `Win32_Process` for the pid from `service.pid` must have `ExecutablePath` whose basename is `node.exe`, a parsed command line whose first script argument normalizes to `<installRoot>\bin\feishu-codex-bridge.mjs`, whose next argument is exactly `run`, and `<installRoot>\package.json` must parse with `name` `feishu-codex-bridge` (bounded read). `installRoot` must equal the root derived from the Run value's launcher. Any miss is `unknown` with detail `process-identity`. No regex over the whole command line.
- PID generation race: before `kill-process` the adapter re-reads `Win32_Process` for the pid and requires `CreationDate` to equal the snapshot's. Then `taskkill /pid <n> /T /F`. The window between the re-read and the kill is not closable without a process handle from Node and is accepted as the residual risk, bounded to one re-read immediately before the kill. The failure test asserts that a changed `CreationDate` yields `partial` at `kill-process` with no `taskkill` call.
- `pause`: check occupants, `delete-run-value`, `kill-process`, `await-exit`. Deleting the value first stops a logon or relaunch task from restarting the process during the kill.
- `restore(expected, progress)`: write the Run value when absent (`New-ItemProperty` with the snapshot's `command`), verify launcher `sha256`, and if `expected.process.kind === 'running'` start it through the launcher path with argv only. Then verify that a process with the positive identity exists. This path is reached from `partial` at `kill-process` with the Run value already deleted, which is F1.
- `disable`: compare runValue and launcher hash, then `delete-run-value`. The relaunch task is never created or deleted by import; `present` at disable time is reported in the receipt as a warning.

## 4. Executor and journal

File: `packages/daemon/src/import/bridge/execute.ts`. Recovery entry: `recoverBridgeImport()` called once from daemon bootstrap before the RPC server accepts requests.

### 4.1 Phases and outcomes

```ts
export type ImportPhase = 'pause' | 'copy' | 'hooks' | 'start' | 'verify' | 'disable' | 'marker';

export type ImportState =
  | { readonly kind: 'running'; readonly phase: ImportPhase }
  | { readonly kind: 'succeeded'; readonly receipt: ImportReceipt }
  | { readonly kind: 'failed'; readonly phase: ImportPhase; readonly code: ImportFailureCode; readonly message: string; readonly rollback: 'restored' | 'manual-recovery' }
  | { readonly kind: 'cancelled'; readonly phase: ImportPhase; readonly rollback: 'restored' | 'manual-recovery' }
  | { readonly kind: 'manual-recovery'; readonly phase: ImportPhase; readonly completed: readonly PauseStep[]; readonly instructions: readonly string[] };

export type ImportFailureCode =
  | 'service-unknown' | 'service-occupied' | 'stale-source' | 'credential-invalid' | 'credential-missing'
  | 'copy-failed' | 'hooks-refused' | 'bot-start-failed' | 'bot-not-connected' | 'disable-failed' | 'marker-failed';
```

- `pause` through `verify` roll back on failure, cancel, or crash: `restore(expected)`, delete the staging copy, remove bots the run registered, and rewrite hook files from their journaled backups.
- `disable` and `marker` roll forward on crash: the bots are connected, so recovery completes the remaining phase. Cancel after `verify` succeeds returns `past-point-of-no-return`.
- `copy` writes to `~/.vonvon-bot/import/bridge/staging/<importId>/`. `start` promotes each bot directory by rename into the daemon's bot store and registers the re-encrypted secret under `master.key`. A preflight `conflict` (an appId already registered in the daemon) refuses execute; no merge is attempted.
- `verify` waits for every imported bot's connection to report connected, 60 s budget, then re-runs `capture()` and requires the service still paused.
- `succeeded` requires every bot connected, `disable` returned `disabled` or `already-disabled`, and the marker written. Nothing else is success.
- Timing for the perf metric comes from journal `phaseStartedAt` entries, not from the UI.

### 4.2 Persisted shapes

All under `~/.vonvon-bot/import/bridge/`, written with temp file and rename, mode 0600.

```ts
export interface ServiceSnapshotRecord {               // journal form of ServiceSnapshot; no bytes
  readonly platform: ServiceSnapshot['platform'];
  readonly identity: Omit<ServiceSnapshot, 'definition' | 'launcher'> & { readonly definition: { kind: 'absent' } | { kind: 'present'; path: string; sha256: Sha256Hex; mode: number; size: number; backup: string } };
}
export interface ImportJournal {
  readonly version: 1;
  readonly importId: string;                           // uuid
  readonly preflightId: string;
  readonly sourceRoot: string;
  readonly sourceFingerprint: Sha256Hex;
  readonly startedAt: number;
  readonly service: ServiceSnapshotRecord;
  readonly phase: ImportPhase;
  readonly phaseStartedAt: Readonly<Partial<Record<ImportPhase, number>>>;
  readonly registeredBots: readonly string[];          // appIds this run added
  readonly hookBackups: readonly { path: string; sha256: Sha256Hex; backup: string }[];
  readonly cancelRequested: boolean;
}
export interface ImportReceipt {
  readonly version: 1;
  readonly importId: string;
  readonly completedAt: number;
  readonly sourceRoot: string;
  readonly sourceFingerprint: Sha256Hex;
  readonly bots: readonly { appId: string; name: string; connectedAt: number }[];
  readonly serviceAutostartRemoved: true;
  readonly markerPath: string;
  readonly warnings: readonly string[];
}
```

Backups live in `~/.vonvon-bot/import/bridge/<importId>/backup/`. `recoverBridgeImport()` reads `journal.json`, rejects a hash mismatch between a backup and its record as `manual-recovery`, and never reads `.feishu-codex-bridge` for the restore bytes. `receipt.json` is the existing-receipt source for lane 5. The marker `~/.feishu-codex-bridge/migrated-to-vonvon-bot.json` holds `{ version: 1, importId, completedAt, vonvonHome }` and nothing else.

`journal.ts` keeps `readJournalJson` and adds a zod schema for `ImportJournal`. `SourceInspection` from `preflight.ts` stays daemon-internal.

### 4.3 Concurrency, clients, and ownership

- One executor per daemon, one import at a time. A second `execute` while one runs returns `already-running` with the current status.
- Ownership is the daemon's. The executor continues when the requesting client disconnects. Any authenticated local client may call `status` and `cancel`, because the local credential is the single owner credential of this daemon.
- The executor takes the daemon's data lease; the CLI never runs a second in-process executor.

## 5. Wire contract

File: `packages/protocol/src/import.ts`. The root exports it from `index.ts` and registers method `import` in `rpc.ts` request and response unions. No `events.ts` change: the UI polls `status` every second while `running`.

```ts
export const importRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preflight') }).strict(),
  z.object({ type: z.literal('execute'), preflightId: z.string().uuid(), sourceFingerprint: z.string().length(64) }).strict(),
  z.object({ type: z.literal('status') }).strict(),
  z.object({ type: z.literal('cancel'), importId: z.string().uuid() }).strict(),
]);

export const importBotViewSchema = z.object({
  appId: z.string(), name: z.string(), tenant: z.enum(['feishu', 'lark']), enabled: z.boolean(),
  groups: z.array(z.object({ name: z.string(), chatId: z.string(), sessionCount: z.number().int() })),
  sessionCount: z.number().int(), settingCount: z.number().int(),
});
export const importServiceViewSchema = z.object({
  platform: z.enum(['launchd', 'systemd', 'windows-run', 'unsupported']),
  state: z.enum(['absent', 'registered-stopped', 'registered-running', 'unknown']),
  detail: z.string(),
});
export const importReceiptViewSchema = z.object({
  importId: z.string().uuid(), completedAt: z.number(), bots: z.array(z.object({ appId: z.string(), name: z.string() })),
  serviceAutostartRemoved: z.literal(true), markerPath: z.string(), warnings: z.array(z.string()),
});
export const importPreflightViewSchema = z.object({
  preflightId: z.string().uuid(), takenAt: z.number(), sourceRoot: z.string(), sourceFingerprint: z.string().length(64),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('not-found') }),
    z.object({ kind: z.literal('invalid'), problem: z.string(), file: z.string() }),
    z.object({ kind: z.literal('multiple-roots'), roots: z.array(z.string()) }),
    z.object({ kind: z.literal('ready'), format: z.enum(['multi-bot-v1', 'legacy-flat']), bots: z.array(importBotViewSchema),
      counts: z.object({ bots: z.number().int(), groups: z.number().int(), sessions: z.number().int(), settings: z.number().int() }) }),
  ]),
  service: importServiceViewSchema,
  credentials: z.enum(['decryptable', 'missing-key', 'invalid-key', 'not-checked']),
  conflicts: z.array(z.object({ appId: z.string(), reason: z.enum(['bot-exists']) })),
  occupants: z.array(z.string()),
  existingReceipt: importReceiptViewSchema.optional(),
  canExecute: z.boolean(),
});
export const importStatusViewSchema = z.object({
  importId: z.string().uuid(), startedAt: z.number(), updatedAt: z.number(),
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'manual-recovery']),
  phase: z.enum(['pause', 'copy', 'hooks', 'start', 'verify', 'disable', 'marker']),
  bots: z.array(z.object({ appId: z.string(), name: z.string(), connection: z.enum(['pending', 'connected', 'failed']) })),
  serviceAutostartRemoved: z.boolean(), markerWritten: z.boolean(),
  rollback: z.enum(['none', 'restored', 'manual-recovery']),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  instructions: z.array(z.string()).optional(),
  receipt: importReceiptViewSchema.optional(),
});
export const importReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preflight'), preflight: importPreflightViewSchema }),
  z.object({ type: z.literal('execute'), outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('started'), status: importStatusViewSchema }),
    z.object({ kind: z.literal('stale-confirmation'), preflight: importPreflightViewSchema }),
    z.object({ kind: z.literal('already-running'), status: importStatusViewSchema }),
    z.object({ kind: z.literal('existing-receipt'), receipt: importReceiptViewSchema }),
    z.object({ kind: z.literal('refused'), reason: z.enum(['not-ready', 'service-unknown', 'occupied', 'conflict', 'credential']), detail: z.string() }),
  ]) }),
  z.object({ type: z.literal('status'), status: importStatusViewSchema.nullable() }),
  z.object({ type: z.literal('cancel'), outcome: z.enum(['cancelling', 'not-running', 'past-point-of-no-return']) }),
]);
```

Projection rules. Secrets, `cwd` values, setting values, and hook file contents never appear. `occupants` and `detail` are human-readable strings with paths and pids only. `credentials` is computed read-only with `legacy-keystore.ts` against each bot's envelope; the plaintext is zeroed immediately.

Stale confirmation. `execute` recomputes the source fingerprint (sha256 over the sorted list of relative path, size, mtime, and content hash of every file `copy` would read) and recaptures the service. A different fingerprint, a `preflightId` the daemon did not issue in the last 15 minutes, or a service identity change returns `stale-confirmation` with a fresh preflight. The UI shows the fresh list and requires a new confirmation.

Authentication is the existing WebSocket hello with the local credential. `preflight` and `status` are `RpcOutcome` `read`; `execute` and `cancel` are `mutation`, since the bot snapshot changes.

## 6. Daemon routing, client, CLI, UI

- `packages/daemon/src/import/bridge/rpc.ts` (V8 owner) exports `importRpc(importer, payload): Promise<RpcOutcome<ImportReply>>`. The root adds one `case 'import'` line in `server/http.ts` and the bootstrap call to `recoverBridgeImport()`. These are the only shared daemon edits.
- `packages/client/src/client.ts` (root at integration): method `bridgeImport(request: ImportRequest): Promise<ImportReply>` and the `import: importReplySchema` entry in `replySchemas`. The name avoids the reserved word.
- `packages/daemon/src/cli/commands/import.ts` (V8 owner): `vonvon import feishu-codex-bridge [--yes] [--json]` connects to the running daemon with the local transport, runs `preflight`, prints the view, asks for confirmation unless `--yes`, sends `execute`, polls `status` to a terminal state, prints the receipt. If no daemon is running it exits non-zero with "start the daemon first". There is no in-process executor path, which is what makes lane 9's receipt identical to the UI path. The root adds the one registration line in `cli/index.ts`.
- `packages/ui/src/import/ImportFlow.tsx` (V8-T4 worker): a props-less container that owns the client calls and maps `ImportReply` to the existing `ImportView`. The existing `ImportPage.tsx`, `import.css`, test file, and `ImportFirstRunStep` are reused unchanged except where the mapping needs a prop. The completion gate stays: every bot `connected`, `serviceAutostartRemoved`, and `markerWritten`.
- `packages/ui/src/features.ts` (root): one entry `{ id: 'import', label: '导入 bridge 数据', slot: 'page', component: ImportFlow }`.
- `packages/ui/src/App.tsx` (root): render `ImportFirstRunStep` in the empty-bot branch of the bot list. The step calls `preflight` once, renders nothing on `not-found`, and links to the feature page otherwise. The root chooses the exact insertion point and names it in the PR.

Owner and path partition.

| Path | Writer |
| --- | --- |
| `packages/daemon/src/import/**`, `cli/commands/import.ts`, `protocol/src/import.ts`, `ui/src/import/**` | V8 workers (T2 service-control, T1 executor, T3 protocol and CLI, T4 UI container) |
| `protocol/src/index.ts`, `protocol/src/rpc.ts`, `client/src/client.ts`, `server/http.ts`, `host/bootstrap.ts` (one call), `cli/index.ts`, `ui/src/features.ts`, `ui/src/App.tsx` | root at integration |

## 7. Failure tests mapped to findings

Each row is a required unit test with fake commands and in-memory files, in `packages/daemon/test/import-bridge-service-control.test.ts` or `import-bridge.test.ts`. A test asserts state after the call, not an error string.

| Finding | Rule | Failure test |
| --- | --- | --- |
| F1 Windows partial pause | 1.4, 3.3 restore | `taskkill` fails after the Run value is deleted; `pause` returns `partial` at `kill-process`; `restore(expected, partial)` writes the Run value and returns `restored`; the fake registry has the value. |
| F2 inspection failure as absence | 1.1, 3.3 probes | Every probe exits 1 with access-denied stderr; `capture` returns `unknown`; `pause` is never reached and no mutation command is in the trace. |
| F3 substring ownership | 1.2, 3.3 identity | A pid whose command line contains `feishu-codex-bridge run` inside a `python.exe` argument; `capture` returns `unknown` with `process-identity`; no `taskkill` in the trace. Second case: `CreationDate` changes between capture and kill; `partial` at `kill-process`, no `taskkill`. |
| F4 Linux stop without occupancy | 1.8, 3.2 occupancy | Unit absent and inactive while `knownOwnersStopped` reports an unmanaged process; `pause` returns `occupied`; trace is read-only. |
| F5 launchd running-state loss | 1.7, 3.1 verify | Captured `loaded-running`, after bootstrap `print` shows `state = waiting` and no pid for the whole budget; `restore` returns `manual-recovery`, not `restored`. Reverse case: captured `loaded-idle`, bootstrap yields a pid; `restored` with `verified.job` reporting it. Disabled override differs after restore; `manual-recovery`. |
| F6 XDG path | 3.2 unit path | `XDG_CONFIG_HOME` set to a non-default directory; `capture` reads that unit file and `FragmentPath` compares against it. |
| F7 mutate before compare | 1.3, 3.2 disable | Unit bytes replaced and enabled after pause; `disable(expected)` returns `identity-changed` and the trace has no `disable`, `rm`, or `daemon-reload`. |
| Retry convergence | 1.5 | `disable` twice, `restore` twice, `pause` twice each return the success or `already-*` variant with identical end state. systemd restore with `daemon-reload` failing once, then succeeding on retry with the file already present. |
| Journal integrity | 1.6, 4.2 | Backup file altered after the journal was written; `recoverBridgeImport` returns `manual-recovery` and writes nothing to the service. |
| Executor crash matrix | 4.1 | Kill after every phase; rerun converges: rollback with restored service before `verify`, roll forward after. Twice-import reports `existing-receipt`. `stale-confirmation` when a source file changes between preflight and execute. |
| Success proof | 4.1 | A run where one bot never connects ends `failed` with `bot-not-connected`, service `restored`, no marker, no receipt. |

## 8. Implementation order and gates

1. V8-T2: revise `service-control/` to section 2 and 3; land the F1 to F7 tests. Checkpoint: `npm test -w packages/daemon -- import-bridge-service-control` with the failure rows green and the command trace assertions present.
2. V8-T1: `execute.ts`, journal schema, `recoverBridgeImport`, `import-bridge.test.ts` crash matrix. Checkpoint: unit crash matrix green on fakes.
3. V8-T3: `protocol/src/import.ts`, `import/bridge/rpc.ts`, `cli/commands/import.ts`. Root registers protocol, client method, `http.ts` case, bootstrap call, CLI line. Checkpoint: typecheck across protocol, client, daemon; CLI preflight against a daemon with no bridge data prints `not-found`.
4. V8-T4: `ImportFlow.tsx`; root adds the feature entry and the first-run render. Checkpoint: `npm run test -w packages/ui -- import-bridge` still green, plus a container test that a `status` reply with one `pending` bot never shows completion.
5. Gates, none marked here: the ten live lanes in `test-user` `gui/502` and `accept-user` only, the perf probe on journal timestamps, independent review by someone who wrote none of the code, and the exact-head Shipping verdict. Windows stays unverified until a Windows host exists, and the receipt says so.

## 9. Disclosure for the root PR

- New request group `import` in `rpc.ts` request and response unions. Additive; no existing shape changes. No `events.ts` change.
- New client method `bridgeImport`.
- New persisted files under `~/.vonvon-bot/import/bridge/` and the marker file content in section 4.2.
- V8 file boundary gains `import/bridge/rpc.ts`, `service-control/types.ts`, and `ui/src/import/ImportFlow.tsx`, all inside directories V8 already owns. Shared edits in section 6 are root-written.
- No merge-edge or graph change. V8 still merges after V4 only.
