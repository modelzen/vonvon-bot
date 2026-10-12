# Bridge import: service ledger, executor ledger, and wire contract (V8)

Status: proposal for independent review. Nothing here is approved or frozen until the root records the review verdict. This revision answers the exact-head review of `87638cdaba3ed631d8e5c1bdab11dba832b99371` (R1 to R16). It settles V8-T2 (#183, #225), V8-T3 (#184), and V8-T4 (#185). The phase order, data boundary, and marker name in [architecture.md](architecture.md) stay. Source anchors below are at that head unless a revision is named. Bridge fixture facts (package name, launcher chain) are the review's reads of `feishu-codex-bridge` at `446b2a40ca75b5f725d7b0baab777b3a8f18b2e0` and `6698118352d7eca87887d3ee1b58736caca204bc`; this worktree does not contain that repository, so Codex re-reads them when it builds the fixture.

Codex implements against these shapes. A deviation that changes a type, a persisted file, a wire field, or a shared-file edit returns here first.

Four models carry the design. Model A is the service ledger: what the old service was, what the transaction did to it, and what the adapter may touch. Model B is the per-platform identity and termination policy. Model C is the executor ledger: every side effect as a durable intent and outcome with one commit point. Model D is the wire. Section 7 maps R1 to R16 to rules and traces.

## 1. Rules

1. **Absent is proven, unknown is reported.** A probe yields `absent` only on exit 0 plus the adapter's own sentinel for "not there". launchd's `launchctl print` of a missing service is the one documented nonzero sentinel (section 3.1). Everything else is `unknown`, and `unknown` refuses before mutation.
2. **Identity is positive, fixed, and complete.** Names and paths come from `service/control.ts` (`launchdLabel`, `systemdUnit`, `runKeyPath`, `runKeyName`, `relaunchTaskName`, `installationPaths`). A process is the bridge only when every field of the platform's identity table (section 3) matches. No substring, no regex over a whole command line.
3. **Compare against origin or projection, refuse on foreign change.** Every mutating call compares the current observation with the origin snapshot and with the state the transaction's own completed steps project (section 2.4). An observation equal to neither is `foreign-change`, returned before any write.
4. **A partial step is a value with evidence.** Pause, restore, and disable return per-step outcomes; the executor persists them. Restore converges from any transaction-created state and never requires a fresh capture to equal the origin.
5. **Destructive actions need a binding mechanism or they do not happen.** Where the platform offers no mechanism that binds a termination or a removal to the identified object (section 3.3 Windows), the adapter returns `blocked` before mutation and the import ends in `blocked` or `manual-recovery` with the evidence preserved. No residual-risk acceptance exists in this document.
6. **Exact restoration or no restoration.** A state the adapter cannot reproduce exactly (launchd `loaded-idle` with autostart keys, section 3.1) is detected at capture and refuses `execute` before any mutation.
7. **Stop what we started before we restart what we stopped.** Rollback stops and removes this transaction's imported runtimes with confirmed termination before the old service is restored (section 4.5).
8. **Snapshots in memory, hashes and backups on disk.** Bytes of definitions and launchers live in the transaction directory as backup files; the ledger stores path, hash, mode, size, and backup name (section 2.2).
9. **No foreign target is ever signaled.** Occupancy by a foreign owner refuses the import; it never kills the occupant.
10. **Order holds.** Pause, verify inventory, copy, hooks, start, verify connected, disable autostart, marker, receipt. Original bridge payload data is never modified; the sole write under `~/.feishu-codex-bridge` is the marker, as `architecture.md` authorizes.
11. **Every destination path resolves through `paths.appDir`.** `config/paths.ts:6` resolves `VONVON_HOME`; the importer never spells `~/.vonvon-bot`.

## 2. Model A: service ledger

Files: `packages/daemon/src/import/bridge/service-control/types.ts`, `ledger.ts`, `files.ts`, `launchd.ts`, `systemd.ts`, `windows.ts`. The existing uncommitted candidate adapters are revised to this contract, not recreated.

### 2.1 In-memory origin

```ts
export type Sha256Hex = string & { readonly __brand: 'Sha256Hex' };

export interface FileSnapshot {
  readonly path: string; readonly bytes: Uint8Array; readonly sha256: Sha256Hex; readonly mode: number; readonly size: number;
  readonly dev: number; readonly ino: number;        // POSIX identity of the inspected file; 0 on Windows
}
export type Definition = { readonly kind: 'absent' } | { readonly kind: 'present'; readonly file: FileSnapshot };

export type Observation<T> =
  | { readonly kind: 'observed'; readonly value: T }
  | { readonly kind: 'unknown'; readonly probe: ProbeCode; readonly exit: number | null };   // no stderr text crosses this boundary

export type ServiceOrigin =
  | {
      readonly platform: 'launchd';
      readonly label: 'ai.feishu-codex-bridge.bot'; readonly domain: `gui/${number}`;
      readonly definition: Definition;
      readonly loadedPath: string | null;                          // `path =` from launchctl print; must equal definition path when loaded
      readonly job: { readonly state: 'not-loaded' } | { readonly state: 'loaded-idle' } | { readonly state: 'loaded-running'; readonly pid: number };
      readonly autostart: { readonly runAtLoad: boolean; readonly keepAlive: boolean };    // parsed read-only from the plist
      readonly disabledOverride: boolean;
      readonly restorable: boolean;                                // false when job is loaded-idle and either autostart key is true
    }
  | {
      readonly platform: 'systemd';
      readonly unit: 'feishu-codex-bridge.service'; readonly unitPath: string;   // XDG_CONFIG_HOME || ~/.config, control.ts:27
      readonly definition: Definition;
      readonly fragmentPath: string | null;                        // must realpath-equal unitPath when LoadState=loaded
      readonly unitFileState: 'enabled' | 'disabled' | 'not-found';
      readonly activeState: 'active' | 'inactive' | 'failed';
      readonly mainPid: number | null;
    }
  | {
      readonly platform: 'windows-run';
      readonly runValue: { readonly kind: 'absent' } | { readonly kind: 'present'; readonly command: string };
      readonly chain: WindowsLaunchChain | { readonly kind: 'absent' };
      readonly relaunchTask: 'absent' | 'present';                 // present refuses execute (section 3.3)
      readonly process: { readonly kind: 'absent' } | { readonly kind: 'running'; readonly identity: WindowsProcessIdentity };
      readonly children: readonly WindowsProcessIdentity[];        // pids from processes.json that pass the identity table
    };

export interface WindowsLaunchChain {                              // every executable definition restore depends on
  readonly kind: 'chain';
  readonly vbs: FileSnapshot;            // <bridgeDataRoot>\service-launcher.vbs, the Run value target
  readonly cmd: FileSnapshot;            // path parsed from the vbs `sh.Run "cmd /c ""<cmd>"""` line
  readonly nodePath: string;             // first quoted token of the run line in cmd
  readonly scriptPath: string;           // second quoted token; must be <installRoot>\bin\feishu-codex-bridge.mjs
  readonly installRoot: string;
  readonly packageName: '@modelzen/feishu-codex-bridge';
  readonly command: 'run';
}
export interface WindowsProcessIdentity {
  readonly pid: number; readonly startTime: string;               // Process.StartTime via the held handle, ISO string
  readonly executablePath: string; readonly scriptPath: string; readonly installRoot: string;
}
```

### 2.2 Persisted origin record

A discriminated union with one tag. Each definition becomes a `FileRecord`. Conversion back to `ServiceOrigin` reads the backup, recomputes the hash, and fails with `backup-mismatch` on any difference.

```ts
export interface FileRecord { readonly path: string; readonly sha256: Sha256Hex; readonly mode: number; readonly size: number; readonly dev: number; readonly ino: number; readonly backup: string; }
export type DefinitionRecord = { readonly kind: 'absent' } | { readonly kind: 'present'; readonly file: FileRecord };

export type ServiceOriginRecord =
  | { readonly platform: 'launchd'; readonly label: string; readonly domain: string; readonly definition: DefinitionRecord; readonly loadedPath: string | null;
      readonly job: ServiceOrigin extends infer O ? Extract<O, { platform: 'launchd' }>['job'] : never;
      readonly autostart: { readonly runAtLoad: boolean; readonly keepAlive: boolean }; readonly disabledOverride: boolean; readonly restorable: boolean }
  | { readonly platform: 'systemd'; readonly unit: string; readonly unitPath: string; readonly definition: DefinitionRecord; readonly fragmentPath: string | null;
      readonly unitFileState: 'enabled' | 'disabled' | 'not-found'; readonly activeState: 'active' | 'inactive' | 'failed'; readonly mainPid: number | null }
  | { readonly platform: 'windows-run'; readonly runValue: { readonly kind: 'absent' } | { readonly kind: 'present'; readonly command: string };
      readonly chain: { readonly kind: 'absent' } | { readonly kind: 'chain'; readonly vbs: FileRecord; readonly cmd: FileRecord; readonly nodePath: string; readonly scriptPath: string; readonly installRoot: string; readonly packageName: string; readonly command: string };
      readonly relaunchTask: 'absent' | 'present';
      readonly process: { readonly kind: 'absent' } | { readonly kind: 'running'; readonly identity: WindowsProcessIdentity };
      readonly children: readonly WindowsProcessIdentity[] };
```

The `job` field is written out explicitly in code as the three-variant union; the conditional type above is notation for "the same union", not an instruction to use `Omit` or `Extract` across the outer union. Codex adds a round-trip test for every variant: `toRecord(origin)` then `fromRecord(record, backupDir)` equals `origin` with bytes compared, and a mutated backup yields `backup-mismatch`.

### 2.3 Transaction and steps

```ts
export type ServiceStep =
  | 'launchd.retire-plist' | 'launchd.bootout' | 'launchd.await-exit' | 'launchd.publish-plist' | 'launchd.bootstrap'
  | 'systemd.disable' | 'systemd.stop' | 'systemd.await-exit' | 'systemd.retire-unit' | 'systemd.daemon-reload' | 'systemd.publish-unit' | 'systemd.enable' | 'systemd.start'
  | 'windows.acquire-handles' | 'windows.delete-run-value' | 'windows.kill-main' | 'windows.kill-child' | 'windows.await-exit' | 'windows.write-run-value' | 'windows.launch';

export interface StepRecord {
  readonly step: ServiceStep; readonly seq: number;
  readonly intent: { readonly at: number; readonly observed: unknown };          // what the adapter saw immediately before acting; platform-typed in code
  readonly outcome?: { readonly at: number; readonly state: 'done' | 'failed' | 'skipped' | 'blocked'; readonly observed: unknown; readonly code?: ProbeCode };
}
export interface ServiceTransaction { readonly txnId: string; readonly origin: ServiceOriginRecord; readonly steps: readonly StepRecord[]; }
```

The executor owns the ledger file (section 4.2). The adapter receives a `StepSink` with `begin(step, observed): Promise<seq>` and `end(seq, outcome): Promise<void>`; both resolve only after the ledger write and fsync. The adapter acts only between `begin` and `end`.

### 2.4 Projection and the comparison table

`projected(origin, steps)` is a pure function that applies every `done` step to the origin and returns the expected current state. Each mutating operation compares the fresh observation `now` against the two legal states.

| Operation | Legal `now` | Action | Anything else |
| --- | --- | --- | --- |
| `pause(txn)` | equals `origin` | run the remaining pause steps | `foreign-change`, no write |
| `pause(txn)` retry | equals `projected` after a prefix of pause steps | continue from the first step not `done` | `foreign-change` |
| `restore(txn)` | equals `projected` (any prefix of pause steps done), or equals `origin` | undo done steps in reverse; `origin` means `already-restored` | `foreign-change`, no write |
| `disable(txn)` | equals `projected` after full pause | remove what pause left (section 3) and record | `foreign-change` |
| `disable(txn)` retry | equals `projected` after full pause plus done disable steps | continue; fully done means `already-disabled` | `foreign-change` |

Equality is field-wise on the identity fields of section 3 with pids and start times excluded, exactly as section 2.1 types them. There is no `already-disabled` exception based on guesswork: the transaction's own step records are the only source of "we did this".

### 2.5 File primitives (`files.ts`)

- `publishNoClobber(target, bytes, mode)`: write `<txnDir>/publish-<seq>` with `wx`, fsync, then `link(temp, target)`. `EEXIST` means a file appeared and is `foreign-change`; the temp is unlinked and the target is not read or touched. On success unlink the temp and fsync the directory. On Windows, where `link` across the Run value is meaningless and files are only the launcher chain, publication uses `open(target, 'wx')` plus write plus fsync; `EEXIST` is `foreign-change`.
- `retire(target, expected)`: `rename(target, <txnDir>/retired-<seq>)`, then `lstat` and hash the moved file. Equal to `expected` means done, with the bytes preserved as evidence. Not equal means `link(retired, target)` to put it back without clobbering, and `foreign-change` with the retired copy kept. Nothing is ever unlinked in place. On Windows the launcher chain is never retired or deleted by import; only the Run value is.
- Registry value removal (Windows) has no atomic compare-and-delete. The adapter reads the value, compares it to `origin.runValue.command`, records that read as the step intent, deletes, and re-reads to confirm absence. The window between read and delete is stated in the step record. A mismatch at the read refuses. This is the narrower guarantee; nothing claims it never clobbers.

## 3. Model B: platform identity and termination

### 3.1 launchd

- Probes: `/bin/launchctl print gui/<uid>/<label>` parsed for `pid =`, `state =`, and `path =`; `/bin/launchctl print-disabled gui/<uid>`; `lstat` and bounded read of the plist; `/usr/bin/plutil -convert json -o - <plist>` for `RunAtLoad` and `KeepAlive` (any truthy `KeepAlive` dictionary counts as true). Sentinel for `not-loaded`: `print` exit 113, or the literal `Could not find service` on stderr with nothing else. Other failures are `unknown`.
- `loadedPath` must equal the definition path when loaded; otherwise `unknown` with `foreign-fragment`.
- Managed set: the job's pid and the pids in `processes.json` under the bridge data root whose command is `<node> <installRoot>/bin/feishu-codex-bridge.mjs run --bot <id>` by argv (read through `ps -o pid=,command= -p`), where the Vonvon daemon's pid is excluded. Everything `assertKnownOwnersStopped` would flag that is not in the managed set is foreign (section 3.4).
- `restorable` is false for `loaded-idle` with `runAtLoad` or `keepAlive` true. Preflight shows `registered-idle-unrestorable`; `execute` refuses with `refused: unrestorable-service`. A `loaded-idle` job without autostart keys is restorable by `bootstrap` and must show no pid for 5 s; a pid is `manual-recovery`. `loaded-running` requires a pid within 10 s or `manual-recovery`. `not-loaded` publishes the plist and does not bootstrap.
- Pause steps: `retire-plist` (section 2.5), `bootout` when loaded, `await-exit` until `print` says `not-loaded` and the managed set is dead (10 s). A managed pid that survives is `partial` at `await-exit`; a foreign pid that appears is `foreign-change`.
- Restore steps in reverse: `publish-plist` from backup bytes with hash check, `bootstrap` per `restorable` rules. `disabledOverride` is compared before and after; a difference is `manual-recovery`. Repeated `restore` with everything already in place is `already-restored`.
- Disable: `retire-plist` is already done by pause; `disable` records `launchd.bootout` as `skipped` when `not-loaded` and completes. The override is never written.

### 3.2 systemd

- Unit path per `control.ts:27`. One `systemctl --user show -p FragmentPath,LoadState,UnitFileState,ActiveState,SubState,MainPID <unit>` plus `is-system-running`. `LoadState=not-found` is the sentinel. `masked`, `static`, `linked`, `activating`, `deactivating`, `reloading` are `unknown`. `FragmentPath` must realpath-equal `unitPath` when loaded.
- Managed set: `MainPID` and `processes.json` pids with the argv identity above. Pause requires the foreign set empty (section 3.4), not the managed set empty.
- Pause: `disable`, `stop`, `await-exit` (ActiveState `inactive` or `failed` and managed set dead, 10 s), `retire-unit`, `daemon-reload`.
- Restore in reverse: `publish-unit` with hash check, `daemon-reload` unconditionally, `enable` if `unitFileState` was `enabled`, `start` if `activeState` was `active`, verify both. A `daemon-reload` that failed once and the file already present on retry continues at `daemon-reload` because the step record says `publish-unit` is `done`.
- Disable: compares `projected` after pause (unit absent, `not-found`); nothing further to remove; completes.

### 3.3 Windows Run key

Supported installation identity table. Any row that does not match makes `chain` `unknown` with `unsupported-installation`, and import refuses before mutation. Windows import is `supported-pending-native-proof`; no receipt or lane claims Windows acceptance until a Windows host runs the native tests, and the status view carries `platformProof: 'none'` on Windows until then.

| Element | Required value |
| --- | --- |
| Run value `feishu-codex-bridge` | exactly `wscript.exe "<bridgeDataRoot>\service-launcher.vbs"` |
| VBS | lines equal to the bridge's `buildLauncherVbs()` output with `<bridgeDataRoot>\service-launcher.cmd` as the only variable; mirrored by current `service/win-startup.ts:95-103` |
| CMD | parsed run line `"<nodePath>" "<scriptPath>" run >> ...`; `scriptPath` ends with `\bin\feishu-codex-bridge.mjs`; `installRoot` is its grandparent; mirrored by current `win-startup.ts:85` |
| `installRoot\package.json` | bounded read, `name` equals `@modelzen/feishu-codex-bridge` |
| Process | `ExecutablePath` equals `nodePath` after case-insensitive normalization; parsed command line is `"<nodePath>" "<scriptPath>" run` with no other tokens before `run` |
| Relaunch task `feishu-codex-bridge-relaunch` | must be `absent`; `present` refuses execute with `refused: relaunch-task-present` and an instruction code to remove it with the bridge's own service command first |

Termination policy. The only termination mechanism is a process handle held for the whole verify-then-kill sequence in a single PowerShell invocation: `$p = Get-Process -Id <pid>`; `$null = $p.Handle` to open and cache the handle; read `$p.StartTime` and `$p.Path` through that handle; compare with the snapshot's `startTime` and `executablePath`; `$p.Kill()`, which .NET performs on the cached handle. The script prints a sentinel per stage. Codex verifies in the Windows native lane that the kill is performed on the held handle and records the .NET version; until that record exists the mechanism is a design requirement, not a proven fact. If `Get-Process` fails, `Handle` is denied, or the comparison fails, the step ends `blocked` and nothing has been deleted yet, because `acquire-handles` precedes `delete-run-value`. Children in `processes.json` are handled the same way, each with its own handle and identity. A live child that fails the identity table is foreign and refuses the import. `taskkill /T` is not used.

- Pause: `acquire-handles` for the main process and each child (blocked on any failure), `delete-run-value` (section 2.5), `kill-main`, `kill-child` each, `await-exit` by `HasExited` on the held handles and a re-read of `processes.json`.
- Restore in reverse: `write-run-value` with `New-ItemProperty` when absent; verify both launcher files' hashes (never rewritten by import; a mismatch is `foreign-change`); `launch` only when all of: origin had a running process, no process matching the identity table exists now, no foreign owner exists, and the handle for the original reports `HasExited`. A surviving original means registration is restored and zero launches happen. Repeated restore is `already-restored`.
- Disable: compares `projected` after pause (Run value absent, process absent); completes. The launcher files stay on disk; the receipt notes them.

### 3.4 Ownership inventory

```ts
export interface OwnershipInventory {
  readonly managed: readonly { pid: number; role: 'service-main' | 'bot-child'; identity: string }[];
  readonly foreign: readonly Occupant[];
  readonly unknown: readonly { probe: ProbeCode; exit: number | null }[];
}
export type Occupant =
  | { kind: 'pending-operation'; file: string }         // update.lock, relaunch-request.*, win-relaunch.json, as control.ts:63-67
  | { kind: 'source-lease'; file: string; pid: number }  // <sourceRoot>/.vonvon-bridge-access/*.json with a live pid, bridge 446b2a4 lease format
  | { kind: 'data-in-use'; file: string; pid: number }   // processes.json, service.pid, web-console.json pid alive and not in managed
  | { kind: 'unmanaged-process'; pid: number }           // bridge argv identity but not in managed
  | { kind: 'other-data-root'; root: string };           // existingDataRoots returns more than one
```

`inventory(sourceHome, sourceRoot, origin)` is read-only and replaces the direct use of `assertKnownOwnersStopped`, which throws on the managed service itself (`control.ts:76-83`). Pause requires `foreign` and `unknown` empty. After pause, `managed` must be empty too. The inventory runs at preflight, before pause, after pause, after copy, and before restore starts anything.

## 4. Model C: executor ledger

File: `packages/daemon/src/import/bridge/execute.ts`, plus `ledger.ts` for the persisted ledger, `inventory.ts` for the confirmed source inventory, and `runtime-port.ts` for the binding to the daemon.

### 4.1 Roots and inputs

```ts
export interface ImportRoots {
  readonly sourceHome: string;      // os.homedir() of the daemon user; service identities and ~/.feishu-codex-bridge derive from it
  readonly sourceRoot: string;      // the single element of existingDataRoots(sourceHome); two elements refuse (other-data-root)
  readonly destRoot: string;        // paths.appDir, VONVON_HOME-resolved; ledger, staging, backups live under destRoot/import/bridge/
  readonly hookFiles: readonly string[];  // sourceHome/.claude/settings.json, sourceHome/.codex/hooks.json
}
```

### 4.2 Ledger

One file `destRoot/import/bridge/ledger.json`, written as temp plus rename, fsync of file then directory, before and after every effect. The transaction directory `destRoot/import/bridge/<txnId>/` holds backups, retired definitions, and staging.

```ts
export type Effect =
  | { kind: 'service'; step: ServiceStep }
  | { kind: 'source.verify-inventory' }
  | { kind: 'stage.copy'; rel: string }
  | { kind: 'bot.reserve'; appId: string } | { kind: 'bot.secret'; appId: string } | { kind: 'bot.config'; appId: string }
  | { kind: 'bot.files'; appId: string } | { kind: 'bot.register'; appId: string } | { kind: 'bot.enable'; appIds: readonly string[] }
  | { kind: 'hooks.backup'; path: string } | { kind: 'hooks.write'; path: string }
  | { kind: 'bot.activate'; appId: string } | { kind: 'bot.connected'; appId: string }
  | { kind: 'marker.write' } | { kind: 'receipt.write' }
  | { kind: 'rollback.bot.stop'; appId: string } | { kind: 'rollback.bot.remove'; appId: string }
  | { kind: 'rollback.hooks.restore'; path: string } | { kind: 'rollback.stage.discard' };

export interface EffectRecord { readonly seq: number; readonly effect: Effect; readonly intent: { at: number; before: unknown }; readonly outcome?: { at: number; state: 'done' | 'failed' | 'skipped' | 'blocked'; after: unknown; code?: ImportFailureCode } }

export interface ImportLedger {
  readonly version: 1; readonly txnId: string; readonly preflightId: string;
  readonly roots: ImportRoots; readonly inventory: ConfirmedInventory; readonly service: ServiceOriginRecord;
  readonly effects: readonly EffectRecord[];
  readonly verify?: { at: number; outcome: 'passed' | 'failed'; code?: ImportFailureCode };
  readonly commitPoint?: number;                  // set when verify passed and the service disable steps are all done
  readonly cancelRequested?: number;
  readonly terminal?: { at: number; state: 'succeeded' | 'rolled-back' | 'manual-recovery' | 'blocked'; code?: ImportFailureCode; instructions?: readonly InstructionCode[] };
}
```

Phase is derived from the effects, never stored separately. `receipt.json` next to the ledger is written only as the last effect and is the lane 5 existing-receipt source.

### 4.3 Effects in order, with recovery rule per effect

| Effect | Does | Before/after recorded | Recovery when intent has no outcome |
| --- | --- | --- | --- |
| `service.*` pause steps | section 3 | adapter observation | adapter compares against `projected` and continues or refuses (section 2.4) |
| `source.verify-inventory` | inventory shows `managed`, `foreign`, `unknown` all empty; each file in `ConfirmedInventory.files` opened `O_NOFOLLOW`, bounded read, hash equals; no file added or removed | per-file hashes | rerun; pure read |
| `stage.copy rel` | write the exact bytes read in the previous effect to `<txnDir>/staging/<rel>` | hash | rerun from staged or re-read; staging is disposable |
| `bot.reserve appId` | registry has no such appId (`loadBots`); `mkdir(botDir(appId))` with exclusive semantics and write `botDir/.import-owned` containing `txnId` with `wx` | registry snapshot | if dir exists with our `.import-owned`, done; if exists without it, `conflict` and refuse |
| `bot.secret appId` | decrypt legacy envelope with `legacy-keystore.ts`, `setSecret(secretKeyForApp(appId), plaintext)` (`config/keystore.ts:107`), zero plaintext | none | rerun; `setSecret` overwrites our own key |
| `bot.config appId` | `buildEncryptedAccountConfig(appId, tenant, preferences)` with preferences copied unchanged from source, then `saveConfig` to `botPaths(appId).configFile`; no owner or admin injection | hash | rerun |
| `bot.files appId` | rename staged `projects.json`, `sessions.json`, `comment-instructions.md` into `botDir` | hashes | compare dest hashes to staging; rerun missing |
| `bot.register appId` | `addBot(entry)` only while `.import-owned` is ours and the registry still lacks the appId | registry before/after | registry contains entry → done |
| `bot.enable appIds` | `setActiveBots(existingActive ∪ importedEnabled)` where `importedEnabled` is the source `enabled` set | both sets | idempotent rerun |
| `hooks.backup path` | copy current hook file bytes to `<txnDir>/backup/` | hash | rerun |
| `hooks.write path` | `convertBridgeHooks` then `publishNoClobber` to a temp and `rename` over the hook file (hooks are user files that may legitimately exist; here rename-over is correct and the backup is the evidence) | before/after hash | current hash equals after → done; equals before → rerun; neither → `foreign-change`, leave it, note for manual recovery |
| `bot.activate appId` | `port.activate(appId)` (section 4.4) must return `applied` | result | query running state; running → done; not running → rerun once |
| `bot.connected appId` | `port.connection(appId)` reports connected within the 60 s shared budget | observation | rerun observation |
| verify decision | all `bot.connected` done, inventory after copy still clean, service still `projected` paused | | derived |
| `service.*` disable steps | section 3 | | adapter rule |
| commit point | written when verify passed and disable steps done | | |
| `marker.write` | `publishNoClobber(sourceRoot/migrated-to-vonvon-bot.json, {version:1, txnId, completedAt, vonvonHome: destRoot})` | | exists with our txnId → done; exists with another → `manual-recovery` |
| `receipt.write` | `receipt.json` | | rerun |

Crash matrix: Codex injects a crash before and after every effect's action, for every effect, and asserts the recovery end state in section 4.6.

### 4.4 Runtime port binding

```ts
export interface ImportRuntimePort {
  registryHas(appId: string): Promise<boolean>;                       // loadBots
  activate(appId: string): Promise<'applied' | 'restart-required' | 'failed'>;   // AdminService.setBotEnabled(appId, true), admin/service.ts:980-991
  connection(appId: string): Promise<'connected' | 'pending' | 'failed'>;        // AdminService.listBots() running + connection, backed by supervisor liveStatus
  stop(appId: string): Promise<'stopped' | 'unconfirmed'>;             // setBotEnabled(appId, false), then runState(appId).running === false and readSingleInstanceHolder(...) === null, 15 s
  remove(appId: string): Promise<void>;                                // removeBot + removeSecret + rm botDir, only when botDir/.import-owned holds our txnId
  gateMutations(txnId: string | null): void;                           // admin/service.ts: registerBotByQr, setBotEnabled, deleteBot for a reserved appId return conflict while set
  invalidateSnapshot(): void;                                          // DaemonApi.invalidate, server/http.ts:52,59
}
```

- The importer runs only in supervisor mode. `activate` returning `restart-required` (no `applyBotActivation`, `admin/service.ts:981`) is `bot-start-failed`. Inline `run --bot` mode never constructs an importer; the RPC returns `refused: unsupported-runtime`.
- `connection` maps the bot status IPC's connection string to the three values. Codex binds the exact literal the bot child reports for a live long connection and records it in the PR; `unknown` maps to `pending`.
- `remove` is the only deletion path and it is ownership-checked by the `.import-owned` marker, so a crash between `bot.register` intent and outcome can never delete a bot the transaction did not create.
- `gateMutations` is the destination serialization. While a transaction is active, admin mutations on any appId in the reservation set return `conflict`; mutations on other appIds proceed. This is a disclosed edit to `admin/service.ts` (section 6).
- Source fencing: the bridge's lease namespace (`vonvon-bridge-v1`, `.vonvon-bridge-access`, review's read of fixture `446b2a4`) differs from the daemon's (`config/data-access.ts:17-22`). The importer does not acquire the bridge mutex. The achievable guarantee is: inventory clean before pause, after pause, and after copy, plus exact-byte verification of the confirmed inventory after quiescence. A bridge writer that appears in any of those windows makes the run `stale-source` and rolls back. No exclusive fence on the source is claimed.

