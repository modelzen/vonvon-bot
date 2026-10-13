# Outbound local image read containment (BUG220, #230)

Design only, revision 4. Baseline `ae26ed377b619807d652acf62c88aef37f0cde46` on `codex/v6a-provider-core`, proposal first committed at `0aaa1740a47adf5ad0fa30155f9db5ee175128c7`. Revised 2026-10-13 after the second independent review returned CHANGES REQUIRED on R1 to R5, with the root's six decisions applied, and again after the third review returned CHANGES REQUIRED on N1 to N5 with the root's dispositions for that checkpoint applied. The admission and resource primitive, the cache compatibility decision, the Linux `openat2` mechanism, and the Darwin `openat` direction were marked PASS as bounded design by that review and are retained unchanged except where N2 adds the byte lease. Retained from revision 2 as accepted progress: the withdrawn Linux equivalence and Darwin atomicity claims, the Windows-not-closed correction, the provenance versus immutability distinction, and the positive and negative probes. Nothing here is implemented. No platform is accepted by this document. Every API, data, dependency, or packaging change is a proposal for the root and an independent reviewer. Prose marked "for approval" does not become approved by appearing in *Integration anchors*.

## Problem

`packages/daemon/src/card/outbound-images.ts` `loadLocal` (lines 114 to 159) decides containment on a pathname and reads a pathname. Line 128 realpaths through `checkUploadPath`, line 145 stats the canonical pathname, line 157 reads it. A process that can rename or symlink inside a `write` project can swap the final component or a parent between any two calls. The reviewer uploaded outside bytes by swapping after `stat` and before `readFile`.

`bot/outbound-files.ts` `inspect` and `readSnapshot` (lines 100 to 131) take a pathname `stat` snapshot, open with `O_NOFOLLOW`, and compare `fstat` with the snapshot. A parent swapped after the initial realpath gate and before the snapshot makes snapshot and descriptor agree on an outside object. That is #230. A static outside symlink before the gate is already refused. The reader here is the common mechanism for both consumers. This unit changes only the image consumer. *Files consumer* states what #230 still needs. An image-only merge never closes #230.

## Authority: what the guarantees derive from

Two sources of authority exist and the contract names which guarantee comes from which.

**From the retained granted root object.** Once a turn holds a bound root, meaning a directory object captured at the provider grant boundary with its identity, the Linux walk and every native strategy prove per open that each opened object was a non-symlink entry of a directory the daemon already held, starting from that object. For those strategies this covers final and parent symlink replacement at any time, root pathname re-pointing after the grant, and replacement of the root by another real directory after the grant, without depending on the agent being confined. The pure Darwin strategy resolves from `/` and gets the root-replacement cover only within its qualification preconditions in *Mechanisms*.

**From pathname plus confinement.** Three residuals are not covered by the retained object and depend on the effective provider profile or stay open:

1. A held intermediate directory moved out of the root after its descriptor was taken, then a child opened through it. On Linux the procfs walk follows the held directory. Closing this needs either a single-syscall beneath-resolution from the bound root, which is the native fallback, or proof that the effective profile denies moving a directory from the root to any location outside it, including `/tmp`, provider temp locations, and any secondary writable root.
2. A mount made visible in the daemon's namespace beneath the root. A mount inside the child's private namespace is not visible to the daemon and does not change the daemon's lookup. A mount the daemon sees changes lookup authority. Neither mechanism checks `st_dev`. This is a stated residual, not a proven impossibility, and the proof gate records namespace visibility.
3. A hardlink inside the root to an outside file on the same filesystem. Static or created during the turn, this is accepted by the current pathname gate and by this reader. Linux `fs.protected_hardlinks` is not a confinement mechanism and has an owner exception, so it is not cited as a defense. No `nlink === 1` rule, no `RESOLVE_NO_XDEV`, and no content or secret scope is added. Mount and hardlink residuals stay under the original pathname-authority semantics and the root decides their disposition separately.

**Adversary and excluded actors.** The adversary is any process that can write inside the project root during the turn. Whether an unconfined same-user process is in scope is a root decision, not derived from "it gains nothing". The daemon offers network egress and bot credentials that such a process may not have. Under the retained-object guarantee above, that process still cannot make the daemon follow a symlink out of the root. It can exercise residuals 1 to 3. The contract therefore states, per platform, which residuals the accepted profile closes and which stay open, and no platform is accepted with an open residual the root has not explicitly accepted.

**Essential enforcement and what exists at this head.** `planEnforcement` has no production caller at this head, `provider/policy/proofs.ts` exports an empty list, and the uploaders' real neighbours are the legacy adapters. Facts read from source:

- `agent/codex-appserver/backend.ts:73-98` `sandboxParams`. `qa` and `write` are enforced only on macOS and Windows through the Codex `feishu` profile with `:workspace_roots` read or write. On Linux the function throws, so legacy Codex `qa` and `write` do not run on Linux at all.
- `agent/claude-agent/permission.ts:59-76`. `qa` sets `filesystem.denyWrite: [cwd]`. `write` sets no filesystem restriction. Under legacy Claude `write`, the provider's Bash can write anywhere the user can, so residual 1 is open and so is root-parent mutation. This is a confinement gap of the legacy adapter, not of this reader, and it means the "cannot write outside the root" precondition is false for legacy Claude `write` today.

Consequently the conditional mechanisms below are acceptable only with a mandatory proof per provider, version, and profile, and a platform stays unaccepted until its proof passes. The proof gate is in *Proof gate*. No future engine wiring is claimed to exist.

## Bound root at the grant boundary

Root decision 1, corrected for N1. Outbound authority is captured at the provider grant boundary, which is every `startThread` and `resumeThread` call, from the effective grant the caller already holds. The provider's launch cwd and the outbound binding are separate outputs of one capture so that provider startup never depends on outbound capture succeeding.

