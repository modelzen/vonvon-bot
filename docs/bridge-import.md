# Bridge import: service ledger, executor ledger, and wire contract (V8)

Status: proposal for independent review at a new checkpoint after `bad75db8a6eafd9bc58a99bb3d4e40cd6fc5fa74`. Nothing here is approved or frozen until the root records the review verdict. This revision answers B1 to B10 of the exact-head review of that commit and keeps the clarifications that review accepted (scoped Windows package name, VBS plus CMD chain, task-present refusal, survivor no-launch, sessions rows, required receipt, `paths.appDir` roots, XDG path, managed-versus-foreign inventory, stop-before-restore order, commit point). It settles V8-T2 (#183, #225), V8-T3 (#184), and V8-T4 (#185). Bridge fixture facts are the review's reads of `feishu-codex-bridge` at `446b2a40ca75b5f725d7b0baab777b3a8f18b2e0` and `6698118352d7eca87887d3ee1b58736caca204bc`; this worktree does not contain that repository. Source anchors are at the commit above.

The premise the earlier revisions shared was that compare, then rename or delete, plus a backup, is as good as an identity-bound destructive operation, and that an intent and outcome ledger reconciles every crash prefix by itself. Both are false. This revision therefore changes what the importer does, not how firmly it says it:

- **Pause never touches a file.** It uses the service manager's own name-bound operations, which are the only identity-bound operations these platforms offer: `launchctl disable` and `bootout` by service target, `systemctl --user disable --now` by unit name. The definition file stays where it is during the whole import. Restore is `enable` plus `bootstrap` or `start`, again by name.
- **The only file removal happens after the commit point**, as the last cleanup, and its narrower guarantee is stated in section 2.6 together with the one escalation it implies for lane 1.
- **Hooks are rewritten through the inode**, not by rename over a path the user may have replaced.
- **Every effect records what it saw before acting and what it expects after**, and recovery classifies the current state as before, after, or neither. "Neither" never becomes "foreign" by default; it becomes `manual-recovery` with the evidence named.
- **Windows executes nothing in this version.** Preflight is read-only there, `execute` refuses with `platform-unsupported`, and the Windows design in section 3.3 is the specification for a later enablement task that needs native proof and root acceptance before it runs.

Codex implements against these shapes. A deviation that changes a type, a persisted file, a wire field, or a shared-file edit returns here first.

## 1. Rules

1. **Absent is proven, unknown is reported.** `absent` requires exit 0 plus the adapter's own sentinel. launchd's `launchctl print` of a missing service is the one documented nonzero sentinel (section 3.1). Anything else is `unknown`, and `unknown` refuses before mutation.
2. **Identity is positive, fixed, and complete.** Names and paths come from `service/control.ts`. A process is the bridge only when every field of the platform's identity table matches. No substring, no regex over a whole command line.
3. **Mutations are name-bound or inode-bound or they do not happen.** Section 2.6 lists each destructive action with the primitive that binds it and the one action whose binding is incomplete.
4. **Before, after, or neither.** Every effect records `before` and `expectedAfter`. Recovery observes the current state and classifies it. Only `before` and `expectedAfter` are automatic; `neither` is `manual-recovery` with evidence (section 4.4).
5. **Refuse before mutation when exact restoration is not provable.** Section 3 defines the supported definition and state for each platform. Outside it, preflight reports the reason and `execute` refuses.
6. **Stop what we started before we restart what we stopped.** Rollback stops this transaction's imported runtimes with confirmed exit before the old service is restored. Unconfirmed exit ends in `manual-recovery` with the old service untouched and the imported bots quarantined (section 4.6).
7. **No foreign target is ever signaled or moved.** Occupancy refuses; the inventory distinguishes the managed service from foreign owners by pid correlation (section 3.4).
8. **Order holds.** Pause, verify inventory, copy, bots, hooks, start, verify connected, disable autostart (commit point), remove definition, marker, receipt. Original bridge payload data is never modified. The sole writes under the bridge data root are the marker and nothing else; the definition file lives under `~/Library/LaunchAgents` or `$XDG_CONFIG_HOME/systemd/user`, not under the data root.
9. **Destination paths resolve through `paths.appDir`** (`config/paths.ts:6`). The transaction directory lives under it.
10. **Source exclusivity comes from a held capability or the import refuses.** The importer holds the bridge's own admission mutex for the whole run (section 3.5), which stops any new bridge process from entering its data, and requires every existing bridge lease to be dead after pause. Only then is the confirmed byte snapshot a consistent one. A bridge revision without that protocol has no fence; the default is to refuse `execute` with `fence-unavailable`. Accepting a snapshot-only import for such installs is a separate root decision, not this contract's default.
11. **No lane is redefined to claim a pass.** Where this contract declines to perform an action a lane asserts, the lane stays open and the decision is listed in section 9.

## 2. Model A: service ledger

Files: `packages/daemon/src/import/bridge/service-control/types.ts`, `launchd.ts`, `systemd.ts`, `windows.ts`, `inventory.ts`, `files.ts`. The existing uncommitted candidate adapters are revised to this contract.

### 2.1 Origin

```ts
export type Sha256Hex = string & { readonly __brand: 'Sha256Hex' };
export interface FileSnapshot { readonly path: string; readonly bytes: Uint8Array; readonly sha256: Sha256Hex; readonly mode: number; readonly size: number; readonly dev: number; readonly ino: number; }
export type Definition = { readonly kind: 'absent' } | { readonly kind: 'present'; readonly file: FileSnapshot };
export type Observation<T> = { readonly kind: 'observed'; readonly value: T } | { readonly kind: 'unknown'; readonly probe: ProbeCode; readonly exit: number | null };

export type LaunchdJob = { readonly state: 'not-loaded' } | { readonly state: 'loaded-idle' } | { readonly state: 'loaded-running'; readonly pid: number };

export type ServiceOrigin =
  | { readonly platform: 'launchd'; readonly label: 'ai.feishu-codex-bridge.bot'; readonly domain: `gui/${number}`;
      readonly definition: Definition; readonly template: LaunchdTemplate;          // parsed, validated plist (section 3.1)
      readonly loaded: { readonly kind: 'not-loaded' } | { readonly kind: 'loaded'; readonly path: string; readonly program: readonly string[] };   // launchctl print path = and arguments
      readonly job: LaunchdJob; readonly disabledOverride: boolean; }
  | { readonly platform: 'systemd'; readonly unit: 'feishu-codex-bridge.service'; readonly unitPath: string;
      readonly definition: Definition; readonly template: SystemdTemplate;
      readonly loaded: { readonly kind: 'not-found' } | { readonly kind: 'loaded'; readonly fragmentPath: string; readonly execStart: string; readonly dropIns: readonly string[] };
      readonly unitFileState: 'enabled' | 'disabled'; readonly activeState: 'active' | 'inactive'; readonly mainPid: number | null; }
  | { readonly platform: 'windows-run'; readonly runValue: { readonly kind: 'absent' } | { readonly kind: 'present'; readonly command: string };
      readonly chain: WindowsLaunchChain | { readonly kind: 'absent' }; readonly relaunchTask: 'absent' | 'present';
      readonly process: { readonly kind: 'absent' } | { readonly kind: 'running'; readonly identity: WindowsProcessIdentity }; readonly children: readonly WindowsProcessIdentity[]; };

export interface LaunchdTemplate { readonly program: readonly string[]; readonly runAtLoad: boolean; readonly keepAlive: boolean; readonly stdout: string; readonly stderr: string; readonly env: Readonly<Record<string, string>>; }
export interface SystemdTemplate { readonly execStart: string; readonly restart: string; readonly wantedBy: string; readonly env: readonly string[]; }
```

`activeState: 'failed'` and `unitFileState: 'not-found'` with a present file are not in the type. Capture returns `unsupported-state` for them (section 3.2), so `execute` refuses before mutation. The Windows types are kept for preflight display and for the later enablement task; `WindowsLaunchChain` and `WindowsProcessIdentity` are unchanged from the previous revision.

### 2.2 Persisted record

```ts
export interface FileRecord { readonly path: string; readonly sha256: Sha256Hex; readonly mode: number; readonly size: number; readonly dev: number; readonly ino: number; readonly backup: string; }
export type DefinitionRecord = { readonly kind: 'absent' } | { readonly kind: 'present'; readonly file: FileRecord };

export type ServiceOriginRecord =
  | { readonly platform: 'launchd'; readonly label: string; readonly domain: string; readonly definition: DefinitionRecord; readonly template: LaunchdTemplate;
      readonly loaded: { readonly kind: 'not-loaded' } | { readonly kind: 'loaded'; readonly path: string; readonly program: readonly string[] };
      readonly job: LaunchdJob; readonly disabledOverride: boolean }
  | { readonly platform: 'systemd'; readonly unit: string; readonly unitPath: string; readonly definition: DefinitionRecord; readonly template: SystemdTemplate;
      readonly loaded: { readonly kind: 'not-found' } | { readonly kind: 'loaded'; readonly fragmentPath: string; readonly execStart: string; readonly dropIns: readonly string[] };
      readonly unitFileState: 'enabled' | 'disabled'; readonly activeState: 'active' | 'inactive'; readonly mainPid: number | null }
  | { readonly platform: 'windows-run'; readonly runValue: { readonly kind: 'absent' } | { readonly kind: 'present'; readonly command: string };
      readonly chain: { readonly kind: 'absent' } | { readonly kind: 'chain'; readonly vbs: FileRecord; readonly cmd: FileRecord; readonly nodePath: string; readonly scriptPath: string; readonly installRoot: string; readonly packageName: string; readonly command: string };
      readonly relaunchTask: 'absent' | 'present'; readonly process: { readonly kind: 'absent' } | { readonly kind: 'running'; readonly identity: WindowsProcessIdentity }; readonly children: readonly WindowsProcessIdentity[] };
```

`fromRecord` parses with zod, narrows `label`, `domain`, `unit`, `packageName`, and `command` back to their literals, reads each backup, recomputes the hash, and returns `backup-mismatch` on any difference. The backup is written and fsynced, and its directory synced, before the ledger header that references it is written (section 4.3). Round-trip tests cover every variant.

### 2.3 Steps as effects

Service steps are effects in the executor ledger (section 4.2), not a separate step sink. Each has a typed `before` and `expectedAfter`.

| Step | Platform | Primitive | Binding | `before` → `expectedAfter` |
| --- | --- | --- | --- | --- |
| `launchd.disable-override` | launchd | `launchctl disable gui/<uid>/<label>` | label | `disabledOverride:false` → `true` (skipped when already true) |
| `launchd.bootout` | launchd | `launchctl bootout gui/<uid>/<label>` | service target | `loaded` → `not-loaded` |
| `launchd.await-exit` | launchd | poll `print` and managed pids | read-only | managed pids alive → all dead |
| `launchd.enable-override` | launchd | `launchctl enable gui/<uid>/<label>` | label | restore of `disable-override`; skipped when origin was `true` |
| `launchd.bootstrap` | launchd | `launchctl bootstrap gui/<uid> <plist>` | label plus unchanged file | `not-loaded` → origin `job` kind (section 3.1) |
| `systemd.disable-now` | systemd | `systemctl --user disable --now <unit>` | unit name | `enabled/active` → `disabled/inactive`; the unit file is untouched |
| `systemd.await-exit` | systemd | poll `ActiveState`, `MainPID`, managed pids | read-only | → all dead |
| `systemd.enable` | systemd | `systemctl --user enable <unit>` | unit name | restore when origin `enabled` |
| `systemd.start` | systemd | `systemctl --user start <unit>` | unit name | restore when origin `active` |
| `fence.acquire` | both | bind the bridge's admission mutex address (section 3.5) | the bridge's own protocol | not held → held; `EADDRINUSE` is `source-occupied` |
| `fence.release` | both | close the listener | | after terminal state |

There is no `retire`, `publish-plist`, `publish-unit`, or `definition.remove`. No definition file is written, moved, or unlinked by the importer at any point.

### 2.4 Comparison

`projected(origin, effects)` applies every service effect whose outcome is `done`. For an effect whose outcome is missing or `failed`, recovery first runs the classification of section 4.4 against that effect's `before` and `expectedAfter`, records the result, and only then compares. A fresh observation that equals `projected` continues; one that equals `origin` on a restore path is `already-restored`; anything else is `manual-recovery`, never an automatic `foreign-change` label that hides a state the transaction may have produced.

Equality is on `template`, `definition.file.sha256`, `definition.file.ino` and `dev`, `loaded.program` or `loaded.execStart`, `disabledOverride`, `unitFileState`, `activeState`, and `job.state`. Pids and start times are excluded. Because no definition file is ever written, moved, or removed, there is no published-inode case to special-case.

### 2.5 Inventory (`inventory.ts`)

```ts
export interface OwnershipInventory {
  readonly managed: readonly { pid: number; startedAt: number | null; role: 'service-main' | 'bot-child'; evidence: 'manager-pid' | 'processes-json' | 'service-pid' }[];
  readonly foreign: readonly Occupant[];
  readonly unknown: readonly { probe: ProbeCode; exit: number | null }[];
}
export type Occupant =
  | { kind: 'pending-operation'; file: string }                          // update.lock, relaunch-request.*, win-relaunch.json; control.ts:63-67
  | { kind: 'source-lease'; file: string; pid: number }                   // realpath(sourceHome)/.vonvon-bridge-access/*.json, fixture 446b2a4 enterDataAccess(homedir())
  | { kind: 'data-in-use'; file: string; pid: number }                    // processes.json, service.pid, web-console.json pid alive and not managed
  | { kind: 'unmanaged-process'; pid: number }                            // bridge argv identity, not managed
  | { kind: 'other-data-root'; root: string };
```

Managed set: the manager's pid (`launchctl print` pid, `MainPID`) and the pids in `<sourceRoot>/bots/<appId>/processes.json` and `<sourceRoot>/processes.json` whose argv is `<node> <installRoot>/bin/feishu-codex-bridge.mjs run --bot <id>` or `... run`, read with `ps -o pid=,lstart=,command= -p <pid>`. The Vonvon daemon's own pid and its children are excluded by pid. A lease file whose pid is in the managed set is managed, not foreign; the ordinary running service holds one. A lease whose pid is dead is stale and ignored. Pause requires `foreign` and `unknown` empty; after pause, `managed` must be empty too.

### 2.6 Destructive actions and their binding

| Action | When | Binding | What happens on the unbound part |
| --- | --- | --- | --- |
| stop the service | pause | manager, by name | none unbound |
| disable autostart | pause (launchd override), commit (both) | manager, by name | none unbound |
| kill a process | never on launchd or systemd; the manager stops its job and the managed children exit with it, verified by `await-exit` | | a managed child that survives `await-exit` is `partial`; the importer does not signal it; restore proceeds by name and the run ends `manual-recovery` |
| remove the definition file | never, by the importer | none exists. POSIX has no unlink-by-descriptor and no compare-and-unlink; Node exposes neither. Rename-then-verify was rejected because the verify runs on an object already moved. | the file stays. Autostart is already removed by the persistent launchd override and by `systemctl disable`, so the file is inert. The receipt records `definitionRemoved: false` with warning `definition-left-in-place` and instruction `remove-definition-manually` naming the path. Two routes remove it with bound identity: the user runs the bridge's own `service uninstall`, which deletes the file its installer wrote, or the V9 bridge release deletes it on start when it finds the marker. Lane 1's "plist is gone", "unit file is gone", and `LoadState` `not-found` assertions therefore stay open until the root disposes (section 9). |
| write hooks | hooks phase | inode plus immediate content check on the same descriptor: `open(path, O_RDWR\|O_NOFOLLOW)`, `fstat` equals the backup's `dev` and `ino`, read through the fd, hash equals the backup hash taken moments before, convert, write through the same fd, `fsync`, re-read through the same fd and compare | this binds the inode and the content read immediately before the write, but POSIX offers no compare-and-swap on file content and Node has no advisory lock in core, so a writer that writes in place between our read and our write can interleave. No mechanism available to this daemon closes that window. The default is therefore: write only when the same-descriptor hash equals the backup; otherwise reconvert from the new content and retry, three times, then `manual-recovery` with `inspect-hook-file`. A rename-save by an editor replaces the inode and our write becomes harmless. The alternative that needs no user-file write is legacy cooperation: the V9 bridge release makes `feishu-codex-bridge hook` forward to `vonvon hook` when the marker exists. That alternative changes lane 6's assertion and is listed in section 9 for the root. |
| manager operations by label or unit name | pause, restore | the manager's own name-bound primitives | a name binds the registration, not a process. The importer reads the loaded definition's program arguments and pid immediately before `bootout` or `disable --now`, and after it verifies that exactly the recorded managed pids exited and no process with bridge argv appeared. A foreign job that registers under the bridge's fixed label in the window between that read and the command would be stopped by the command; the manager offers no pid-bound stop, and this contract reserves the label for the bridge, so the stated guarantee is label-level and the trace records the before and after pids as evidence. |
| marker | after commit | `open(path, 'wx')` then write and fsync | `EEXIST` with our `txnId` inside is done; with another content it is `manual-recovery` |
| registry entries, bot directories, secrets | section 4.5 | process mutex plus exclusive create or rename onto a non-existent name | none unbound inside the daemon, which is the only writer of its data root by architecture |
| Windows Run value and process | not executed by this candidate | Win32 has no compare-and-delete for a registry value; `RegDeleteValue` and `Remove-ItemProperty` are unconditional. Process termination through a held .NET handle is unproven. | `execute` refuses on `win32`. This is a non-delivery of V8's "all three platforms" build item, not an acceptance (section 3.3 and section 9). |

## 3. Model B: platforms

### 3.1 launchd

- Probes: `/bin/launchctl print gui/<uid>/<label>` for `pid =`, `state =`, `path =`, and the `program`/`arguments` block; `/bin/launchctl print-disabled gui/<uid>`; `lstat` and bounded read of the plist; `/usr/bin/plutil -convert json -o - <plist>`. Sentinel for `not-loaded`: exit 113, or `Could not find service` alone on stderr.
- Supported definition: the parsed plist has exactly the keys the bridge's installer writes (`Label`, `ProgramArguments`, `RunAtLoad`, `KeepAlive`, `StandardOutPath`, `StandardErrorPath`, `EnvironmentVariables`; mirrored by current `service/launchd.ts:44-72`), `Label` equals the fixed label, `ProgramArguments` is `<node> <installRoot>/bin/feishu-codex-bridge.mjs run` or the fixture's equivalent that Codex records from `446b2a4`, `KeepAlive` is a boolean, and no other key. Any other key or shape is `unsupported-definition`.
- Supported state: `loaded.program` equals `template.program` when loaded (the manager runs the definition we see), and `loaded.path` equals the definition path. Otherwise `unsupported-state` (a different definition is loaded under the same label).
- Restorable job states: `not-loaded`; `loaded-running` when `template.runAtLoad` or `template.keepAlive` is true (bootstrap starts it, as the origin was); `loaded-idle` only when both are false (bootstrap loads without starting). `loaded-idle` with either key true is `unrestorable-state`. `loaded-running` with both keys false is `unsupported-state`, because bootstrap would not start it.
- Pause: `disable-override` (skipped when already true), `bootout` when loaded, `await-exit` 10 s. The plist is not touched. Immediately before `bootout` the adapter re-reads `launchctl print` and requires `program` equal to `template.program` and the pid equal to the recorded managed pid; a difference is `unsupported-state` before the command. The label-level guarantee of section 2.6 applies to the window after that read. An origin with `disabledOverride: true` and a loaded job is `unsupported-state`, because `bootstrap` cannot reproduce it.
- Restore in reverse: `bootstrap` when the origin was loaded, verify the job kind within 10 s for `loaded-running` and no pid for 5 s for `loaded-idle`; `enable-override` only when the origin had it false, so a user's preexisting disabled override is never cleared. A pid where none is expected, or none where one is expected, is `manual-recovery`. The override is compared before and after.
- Commit: autostart is removed by the persistent override and the bootout. The plist stays on disk (section 2.6). Lane 1's `launchctl print` failing is satisfied by the bootout; its "plist is gone" assertion is open for the root's disposition.

### 3.2 systemd

- Probes: `systemctl --user show -p FragmentPath,DropInPaths,ExecStart,LoadState,UnitFileState,ActiveState,SubState,MainPID <unit>` and `is-system-running`. `LoadState=not-found` is the sentinel. Transitional states are `unknown`.
- Supported definition: the unit file parses to exactly `[Unit]`, `[Service]`, `[Install]` with the keys the bridge's installer writes (mirrored by current `service/systemd.ts:49-65`), `ExecStart` matches the bridge argv form. `DropInPaths` must be empty and `ExecStart` from the manager must equal the file's; otherwise `unsupported-state`.
- Supported states: `unitFileState` in `enabled`, `disabled`; `activeState` in `active`, `inactive`. `failed`, `masked`, `static`, `linked`, `indirect`, and a present file with `LoadState=not-found` are `unsupported-state`, because `disable --now` and `start` do not reproduce them.
- Pause: `disable-now` (one command; `before` is the pair `enabled/active`, `expectedAfter` is `disabled/inactive`), `await-exit`. Immediately before it the adapter re-reads `ExecStart` and `MainPID` and requires them equal to the recorded values; the label-level guarantee of section 2.6 applies after that read. The unit file is untouched; `FragmentPath` stays valid, so `daemon-reload` is not needed.
- Restore in reverse: `enable` when the origin was `enabled`, `start` when the origin was `active`; verify both. Repeating is `already-restored`.
- Commit: `disable-now` already removed autostart (the manager deletes the wants symlink it owns). The unit file stays (section 2.6), so `LoadState` stays `loaded` and `UnitFileState` `disabled`. Lane 1's `not-found` and "unit file is gone" assertions are open for the root's disposition.

### 3.3 Windows

This candidate does not deliver V8's Windows stop and disable. `execute` on `win32` returns `refused: platform-unsupported` before any mutation; preflight is read-only and classifies the installation. The plan's build item "detect and stop the bridge on all three platforms" is therefore not met for Windows, and this document does not present the refusal as meeting it. The root records the gap in section 9; the Windows follow-up task below is the proposed route, not an accepted scope change.

Why refused, stated as the facts a later task must change: the Run value has no compare-and-delete primitive anywhere in Win32 (`RegDeleteValue`, and therefore `Remove-ItemProperty`, is unconditional; a native helper holding the key handle still races another writer with its own handle), so Run-value removal is a legacy-cooperation or manual step, the same as the POSIX definition file; process termination through a .NET `Process` handle is the only candidate for a bound kill and is unproven; a single PowerShell invocation that holds handles across the executor's ledger writes needs an acknowledgement protocol and a crash story that reacquisition by pid cannot provide; and a helper that dies loses `HasExited` for the original. The enablement task must deliver: a native proof artifact that the kill went through the held handle on a named Windows and .NET version; a helper protocol with per-stage acknowledgements and explicit failure ownership; a Run-value policy that either finds a bound primitive or declares the value's removal a manual step; and root acceptance. Until then the identity table (scoped package `@modelzen/feishu-codex-bridge`, Run value `wscript.exe "<dataRoot>\service-launcher.vbs"`, VBS and CMD templates equal to the bridge's `buildLauncherVbs` and `buildLauncherCmd` output modulo paths, `installRoot\bin\feishu-codex-bridge.mjs run`) is a preflight classifier only. `platformProof` on the wire is a display of this state; the refusal is the enforcement.

### 3.4 Managed versus foreign

The inventory of section 2.5 is the only occupancy check. `assertKnownOwnersStopped` (`service/control.ts:61-95`) is not used, because it rejects the managed service's own `service.pid` and lease. Managed means pid-correlated to the manager's job or to a `processes.json` holder with bridge argv; everything else alive is foreign and refuses.

### 3.5 Source fence through the bridge's own admission protocol

The bridge at fixture `446b2a4` enters its data through `enterDataAccess(homedir())` (`src/cli/index.ts:16-22`), which first acquires an admission mutex and then writes a lease under `realpath(home)/.vonvon-bridge-access` (`src/config/data-access.ts:18-23,53,81-105`). The mutex is a loopback listener whose address is derived from `vonvon-bridge-v1:admission:<normalized realpath(home)>`, exactly as the daemon's own `coordinationAddress` does for its namespace (`config/data-access.ts:17-22`). A bridge process that cannot bind it within its timeout fails to enter. That is a real exclusion primitive, and it belongs to the bridge's protocol, not to this importer's invention.

- `fence.acquire`: the importer computes the bridge's address from the fixture's constants, which Codex binds verbatim from `446b2a4` and records in the PR, and binds it with the same exclusive listener. `EADDRINUSE` means a bridge process is inside admission right now: `source-occupied`, refuse. Held for the whole transaction and released at terminal state. Recovery re-acquires it before any effect.
- With the fence held: no new bridge process can enter its data for the rest of the run. Existing ones are visible as leases with live pids. After pause, every lease pid must be dead (managed ones exit with the service; a foreign live one refused earlier). From that point until release, the source has no writer, so the byte verification of section 4.7 verifies a consistent snapshot, not merely a repeated hash. A bridge `hook` or CLI invocation during the run fails its own admission and reports that to the user; it does not corrupt the import.
- Applicability: the protocol exists from the bridge revision that introduced `data-access.ts`; the review found that file absent at `6698118`. Preflight reads the installed bridge's `package.json` version and compares it to the first version carrying the protocol, which Codex determines from the bridge repository history and records as a constant. Older installs report `fence: unavailable` and `execute` refuses with `fence-unavailable` and instruction `upgrade-bridge-first`. Accepting a snapshot-only import for them is a root decision listed in section 9, not this contract's default.
- What the fence does not do: it does not stop a non-bridge program from editing `~/.feishu-codex-bridge`, and it does not bind the service manager's label operations to a process (section 2.6). Both are stated, not hidden.

## 4. Model C: executor ledger

Files: `packages/daemon/src/import/bridge/execute.ts`, `ledger.ts`, `inventory.ts` (confirmed source inventory), `runtime-port.ts`, `recover.ts`.

### 4.1 Roots

```ts
export interface ImportRoots {
  readonly sourceHome: string;                       // os.homedir(); leases, hooks, and service identities derive from it
  readonly sourceRoot: string;                       // single element of existingDataRoots(sourceHome); realpath, dev, ino recorded
  readonly destRoot: string;                         // paths.appDir
  readonly txnDir: string;                           // destRoot/import/bridge/<txnId>
  readonly hookFiles: readonly string[];             // sourceHome/.claude/settings.json, sourceHome/.codex/hooks.json
}
```

### 4.2 Ledger

```ts
export type Effect =
  | { kind: 'service'; step: ServiceStep }
  | { kind: 'source.verify-inventory' } | { kind: 'stage.copy'; rel: string }
  | { kind: 'wrapper.ensure' }
  | { kind: 'bot.prepare'; appId: string } | { kind: 'bot.secret'; appId: string } | { kind: 'bot.place'; appId: string }
  | { kind: 'bot.register'; appId: string } | { kind: 'bot.enable'; appIds: readonly string[] }
  | { kind: 'hooks.backup'; path: string } | { kind: 'hooks.write'; path: string }
  | { kind: 'bot.activate'; appId: string } | { kind: 'bot.connected'; appId: string }
  | { kind: 'marker.write' } | { kind: 'receipt.write' }
  | { kind: 'rollback.bot.stop'; appId: string } | { kind: 'rollback.bot.unregister'; appId: string }
  | { kind: 'rollback.bot.secret-remove'; appId: string } | { kind: 'rollback.bot.quarantine-dir'; appId: string }
  | { kind: 'rollback.hooks.restore'; path: string } | { kind: 'rollback.stage.discard' };

export interface EffectRecord<B = unknown, A = unknown> {
  readonly seq: number; readonly effect: Effect;
  readonly intent: { readonly at: number; readonly before: B; readonly expectedAfter: A };
  readonly outcome?: { readonly at: number; readonly state: 'done' | 'failed' | 'skipped' | 'blocked'; readonly observed: A | B | unknown; readonly code?: ImportFailureCode };
  readonly reconciled?: { readonly at: number; readonly classified: 'before' | 'after' | 'neither' };
}
export interface ImportLedger {
  readonly version: 1; readonly txnId: string; readonly preflightId: string;
  readonly roots: ImportRoots; readonly inventory: ConfirmedInventory; readonly service: ServiceOriginRecord;
  readonly effects: readonly EffectRecord[];
  readonly verify?: { at: number; outcome: 'passed' | 'failed'; code?: ImportFailureCode };
  readonly commitPoint?: number;
  readonly cancelRequested?: number;
  readonly terminal?: { at: number; state: 'succeeded' | 'rolled-back' | 'manual-recovery' | 'blocked' | 'refused'; code?: ImportFailureCode; instructions?: readonly InstructionCode[]; evidence?: readonly ImportDetail[] };
}
```

`before` and `expectedAfter` are typed per effect kind in code (a `Record<Effect['kind'], { before: ...; after: ... }>` map), not `unknown`; the generic here is notation.

### 4.3 Durability

- The ledger is written as `ledger.json.tmp-<uuid>` with `wx`, `fsync`, `rename`, directory `fsync`. On Windows directory `fsync` is unavailable (`config/keystore.ts:25-29`); Windows does not execute, so this does not arise in V8.
- Every file the ledger references (backups, staging files, the removed definition) is written, fsynced, and its directory synced before the ledger record that references it is written. `syncPath(file)` in `files.ts` opens and fsyncs the file and its parent.
- Every daemon helper the importer calls that writes without fsync is followed by `syncPath` on the file it wrote before the outcome is recorded: `saveBots` (`config/bots.ts:52-57`), `saveConfig` (`config/store.ts:74-82`), `ensureSecretsGetterWrapper` (`store.ts:53-67`). The keystore syncs its own writes (`keystore.ts:69-74`). The outcome record of an effect is therefore never durable before the effect's data.

### 4.4 Reconciliation

For every effect, recovery or retry observes the current state of the effect's target and classifies it:

- equals `before`: the action did not take effect. Redo it (idempotent actions) or, on rollback, nothing to undo.
- equals `expectedAfter`: the action took effect. Record `outcome: done` and continue.
- neither: record `reconciled: neither`, stop automatic processing, terminal `manual-recovery` with the effect, both expected states, and the observed state as evidence. The old service is not restored from this state unless its own classification is `before` or `after`, because restoring by name is safe when the manager state is one of the two known states and unsafe to reason about otherwise.

A `failed` outcome is classified the same way before anything else runs, because a command that returned nonzero may have changed state. Rollback effects have `before` and `expectedAfter` too and are classified on retry.

Per-effect targets and states:

| Effect | `before` | `expectedAfter` | Notes |
| --- | --- | --- | --- |
| `service.fence.acquire` | not held | listener bound | `EADDRINUSE` is `source-occupied`; recovery re-acquires first |
| `service.*` | section 2.3 | section 2.3 | |
| `source.verify-inventory` | fence held, every lease pid dead, root `dev,ino` unchanged | per-file hashes equal | read-only; rerun |
| `stage.copy rel` | staging absent | staging file hash equals confirmed | on rerun the staged or re-read bytes must equal the confirmed hash or the run is `stale-source` |
| `wrapper.ensure` | wrapper hash or absent | wrapper hash | daemon-owned idempotent file rewritten by every registration (`store.ts:53-67`); not rolled back |
| `bot.prepare appId` | `<txnDir>/bots/<appId>` absent | directory with `.import-owned` (txnId), `config.json`, `projects.json`, `sessions.json`, `comment-instructions.md` as applicable | entirely inside `txnDir`; a crash leaves a partial directory that is discarded and redone |
| `bot.secret appId` | `getSecret(key)` undefined | `getSecret(key)` defined | a defined `before` is `conflict: orphan-secret` and refuses before writing |
| `bot.place appId` | `destRoot/bots/<appId>` absent (lstat ENOENT) | directory present with our `.import-owned` | one `rename(txnDir/bots/<appId>, destRoot/bots/<appId>)` under the registry mutex (section 4.5); `ENOTEMPTY` or `EEXIST` is `conflict`; present with our marker is `after`; present without our marker is `neither` |
| `bot.register appId` | registry lacks appId | registry has our entry (deep-equal) | under the registry mutex; `addBot` (`bots.ts:132-139`) |
| `bot.enable appIds` | current active set | current active set ∪ imported enabled | under the registry mutex; computed from the current set at the time of the write, so a user's concurrent decision about another bot is kept |
| `hooks.backup path` | current file `dev,ino,sha256` or absent | backup file present | |
| `hooks.write path` | backup `dev,ino,sha256`, re-checked on the same descriptor immediately before writing | same inode, converted hash, re-read on the same descriptor | section 2.6; a hash change before the write reconverts from the new content; after three changes `manual-recovery` |
| `bot.activate appId` | not running | running (supervisor child present) | trusted capability, section 4.5 |
| `bot.connected appId` | pending | connected | observation only |
| `marker.write` | absent | present with our txnId | `wx` |
| `receipt.write` | absent | present | |
| `rollback.bot.stop appId` | running | holder absent and child exited | trusted capability; `unconfirmed` stops rollback |
| `rollback.bot.unregister appId` | registry has our entry | registry lacks appId | under mutex; a different entry is `neither` |
| `rollback.bot.secret-remove appId` | defined and `bot.secret.before` was undefined | undefined | skipped when `bot.secret` recorded a prior value, which cannot happen because that refuses |
| `rollback.bot.quarantine-dir appId` | present with our marker | `destRoot/bots/<appId>` absent, directory under `<txnDir>/quarantine/` | `rename`, never `rm -rf` on the live path |
| `rollback.hooks.restore path` | converted hash on the backup inode | backup hash on the same inode | inode write; a different inode or hash is `neither` |

### 4.5 Destination ownership and the runtime port

The daemon is the only writer of `destRoot` by architecture, so destination contention is intra-process and a process mutex is sufficient. `config/bots.ts` gains `withRegistry<T>(fn)` (an async mutex) and a reservation set `reserveAppId(appId, owner)`, `releaseAppId(appId, owner)`. `addBot`, `removeBot`, `setActiveBots`, and `setCurrent` run inside `withRegistry` and throw `RegistryReservedError` for a reserved appId unless the caller passes the owner token. `bot/register-bot.ts` checks the reservation under `withRegistry` after credential validation and before `setSecret` (`register-bot.ts:97-103`), so a QR registration for a reserved appId fails before it writes a secret or a config into a directory the import prepared. `admin/service.ts` needs no entry-point gate; its writes go through these helpers. Both files are root-written shared edits (section 6).

```ts
export interface ImportRuntimePort {
  activate(appId: string): Promise<'running' | 'failed'>;               // supervisor applyBotActivation capability, bot/supervisor.ts:172-211, passed directly, not via AdminService
  connection(appId: string): Promise<'connected' | 'pending' | 'failed'>;  // supervisor liveStatus, supervisor.ts:235-246; exact literal bound by Codex and recorded in the PR
  stop(appId: string): Promise<'stopped' | 'unconfirmed'>;             // supervisor stopBot(child) awaited, then readSingleInstanceHolder(appId, botPaths(appId).processesFile) === undefined, 15 s
  invalidateSnapshot(): void;                                          // DaemonApi.invalidate
}
```

The importer is constructed in `runSupervisor` with these capabilities closed over the supervisor's `children` map, so it is not subject to the reservation gate and does not pass through `AdminService.setBotEnabled` or `activationQueue`. `activate` returns `failed` when the supervisor is shutting down; the importer treats that as a rollback trigger (section 4.6).

Enabled semantics, decided: imported bots keep their source `enabled` flag. `bot.activate` and `bot.connected` run only for enabled ones. Disabled ones are registered and listed in the receipt as `registered-disabled`. Verify requires every enabled imported bot connected. The plan's "every bot connected" is read as every bot the source had enabled; the preflight shows the flag per bot so the user sees which will start.

Credentials, per variant of `accounts.app.secret` in the source config (`preflight.ts:20-23`):

| Source form | Transformation | `credentials` |
| --- | --- | --- |
| inline string | `setSecret(secretKeyForApp(appId), value)`; config secret becomes `{ source: 'exec', provider: 'bridge', id }` | `decryptable` |
| `{ source: 'exec', provider: 'bridge', id }` with an envelope in staged `secrets.enc` | decrypt with the staged `.keystore.salt` and `legacy-keystore.ts`, then as above | `decryptable`, or `missing-key` / `invalid-key` |
| `{ source: 'env' \| 'file', ... }` | copied unchanged; no keystore write | `external-reference`, receipt warning |
| any other `exec` reference | refuse `credential: unsupported-reference` | `unsupported-reference` |

The config written by `bot.prepare` is the source config object with `accounts.app.secret` replaced as above and `secrets.providers.bridge` set to the daemon's provider spec (the object `buildEncryptedAccountConfig` emits, `store.ts:38-45`), every other field preserved byte-for-byte as JSON. `buildEncryptedAccountConfig` itself is not called, so no owner, admin, or network field is invented; the one side effect it would have had is the explicit `wrapper.ensure` effect.

### 4.6 Lifecycle and recovery

- **Construction.** `createBridgeImporter(deps)` is built in `runSupervisor` before `startApi` and passed as `importer` to `startApi`, which passes it to `importRpc`. `startApi`'s drain list is not changed; the importer is shut down by the supervisor, below.
- **Shutdown order.** In the supervisor's `finally` (`supervisor.ts:261-269`) the first awaited statement becomes `await importer.shutdown()`, before `shuttingDown = true`, before `api.beginDrain`, and before the children are stopped. `shutdown()` sets `cancelRequested`, waits for the current effect to settle (effects are bounded: file operations carry timeouts, manager commands 10 s, activation 12 s, stop 15 s), then rolls back if before the commit point or finishes marker and receipt if after. There is no abandon-after-timeout branch; the importer joins its effect. If the host's own shutdown grace expires first, the process exits at an effect boundary at worst mid-effect, and recovery classifies at next start. `drain` on the API therefore sees no running import.
- **Recovery before the supervisor.** `recoverBridgeImport(roots)` runs in `runRun` after `ensureRegistry()` and before `runSupervisor`; `runRun` re-reads the registry after recovery and passes the fresh one to `runSupervisor` (`run.ts:32-38` currently reuses the pre-recovery object; this is a named shared edit). Recovery needs files, the service adapters, the registry mutex, and the keystore. It never needs the supervisor.
- **Crash orphans.** For every `bot.activate` with intent, recovery reads `readSingleInstanceHolder(appId, botPaths(appId).processesFile)` (`core/single-instance.ts:93-108`, pid plus start time with reuse check). A live holder is a running imported bot that this daemon no longer owns a handle for. Recovery does not signal it. It quarantines: `setActiveBots(current minus those appIds)` under the mutex so the supervisor will not spawn a second instance, leaves the registry entries and directories in place, records terminal `manual-recovery` with instruction `stop-orphaned-bot` and the pids, and leaves the old service untouched. A dead holder lets rollback continue.
- **Roll-forward after the commit point.** Recovery re-acquires the fence, completes `marker.write` and `receipt.write`, releases the fence, and never touches bots or definition files.
- **Admission.** `execute` while a transaction exists returns `already-running`. `importRpc` is total: every exception inside it becomes a reply with code `internal` and a server-side log line; nothing reaches the generic `Error.message` paths in `server/http.ts:163-166`.

### 4.7 Confirmed inventory

```ts
export interface ConfirmedInventory {
  readonly preflightId: string; readonly issuedAt: number;
  readonly sourceRoot: { path: string; dev: number; ino: number };
  readonly layout: 'multi-bot-v1' | 'legacy-flat';
  readonly files: readonly { rel: string; size: number; sha256: Sha256Hex }[];
  readonly fingerprint: Sha256Hex; readonly serviceFingerprint: Sha256Hex;
}
```

Copy list. `multi-bot-v1`: `bots.json`, `.keystore.salt`, `secrets.enc`, and per bot `bots/<appId>/config.json`, `projects.json`, `sessions.json`, `comment-instructions.md`. `legacy-flat`: `config.json`, `projects.json`, `sessions.json`, `comment-instructions.md`, `.keystore.salt`, `secrets.enc` (`preflight.ts:234-246` reads these at the root for flat). Optional files are listed when present; presence is part of the fingerprint, so an added or removed optional file is a change. Excluded: `service.pid`, `processes.json`, `web-console.json`, `relaunch-request.*`, `win-relaunch.json`, `update.lock`, logs, the marker, and everything else.

Verification after pause: `lstat(sourceRoot)` must match `dev,ino`; each path's components are re-checked for symlinks as preflight does (`preflight.ts:146-169`); each file is opened `O_NOFOLLOW`, read bounded, hashed, and must equal. The bytes that passed are the bytes staged. Decryption reads `secrets.enc` and `.keystore.salt` from staging, hooks conversion reads the hook file through its fd (section 2.6), never a reopened source path. Any mismatch rolls back and returns `stale-confirmation` with a fresh preflight. The daemon holds issued inventories for 15 minutes.

The guarantee this gives, with the section 3.5 fence held and every lease dead after pause, is a consistent snapshot of the source as of pause, verified byte for byte against what the user confirmed. Without the fence the import does not run.

## 5. Model D: wire

File: `packages/protocol/src/import.ts`. Root exports it from `index.ts` and registers method `import` in `rpc.ts`. No `events.ts` or `domain.ts` change.

Code-only boundary. Every string that could carry probe output, a command, a path the user did not already know, an exception, or credential text is replaced by a member of one of these enums. Paths and pids travel only in `ImportDetail`.

```ts
export const importFailureCodes = ['service-unknown','service-occupied','stale-source','credential-missing-key','credential-invalid-key','credential-unsupported-reference',
  'copy-failed','hooks-refused','hooks-inode-changed','bot-conflict','orphan-secret','bot-start-failed','bot-not-connected','disable-failed','fence-unavailable','source-occupied',
  'marker-conflict','unrestorable-state','unsupported-definition','unsupported-state','relaunch-task-present','platform-unsupported','unsupported-runtime','orphaned-bot','internal'] as const;
export const instructionCodes = ['stop-orphaned-bot','restore-definition-manually','remove-definition-manually','inspect-hook-file','rerun-preflight','remove-relaunch-task','upgrade-bridge-first'] as const;
export const sourceProblems = ['source-path','unsafe-path','missing-file','unsafe-file','too-large','invalid-encoding','invalid-json','invalid-schema','timed-out'] as const;   // preflight.ts:127
export const importDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), value: z.string() }), z.object({ kind: z.literal('pid'), value: z.number().int() }),
  z.object({ kind: z.literal('appId'), value: z.string() }), z.object({ kind: z.literal('file'), value: z.string() }),
  z.object({ kind: z.literal('effect'), value: z.string() }),
]);
export const importRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preflight') }).strict(),
  z.object({ type: z.literal('execute'), preflightId: z.string().uuid(), fingerprint: z.string().length(64) }).strict(),
  z.object({ type: z.literal('status') }).strict(),
  z.object({ type: z.literal('cancel'), txnId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('acknowledge'), txnId: z.string().uuid() }).strict(),     // hides a terminal transaction from first-run; ledger keeps it
]);
export const importSessionViewSchema = z.object({ threadId: z.string(), chatId: z.string(), backend: z.string() });
export const importBotViewSchema = z.object({
  appId: z.string(), name: z.string(), tenant: z.enum(['feishu', 'lark']), enabled: z.boolean(),
  groups: z.array(z.object({ name: z.string(), chatId: z.string(), sessionCount: z.number().int() })),
  sessions: z.array(importSessionViewSchema).max(200), sessionCount: z.number().int(), settingCount: z.number().int(),
  credentials: z.enum(['decryptable', 'missing-key', 'invalid-key', 'external-reference', 'unsupported-reference', 'not-checked']),
});
export const importServiceViewSchema = z.object({
  platform: z.enum(['launchd', 'systemd', 'windows-run', 'unsupported']),
  state: z.enum(['absent', 'registered-stopped', 'registered-running', 'unrestorable-state', 'unsupported-definition', 'unsupported-state', 'relaunch-task-present', 'platform-unsupported', 'unknown']),
  platformProof: z.enum(['native-lanes', 'none']),
  fence: z.enum(['available', 'unavailable', 'occupied']),
});
const botCurrent = z.object({ appId: z.string(), name: z.string(), enabled: z.boolean(), connection: z.enum(['connected', 'pending', 'failed', 'absent']) });
export const importReceiptViewSchema = z.object({
  txnId: z.string().uuid(), completedAt: z.number(),
  bots: z.array(z.object({ appId: z.string(), name: z.string(), outcome: z.enum(['connected', 'registered-disabled']), connectedAt: z.number().optional() })),
  serviceAutostartRemoved: z.literal(true), definitionRemoved: z.literal(false), definitionPath: z.string(), markerPath: z.string(),
  warnings: z.array(z.enum(['external-secret-reference', 'definition-left-in-place'])),
});
export const importPreflightViewSchema = z.object({
  preflightId: z.string().uuid(), takenAt: z.number(), sourceRoot: z.string(), fingerprint: z.string().length(64),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('not-found') }),
    z.object({ kind: z.literal('invalid'), problem: z.enum(sourceProblems), file: z.string() }),
    z.object({ kind: z.literal('multiple-roots'), roots: z.array(z.string()) }),
    z.object({ kind: z.literal('ready'), format: z.enum(['multi-bot-v1', 'legacy-flat']), bots: z.array(importBotViewSchema),
      counts: z.object({ bots: z.number().int(), groups: z.number().int(), sessions: z.number().int(), settings: z.number().int() }) }),
  ]),
  service: importServiceViewSchema,
  conflicts: z.array(z.object({ appId: z.string(), reason: z.enum(['bot-exists', 'orphan-secret']) })),
  occupants: z.array(z.object({ kind: z.enum(['pending-operation', 'source-lease', 'data-in-use', 'unmanaged-process', 'other-data-root']), detail: importDetailSchema })),
  existingReceipt: z.object({ receipt: importReceiptViewSchema, current: z.array(botCurrent) }).optional(),
  oldBridgeObserved: z.boolean(),
  canExecute: z.boolean(), refusal: z.enum(importFailureCodes).optional(),
});
const phase = z.enum(['pause', 'verify-source', 'copy', 'bots', 'hooks', 'start', 'verify', 'disable', 'cleanup', 'rollback']);
const common = { txnId: z.string().uuid(), startedAt: z.number(), updatedAt: z.number(), oldBridgeObserved: z.boolean() };
export const importStatusViewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running'), ...common, phase, bots: z.array(botCurrent), cancelRequested: z.boolean() }),
  z.object({ state: z.literal('succeeded'), ...common, receipt: importReceiptViewSchema, current: z.array(botCurrent) }),
  z.object({ state: z.literal('rolled-back'), ...common, cause: z.enum(['failed', 'cancelled', 'shutdown', 'crashed']), code: z.enum(importFailureCodes), details: z.array(importDetailSchema) }),
  z.object({ state: z.literal('manual-recovery'), ...common, phase, code: z.enum(importFailureCodes), instructions: z.array(z.enum(instructionCodes)), details: z.array(importDetailSchema) }),
  z.object({ state: z.literal('blocked'), ...common, code: z.enum(importFailureCodes), details: z.array(importDetailSchema) }),
]);
export const importReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preflight'), preflight: importPreflightViewSchema }),
  z.object({ type: z.literal('execute'), outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('started'), status: importStatusViewSchema }),
    z.object({ kind: z.literal('stale-confirmation'), preflight: importPreflightViewSchema }),
    z.object({ kind: z.literal('already-running'), status: importStatusViewSchema }),
    z.object({ kind: z.literal('existing-receipt'), receipt: importReceiptViewSchema, current: z.array(botCurrent) }),
    z.object({ kind: z.literal('refused'), code: z.enum(importFailureCodes), details: z.array(importDetailSchema) }),
  ]) }),
  z.object({ type: z.literal('status'), status: importStatusViewSchema.nullable() }),
  z.object({ type: z.literal('cancel'), outcome: z.enum(['cancelling', 'not-running', 'past-point-of-no-return']) }),
  z.object({ type: z.literal('acknowledge'), outcome: z.enum(['acknowledged', 'not-terminal']) }),
]);
```

Semantics the schema now encodes: `succeeded` carries the historical `receipt` and a separately observed `current`; the UI shows "imported" from the receipt and "all connected" only when every enabled `current` entry is `connected`, so a daemon restart after success shows "reconnecting", not a false live success. `oldBridgeObserved` is on every status and preflight reply and is computed read-only by the inventory's process scan. `acknowledge` lets the first-run step hide a terminal transaction without deleting the ledger.

Lifetimes: the UI polls `status` once per second while `running`, every 10 s while the import page or first-run step is mounted and the last state is terminal and unacknowledged, and stops after `acknowledge`. The first-run step is rendered by `App.tsx` unconditionally at the top of the main view and renders nothing when `status` is null and preflight is `not-found` or acknowledged; it is not tied to the empty-bot branch, so `bot.register` invalidating the snapshot does not unmount it. Lane 7's warning is the `oldBridgeObserved` flag on the import page and on the first-run step while either is mounted.

Authentication is the existing hello credential (`server/ws.ts:68-77`). `preflight` and `status` are `RpcOutcome` `read`; `execute`, `cancel`, and `acknowledge` are `mutation`.

## 6. Routing, client, CLI, UI, shared edits

- `packages/daemon/src/import/bridge/rpc.ts` (V8) exports `importRpc(importer, payload)`; root adds `case 'import'` in `server/http.ts` dispatch and `importer` to `startApi` options. No drain-list change.
- Root edits `bot/supervisor.ts` (construct the importer with the three capabilities before `startApi`; `await importer.shutdown()` first in `finally`), `cli/commands/run.ts` (call `recoverBridgeImport` after `ensureRegistry`, re-read the registry before `runSupervisor`), `config/bots.ts` (`withRegistry`, reservations, `syncPath` after `saveBots`), `bot/register-bot.ts` (reservation check under `withRegistry` before `setSecret`). `admin/service.ts` is not edited.
- `packages/client/src/client.ts` (root): `bridgeImport(request)` and the `import` entry in `replySchemas`.
- `packages/daemon/src/cli/commands/import.ts` (V8): `vonvon import feishu-codex-bridge [--yes] [--json]` through the local transport; no in-process executor. Root adds the `cli/index.ts` line.
- `packages/ui/src/import/ImportFlow.tsx` and `ImportFirstRunStep` container logic (V8-T4): map every reply variant above; completion requires `succeeded` plus all enabled `current` connected. The existing `ImportPage.tsx`, `import.css`, and tests are reused.
- `features.ts` and `App.tsx` (root): one feature entry; one unconditional render of the first-run step at the top of the main view.

## 7. B1 to B10 disposition, with traces

| Finding | Design change | Required trace (fakes, in-memory files, effect records captured) |
| --- | --- | --- |
| B1 destructive compare-then-mutate | Pause and commit use manager name-bound operations only. No definition file is written, moved, or removed by the importer, ever. Hooks are written through the inode with a same-descriptor content check immediately before the write; the content-CAS impossibility and the V9 cooperation alternative are stated. Windows registry deletion does not execute. | Whole-run trace on launchd and systemd contains no `rename`, `unlink`, or `link` on a definition path. Hook content changed between backup and the pre-write check: no write, reconvert, retry; three changes end `manual-recovery`. Hook replaced by rename-save: write lands on the old inode, same-descriptor re-read still matches, path re-stat shows a new inode, step retries on the new file. |
| B2 unfinished or failed actions | Section 4.4 before/after/neither classification for every effect, including `failed` outcomes and rollback effects; projection applies classification first. No republished inode case exists. | `systemd.disable-now` done, crash before outcome: recovery observes `disabled/inactive`, classifies `after`, continues. `hooks.write` done, crash before outcome, then rollback: classified `after`, `rollback.hooks.restore` runs. `bot.place` rename done, crash before outcome: directory present with our marker, classified `after`. Observed state matching neither: `manual-recovery`, no further automatic effect. |
| B3 ownership and durability | `bot.prepare` builds the whole directory inside `txnDir`; `bot.place` is one rename onto a non-existent name under the mutex. `bot.secret` refuses on a defined prior value. `wrapper.ensure` is an explicit effect. Rollback is four effects, each classified. `syncPath` after every helper write. | Crash between `mkdir` and marker inside `txnDir`: discarded and redone, destination untouched. Existing orphan secret: `conflict: orphan-secret`, no write. Fake fs records fsync calls: every referenced file and its directory synced before the ledger record; `saveBots`, `saveConfig`, wrapper followed by `syncPath`. Crash after `rollback.bot.unregister`, before `secret-remove`: retry classifies unregister `after`, continues. |
| B4 gate versus port, registry races, enabled semantics, credentials | Importer uses supervisor capabilities directly; reservations live in `config/bots.ts` and are enforced in the helpers and in `register-bot.ts` before `setSecret`; whole-registry writes serialize under `withRegistry`; `bot.enable` computes from the current set; disabled bots are registered not activated; four credential variants. | QR registration for a reserved appId: fails under the mutex before `setSecret`. Concurrent `setActiveBots` for another bot during `bot.enable`: both writes serialized, the other bot's decision preserved. Source bot `enabled:false`: registered, not activated, receipt `registered-disabled`, verify passes without it. `env` secret reference copied unchanged with warning; unknown `exec` provider refused. |
| B5 lease path and quiescence | Leases read from `realpath(sourceHome)/.vonvon-bridge-access`, pid-correlated to the managed set. The bridge's admission mutex is held for the whole run (section 3.5), so no new bridge writer can enter; after pause every lease must be dead. Older bridges without the protocol refuse by default. | Running managed systemd bridge with its lease, `service.pid`, and children: `managed` populated, `foreign` empty, fence bound, pause proceeds, leases dead after pause. Fake bridge process attempting `enterDataAccess` while the fence is held: its bind fails, source bytes unchanged, verification passes. Fence address already bound: `source-occupied`, no effect. Bridge version below the protocol version: `fence-unavailable`, refuse. |
| B6 recovery and drain | Importer shut down by the supervisor before `shuttingDown`; no timeout abandon; recovery quarantines live orphans and refuses to restore; `runRun` re-reads the registry. | Shutdown during `copy`: `shutdown()` joins the effect, rolls back with the children still stoppable, then `shuttingDown` is set. Crash during `start` with a live holder: recovery deactivates those appIds, leaves entries and directories, terminal `manual-recovery` with `stop-orphaned-bot` and pids, service effects untouched, supervisor spawns none of them. Same with a dead holder: rollback completes. |
| B7 Windows | `execute` refuses on `win32`; the refusal is recorded as a non-delivery of the three-platform build item, not an acceptance; Run-value removal has no bound primitive in Win32 and is a cooperation or manual step. | `execute` on `win32`: `refused: platform-unsupported`, no effect recorded. Preflight classifies the fixture chain and a wrong package name. |
| C1 manager TOCTOU | Re-read of loaded program and pid immediately before `bootout` or `disable --now`; label-level guarantee stated in section 2.6; before and after pids recorded. | Loaded program differs from template at the pre-command read: `unsupported-state`, no command. After `bootout`, a pid outside the recorded set still alive with bridge argv: `partial`, no signal, restore by name, `manual-recovery`. |
| C2 override preservation | `enable-override` only when origin was false; origin `true` with a loaded job is `unsupported-state`. | Origin override true, job not loaded: pause skips disable, restore never enables, commit leaves it true. |
| C3 definition removal | Not performed; receipt `definitionRemoved: false`; lane 1 file assertions open. | Whole-run trace has no file operation on the definition path; receipt and instruction present. |
| C4 crash prefixes | Section 4.4 before, after, or neither for every effect including `fence.acquire` and rollback effects. | Crash after `disable-now`, before outcome: classified `after`. Crash after fence bound, before record: recovery binds again, idempotent. |
| B8 supported-state boundary | Templates for launchd and systemd; loaded program or `ExecStart` must equal the file's; `DropInPaths` empty; `failed`, `masked`, `static`, `linked` refused; `loaded-idle` with autostart keys refused before mutation. | Plist with an extra `StartInterval` key: `unsupported-definition`. Loaded job whose `arguments` differ from the file: `unsupported-state`. systemd `failed`: `unsupported-state`. All refusals leave an empty effect list. |
| B9 inventory coverage | Flat layout list complete; root `dev,ino` revalidated; staged bytes are the verified bytes; decryption from staging; `stage.copy` rerun must match the confirmed hash. | Flat fixture: `projects.json`, `sessions.json`, `comment-instructions.md` in the inventory. Source root replaced by a different directory at the same path: `dev,ino` mismatch, `stale-source`. Staging lost after crash, source changed: re-read hash differs, `stale-source`, rollback. |
| B10 wire coherence | Enums defined in the protocol; `problem` from preflight's union; `succeeded` separates `receipt` and `current`; `importRpc` total; `acknowledge`; polling and first-run lifetimes specified. | Fixture status with `succeeded` and a `current` entry `pending`: UI shows imported, not all connected. Any `Error` thrown inside `importRpc`: reply `refused: internal`, never an error envelope with a message. First-run step stays mounted across a snapshot change that adds bots. `oldBridgeObserved` true after a manual bridge start while the page is mounted. |

Earlier rows R1 to R16 and F1 to F7 keep their traces from the previous revision where this revision did not change the mechanism; where it did (R1, R4, R9, R11, R12, R13, F1, F5, F7), the rows above supersede them.

## 8. Implementation order and gates

1. V8-T2: `types.ts`, `inventory.ts`, `files.ts`, `launchd.ts`, `systemd.ts` to sections 2 and 3, with every section 7 trace that touches them. `windows.ts` is preflight-only. Checkpoint: `npm test -w packages/daemon -- import-bridge-service-control`.
2. V8-T1: `execute.ts`, `ledger.ts`, `recover.ts`, `runtime-port.ts`, crash matrix before and after every effect including rollback effects. Checkpoint: `npm test -w packages/daemon -- import-bridge`.
3. V8-T3: `protocol/src/import.ts`, `import/bridge/rpc.ts`, `cli/commands/import.ts`; root applies section 6 shared edits. Checkpoint: typecheck across protocol, client, daemon; CLI preflight on a daemon without bridge data prints `not-found`.
4. V8-T4: `ImportFlow.tsx` and first-run container; root adds the feature entry and render. Checkpoint: `npm run test -w packages/ui -- import-bridge` plus a test per status variant.
5. Gates, none passed here: fresh independent review of this exact head before implementation; then the ten live lanes in `manzana` `gui/502` and `vonvon-accept` only, perf from ledger `intent.at` timestamps, independent review, exact-head Shipping. Windows is refused and has no acceptance.

## 9. Disclosure for the root PR

- Additive `import` request group in `rpc.ts`; export in `index.ts`; client method `bridgeImport`. No existing shape changes. No `events.ts` or `domain.ts` change.
- New persisted files under `destRoot/import/bridge/`: `ledger.json`, `receipt.json`, `<txnId>/` with `backup/`, `staging/`, `bots/`, `quarantine/`, `removed-definition`. New `.import-owned` marker inside imported bot directories. Marker content `{ version: 1, txnId, completedAt, vonvonHome }`.
- Shared edits: `server/http.ts` (case and option), `bot/supervisor.ts` (importer construction and shutdown order), `cli/commands/run.ts` (recovery call and registry re-read), `config/bots.ts` (`withRegistry`, reservations, `syncPath`), `bot/register-bot.ts` (reservation check), `client.ts`, `cli/index.ts`, `features.ts`, `App.tsx`. `admin/service.ts` is no longer edited.
- Decisions the root must record, each a proposal with the original gate kept open until disposed: (1) the importer never removes the definition file, so lane 1's "plist is gone", "unit file is gone", and `LoadState` `not-found` assertions cannot pass as written; the routes are the bridge's own `service uninstall`, the V9 release removing it on start, or a root-disposed lane change. (2) Older bridges without the admission protocol refuse by default; a snapshot-only import for them would be a root-accepted exception. (3) Hooks are written in place with inode plus same-descriptor content check; the content-CAS window is stated; the alternative is V9 forwarding `feishu-codex-bridge hook` to `vonvon hook`, which changes lane 6. (4) Windows stop and disable are not delivered by this candidate; the three-platform build item stays open. (5) Enabled-bot semantics of section 4.5.
- `architecture.md` and `plan.md` now say that failure before the commit point restores the bridge and failure after it rolls forward.
- No merge-edge or graph change. V8 still merges after V4 only.