### 4.5 Rollback and roll-forward

Before the commit point, failure, cancel, drain, or crash rolls back in this order, each step an effect with its own record.

1. `rollback.bot.stop` for every `bot.activate` done or intended. `unconfirmed` stops the rollback here: terminal `manual-recovery` with instruction codes, service untouched, old bridge not started.
2. `rollback.bot.remove` for every `bot.reserve` done, through `remove`.
3. `rollback.hooks.restore` for every `hooks.write` done, only when the current hash equals our written hash; otherwise leave and record `foreign-change`.
4. `rollback.stage.discard`.
5. `service.*` restore steps per section 2.4. `foreign-change` or `manual-recovery` from the adapter ends terminal `manual-recovery`.

After the commit point, recovery completes `marker.write` and `receipt.write` and never touches bots or the service. A failed `service.*` disable step after verify passed is before the commit point and rolls back.

### 4.6 Lifecycle binding

- `recoverBridgeImport(roots)` runs in `cli/commands/run.ts runRun` after `ensureRegistry()` and before `runSupervisor` (`run.ts:32-38`), so before any child spawns. It needs files, the service adapters, the registry, and the keystore; it never needs the supervisor. Its outcomes: nothing to do; rolled back (owned registrations removed before the supervisor reads the registry); rolled forward; `manual-recovery` or `blocked` left in the ledger for the UI and CLI to show.
- `createBridgeImporter(deps)` is built inside `runSupervisor` beside `createAdminService` (`bot/supervisor.ts:166`) and passed to `startApi` as `importer`. `startApi` adds `() => importer.drain()` first in its drain list (`server/http.ts:73-79`). `drain()` sets `cancelRequested`, waits for the current effect to end, rolls back if before the commit point or finishes if after, with a 60 s bound per effect; past the bound it leaves the ledger consistent for the next start and resolves.
- `execute` returns `started` after the ledger header and service origin are durable. The importer owns the background promise; a client disconnect changes nothing. `invalidateSnapshot` is called after every `bot.register`, `bot.enable`, `bot.activate`, and rollback effect.
- `cancel` before the commit point sets `cancelRequested`; rollback begins at the next effect boundary. After the commit point it returns `past-point-of-no-return`.