```ts
// provider/outbound/bound-root.ts
export type ObjectIdentity =
  | { readonly os: 'posix'; readonly dev: bigint; readonly ino: bigint }
  | { readonly os: 'win32'; readonly volumeSerial: bigint; readonly fileId: string }; // 128-bit FILE_ID_INFO as 32 hex chars, lossless

/** The effective grant, supplied by the caller from what it actually resolved. Never synthesized from a tier alone and never from PROOFS. */
export interface OutboundAuthority {
  readonly tier: 'qa' | 'write' | 'full';
  readonly readScope: 'project' | 'unrestricted'; // providers.md readScope; legacy adapters supply 'project' for qa and write, because uploadPlan:18-26 hardcodes it today
  readonly provider: 'legacy-codex' | 'legacy-claude' | ProviderId;
  readonly version: string | undefined;
  readonly qualification: Qualification; // the recorded proof-gate result for this provider, version, profile, and OS, or 'unqualified'
}
export type Qualification =
  | { readonly status: 'qualified'; readonly record: string; readonly closes: ReadonlyArray<'root-parent' | 'move-out' | 'alias' | 'mount' | 'hardlink'> }
  | { readonly status: 'unqualified' };

export type OutboundRootBinding =
  | { readonly status: 'bound'; readonly authority: OutboundAuthority; readonly canonical: string; readonly identity: ObjectIdentity; readonly grant: GrantToken }
  | { readonly status: 'unrestricted'; readonly authority: OutboundAuthority; readonly canonical: string; readonly grant: GrantToken }
  | { readonly status: 'unbound'; readonly authority: OutboundAuthority; readonly reason: 'canonicalize-failed' | 'capture-failed' | 'launch-mismatch' | 'unsupported' | 'busy' | 'retired'; readonly errno?: string; readonly grant: GrantToken };

/** Process-local correlation token. Not durable, not unique across restarts, never serialized as authority. */
export type GrantToken = number & { readonly __brand: 'GrantToken' };

export interface OutboundCapture { readonly launchCwd: string; readonly binding: OutboundRootBinding }
export function captureOutboundRoot(cwd: string, authority: OutboundAuthority, deps?: ContainedReadDeps): Promise<OutboundCapture>;
export function confirmLaunch(capture: OutboundCapture, deps?: ContainedReadDeps): Promise<OutboundRootBinding>;
export function retireGrant(grant: GrantToken): void;
```

**Capture.** `captureOutboundRoot` takes a capture slot per *Resource contract*. It realpaths `cwd`. If that fails, `launchCwd` is the caller's original `cwd` unchanged and `binding` is `unbound` with `canonicalize-failed`. The provider starts with the cwd it would have had before this design. No fallback string is ever labelled canonical and no local source is read under that grant. If realpath succeeds, `launchCwd` is the canonical path. For `readScope: 'unrestricted'` or `tier: 'full'`, `binding` is `unrestricted`. Otherwise capture opens the canonical path as a directory with the platform root flags, reads the identity with `stat({ bigint: true })` on POSIX or natively on Windows, closes the handle, and returns `bound`. An identity or probe failure after a successful realpath yields `unbound` with `capture-failed`, and the provider still starts on the canonical `launchCwd`. The binding is data; no handle outlives capture.

**Launch validation.** After the provider has started, meaning after `startThread` or `resumeThread` returned, the caller runs `confirmLaunch`, which stats `canonical` again and compares identity. A mismatch converts the binding to `unbound` with `launch-mismatch` and local sources refuse for that grant. This validates around the launch, not atomically with it. The provider APIs at `codex-appserver/backend.ts:666-692` and the Claude query construction through `thread.ts:281` take a pathname. A replacement between capture and the provider's own open, restored before `confirmLaunch`, leaves the provider operating against the replacement while the outbound identity is the original. No pathname-only provider API can exclude that schedule, and this document does not invent a provider-supported retained-root launch. The remaining assumption is explicit: the root directory and its ancestors are not replaced by an actor outside the model during the launch window. The reviewer's earlier schedule, an alias re-pointed between thread open and capture, cannot occur because capture precedes the open and the provider receives the canonical path.

**Sequencing at the actual call sites, enumerated at this head.** `handle-message.ts:1559, 1720, 1737, 1814, 2144, 4027, 5392, 5401` are the eight production calls. The backends are `codex-appserver/backend.ts:666` and `:681`, and `claude-agent/backend.ts:353` and `:369`. `supervisor.ts` has no direct call at this head, and desktop call sites are not in this checkout. Each call site builds `OutboundAuthority` from the mode and scope it already resolved; the two sites at 5392 and 5401 omit mode today and use the same effective mode resolution their backend applies, not a new default. The sequence is capture, start or resume with `launchCwd`, `confirmLaunch`, then store the result on `AgentThread.root`. `launchRun` at 4195 and the goal launcher at 4840 take `runCwd` from `opts.thread.root.canonical` only when the binding is `bound` or `unrestricted`; with `unbound` there is no local resolution and the upload callbacks at 4418, 4516, and 5022 refuse every local source with `image-root-unbound` and still process remote sources. Queued turns at 4331 and goal turns share the thread's binding.

**Grant lifetime.** A new start or resume for the same session captures a new binding and calls `retireGrant` on the previous token. A retired grant admits no new local reads. Work already admitted under it completes, and late folds into an older `StreamingImages` continue as today. `GrantToken` is an in-process number for correlation and refusal of new admissions only. It is not protection against inode reuse after every handle closes and is never persisted.

**Retained root per batch.** `retainRoot(binding)` opens `binding.canonical` with the root flags and refuses with `root-changed` unless the handle's identity equals `binding.identity`, and refuses with `root-unbound` `retired` if the grant was retired. The handle lives for one batch and its initialization promise is memoized before the first `await`.

## Mechanisms

