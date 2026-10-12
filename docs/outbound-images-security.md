# Outbound local image read containment (BUG220)

Design only. Baseline `ae26ed377b619807d652acf62c88aef37f0cde46` on `codex/v6a-provider-core`. Written 2026-10-12 for issue BUG220, which the independent review of PR #117 (finding F1) opened against the V6a-T6 outbound gate (#152, #114). Nothing here is implemented. Codex implements it on the Mac as one unit, described under *Implementation unit*.

This document stands alone. It does not edit `providers.md` or `plan.md`. *Integration anchors* at the end names the exact sentences those two files gain once the root accepts this proposal.

## Problem

`packages/daemon/src/card/outbound-images.ts` `loadLocal` (lines 114 to 159) decides containment on a pathname and then reads a pathname. Line 128 realpaths the source through `checkUploadPath` and compares the canonical string with the root. Line 145 stats that canonical pathname. Line 157 reads that canonical pathname with `readFile`. Each of the three calls resolves the path again. A process that can rename or unlink entries inside a `write` project can place a symlink at the final component, or at any parent component, between any two of those calls. The reviewer reproduced it by replacing `image.png` with a symlink to an outside file after `stat` returned and before `readFile` opened. The daemon uploaded the outside bytes. The size check at line 153 reads the same stale `stat`, so a larger replacement passes it too.

`bot/outbound-files.ts` `readSnapshot` (lines 116 to 131) opens with `O_NOFOLLOW`, fstats the descriptor, and compares `dev`, `ino`, `size`, and `mtimeMs` with a snapshot taken earlier by `inspect`. That is better and still not a proof. `O_NOFOLLOW` covers only the final component. The snapshot comes from a pathname `stat`, so if a parent was already a symlink when `inspect` ran, the snapshot describes an outside file, the later open reaches the same outside file, and the identities match. Fixing `outbound-files.ts` is a later unit that reuses the function this document defines. It is not in BUG220's unit.

## Threat model and allowed path

The attacker is the agent process, or anything else running as the same OS user, that can create, rename, unlink, and symlink entries inside the project root while a `qa` or `write` turn is running. The daemon runs as the same OS user but is not confined, so it can read files the agent's sandbox cannot. The attacker chooses the image reference text and the timing of each filesystem change. The attacker cannot write outside the root. That is the sandbox contract the V6a enforcement table promises for `qa` and `write`. Everything above the root is trusted. The root's parent directories, their permissions, and the mount table are not under attacker control.

The security promise this fix preserves is the V6a one in `providers.md` *Outbound* and `plan.md` V6a *You see*. Under `qa` and `write`, the bytes the daemon uploads come from a regular file reachable from the project root through directory entries that are not symlinks, at the moment the daemon opens it. A symlink that leaves the root is never followed. A symlink that stays inside the root still resolves, so the existing test "uploads an inside alias using the canonical in-project file" keeps passing. Under `full`, any local image is readable, matching what the agent's own shell can already print.

What the fix does not promise. It does not prove the file's content is an image. It does not stop a hardlink that already existed inside the root to an outside file on the same filesystem. That is not a race and not BUG220. `realpath` already accepts it today, Linux `fs.protected_hardlinks` (default on) stops a user from linking a file they cannot read or write, and macOS behavior is unverified. The root should track it as a separate item. This unit does not add an `nlink === 1` requirement, because that changes data behavior for legitimately hardlinked images and the root has not asked for it.

Allowed path through the new code, for every local source under `qa` or `write`:

1. `resolve(cwd, src)` gives `abs`. The extension check on `abs` is unchanged.
2. `uploadPlan` and `checkUploadPath` are unchanged. They give `canonical`, a realpath that lies under `plan.grant.root` by string comparison. This stays as the first gate because it is what resolves an inside alias to its target and refuses a static escape with the existing `image-outside-cwd` code.
3. The batch retains the root directory as an open descriptor once per `uploadOutboundImages` call. Its identity is recorded from `fstat`.
4. The file is opened relative to that retained root by the platform strategy below, never by re-resolving `canonical` from `/`. Any symlink encountered in a project component refuses.
5. `fstat` on the opened descriptor is the only metadata the reader trusts. It must be a regular file, non-empty, and at most 10 MiB.
6. Bytes are read from that descriptor, exactly `size` of them. A second `fstat` after the read must show the same `dev`, `ino`, and `size`.
7. All descriptors close in `finally`. The upload uses the buffer. Nothing re-opens the pathname.