### 4.7 Confirmed inventory and stale confirmation

```ts
export interface ConfirmedInventory {
  readonly preflightId: string; readonly issuedAt: number; readonly sourceRoot: string;
  readonly files: readonly { rel: string; size: number; sha256: Sha256Hex }[];   // exact copy list
  readonly fingerprint: Sha256Hex;        // sha256 over the sorted files tuples
  readonly serviceFingerprint: Sha256Hex; // sha256 over the identity fields of ServiceOriginRecord
}
```

The copy list is exactly: `bots.json` (multi-bot) or `config.json` (flat), `.keystore.salt`, `secrets.enc` when present, and per bot `bots/<appId>/config.json`, `projects.json`, `sessions.json`, `comment-instructions.md` when present. Excluded: `service.pid`, `processes.json`, `web-console.json`, `relaunch-request.*`, `win-relaunch.json`, `update.lock`, logs, `.vonvon-bridge-access/`, the marker, and anything else. External secret references (`source: env|file|exec` in `config.json`) are copied as references; `credentials` reports `external-reference` and the receipt warns.

The daemon holds issued inventories in memory for 15 minutes. `execute` requires the `preflightId` to be held, the request's `fingerprint` to equal the held one, and a fresh capture to equal the held `serviceFingerprint`. Then pause, then `source.verify-inventory` re-reads every file and compares. Any difference rolls back and returns `stale-confirmation` with a fresh preflight. The staged bytes are the bytes that passed verification, not a reopen.