Facts are marked verified or inferred as in revision 2. Added since: the macOS SDK on the reviewer's host defines `O_RESOLVE_BENEATH 0x00001000` at `sys/fcntl.h:128` (verified there, availability on the oldest supported macOS inferred as unknown). Node `stat({ bigint: true })` returns `dev` and `ino` as `bigint` (verified, Node 24 fs documentation).

### Linux: directory-descriptor walk through procfs

Unchanged from revision 2 in mechanism and in its exact guarantee: each opened object was, at its open, a non-symlink entry of a directory the daemon held. Flags per call are exact: root `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` (0 | 65536 | 131072), intermediates the same, final `O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` (0 | 131072 | 2048 | 256). Residual 1 is open on Linux until the proof gate shows the effective profile denies moving a directory out of the root, or the native fallback replaces the walk with one `openat2(rootfd, path, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` from the retained root, which resolves the whole path in one syscall under the root object and returns `ENOENT` for a directory already moved out. The pure Linux strategy is selected only when the grant's `Qualification` closes `move-out` and records the `mount` result. Legacy Codex does not run `qa` or `write` on Linux, so the Linux proof gate concerns legacy Claude and future engines only.

### macOS: `O_NOFOLLOW_ANY` after the root identity check

Unchanged from revision 2. Root flags `O_RDONLY | O_DIRECTORY | O_NOFOLLOW | 0x20000000`, file flags `O_RDONLY | 0x20000000 | O_NONBLOCK | O_NOCTTY`. The open resolves from `/`. The pre-open `stat` proves the pathname denoted the bound root at that instant and no longer. The pure Darwin strategy is selected only when the grant's `Qualification` closes `root-parent`, `move-out`, and `alias` together. Residuals 1 and root-parent mutation are otherwise open. The native fallback is `openat(rootfd, relative, O_RESOLVE_BENEATH | O_NOFOLLOW_ANY | O_RDONLY | O_NONBLOCK | O_NOCTTY)` from the retained root, which pins the walk to the root object. Its availability on the oldest supported macOS is unverified and is part of the native unit's gate.

### Windows: native reader

Node cannot refuse reparse points per component and cannot query a handle's final path. Windows under `qa` and `write` is a supported configuration for legacy Codex, which enforces the `feishu` profile there, and for Claude with Bash off per `providers.md:594-602`. The pure-Node reader has no Windows strategy. The native reader is the Windows mechanism and is specified in *Native unit*. Until it is accepted, Windows keeps its current pathname read and current test expectations, and BUG220 stays open on Windows. This is root decision 5. It is not a refusal policy, not a downgrade, and not closure.

### Strategy selection

```ts
export function selectStrategy(platform: NodeJS.Platform, authority: OutboundAuthority, native: NativeContainedReader | undefined): ContainmentStrategy;
```

`unrestricted` reads need no strategy. For a bound grant, a `qualified` record whose `closes` contains the platform's required set selects `linux-dirfd` or `darwin-nofollow-any`. Any other grant on any platform, which at this head is every legacy writer, selects `native` when the addon loaded and `unsupported` otherwise. Root decision: native B serves all unqualified writers, not only legacy Claude `write`. The reader is constructed with the selected strategy, `createContainedReader(strategy, deps)`, so no implementation can substitute a platform boolean or a fabricated qualification.

### Runtime probe

Unchanged from revision 2: a canonical `mkdtemp` fixture with a positive and a negative open, per reader instance, Linux through procfs and macOS through the flag, every probe handle closed by the probe. The probe runs only after batch admission.

## Proof gate

Mandatory before any platform is accepted for any provider under `qa` or `write`. Executed by the implementation owner on the real host with the real provider at its installed version and the exact profile the legacy adapter or engine supplies. Each negative result is paired with a positive inside operation in the same run to prove the sandbox was active. Results are recorded per provider, version, profile, OS, and residual.

| Probe | Operation from inside the sandboxed provider | Pass |
| --- | --- | --- |
| `confine.inside-read` | read a file under the root | succeeds, in every tier |
| `confine.inside-write` | create a file under the root | succeeds under `write`; refused under `qa`, which is that tier's positive control of an active sandbox |
| `confine.root-parent` | rename the root, create a sibling of the root | both refused |
| `confine.move-out` | move a root subdirectory to each of `/tmp`, `$TMPDIR`, the provider's own temp or cache location, and any secondary writable root the profile lists | all refused |
| `confine.alias` | create a symlink outside the root pointing at the root, open the project through it | provider still cannot write outside |
| `confine.mount` | attempt a bind mount or user-namespace mount beneath the root, then from the daemon check whether the mount is visible | either refused, or not visible to the daemon; a daemon-visible mount fails the gate |
| `confine.hardlink` | hardlink an outside file the provider cannot read into the root, then read it through the link from the provider, then stat the link from the daemon | three results recorded separately: link creation, provider read, daemon-visible link. A created link that the daemon can see is residual 3 open on that provider regardless of the provider read |
| `confine.handle-inherit` | enumerate inherited directory descriptors of the provider process | none outside the root |

The gate's outcome is written as the `Qualification` record that `OutboundAuthority` carries. A failed `confine.move-out` or `confine.root-parent` leaves the grant `unqualified`, which selects native B. A failed `confine.hardlink` is recorded, not fixed here. Legacy Claude `write` is expected to fail `confine.root-parent` and `confine.move-out` from the source read above and is served by native B.

## Read contract

Unchanged from revision 2. Bounded, non-atomic view of an object the reader proved contained. Provenance is the security property, immutability is not. The two `fstat` calls refuse what they observe: a zero-progress read, or a `dev`, `ino`, or size change between them. Same-length rewrites and grow-then-shrink are accepted and tested as the documented contract. Identity uses `bigint` `dev` and `ino` on POSIX.