Under `full`, steps 3 and 4 are replaced by a plain open of `canonical`. Steps 5 to 7 still apply, so `full` also gains descriptor-based size bounding and no pathname re-read.

## Trusted retained root

`uploadPlan` already computes `root = realpath(cwd)` once per call. The retained root is that pathname opened as a directory and held for the life of one `uploadOutboundImages` call. Its lifetime is the batch, not the project. Retaining it per project would put a descriptor into `EnforcementPlan`, which is a shared data shape with lifecycle and close semantics this fix does not need. Per batch costs one `open` and one `close`, and `StreamingImages` calls upload a handful of times per turn.

```ts
interface RootIdentity { dev: number; ino: number }
interface RetainedRoot {
  readonly path: string;           // plan.grant.root, already a realpath
  readonly identity: RootIdentity; // from fstat on the handle, isDirectory() true
  readonly handle: FileHandle;
  close(): Promise<void>;
}
```

Opening the root uses `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` on Linux and macOS, plus `O_NOFOLLOW_ANY` on macOS. The root pathname's own components are trusted, so a symlink there is not an attack, but the flags cost nothing and turn a replaced root into a refusal rather than a silent follow. If the open fails, every local source in the batch refuses with `image-root-changed` and remote sources are unaffected.

## Platform mechanisms

These are facts about what Node 22 and 24 expose through `node:fs`, checked against this repository's Node 24.21.0 and the libuv headers shipped with it. Native API existence is not enough. Each mechanism below is reachable from `fs.promises.open` with a numeric `flags` argument, which Node passes through to libuv and libuv passes to `open(2)` unchanged on Unix (libuv adds `O_CLOEXEC`). Node has no `openat`, no `openat2`, no `fcntl`, no `F_GETPATH`, and no `GetFinalPathNameByHandleW`.

### Linux: directory-descriptor walk through procfs

`/proc/self/fd/N` is a magic link. Opening `/proc/self/fd/N/name` resolves `name` inside the directory object that descriptor `N` refers to, not inside whatever pathname that directory currently has. This is the user-space equivalent of `openat(N, "name")` and is what libraries use when `openat` is unavailable. With `O_NOFOLLOW` on each step, `name` is refused when it is a symlink. The magic link itself is not the final component, so `O_NOFOLLOW` does not block it.

The walk, for `components = relative(root.path, canonical).split(sep)`, which `checkUploadPath` guarantees contains no empty, `.`, or `..` entries:

```
dir = root.handle
for name in components[0 .. n-2]:
  next = open(`/proc/self/fd/${dir.fd}/${name}`, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  if dir is not root.handle: close(dir)
  dir = next
file = open(`/proc/self/fd/${dir.fd}/${components[n-1]}`, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY)
if dir is not root.handle: close(dir)
```

Each step opens a child of a directory the daemon already holds. No step re-resolves from `/`. A symlink at any project component fails the step with `ELOOP` or `ENOTDIR`, both of which map to the `link` refusal. The daemon never opens an object outside the root, not even transiently. `O_NONBLOCK` and `O_NOCTTY` on the final open make a FIFO or a terminal device placed inside the root harmless to open. `fstat` then refuses anything that is not a regular file. This matches what `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` would give, without needing the syscall.

Observed on this Linux host, Node 24.21.0, kernel 6.8, with a throwaway script in a temporary directory, not product code. A directory descriptor taken for `root/a`, then `root/a` renamed away and replaced by a symlink to an outside directory, still read the inside bytes through `/proc/self/fd/<a>/img.png`. A fresh step through the swapped `root/a` with `O_DIRECTORY | O_NOFOLLOW` failed with `ENOTDIR`. A final component replaced by a symlink and opened through the retained directory descriptor with `O_NOFOLLOW` failed with `ELOOP`. `readlink('/proc/self/fd/<f>')` on the retained file reported its inside path with a ` (deleted)` suffix after the rename.

Requirement. procfs must be mounted at `/proc`. The runtime probe below checks it. `fs.constants.O_DIRECTORY` is 65536 and `O_NOFOLLOW` is 131072 on Linux in Node 24, both present.

### macOS: `O_NOFOLLOW_ANY` plus root identity