## 5. Model D: wire contract

File: `packages/protocol/src/import.ts`. The root exports it from `index.ts` and registers method `import` in `rpc.ts`. No `events.ts` change; the UI polls `status` once per second while `running`.

Projection boundary: no probe output, command string, hook content, exception message, or credential text crosses the wire. Every human-readable message is rendered by the UI from a code. Paths and pids appear only in typed `detail` fields.

```ts
export const importDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), value: z.string() }), z.object({ kind: z.literal('pid'), value: z.number().int() }),
  z.object({ kind: z.literal('appId'), value: z.string() }), z.object({ kind: z.literal('file'), value: z.string() }),
]);
export const importRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preflight') }).strict(),
  z.object({ type: z.literal('execute'), preflightId: z.string().uuid(), fingerprint: z.string().length(64) }).strict(),
  z.object({ type: z.literal('status') }).strict(),
  z.object({ type: z.literal('cancel'), txnId: z.string().uuid() }).strict(),
]);
export const importSessionViewSchema = z.object({ threadId: z.string(), chatId: z.string(), backend: z.string() });
export const importBotViewSchema = z.object({
  appId: z.string(), name: z.string(), tenant: z.enum(['feishu', 'lark']), enabled: z.boolean(),
  groups: z.array(z.object({ name: z.string(), chatId: z.string(), sessionCount: z.number().int() })),
  sessions: z.array(importSessionViewSchema).max(200), sessionCount: z.number().int(), settingCount: z.number().int(),
});
export const importServiceViewSchema = z.object({
  platform: z.enum(['launchd', 'systemd', 'windows-run', 'unsupported']),
  state: z.enum(['absent', 'registered-stopped', 'registered-running', 'registered-idle-unrestorable', 'unsupported-installation', 'relaunch-task-present', 'unknown']),
  platformProof: z.enum(['native-lanes', 'none']),
});
export const importReceiptViewSchema = z.object({
  txnId: z.string().uuid(), completedAt: z.number(), bots: z.array(z.object({ appId: z.string(), name: z.string(), connectedAt: z.number() })),
  serviceAutostartRemoved: z.literal(true), markerPath: z.string(), warnings: z.array(z.enum(['launcher-files-left', 'external-secret-reference', 'windows-unproven'])),
});
export const importPreflightViewSchema = z.object({
  preflightId: z.string().uuid(), takenAt: z.number(), sourceRoot: z.string(), fingerprint: z.string().length(64),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('not-found') }),
    z.object({ kind: z.literal('invalid'), problem: z.string(), file: z.string() }),
    z.object({ kind: z.literal('multiple-roots'), roots: z.array(z.string()) }),
    z.object({ kind: z.literal('ready'), format: z.enum(['multi-bot-v1', 'legacy-flat']), bots: z.array(importBotViewSchema),
      counts: z.object({ bots: z.number().int(), groups: z.number().int(), sessions: z.number().int(), settings: z.number().int() }) }),
  ]),
  service: importServiceViewSchema,
  credentials: z.enum(['decryptable', 'missing-key', 'invalid-key', 'external-reference', 'not-checked']),
  conflicts: z.array(z.object({ appId: z.string(), reason: z.enum(['bot-exists']) })),
  occupants: z.array(z.object({ kind: z.enum(['pending-operation', 'source-lease', 'data-in-use', 'unmanaged-process', 'other-data-root']), detail: importDetailSchema })),
  existingReceipt: z.object({ receipt: importReceiptViewSchema, currentBots: z.array(z.object({ appId: z.string(), connection: z.enum(['connected', 'pending', 'failed', 'absent']) })) }).optional(),
  oldBridgeObserved: z.boolean(),
  canExecute: z.boolean(),
});
const botProgress = z.object({ appId: z.string(), name: z.string(), connection: z.enum(['pending', 'connected', 'failed']) });
const phase = z.enum(['pause', 'verify-source', 'copy', 'hooks', 'start', 'verify', 'disable', 'marker', 'rollback']);
export const importStatusViewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running'), txnId: z.string().uuid(), startedAt: z.number(), updatedAt: z.number(), phase, bots: z.array(botProgress), cancelRequested: z.boolean() }),
  z.object({ state: z.literal('succeeded'), txnId: z.string().uuid(), startedAt: z.number(), updatedAt: z.number(), receipt: importReceiptViewSchema, oldBridgeObserved: z.boolean() }),
  z.object({ state: z.literal('rolled-back'), txnId: z.string().uuid(), startedAt: z.number(), updatedAt: z.number(), cause: z.enum(['failed', 'cancelled', 'drained', 'crashed']), code: z.string(), detail: importDetailSchema.optional() }),
  z.object({ state: z.literal('manual-recovery'), txnId: z.string().uuid(), startedAt: z.number(), updatedAt: z.number(), phase, code: z.string(), instructions: z.array(z.string()), details: z.array(importDetailSchema) }),
  z.object({ state: z.literal('blocked'), txnId: z.string().uuid(), startedAt: z.number(), updatedAt: z.number(), code: z.string(), details: z.array(importDetailSchema) }),
]);
export const importReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preflight'), preflight: importPreflightViewSchema }),
  z.object({ type: z.literal('execute'), outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('started'), status: importStatusViewSchema }),
    z.object({ kind: z.literal('stale-confirmation'), preflight: importPreflightViewSchema }),
    z.object({ kind: z.literal('already-running'), status: importStatusViewSchema }),
    z.object({ kind: z.literal('existing-receipt'), receipt: importReceiptViewSchema }),
    z.object({ kind: z.literal('refused'), reason: z.enum(['not-ready', 'service-unknown', 'occupied', 'conflict', 'credential', 'unrestorable-service', 'unsupported-installation', 'relaunch-task-present', 'unsupported-runtime']), details: z.array(importDetailSchema) }),
  ]) }),
  z.object({ type: z.literal('status'), status: importStatusViewSchema.nullable() }),
  z.object({ type: z.literal('cancel'), outcome: z.enum(['cancelling', 'not-running', 'past-point-of-no-return']) }),
]);
```