**Cache key and late folding, root decision 4, N2 classification.** The cache key stays `local:${canonical}:${mtimeMs}:${size}` with the values from the descriptor's `fstat`, and cross-grant reuse stays as today. The content-hash proposal is withdrawn. A cache hit gives no fresh-byte guarantee and no grant-isolation guarantee, and a cached `image_key` is not proof that the displayed bytes came from the object just opened. The read still runs before the cache lookup, exactly as `outbound-images.ts:97-102` does today, so every cache hit has passed the current containment gate. Partitioning the cache by grant is a root choice that changes reuse and is not proposed here. `StreamingImages` late folding and repaint at source lines 289 to 292 and 338 to 340 are unchanged. The `GrantToken` in the result is a correlation token for tests and logs and changes no UI behavior.

## Resource contract

Root decision 3, with the N2 byte lease. Admission precedes every local filesystem operation, including realpath, probe, root open, and capture. Nothing is promised about OS cancellation or duration. Eight stuck operations can exhaust a budget indefinitely, and later sources refuse with `busy` until they settle. Every reservation lasts until the work and its cleanup, including the last SDK owner of a buffer, settle. Outer timers never release a reservation. The maxima are unchanged: 8 active batches, 8 active reads, 16 waiters expiring at 2000 ms, 80 MiB reserved bytes, 8 active plus 16 queued captures, 4 dispatched native workers.

| Budget | Maximum | Taken when | Released when |
| --- | --- | --- | --- |
| active local batches | 8 | before a batch's first local operation, which is `uploadPlan` | after the batch's last read and its root close attempt settle |
| active local reads | 8 | before the walk, the flagged open, or the native dispatch of one source | in that read's own `finally` |
| waiting admissions | 16, each expiring after 2000 ms, shared by batches, reads, and captures | a request that finds its budget full | granted, or expired with `busy`; expiry removes only the queued request |
| reserved local source bytes | 80 MiB | pure-Node: after `fstat` passes the size check, for `size`. Native: before dispatch, for `maxBytes`, adjusted down to the returned size on completion | by the byte lease below |
| capture jobs | 8 active, 16 queued under the same 2000 ms expiry | before `captureOutboundRoot` realpaths | when capture returns |
| native workers | 4 dispatched | at dispatch, after a read slot and the byte reservation | when the worker completes |

**Byte lease.** A successful read returns `lease: ByteLease` with the bytes.

```ts
export interface ByteLease { readonly bytes: number; release(): void; transferTo(settlement: Promise<unknown>): void }
```

Exactly one of `release` or `transferTo` is called, once. `resolveAndUpload` releases on a cache hit, on any local discard, and when constructing the SDK request throws synchronously. It calls `transferTo` with the original `image.create` promise at invocation, and the lease releases in a `finally` attached to that promise, never to the `withTimeout` wrapper at `outbound-images.ts:232-245`, which abandons without cancelling. A lease never transferred or released by the time the batch worker returns is released by the worker's `finally` and logged as `image-lease-leak`, which is a test failure condition, not a runtime strategy. Native reads reserve `maxBytes` from the same JavaScript-owned budget before dispatch, so the addon never allocates unreserved bytes; the reservation shrinks to the actual size when the worker returns.

Ownership rules. A batch slot owns the root handle. A read slot owns the walk handles and the file handle, or the native worker. The byte lease is owned by the buffer's current holder. A batch's shared root initialization is a memoized promise created before its first `await`. Operations are tracked from admission through cleanup. No handle is closed from outside its owner, and no close is retried.

## Native unit

Root decision 5. One N-API addon provides the Windows mechanism and the native fallback for Linux and macOS residual 1. It captures and reads with the same identity mechanism, asynchronously, with RAII ownership and a bounded native pool.

```ts
// provider/outbound/native.ts, loader
export interface NativeContainedReader {
  captureRoot(canonical: string): Promise<{ ok: true; identity: ObjectIdentity } | ({ ok: false } & ContainedReadFailure)>;
  readBeneath(canonical: string, expected: ObjectIdentity, components: BeneathComponents, maxBytes: number): Promise<ContainedRead>;
}
export function loadNativeContainedReader(): NativeContainedReader | undefined; // undefined when the prebuild is absent or fails to load; never throws
```