Darwin has no procfs, and `/dev/fd/N/name` does not resolve children. Darwin's `open(2)` accepts `O_NOFOLLOW_ANY`, which refuses the open with `ELOOP` if any component of the path is a symlink, not only the last. It was added in macOS 11 and is defined in the SDK's `sys/fcntl.h` as `0x20000000`. Node does not expose it in `fs.constants`, so the code passes the numeric value, which libuv forwards to `open(2)`. Linux ignores unknown flag bits, so the value is harmless there and useless there. The runtime probe is what decides whether it is honoured.

The read, for each local source:

```
st = stat(root.path)
if st.dev !== root.identity.dev or st.ino !== root.identity.ino: refuse root-changed
file = open(canonical, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK | O_NOCTTY)
```

`canonical` is a realpath, so it has no symlinks when computed. If any component becomes a symlink before the kernel walks it, the open fails with `ELOOP` and maps to `link`. If a project directory is renamed and a real directory put in its place, the walk descends into whatever is there, which is inside the root. The only pathname-to-object binding the daemon cannot pin with a descriptor is the root's own, and the `stat` immediately before the open proves that binding at that instant. Between that `stat` and the open, only an actor with write access to the root's parent could re-point it, and that actor is outside the threat model.

Two things must be proved on the Mac before this strategy is accepted. First, the constant's value against the SDK header on the build machine. Second, that `O_NOFOLLOW_ANY` does not treat a firmlink as a symlink. `/Users` on macOS 10.15 and later is a firmlink to `/System/Volumes/Data/Users`, and `realpath` returns the `/Users/...` form. My expectation is that firmlinks are transparent to the kernel path walk and the flag only inspects symlinks, but that is unverified. The probe and the root open make the answer visible at once. If a project root under `/Users` fails with `ELOOP`, the darwin strategy is unsupported as designed and the Mac remains unaccepted until the root picks a replacement, which would be the native addon in *Alternatives*.

### Windows: no pure-Node mechanism

libuv's `uv/win.h` defines `UV_FS_O_NOFOLLOW`, `UV_FS_O_DIRECTORY`, and `UV_FS_O_SYMLINK` all as `0`. That is why `outbound-files.ts` writes `constants.O_NOFOLLOW ?? 0`: on Windows it opens with no symlink protection at all. `CreateFileW` follows reparse points by default, and `FILE_FLAG_OPEN_REPARSE_POINT` only affects the final component and is not reachable from Node. Any user can create a directory junction with `mklink /J` without privilege, so parent replacement is the easy case on Windows, not the hard one. `GetFinalPathNameByHandleW` on the opened handle would give the actual final path of the opened object, which is the Windows equivalent of Linux's `readlink` on a procfs fd, but Node exposes nothing that takes a handle and returns its path. `fs.realpath.native` opens its own handle and closes it.

Consequently, on `win32` under `qa` and `write`, every local image refuses with `image-containment-unsupported`. Remote images and `full` are unaffected. `full` on Windows uses the same descriptor-based open, `fstat`, and bounded read as everywhere else, with no containment because `readableRoots` is `unrestricted`. This is an explicit, logged refusal, not a silent feature loss. Windows acceptance for the local image path stays open until a native mechanism is approved, per *Windows native proposal*. V6a already conditions Windows `qa` and `write` on `windowsSandboxReady` in `enforcement.ts:178`, so the set of Windows projects that reach this refusal is the set whose sandbox was declared ready.

### Runtime capability probe

Platform is a selector, not a proof. A memoized per-process probe decides whether the selected strategy works on this host, and a failed probe makes `qa` and `write` local images refuse with `image-containment-unsupported`.

- Linux. Open the retained root. Open `/proc/self/fd/${root.handle.fd}` with `O_RDONLY | O_DIRECTORY`. Its `fstat` identity must equal the root's. Close it. A missing procfs or a `hidepid` configuration that breaks `self` fails here.
- macOS. In a fresh `mkdtemp` directory, create `d/f`, a symlink `l` to `d`, then `open('l/f', O_RDONLY | O_NOFOLLOW_ANY)` must fail with `ELOOP` and `open('d/f', same flags)` must succeed. Remove the directory. A kernel that ignores the flag passes the first open and fails the probe.
- Windows and anything else. Unsupported without probing.

The probe runs on the first `qa` or `write` local image after daemon start and its result is cached for the process. It is injectable for tests.

## The read protocol