`instructions` and `code` are members of the daemon's `InstructionCode` and `ImportFailureCode` string enums, defined in `import.ts` as zod enums, so the UI maps them to text and never prints a raw string. `succeeded` carries no bot list with a non-connected member because the receipt type admits only connected bots with `connectedAt`. `oldBridgeObserved` is computed read-only on every `status` and `preflight` by the inventory's process scan, which is the lane 7 warning after terminal status.

Authentication is the existing hello credential (`server/ws.ts:68-77`). `preflight` and `status` are `RpcOutcome` `read`; `execute` and `cancel` are `mutation`.

## 6. Routing, client, CLI, UI, and shared edits

- `packages/daemon/src/import/bridge/rpc.ts` (V8) exports `importRpc(importer, payload)`. Root adds `case 'import'` in `server/http.ts` dispatch (`http.ts:143-160`) and `importer` to `startApi` options, plus `() => importer.drain()` in the drain list.
- Root adds the importer construction in `bot/supervisor.ts` beside `createAdminService`, the `recoverBridgeImport` call in `cli/commands/run.ts` before `runSupervisor`, and the `gateMutations` check in `admin/service.ts` at `registerBotByQr`, `setBotEnabled`, and `deleteBot`. These three files are outside V8's original boundary and are disclosed as required shared edits.
- `packages/client/src/client.ts` (root): `bridgeImport(request)` and the `import` entry in `replySchemas`.
- `packages/daemon/src/cli/commands/import.ts` (V8): `vonvon import feishu-codex-bridge [--yes] [--json]` through the local transport; no in-process executor. Root adds the `cli/index.ts` line.
- `packages/ui/src/import/ImportFlow.tsx` (V8-T4): props-less container mapping `ImportReply` to the existing `ImportView`, reusing `ImportPage.tsx`, `import.css`, the test, and `ImportFirstRunStep`. States to map: preflight variants, `stale-confirmation` (re-render list, require new click), `occupied` and `refused` reasons, `running` with cancel, `rolled-back`, `manual-recovery` with instruction codes, `blocked`, reconnect (poll `status` on mount), `existingReceipt` with current connections, and `oldBridgeObserved` warning. Completion shows only on `state: 'succeeded'`.
- `features.ts` and `App.tsx` (root): one feature entry and one first-run render in the empty-bot branch. #185 stays partial until this wiring exists and is verified.