- **Asynchrony.** Every call is a `Napi::AsyncWorker` on the libuv threadpool. No filesystem call runs on the JavaScript thread, so timers including the 3 s finalize grace keep running. The addon's own pool is bounded at 4 concurrent workers; a fifth call waits in the addon's queue, which is itself bounded by the admission budgets above because admission precedes dispatch.
- **Windows capture.** `CreateFileW(canonical, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)`. `GetFileInformationByHandleEx(FileAttributeTagInfo)` must show `FILE_ATTRIBUTE_DIRECTORY` and no `FILE_ATTRIBUTE_REPARSE_POINT`. `GetFileInformationByHandleEx(FileIdInfo)` gives `VolumeSerialNumber` and the 128-bit `FileId`, encoded as the `win32` identity. Fail closed if the query is unsupported on the volume.
- **Windows read, N4.** Open the root with share `FILE_SHARE_READ | FILE_SHARE_WRITE` and no `FILE_SHARE_DELETE`, and compare its `FileIdInfo` with `expected`; mismatch is `root-changed`. The root handle and every intermediate directory handle are held until the final read and its second identity check complete, so that no held directory can be renamed or deleted while the chain is open: a rename needs `DELETE` access, and an open without delete sharing makes that access a sharing violation. For each component, `NtCreateFile` with `ObjectAttributes.RootDirectory` set to the held directory handle, `ObjectName` the single component as a UNICODE_STRING, `OBJ_CASE_INSENSITIVE`, `CreateDisposition FILE_OPEN`, `CreateOptions FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT` plus `FILE_DIRECTORY_FILE` for intermediates or `FILE_NON_DIRECTORY_FILE` for the final, `DesiredAccess FILE_READ_ATTRIBUTES | SYNCHRONIZE` for intermediates and `FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE` for the final, `ShareAccess FILE_SHARE_READ | FILE_SHARE_WRITE` for every directory and `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` for the final file only. `STATUS_SHARING_VIOLATION` on any directory, including one caused by a pre-existing handle opened with delete access, refuses with `conflict` and is never retried with broader sharing. With `FILE_SYNCHRONOUS_IO_NONALERT` and `SYNCHRONIZE` the call completes before returning; a `STATUS_PENDING` is treated as a failure, and the IO_STATUS_BLOCK and any handle stay allocated until the operation has actually completed before they are released. The chain is closed in reverse order after the read, and closed the same way on every failure. After each open, `FileAttributeTagInfo` must show no reparse point; any tag refuses with `link`. For the final, `GetFileType` must be `FILE_TYPE_DISK`, `FileAttributeTagInfo` must show no directory and no reparse point, `FileStandardInfo` gives size and `Directory`, `FileBasicInfo` gives `LastWriteTime` for `mtimeMs`, `FileIdInfo` gives the identity. Read with `ReadFile` in a bounded loop, then re-query `FileStandardInfo` and `FileIdInfo` for the second check.
- **Component validation on Windows.** Before any open, refuse with `invalid-path` a component that is empty, `.`, `..`, contains `\`, `/`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, or a control character, ends with a dot or a space, or whose name before the first dot matches, case-insensitively, `CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, or `LPT1` to `LPT9`. A relative NT name under a directory handle does not go through Win32 DOS-device translation, but the validator refuses these forms anyway so the behavior does not depend on that. Tests cover each form.
- **Linux fallback.** `captureRoot` opens with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC` and `fstat`. `readBeneath` opens the root, compares identity, then `openat2(rootfd, joined components, { flags: O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC, resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS })`, kernel 5.6 or later, `ENOSYS` is `unsupported`. `EAGAIN` and `EXDEV` from a racing lookup map to `changed`, `ENOENT` to `missing`; no outcome of a concurrent rename is promised beyond refusal. Then the same read contract with `fstat`. `RESOLVE_NO_XDEV` is not used.
- **macOS fallback.** Same capture. `readBeneath` opens the root, compares identity, then `openat(rootfd, joined components, O_RDONLY | O_RESOLVE_BENEATH | O_NOFOLLOW_ANY | O_NONBLOCK | O_NOCTTY | O_CLOEXEC)`. `EINVAL` on a kernel without the flag is `unsupported`.
- **RAII.** Every HANDLE or fd is held by a unique-owner wrapper closed on every exit path. A handle is owned before any metadata query on it. Addon teardown waits for in-flight workers to complete; it never frees a handle or an IO_STATUS_BLOCK that a pending operation still references.
- **Dependencies, enumerated.** Runtime: `node-gyp-build`, which locates and loads the prebuild. Build only: `node-addon-api`, `node-gyp`, `prebuildify`. The addon targets N-API version 8, which every engine in `package.json` (`^22.12.0 || ^24.0.0 || >=26.0.0`) supports. Minimum OS: Windows 10 1809 or Server 2019, on local NTFS and ReFS volumes, where `FileIdInfo` is supported; any volume that fails the query refuses with `unsupported` rather than being supported by assumption. Linux `openat2` needs kernel 5.6; macOS minimum is the version that gained `O_RESOLVE_BENEATH`, which the unit must determine from the SDK availability macros and record.
- **Packaging, as a plan amendment proposal.** `packages/daemon/package.json` `files` gains `prebuilds/`. The tsup config marks `node-gyp-build` external so the loader resolves `prebuilds/` relative to the installed package directory rather than from inside the bundle. The `global-npm` package carries `prebuilds/win32-x64/`, `prebuilds/win32-arm64/`, `prebuilds/linux-x64/`, `prebuilds/linux-arm64/`, `prebuilds/darwin-x64/`, and `prebuilds/darwin-arm64/`. The desktop staging script named in `plan.md` V5 (`scripts/stage-daemon.mjs`, absent at this head) must copy `prebuilds/` and the macOS build must sign and notarize each `.node` with the app. This contradicts the current rule that nothing native ships with the daemon, so it is a `plan.md` amendment for the root, not something the existing exclusion rules already allow.
- **Proof per architecture.** A packed `npm pack` package installed on a clean Windows x64 host and a clean Windows ARM64 host, each running the contained-read tests through the addon and a handle-count check before and after a batch with injected failures. An ARM64 run is not x64 evidence and the reverse. Linux and macOS fallback prebuilds get the same from the packed package on each architecture.
- **Load failure.** A missing or unloadable prebuild yields `unsupported` from the loader. That is load-failure handling and leaves the platform unaccepted. It is not completion.

## Public types

```ts
// provider/outbound/contained-read.ts
export type ContainmentStrategy = 'linux-dirfd' | 'darwin-nofollow-any' | 'native' | 'unsupported';
export function selectStrategy(platform: NodeJS.Platform, authority: OutboundAuthority, native: NativeContainedReader | undefined): ContainmentStrategy;

export interface ContainedReadDeps {
  platform: NodeJS.Platform;
  open(path: string, flags: number): Promise<FileHandle>;
  stat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  mkdtemp(prefix: string): Promise<string>;
  realpath(path: string): Promise<string>;
  rm(path: string): Promise<void>;
  native?: NativeContainedReader;
}

export interface FileIdentity { readonly identity: ObjectIdentity; readonly size: number; readonly mtimeMs: number }

export type BeneathComponents = readonly string[] & { readonly __brand: 'BeneathComponents' };
/** root and canonical are both absolute canonical paths; the suffix is checked. Refuses root itself, an empty, '.', '..', separator-bearing, or NUL-bearing component, and a suffix that is absolute or escapes. */
export function beneathComponents(root: string, canonical: string): BeneathComponents | { code: 'invalid-path' };