Shared by every strategy once a descriptor exists.

```
info = fstat(file)
if !info.isFile(): refuse not-file
if info.size === 0: refuse empty
if info.size > MAX_BYTES: refuse too-large
bytes = Buffer.alloc(info.size)
offset = 0
while offset < info.size:
  n = read(file, bytes, offset, info.size - offset, offset)
  if n === 0: refuse changed          // shrank during read
  offset += n
again = fstat(file)
if again.dev !== info.dev or again.ino !== info.ino or again.size !== info.size: refuse changed
return { bytes, identity: { dev, ino, size, mtimeMs } }
```

The descriptor is the identity. There is no earlier pathname snapshot to compare against, because that snapshot is exactly what the reviewer showed cannot be trusted. The read is bounded by the `fstat` size, so a file that grows is truncated to the inspected size and then refused by the second `fstat`, and a file that shrinks is refused by the short read. The buffer is at most 10 MiB and the pool keeps at most four in flight, so peak memory is unchanged from today.

The cache key keeps today's shape, `local:${canonical}:${mtimeMs}:${size}`, with the values taken from the descriptor's `fstat` instead of the pathname `stat`. Cache hits behave as before.

## Counterexamples

Each row names the replacement, when it happens relative to the new code, and what each strategy does. "Inside bytes" means the uploaded bytes are those of the regular file that was inside the root when it was opened, which is the promised outcome.