## 7. R1 to R16 and F1 to F7: rule, trace, anchor

| Finding | Rule | Required trace (fake commands, in-memory files, step sink captured) |
| --- | --- | --- |
| R1 origin vs paused comparison | 2.4 projection table | capture, pause, verify, `disable(txn)`: observation equals `projected`, disable completes; same sequence with the unit replaced after pause: `foreign-change`, trace read-only. `pause` twice: second returns continuing from step records, no duplicate mutation. |
| R2 persisted union | 2.2 | round-trip every variant; narrowing to `windows-run` exposes `runValue`, `chain`, `children`; mutated backup yields `backup-mismatch`. |
| R3 rollback order | 4.5 | two bots, A connected, B fails: trace shows `rollback.bot.stop A` done, `rollback.bot.remove A`, then `service.*` restore; `stop A` `unconfirmed`: terminal `manual-recovery`, zero service restore steps. |
| R4 within-phase crash | 4.2, 4.3 | crash between `bot.files` rename and outcome: recovery compares dest hashes to staging and completes or removes via `.import-owned`; crash between `bot.register` intent and `addBot`: recovery removes only directories with our marker; crash after verify passed before `commitPoint`: rollback; after `commitPoint`: marker and receipt written, bots untouched; fsync order asserted by a fake fs that records fsync calls. |
| R5 runtime port | 4.4 | `activate` returns `restart-required`: `bot-start-failed`, rollback; `connection` stays `pending` 60 s: `bot-not-connected`; config preserves source preferences byte-for-byte except the secret reference; QR registration for a reserved appId during import returns `conflict`. |
| R6 managed vs foreign | 3.4 | running systemd bridge with `service.pid` and children in `processes.json`: inventory `managed` non-empty, `foreign` empty, pause proceeds; one extra bridge process not in the managed set: `occupied`, read-only trace. |
| R7 roots and fencing | 1.11, 4.1, 4.4 | `VONVON_HOME` set: ledger path under it; two source roots: `other-data-root` refuses; live `.vonvon-bridge-access` lease: `source-lease` occupant; bridge write between pause and `source.verify-inventory`: `stale-confirmation` and rollback. |
| R8 Windows identity | 3.3 table | fixture chain with `@modelzen/feishu-codex-bridge`: `chain` recognized; package name `feishu-codex-bridge`: `unsupported-installation`; CMD altered after capture: restore `foreign-change`, no launch. |
| R9 duplicate launch | 3.3 restore | kill `blocked` or `failed` with original alive (handle `HasExited` false): restore writes Run value, zero `launch` steps, `restored`; second restore: `already-restored`. |
| R10 relaunch task | 3.3 table | task `present`: preflight `relaunch-task-present`, `canExecute` false, execute `refused`. |
| R11 PID race | 1.5, 3.3 termination | handle acquisition fails: pause ends `blocked` at `acquire-handles` with the Run value still present; identity via handle mismatches: `blocked`; no `taskkill` anywhere in the trace. |
| R12 loaded-idle | 3.1 restorable | `loaded-idle` with `KeepAlive`: preflight `registered-idle-unrestorable`, execute refused before mutation; `loaded-idle` without autostart keys: bootstrap, no pid for 5 s, `restored`; pid appears: `manual-recovery`. |
| R13 no-clobber | 2.5 | plist appears between observation and `publish`: `link` EEXIST, `foreign-change`, new file untouched; `retire` moves a replaced unit: hash mismatch, linked back, `foreign-change`, retired copy kept. |
| R14 confirmed inventory | 4.7 | sessions.json changes after pause: verify fails, rollback, `stale-confirmation`; symlink swapped in: `O_NOFOLLOW` open fails, same outcome; staged bytes equal verified bytes. |
| R15 lifecycle | 4.6 | drain during `copy`: rollback completes before drain resolves; drain after `commitPoint`: marker and receipt written; recovery runs before `runSupervisor` and removes owned registrations so no imported child spawns. |
| R16 projection | 5 | status fixtures: `succeeded` without receipt fails schema; probe stderr containing a secret never appears in any reply field; sessions list capped at 200 with `sessionCount` total; `existingReceipt.currentBots` reflects current connections. |
| F1 | 3.3 pause and restore, 4.5 | as R9 and R11. |
| F2 | 1.1, 3.3 probes | access-denied on every probe: `unknown`, no mutation. |
| F3 | 3.3 table, 1.2 | python argument containing `feishu-codex-bridge run`: `unknown` process identity, refuse. |
| F4 | 3.4 | as R6. |
| F5 | 3.1 | as R12 plus override difference → `manual-recovery`. |
| F6 | 3.2 | `XDG_CONFIG_HOME` non-default: unit path and `FragmentPath` compare there. |
| F7 | 2.4, 2.5 | as R1 and R13. |