export type ContainedReadFailure =
  | { code: 'unsupported'; strategy: ContainmentStrategy }
  | { code: 'root-unbound'; reason: OutboundRootBinding extends { reason: infer R } ? R : never; errno?: string }
  | { code: 'root-changed'; errno?: string }
  | { code: 'invalid-path' }
  | { code: 'link'; errno: string }
  | { code: 'missing' }
  | { code: 'not-file' }
  | { code: 'empty' }
  | { code: 'too-large'; size: number }
  | { code: 'changed' }
  | { code: 'busy'; budget: 'batch' | 'read' | 'bytes' | 'capture' | 'native'; waitedMs: number }
  | { code: 'conflict' } // Windows sharing violation on a directory of the chain
  | { code: 'io'; errno?: string };
export type ContainedRead = { ok: true; bytes: Buffer; lease: ByteLease; identity: FileIdentity; grant: GrantToken } | ({ ok: false } & ContainedReadFailure);

export interface RetainedRoot { readonly binding: Extract<OutboundRootBinding, { status: 'bound' }>; close(): Promise<void> }

export interface ContainedReader {
  readonly strategy: ContainmentStrategy;
  probe(): Promise<boolean>;
  retainRoot(binding: Extract<OutboundRootBinding, { status: 'bound' }>): Promise<{ ok: true; root: RetainedRoot } | ({ ok: false } & ContainedReadFailure)>;
  readBeneath(root: RetainedRoot, components: BeneathComponents, maxBytes: number): Promise<ContainedRead>;
  readUnrestricted(canonical: string, maxBytes: number): Promise<ContainedRead>;
}
export function createContainedReader(strategy: ContainmentStrategy, deps?: ContainedReadDeps): ContainedReader;
export const DARWIN_O_NOFOLLOW_ANY = 0x20000000; // macOS SDK sys/fcntl.h:159

// card/outbound-images.ts
export function uploadOutboundImages(channel: LarkChannel, sources: string[], root: OutboundRootBinding, options?: { deps?: ContainedReadDeps }): Promise<Map<string, string>>;

// agent/types.ts, for approval
export interface AgentThread { /* existing */ readonly root: OutboundRootBinding }