| Replacement | When | Linux walk | macOS `O_NOFOLLOW_ANY` | Windows project scope |
| --- | --- | --- | --- | --- |
| Final component becomes a symlink to an outside file (the review's repro) | after `realpath`, before the final open | final step `ELOOP`, refuse `link`, nothing opened outside | `ELOOP`, refuse `link` | refuse `unsupported` before any open |
| Final component becomes a symlink | after the final open, before or during read | inside bytes from the held descriptor | inside bytes | n/a |
| Parent directory becomes a symlink to an outside directory | before the step that opens that parent | that step `ENOTDIR` or `ELOOP`, refuse `link` | `ELOOP`, refuse `link` | refuse `unsupported` |
| Parent directory becomes a symlink | after its descriptor was taken, before the next step | next step resolves inside the held directory, inside bytes (observed on this host) | the kernel walk is atomic per open, so this is the previous row or the next | n/a |
| Parent directory already a symlink | before `realpath` | `checkUploadPath` resolves through it, canonical is outside, existing `image-outside-cwd` refusal | same | same |
| Parent directory renamed and a real directory put in its place | any time | descends into the new inside directory, inside bytes or `missing` | same | n/a |
| Root pathname re-pointed (needs write on the root's parent, outside the model) | before the batch | root open `ELOOP` or `ENOTDIR`, refuse `root-changed` | pre-open `stat` identity differs, refuse `root-changed` | n/a |
| Entry is a FIFO or device inside the root | at open | opens without blocking, `fstat` not a file, refuse `not-file` | same | n/a |
| File grows or shrinks during the read | during read | refuse `changed` | same | `full` only, same |
| Hardlink inside the root to an outside file on the same filesystem | static | not a race, accepted today, tracked separately | same | same |
| procfs absent, or flag ignored by the kernel | probe | refuse `unsupported` for `qa` and `write`, `full` unaffected | same | always `unsupported` |

The second and fourth rows are the ones that distinguish this design from the current code. The reviewer's repro replaced the file after `stat` and before `readFile`. Under this design the equivalent moment is after the final open and before the read, and the bytes still come from the inside file because the daemon never touches the pathname again.

## Failure codes

Every failure in the local path is a value, not an exception. `readBeneath` and `readUnrestricted` return a discriminated union, and `loadLocal` maps each code to one log event with fixed fields.

| Result code | Log event | Fields |
| --- | --- | --- |
| `unsupported` | `image-containment-unsupported` | `src` (first 80 chars), `strategy`, `platform` |
| `root-changed` | `image-root-changed` | `src`, `errno` |
| `link` | `image-link` | `src`, `errno` |
| `missing` | `image-missing` (existing) | `src` |
| `not-file` | `image-not-file` | `src` |
| `empty`, `too-large` | `image-size` (existing) | `src`, `size` |
| `changed` | `image-changed` | `src` |
| `io` | `image-read-failed` | `src`, `errno` |

`errno` is the `code` string such as `ELOOP`, never `err.message`. Node's error messages embed the full pathname, and on Linux that pathname is `/proc/self/fd/N/name`, which must not reach the log. The `image-failed` catch in `uploadOutboundImages` still logs `String(err)` for upload errors only, because local reads no longer throw. The Feishu card shows the reference as text, as today, and never a reason. The existing `image-outside-cwd` event keeps its `cwd` field because that is current data behavior and the root has not asked to change it.

## Descriptor and process lifetime

Each worker in `mapPool` holds at most two descriptors during a walk, the current directory and the next one, and one during the read. The root descriptor is one more per batch. With `UPLOAD_CONCURRENCY` 4 the batch never holds more than nine descriptors beyond the daemon's baseline. Every open sits in a `try`/`finally` that closes it, including on refusal.

`StreamingImages.finalize` abandons work past its 3 s grace and lets it finish in the background. That is unchanged. An abandoned `loadLocal` still runs to completion, reads at most 10 MiB, and closes its descriptors itself. No `AbortSignal` is added, because the work is bounded and a cancelled read would only save a few milliseconds while adding a cancellation path to test. If the daemon exits mid-read the OS closes the descriptors. libuv opens with `O_CLOEXEC`, so provider child processes spawned during a batch do not inherit them.

## Alternatives

Each alternative is judged on what the API guarantees, not on what it usually does.

**Selected. Per-platform strategies in pure Node.** Linux walks through `/proc/self/fd` with `O_NOFOLLOW` per step. macOS opens the canonical path with `O_NOFOLLOW_ANY` after re-checking the root identity. Windows refuses under project scope. No build, packaging, signing, or distribution change. Deficiencies. Windows `qa` and `write` lose local images until a native mechanism lands. macOS trusts the root's ancestors for the instant between the root `stat` and the open, which is inside the threat model's assumptions but not a descriptor-pinned proof. macOS firmlink behavior of `O_NOFOLLOW_ANY` is unproven until the Mac run. Linux needs procfs. Hardlinks are untouched.

**Linux post-open `readlink('/proc/self/fd/N')` containment check.** Open `canonical` with `O_NOFOLLOW`, read the descriptor's current path from procfs, require it to start with `root.path + sep`. The kernel's `d_path` walks dentry parents, so this is also containment of the opened object. It is three calls instead of a walk. Deficiency. It opens the outside object first and refuses afterwards. With `O_NONBLOCK | O_NOCTTY` that open has no side effect for regular files, FIFOs, or terminals, but it is a weaker invariant than never opening outside the root, and the walk is not much more code. Not selected, and not layered on top, because two mechanisms for one guarantee is more to test for no gain.

**Snapshot identity comparison, the `outbound-files.ts` pattern.** Pathname `stat`, open with `O_NOFOLLOW`, `fstat`, compare. Rejected. The reviewer's parent-before-snapshot case defeats it on every platform, and on Windows `O_NOFOLLOW` is zero so even the final component is unprotected.

**Re-realpath after open and compare pathnames.** Rejected. Still a pathname decision about an object identified by a descriptor. The pathname can be swapped between the realpath and any later use of it.

**Copy the file into a daemon-owned directory, then read the copy.** Rejected. The copy's source open is a pathname open with the same race.

**Native addon through N-API.** `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` on Linux, `openat` with `O_NOFOLLOW` per step on macOS, and `GetFinalPathNameByHandleW` on an opened handle on Windows. This is the only route that gives Windows a proof and the only uniform one. Not selected for Linux and macOS because the pure-Node strategies give the same guarantee there without a native toolchain, prebuilt binaries per platform and architecture, loading a `.node` from the tsup bundle, and signing the binary on macOS. It is proposed below for Windows alone, for the root to approve as its own unit.

**Helper process that opens, verifies, and streams the bytes back.** Same distribution cost as the addon, plus a process lifecycle and no descriptor passing in Node's IPC. Rejected in favour of the addon.

**macOS `/.vol/<dev>/<ino>/name` volfs paths.** Would be an `openat` equivalent by inode. Undocumented and not relied on. Not evaluated further.

## Data behavior preserved

- An image inside the root uploads. An inside alias to an inside file uploads, because `checkUploadPath` resolves it before the walk. A static alias to an outside file refuses with `image-outside-cwd`. A `full` project uploads an outside image. A disallowed extension refuses before any open. A missing file refuses and a resolvable sibling still uploads. These are the eight cases in `test/outbound-images.test.ts`, and their expectations do not change.
- The cache key shape and the `MAX_IMAGES`, `UPLOAD_CONCURRENCY`, `MAX_BYTES`, and timeout constants are unchanged.
- `uploadOutboundImages` keeps its signature for its three callers in `bot/handle-message.ts` (lines 4418, 4516, 5022). An optional trailing `deps` parameter is added for tests only.
- `uploadPlan` is computed once per batch instead of once per source. That is one `realpath(cwd)` per call instead of one per image, and no observable difference.
- Remote images are untouched. The baseline `loadRemote` still uses `fetch`. Wiring it to `fetchRemoteImage` and the DNS deadline work in #221 are separate and already integrated on the policy side.
- `outbound-files.ts` is untouched in this unit.

## Implementation unit

One Codex unit on the Mac, on `codex/v6a-provider-core`, no new branch.

**New file `packages/daemon/src/provider/outbound/contained-read.ts`.**

```ts
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';

export type ContainmentStrategy = 'linux-dirfd' | 'darwin-nofollow-any' | 'unsupported';
export function containmentStrategy(platform: NodeJS.Platform): ContainmentStrategy;

export interface ContainedReadDeps {
  platform: NodeJS.Platform;
  open(path: string, flags: number): Promise<FileHandle>;
  stat(path: string): Promise<Stats>;
}
export const defaultContainedReadDeps: ContainedReadDeps;

export interface FileIdentity { dev: number; ino: number; size: number; mtimeMs: number }
export type ContainedReadFailure =
  | 'unsupported' | 'root-changed' | 'link' | 'missing' | 'not-file' | 'empty' | 'too-large' | 'changed' | 'io';
export type ContainedRead =
  | { ok: true; bytes: Buffer; identity: FileIdentity }
  | { ok: false; code: ContainedReadFailure; errno?: string };

export interface RetainedRoot { readonly path: string; readonly identity: { dev: number; ino: number }; close(): Promise<void> }
export type RetainRoot = { ok: true; root: RetainedRoot } | { ok: false; code: 'unsupported' | 'root-changed' | 'io'; errno?: string };

/** Probe once per process; the result is memoized. Injectable for tests. */
export function probeContainment(deps?: ContainedReadDeps): Promise<boolean>;
export function retainRoot(rootPath: string, deps?: ContainedReadDeps): Promise<RetainRoot>;
/** canonical must already be judged inside rootPath by checkUploadPath. */
export function readBeneath(root: RetainedRoot, canonical: string, maxBytes: number, deps?: ContainedReadDeps): Promise<ContainedRead>;
/** full tier: no containment, same descriptor protocol. */
export function readUnrestricted(canonical: string, maxBytes: number, deps?: ContainedReadDeps): Promise<ContainedRead>;
```

`RetainedRoot` exposes no `FileHandle` to callers. The Linux walk uses the handle internally. `DARWIN_O_NOFOLLOW_ANY = 0x20000000` is a module constant with a comment naming `sys/fcntl.h` and macOS 11.

**Edit `packages/daemon/src/card/outbound-images.ts`.** `uploadOutboundImages(channel, sources, cwd, mode, deps = defaultContainedReadDeps)`. It computes `uploadPlan` once, calls `retainRoot` once when `readableRoots` is not `unrestricted` and at least one source is local, passes both to `loadLocal`, and closes the root in `finally` after `mapPool`. `loadLocal` keeps steps 1 and 2 of *Allowed path*, then calls `readBeneath` or `readUnrestricted`, maps the failure code per *Failure codes*, and builds the cache key from `identity`. The `stat` and `readFile` imports go away.

**New test `packages/daemon/test/provider/outbound-contained-read.test.ts`.** Deterministic injection through `ContainedReadDeps`. The fixture wraps the real `open` and `stat` and can run a replacement callback before a chosen call, counted by call index and matched by path pattern, or wrap the returned `FileHandle` so the replacement runs inside `stat()` or `read()`. Each test creates a temporary project with `a/img.png` holding `inside` and a sibling directory with `img.png` holding a distinct `OUTSIDE` marker. Every test asserts the outside marker never appears in a returned buffer and, on Linux, that no `open` call targeted a path outside the root or outside `/proc/self/fd/`.

1. Baseline. `readBeneath` returns the inside bytes and an identity equal to `fstat` of the file.
2. Final symlink before the final open. Replacement runs before the `open` whose path ends in `img.png`. Expect `{ ok: false, code: 'link' }`.
3. Parent symlink before its step. Replacement swaps `a` for a symlink before the `open` whose path ends in `/a`. Expect `link`.
4. Parent swap after its descriptor. Linux only. Replacement runs after the `/a` open returned. Expect inside bytes.
5. Final swap after `fstat`. The wrapped handle's first `stat()` runs the replacement after the real `fstat`. Expect inside bytes.
6. Root re-pointed before `retainRoot`. Expect `root-changed`. On macOS, also a root re-pointed between `retainRoot` and the pre-open `stat`, expect `root-changed`.
7. Growth during read. The wrapped `read()` appends to the file on its first call. Expect `changed`.
8. Shrink during read. The wrapped `read()` truncates the file on its first call. Expect `changed`.
9. FIFO inside the root, POSIX only, created with the `mkfifo` binary and skipped if absent. Expect `not-file`, and the test completes, which proves `O_NONBLOCK`.
10. Probe failure. `deps.open` throws for the probe path. Expect `readBeneath` to return `unsupported` and `readUnrestricted` to still return bytes.
11. Strategy selection. `containmentStrategy('linux')`, `('darwin')`, `('win32')`, `('freebsd')` return the four expected values.
12. Windows, run by the hosted `windows-2025` job. `retainRoot` returns `unsupported`, a `write` upload of an inside image produces no upload call, a `full` upload of the same image uploads, and a junction inside the root to an outside directory under `full` uploads, documenting that `full` follows reparse points.
13. macOS, run by the self-hosted Mac job and by Codex. The probe returns true. A project root under `/Users` opens. A symlink at a parent and at the final component each refuse with `link`.

**Edit `packages/daemon/test/outbound-images.test.ts`.** Add the reviewer's repro verbatim in shape, through the `deps` parameter. The wrapped handle's `stat()` unlinks `image.png` and symlinks it to the outside `private.png` after the real `fstat`. Expect the fake `image.create` to receive `normal`, not `OUTSIDE_SYNTHETIC_SECRET`. Add a second case where the replacement runs before the final `open`. Expect no upload call and the map to lack the source. The eight existing cases are unchanged.

**Verification commands, in this order, each recorded with its exit code and the head SHA.**

```
npm ci
npm run typecheck -w packages/daemon
npm test -w packages/daemon -- provider/outbound-contained-read.test.ts outbound-images.test.ts provider/outbound-policy.test.ts outbound-files.test.ts no-mention-parity.test.ts
npm run build -w packages/daemon
git diff --check
```

The named test files are explicit so no provider glob or native process helper runs. The four existing files must keep their current pass counts.

**Native proof gates.**

- Linux. The hosted `ubuntu-latest` job runs the test file. GitHub runners have procfs. Record the run URL. Optional: Codex runs the same command on JP-VPS over SSH and records `uname -r` and `node --version`.
- macOS. The self-hosted Mac job runs the test file at the PR head. Codex also runs it locally and records `sw_vers`, `uname -r`, `node --version`, the SDK header line that defines `O_NOFOLLOW_ANY`, and the probe's `ELOOP` result. Then, on the built `dist` started with `node packages/daemon/bin/vonvon.mjs daemon run` in a real Feishu test group, V6a lanes 2 and 3 from `plan.md`, saved as `symlink.txt` and `inside.txt`, plus one new lane. Lane 2b. In a `write` project under `/Users`, a real PNG at `frames/img.png`, reply `![](frames/img.png)`. Save `nested.txt`. Pass when the image uploads, which proves a two-component path through a firmlinked root. A race cannot be driven live, so the deterministic tests are the race evidence and the lanes are the packaged-runtime evidence.
- Windows. The hosted `windows-2025` job runs case 12. The result is a passing refusal, recorded as "Windows project-scope local images refused by design, unaccepted". No Windows run is recorded as acceptance of the local image path.
- Packaging. The daemon bundle gains no native file. `npm run build -w packages/daemon` output under `packages/daemon/dist/` contains no `.node` and no new dependency. Record `ls packages/daemon/dist` and the `package.json` diff, which must be empty.

**Acceptance per platform.**

| Platform | Accepted when | Status after this unit |
| --- | --- | --- |
| Linux | hosted Linux job green at the head, tests 1 to 11 pass | accepted |
| macOS | Mac job green, local test run recorded, lanes 2, 2b, 3 saved, firmlink root opens | accepted if the firmlink proof passes, otherwise unaccepted with the recorded `ELOOP` |
| Windows | never by this unit | unaccepted, refuses under project scope, `full` works |

BUG220 closes when Linux and macOS are accepted and the Windows refusal is recorded. The Windows local image path becomes its own issue, labelled for V6a, carrying the proposal below.

## Windows native proposal

For the root to approve or defer. Not part of this unit, and not assumed to exist anywhere in the code above.

- Architecture. A N-API addon, source under `packages/daemon/native/contained-open/`, exporting `openBeneath(rootFd, relativePath)` and `finalPath(fd)`. On Windows it opens with `CreateFileW` and `FILE_FLAG_OPEN_REPARSE_POINT` per component from a directory handle, or opens the full path and verifies `GetFinalPathNameByHandleW` against the root, and returns a CRT descriptor Node can wrap. On Linux and macOS it would not be used.
- Distribution. Prebuilt with `prebuildify` for `win32-x64` and `win32-arm64`, shipped under `packages/daemon/prebuilds/`, loaded with `node-gyp-build` behind a `try`/`catch` that yields `unsupported` when absent. The `global-npm` package adds the prebuilds to `files`. No build step at install time.
- Authority. In-process, same rights as the daemon, no new privilege, no service.
- Lifecycle. Loaded lazily on the first Windows `qa` or `write` local image. Unloaded with the process.
- Public type change. `ContainmentStrategy` gains `'native-addon'`. `containmentStrategy` returns it on `win32` when the addon loads.
- Cost the root is approving. A C++ toolchain on the Windows CI runner, a prebuild job, binary artifacts in the repository or a release pipeline, and a supply-chain review of two small dependencies.

## Integration anchors

To apply after acceptance, by the root, in the files this document does not edit.

- `docs/providers.md`, section *Outbound*, after the sentence ending "This closes issue #114.", add: "Under `qa` and `write` the uploader reads a local image through a descriptor contained in the retained project root, per `outbound-images-security.md`. On Linux it walks `/proc/self/fd` with `O_NOFOLLOW` per component. On macOS it opens with `O_NOFOLLOW_ANY` after re-checking the root identity. On Windows the local image path refuses under project scope until a native mechanism is approved."
- `docs/plan.md`, V6a *Files*, after the bullet that creates `outbound/policy.ts`, add a bullet: "Create `outbound/contained-read.ts` (`containmentStrategy`, `probeContainment`, `retainRoot`, `readBeneath`, `readUnrestricted`). Edit `card/outbound-images.ts` to read local images through it."
- `docs/plan.md`, V6a *Verify, unit*, after the `outbound-policy.test.ts` bullet, add: "`outbound-contained-read.test.ts`: the thirteen cases in `outbound-images-security.md` *Implementation unit*, with the Windows case run by the hosted Windows job and the macOS case by the Mac job. `outbound-images.test.ts` gains the review's replacement repro and asserts the inside bytes are uploaded."
- `docs/plan.md`, V6a *Verify, live*, after Lane 3, add Lane 2b as written above.
- `docs/plan.md`, V6a *You see*, extend the sentence to: "...is no longer uploaded, a local image replaced by a symlink while it is being read is not uploaded, and a remote image is fetched only when the project network switch is on."
- `docs/program-graph.json`. A new task for the Windows native proposal, labelled for V6a, depending on this unit, if the root approves it. Otherwise a recorded deferral.

## Decisions and their principles

Foundational thinking fixed the data shape first. The descriptor is the identity and the root is retained as a descriptor for the batch, which made the parent-replacement question answerable per platform instead of per call site. Laziness kept the root per batch rather than in `EnforcementPlan`, kept one mechanism per platform, and left `outbound-files.ts` and the cache key alone. Boundary discipline put every refusal into a result union at the filesystem boundary, so `loadLocal` maps codes and never sees a pathname in an error message. Test behavior, not implementation, shaped the thirteen cases. Each one names the replacement it injects and asserts the bytes or the refusal, and the fixture asserts the outside marker is never read. Prove it works shaped the native gates. The constant, the firmlink behavior, and procfs are each proved by a probe on the real host, and a platform where nothing can be proved refuses instead of passing.