## 8. Implementation order and gates

1. V8-T2: `types.ts`, `ledger.ts` step sink, `files.ts`, and the three adapters to sections 2 and 3, with every section 7 trace as a test. Checkpoint: `npm test -w packages/daemon -- import-bridge-service-control` green with trace assertions.
2. V8-T1: `execute.ts`, `ledger.ts`, `inventory.ts`, `runtime-port.ts`, `recoverBridgeImport`, crash matrix before and after every effect. Checkpoint: `npm test -w packages/daemon -- import-bridge`.
3. V8-T3: `protocol/src/import.ts`, `import/bridge/rpc.ts`, `cli/commands/import.ts`. Root applies section 6 shared edits. Checkpoint: typecheck across protocol, client, daemon; CLI preflight against a daemon without bridge data prints `not-found`.
4. V8-T4: `ImportFlow.tsx`; root adds the feature entry and first-run render. Checkpoint: `npm run test -w packages/ui -- import-bridge` plus container tests for every status variant.
5. Gates, none marked passed here: fresh independent review of this exact head before implementation starts; after implementation the ten live lanes in `manzana` `gui/502` and `vonvon-accept` only; perf from ledger `intent.at` timestamps; independent review; exact-head Shipping. Windows has no acceptance and the receipt says so.

## 9. Disclosure for the root PR

- Additive `import` request group in `rpc.ts`; export in `index.ts`; client method `bridgeImport`. No existing shape changes. No `events.ts` change.
- New persisted files under `destRoot/import/bridge/`: `ledger.json`, `receipt.json`, `<txnId>/` backups, retired definitions, staging. New `botDir/.import-owned` marker inside imported bot directories. Marker file content in section 4.3.
- Shared edits beyond V8's original boundary: `server/http.ts` (case, option, drain entry), `bot/supervisor.ts` (importer construction), `cli/commands/run.ts` (recovery call), `admin/service.ts` (`gateMutations` check at three mutation entries), `client.ts`, `cli/index.ts`, `features.ts`, `App.tsx`.
- No merge-edge or graph change. V8 still merges after V4 only.