// Common consumer interface shared by card/outbound-images.ts and bot/outbound-files.ts
export interface OutboundLocalReader {
  read(binding: OutboundRootBinding, canonical: string, maxBytes: number): Promise<ContainedRead>; // admission, retainRoot, beneathComponents, strategy, and lease inside
}
```

The `uploadOutboundImages` signature change replaces `cwd` and `mode` with the binding. The three callers change in the same unit. There is no positional-compatible form. `OutboundLocalReader` is the one entry both consumers call, so admission, root retention, component checking, strategy selection, and the byte lease have one owner.

## Failure codes

As revision 2, plus `root-unbound` logged as `image-root-unbound` with `src` and `reason`, `busy` logged as `image-busy` with `src`, `budget`, and `waitedMs`, `conflict` logged as `image-conflict` with `src`, and `image-lease-leak` as described in *Resource contract*. `errno` is the code string only. Local reads never throw.

## Files consumer (#230)

Common contract through `OutboundLocalReader`. `outbound-files.ts` keeps its prepare-time metadata snapshot for the card. The manifest persists the binding as a versioned, lossless DTO, because the manifest is written with `JSON.stringify` at `outbound-files.ts:203` and a `bigint` would throw.

```ts
export interface OutboundRootBindingDtoV1 {
  readonly v: 1;
  readonly status: 'bound' | 'unrestricted';
  readonly tier: 'qa' | 'write' | 'full';
  readonly readScope: 'project' | 'unrestricted';
  readonly canonical: string;
  readonly identity?: { os: 'posix'; dev: string; ino: string } | { os: 'win32'; volumeSerial: string; fileId: string }; // decimal strings for bigint, 32 hex chars for fileId
}
export function encodeBinding(binding: OutboundRootBinding): OutboundRootBindingDtoV1 | undefined; // undefined for unbound, which is never persisted
export function decodeBinding(raw: unknown): OutboundRootBindingDtoV1 | { code: 'invalid-binding' }; // strict: version, enum values, platform matches process.platform, bigint parse succeeds
```

Prepare-time snapshot numbers (`ino`, `dev` from `Stats`) are converted with `BigInt()` before any comparison with an `ObjectIdentity`; no number is compared with a bigint by strict equality.

**Click-time validation, both paths.** `deliverOne` validates before the fresh upload at line 404 and before the cached-key send at line 411 alike: decode the manifest binding, require a live grant for the same project in this process whose binding has the same `canonical` and `identity`, then `OutboundLocalReader.read` for a fresh upload, or `retainRoot` plus a `readBeneath` of zero bytes (identity and type check only) for a cached key. A cached `file_key` is therefore delivered only after the same containment check as a fresh upload. No path binds a fresh root at click time.

**Expiry policy, proposed for review, not shipped.** The click refuses with the existing message 文件入口已失效，请让 agent 重新引用文件 when any of these holds: the manifest has no binding, which covers every manifest written before this unit; the manifest was prepared under `unrestricted` and the click's effective policy is `qa`, because no identity exists to bind; the manifest's binding does not match the live grant's binding; or no live grant exists for the project, which is the case after a daemon restart or after a resume created a new grant. A `GrantToken` is never persisted or compared. This is a user-visible migration: old file links stop working after restart until the agent references the file again. The root accepts it as a proposal for review only.

The prepare-time snapshot is compared with the returned identity only to tell the user the file changed. #230 stays open until subunit C is accepted with its own gates. DNS221 is untouched.

## Test matrix

Each test builds its own reader with recording deps that log every `open` with its exact numeric flags and the `bigint` identity of what it returned, and can inject an action before a chosen call or inside a wrapped handle's `stat` or `read`. Fixtures are canonicalized. Columns: L Linux, M macOS, W Windows native, D demonstration only. A demonstration case shows an out-of-model schedule and never counts toward containment acceptance; the universal outside-marker assertion applies to acceptance cases only.

| # | Case | L | M | W |
| --- | --- | --- | --- | --- |
| 1 | baseline read, identity equals `fstat`, root, intermediate, final, and probe flags are exactly the listed numbers | run | run | run |
| 2 | final symlink or reparse point before the final open, `link` | run | run | run |
| 3 | parent symlink before its step, macOS before the single open, `link` | run | run | run |
| 4 | parent swapped after its descriptor, Linux reads `INSIDE` and the final identity equals the original | run | skip | skip |
| 5 | final swap inside the first wrapped `stat`, `INSIDE` | run | run | run |
| 6a | root is a symlink at `retainRoot`, `root-changed` | run | run | run |
| 6b | root replaced by a real directory after `bindOutboundRoot`, `root-changed` on the next batch | run | run | run |
| 6c | D, macOS root replaced after the pre-open `stat`, replacement bytes | skip | D | skip |
| 6d | D, Linux held directory moved out then child opened, held bytes; native fallback on the same schedule returns `missing` | D | skip | skip |
| 7, 8 | growth and truncation inside the wrapped `read`, `changed` | run | run | run |
| 9 | FIFO, POSIX, `not-file`, completes | run | run | n/a |
| 10 | probe negative, `unsupported`, a second instance re-probes, probe handles closed on both outcomes | run | run | n/a |
| 11 | `beneathComponents` refuses root itself, a sibling with the same string prefix, `..`, an empty component, a separator in a component, NUL, and an absolute suffix; accepts a two-level path; Windows also refuses reserved names, trailing dot and space, and a stream suffix | run | run | run |
| 12 | `containmentStrategy` for each platform with and without native and with residual 1 open or closed | run | run | run |
| 13 | binding lifecycle at the eight call sites and two backends: `startThread` receives `launchCwd`; a realpath failure starts the provider on the original cwd with `unbound` `canonicalize-failed`; a cwd alias re-pointed between capture and `startThread` does not change the thread's root; `confirmLaunch` mismatch yields `launch-mismatch`; queued turns share the binding; a goal's turns share it; a resume retires the old grant, new admissions under it refuse `retired`, admitted work and late folds complete; `unbound` refuses local sources with `image-root-unbound` while a remote stub still runs; the 5392 and 5401 sites use their backend's mode resolution | run | run | run |
| 14, 15 | same-length rewrite and grow-then-shrink between the two `fstat` calls are accepted, documented contract | run | run | run |
| 16, 17 | zero-progress read `changed`, empty file `empty` | run | run | run |
| 18 | cleanup matrix, each row of revision 2 plus capture `fstat` rejection, probe positive-open failure, next-open success then old-close rejection, and batch root failure with waiting workers; each owned handle gets exactly one close attempt, a rejected close is recorded as unknown state, nothing is retried | run | run | run |
| 19 | admission: a stalled `uploadPlan`, a stalled probe, a stalled root open, a stalled read, a stalled native worker, and a stalled `image.create` each hold exactly their own budget; the ninth batch, ninth read, fifth native, and seventeenth waiter refuse `busy` with the right `budget`; a waiter expires at 2000 ms and running work keeps its ownership; a cache hit, a local discard, and a synchronous SDK setup throw each release the lease; `transferTo` releases only when the original SDK promise settles, not at the 15 s wrapper; a lease neither released nor transferred fails the test through `image-lease-leak`; native reserves `maxBytes` before dispatch and shrinks on return | run | run | run |
| 20 | mixed batch, plan rejection refuses the local source and the remote stub still runs | run | run | run |
| 21 | late folding: a read that settles after `finalize` returned is folded and repaints as today | run | run | run |
| 22 | native: async worker does not block a 10 ms timer during a 200 ms injected native stall; handle count equal before and after a batch with injected failures; pool of 4 queues the fifth; Windows: a rename of a held intermediate during the read fails with a sharing violation and the read returns inside bytes; a pre-opened delete-access handle on an intermediate makes the read refuse `conflict` without retry; a pending-status injection keeps the IO_STATUS_BLOCK alive until completion | n/a | n/a | run |
| 23 | selection: `selectStrategy` returns `native` for every `unqualified` grant on every platform, the pure strategy only when `closes` has the platform's required set, `unsupported` with no addon; a reader cannot be constructed without a strategy | run | run | run |
| 24 | files DTO: encode and decode round-trip bigint identities losslessly on both platforms; decode refuses a wrong version, a foreign platform, and a malformed string; unrestricted-to-qa click refuses; cached-key send runs the same containment check as a fresh upload; a click with no live grant refuses | run | run | run |

`test/outbound-images.test.ts` keeps its eight expectations on every platform, called with a `bound` binding built from the fixture, and gains the reviewer's repro through `options.deps` expecting inside bytes, plus the pre-open variant expecting no upload.

## Implementation units and rollout

Root decision 5 defines the scope. A Mac and Linux first unit is a bounded progress subunit. It keeps the current Windows read and the current Windows test expectations, leaves BUG220 open on Windows, reduces no gate, and is not acceptance.

1. **Subunit A, Mac and Linux image reader.** `bound-root.ts`, `contained-read.ts`, the `AgentThread.root` field, capture and `confirmLaunch` at the eight call sites and two backends, the uploader signature change and its three callers, the resource contract with the byte lease, tests 1 to 21, 23, and 24 excluding native columns. Commands in order: `npm ci`, `npm run typecheck -w packages/daemon`, `npm test -w packages/daemon -- provider/outbound-contained-read.test.ts provider/outbound-bound-root.test.ts outbound-images.test.ts provider/outbound-policy.test.ts outbound-files.test.ts no-mention-parity.test.ts`, `npm run build -w packages/daemon`, `git diff --check`. Gates: hosted Linux job, self-hosted Mac job, the proof gate for legacy Codex on macOS and legacy Claude on macOS and Linux, lanes 2, 2b, and 3 on the built `dist`, and `dist` gaining no native file.
2. **Subunit B, native unit.** The addon, the loader, packaging amendment, tests 22 and the native columns, per-architecture packed-package proof, the proof gate on Windows for legacy Codex.
3. **Subunit C, files consumer.** Per *Files consumer*, with its own gates.

BUG220 closes when A and B are accepted on their implemented heads and the image uploader uses the reader on all three platforms. #230 closes with C. The V6a gates in `plan.md` lines 1323 to 1366 are retained in full.

**Decided by the root.** Native B serves every unqualified writer on every platform, including legacy Claude `write`. **Separately schedulable.** The admission and resource primitive, with the byte lease, is implementable on its own without the reader or the binding, as the third review marked it PASS as bounded design.

## Review dispositions

| Finding | Disposition | Carried by |
| --- | --- | --- |
| R1 grant-boundary binding | Binding at `startThread` and `resumeThread`, canonical path shared with the provider, one epoch per grant across queued, goal, steered, and resumed turns, `unbound` refuses locally with remote intact, no optional identity, no compatibility path, callers rewired in the unit | *Bound root at the grant boundary*, test 13 |
| R2 enforcement proof | Guarantees split by source of authority, legacy adapters read and their gaps named, mandatory proof gate per provider, version, and profile with paired positive controls, residuals 1 to 3 explicit, hardlink defense withdrawn, native beneath-resolution as the fallback | *Authority*, *Proof gate*, *Native unit* |
| R3 resources | Admission before any filesystem operation with the root's maxima, byte reservation through SDK ownership, bounded waiters, memoized root init, late folding preserved, no drop policy | *Resource contract*, tests 19 and 21 |
| R4 native API | Async workers, platform-tagged lossless identity captured and compared natively, `FILE_TYPE_DISK` and tag checks, reserved-name validation, synchronous-completion opens, RAII, bounded pool, runtime versus build dependencies, packaging amendment, per-architecture proof | *Native unit* |
| R5 tests and boundary | Root and capture flags listed, call-site lifecycle tests, demonstration cases separated, `beneathComponents` semantics corrected, cleanup matrix extended, resource tests added, Windows expectations unchanged | *Test matrix* |

## N1 to N5 dispositions

| Finding | Disposition | Carried by |
| --- | --- | --- |
| N1 launch cwd, grant input, launch identity, lifetime | `OutboundCapture` separates `launchCwd` from the binding; realpath failure keeps the original cwd and yields `unbound`; `OutboundAuthority` with `readScope` and `Qualification` is a caller input; `confirmLaunch` validates around the launch with the pathname-API assumption stated; eight sites and two backends enumerated; `retireGrant` defines lifetime; `GrantToken` is not durable authority | *Bound root at the grant boundary*, test 13 |
| N2 byte lease and cache seam | `ByteLease` with release on cache hit, discard, and setup throw, exactly-once transfer to the original SDK promise, native reserves before allocation; cache keeps its key and reuse with no fresh-byte or isolation guarantee and containment still checked before use | *Resource contract*, *Read contract*, test 19 |
| N3 qualification and qa gate | `selectStrategy(platform, authority, native)` from the carried `Qualification`; native for all unqualified writers; Darwin requires root-parent, move-out, and alias; qa positive control is an inside read with write denial; hardlink probe records three results | *Mechanisms*, *Proof gate*, test 23 |
| N4 Windows chain | Root and intermediates held through the read without delete sharing, `conflict` on sharing violation with no retry, pending I/O storage kept alive, supported volume matrix narrowed, `EAGAIN`/`EXDEV` mapping on Linux | *Native unit*, test 22 |
| N5 files DTO and expiry | Versioned lossless DTO, bigint-safe comparison, validation before both fresh and cached sends, explicit expiry for missing binding, unrestricted-to-qa, mismatch, and no live grant after restart or resume, proposed for review | *Files consumer*, test 24 |

## Integration anchors

To apply after acceptance, by the root, and only for the consumers actually integrated at that head.

- `docs/providers.md` *Outbound*, after "This closes issue #114.": "A `qa` or `write` grant binds its project root at `startThread` or `resumeThread` as an `OutboundRootBinding`, and the image uploader reads local images through a descriptor contained in that bound root, per `outbound-images-security.md`." The files sentence is added only with subunit C.
- `docs/plan.md` V6a *Files*: "Create `outbound/bound-root.ts` and `outbound/contained-read.ts`. Add `root` to `AgentThread`. Bind at every `startThread` and `resumeThread` call. Edit `card/outbound-images.ts` to take the binding."
- `docs/plan.md` V6a *Verify, unit*: the test matrix above by number, with its platform columns.
- `docs/plan.md` V6a *Verify, live*: Lane 2b, and the proof gate rows as recorded evidence per provider.
- `docs/plan.md` packaging and V5 staging: the native prebuild amendment, as a proposal.
- `docs/program-graph.json`: subunits B and C as tasks depending on A.

## Decisions and their principles

Foundational thinking placed the binding at the grant boundary and made it the input of every later step. Type system discipline made unbound and bound unrepresentable as the same value, tagged identities by platform with lossless encodings, and branded the component list. Laziness withdrew the content-hash and drop-policy proposals and kept one mechanism per platform. Boundary discipline kept every refusal in the result union and the proof gate outside the reader. Test behavior, not implementation, separated demonstration cases from acceptance cases and tied each resource test to the budget it proves. Prove it works kept every platform unaccepted until its proof gate and packaged-artifact evidence exist.
