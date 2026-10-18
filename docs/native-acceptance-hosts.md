# Native acceptance hosts

This document defines how Codex prepares and uses the dedicated Linux acceptance host, and how every native run that uses a dedicated test context tears down what it owns. [plan.md](plan.md) V5 *Native acceptance environment* and V8 *Verify, live* refer to it. It changes no pass criterion of any box.

## Scope and authority

- The user granted root SSH to the Tencent host `203.0.113.10` for independent use, and testing in `clay`. No further user permission is needed for anything in this document. The work waits only for the accepted design, its independent review, and the root's assignment.
- The protected services on the Tencent host are the bridge website, the notelet site and its automatic update path, the account service, and every other service that runs there. On `clay`, the protected service is the daily bridge.
- The owned fallback VM F on the Mac mini, under *Fallback VM F*, carries V5's Linux half when the Tencent host is not eligible. It runs no production service. Its method has passed source review only, and its gates keep it ineligible until they close.
- A real user action remains only where no agent can act: logging `test-user` into a macOS GUI session, and a provider credential that does not exist yet.

## Linux host facts and limits

Verified facts. Each comes from read-only evidence named in the corrected proposal.

- OpenCloudOS 9.6, x86_64, 4 CPU, 3655 MiB RAM, 1024 MiB swap, one root filesystem `/dev/vda1` of 40 G with 32 G free, from one snapshot.
- Production on the host includes nginx, `vonvon-account.service` on `127.0.0.1:8787`, `bt.service`, `site_total.service`, `postfix.service`, `crond.service`, and `sshd.service`.
- A read-only platform refresh by the root on 2026-10-12 recorded the following. Kernel `6.6.119-49.23.oc9.x86_64`. systemd 255 (`v255-20.oc9.ap.3`, `default-hierarchy=unified`). `/sys/fs/cgroup` is `cgroup2fs`. The available controllers are `cpuset cpu io memory net_cls hugetlb pids rdma misc`. Root filesystem 32794760 KiB free. RAM 3655 MiB total, 2784 MiB available. Swap 1024 MiB, none used. `getent passwd accept-user` printed nothing, so the test user does not exist yet.
- These facts make the host eligible for the procedure below. They do not prove that `set-property` works on the slice, that check V1 or V passes, or that the caps take effect. The preparation gates stay in place.
- Still not recorded: user unit files in any home, cron and timer definitions, and the notelet update path. Record B0 covers them.

Resources the test user still shares with production after preparation:

- The kernel, the page cache, and kernel memory.
- The root filesystem, its space, and its I/O bandwidth.
- Network bandwidth and outbound connections.
- The system journal, which stores the test user's unit logs.
- CPU time up to the cap below.

The slice caps below contain memory, swap, CPU time, and task count. Nothing in this document caps disk space, disk I/O, network, or the journal. Those are monitored, and a run stops when a monitor crosses its limit.

## Containment values

The values in this section are proposals. Their units are exact, and calibration may change them only within the stated bounds.

| Property on `user-<U>.slice` | Value | Bound |
| --- | --- | --- |
| `MemoryMax` | `1536M` | Never above `MemTotal` minus 2048 MiB, measured at B0. |
| `MemorySwapMax` | `0` | Fixed. The test user never pushes production into swap. |
| `CPUQuota` | `200%` | Fixed. Two of four CPUs remain outside the cap. |
| `TasksMax` | `512` | Fixed. |

Monitored limits. Every record R checks them. The root agent also samples them every 10 s while `npm ci`, the build, the pack, and each native step or lane run. It reads the values read-only over its own SSH session and stores them in the evidence on the Mac. These are samples, not continuous enforcement. A crossing between two samples is not observed. Only the four slice caps above are enforced continuously, by the kernel.

| Monitor | Run starts only when | Run stops when |
| --- | --- | --- |
| `MemAvailable` | at least `MemoryMax` plus 512 MiB | not used as a stop rule |
| Root filesystem free space | at least 20 GiB | below 14 GiB |
| `du -sxb /home/accept-user` | not used as a start rule | above 6 GiB |
| `/proc/pressure/memory` `full avg10` | at most 1.00 | above 10.00 |
| `/proc/pressure/io` `full avg10` | at most 5.00 | above 25.00 |

When a sample crosses a stop limit, the test user's current command is allowed to finish or is interrupted by the test user's own shell. No further command starts. The run is recorded as stopped. The root agent sends no signal to any process.

Calibration. The first build under the cap records `memory.peak` of the slice, or the highest `memory.current` sample when the kernel has no `memory.peak`. If the slice's `memory.events` shows `oom_kill` above 0 during the build, the root may raise `MemoryMax` to 1.25 times the recorded peak, but never above the bound. If the bound is not enough, the Tencent host is not eligible for that work, and the run moves to the fallback VM. Every change of a value is recorded with its measurement in the next evidence bundle.

## Records

Record B is the full protective record. Record R is the checkpoint record. Both are read-only and run as root over SSH. Neither one writes to the host, apart from the evidence that the root agent stores on the Mac.

Record B contains R and also the following.

- `uname -r`, `systemctl --version`, `stat -fc %T /sys/fs/cgroup`, and `cat /sys/fs/cgroup/cgroup.subtree_control`.
- The sha256 of the `FragmentPath` file and of every drop-in of each unit that was running at B0.
- The sha256 of every file under `/etc/nginx`.
- Cron and timer coverage: `systemctl list-timers --all --no-legend`, and the sha256 of `/etc/crontab`, of each file under `/etc/cron.d`, `/etc/cron.hourly`, `/etc/cron.daily`, `/etc/cron.weekly`, `/etc/cron.monthly`, and `/var/spool/cron`, and of the BT panel's cron directory `/www/server/cron` when it exists.
- User unit coverage: `ls /var/lib/systemd/linger`, and the path and sha256 of every file that `find / -xdev -path '*/systemd/user/*' -type f` lists outside `/usr`, `/etc`, and `/home/accept-user`. Teardown T checks the test user's own units.
- Account files AF, under *Account files*. On a host labelled `AF unavailable`, the sha256 of `/etc/passwd` and of `/etc/group`, computed without the `accept-user` lines.
- `readlink -f` of `/var/www/vonvon-site/current`, `/var/www/notelet-site/current`, `/var/www/vonvon-account/current`, and `/opt/vonvon-account/current`.
- `journalctl --disk-usage`.
- Production port set Π, under *Run listeners*.
- Outside-home inventory I, under *Outside-home inventory*.

Record R contains the following.

- For each unit running at B0: `systemctl show -p Id -p ActiveState -p SubState -p MainPID -p ExecMainStartTimestamp -p NRestarts`.
- `systemctl list-units --type=service --state=running --no-legend` as a sorted list of unit names.
- `ss -ltnupeH`, taken once. Its sorted local-address column is the compared listener list. Its owner columns are the input to *Run listeners*. No other `ss` call is used in the record.
- Availability: `curl -sS -o /dev/null -w '%{http_code}\n' --resolve <name>:443:127.0.0.1 https://<name>/` for `bridge.vonvon.cc` and `notelet.vonvon.cc`. This is one read-only GET each, and it sends no test traffic to the account service.
- The monitors from the table above: `/proc/meminfo` `MemAvailable`, `df -B1 --output=avail /`, the `du` of the test home, and the two pressure files.
- After the slice exists: `memory.current`, `memory.peak` when it exists, `memory.events`, `cpu.stat`, and `pids.current` of the slice.
- After the slice exists: membership check M below.

Owned additions. Preparation creates the following host state. It belongs to the test user, not to production, and it persists across runs until retirement.

| Owned addition | Created by | Where it appears in a record |
| --- | --- | --- |
| `user@<U>.service` and `user-runtime-dir@<U>.service` | step 4 | running unit set |
| `/var/lib/systemd/linger/accept-user` | step 4 | user unit coverage |
| `user-<U>.slice` and `/etc/systemd/system.control/user-<U>.slice.d/` | step 3 | not compared |
| The `accept-user` lines in `/etc/passwd`, `/etc/shadow`, `/etc/group`, and `/etc/gshadow`, the four `-` backups, `/etc/.pwd.lock` when absent before, and `/home/accept-user` | step 2 | AF under *Account files*. The home is already excluded. |

Comparison rules.

- Every R and the final B are compared with B0. In each record, first remove the owned additions that exist at that point. The remaining running unit set must equal B0's set without its owned additions. The identity fields of every unit running at B0, excluding owned additions, must equal B0. The listener list and the availability codes must also equal B0. During the run only, the listener list may also contain the listeners that *Run listeners* allows. The final B allows none of them.
- In the final B, the definition hashes, the cron and timer coverage, and the user unit coverage without the owned linger entry must also equal B0, and AF must pass under *Account files*. On a host labelled `AF unavailable`, the `passwd` and `group` hashes must equal B0 instead.
- In every T and in the final B, inventory I is compared under *Outside-home inventory*.
- Only the table names owned additions. An added unit, linger entry, user, or listener that is not in the table is a difference.
- The `readlink -f` targets and `journalctl --disk-usage` are observations, not pass conditions. A production publisher may change a `current` target legitimately. The test user cannot write those paths, and check W below proves it.
- Any difference in a compared field stops the run. The box stays unchecked, and every record is kept. The record classifies the difference as test-attributable, production-scheduled with its evidence, or unknown. A production-scheduled difference still fails the run. That run is repeated later, and the failed run is never counted as a pass. No production unit is repaired, restarted, or reloaded by the run.

### Run listeners

The product holds four mutexes for each data root, with the roles `host`, `admission`, `keystore`, and `service` (s08). Before s20c each mutex was a TCP listener on `127.0.0.1`. Its port, the role port, is `20000 + (the first four bytes of sha256("vonvon-bot-v2:<role>:<realpath of VONVON_HOME>"), read as a big-endian UInt32) mod 30000`, as `config/data-access.ts` computes it. On Windows the mutexes are named pipes.

Since s20c the mutex itself is no longer the port. On Linux it is the abstract Unix socket `@vonvon-bot-mutex-v3:<role>:<sha256 hex of the realpath>`, listed by `ss -lx`. On macOS it is an `O_EXLOCK` lock on `<data root>/.locks/<role>.lock`. Builds from s20c up to s20e also listen on the role port above whenever that port is free: the transition from pre-s20c builds (`docs/v1-plan.md`, s20c). s20e removed that transition (`docs/v1-plan.md`, s20e), so a build that includes s20e never listens on a role port, and the rules below that apply "until the transition is removed" do not apply to it. For an older build they still apply, and a role port that is missing because another socket had it is not a failure.

Production port set Π. Before each run, root reads the sources below read-only and records, for each source, either the ports it found or `unresolved`.

- The listeners at B0, from `ss -ltnuH`.
- Every unit file from `systemctl list-unit-files`, in the system manager and in every user manager. Read its `ListenStream`, its `ListenDatagram`, and every port that appears in `ExecStart*`, in `Environment`, and in the files that `EnvironmentFile` names.
- The `listen` directives in `nginx -T`.
- The BT panel's own port, and the port of each piece of software under `/www/server`, read from that software's configuration.
- Every cron and timer command that the record already hashes, when that command starts a listener.
- The fixed ports 22, 25, 80, 443, 8787, and 8888.

If any source is `unresolved`, the Tencent host is not eligible for the run, and the box runs on the fallback VM. Π covers configuration as it was at preflight. A change made to production during the run is detected under the comparison rules, and nothing prevents it.

Declared homes. Before preflight, the run ledger names exactly three data roots: `H_run`, which is the run's `VONVON_HOME`; `H_neg`, used in *Packaged build* step 7; and `H_smoke`, used in step 6. For each one, the test user creates the directory with `mkdir`, and `realpath` must print the same path. Root then computes the four role ports of each home. Until the transition is removed, the resulting twelve ports must be pairwise distinct, must all differ from `P`, and must all lie outside Π. If a home fails this check, the run picks a new name for it. `P` must lie outside `20000-49999` and outside Π. Every `vonvon service install` in the run passes `--port <P>`.

R records are taken only at quiescent points: between steps, after every command that the step launched has exited. At a quiescent point, a listener that is not in B0 is allowed only when it is one of the following.

1. `127.0.0.1:<P>`, held by the daemon of `H_run`.
2. The port of (`H_run`, host), held by the daemon of `H_run`. Its `/proc/<pid>/cmdline` is the installed `bin/vonvon.mjs` running `daemon run`. When `H_run/daemon.pid` exists, it names this pid. If `P` is present in the record and its owner's `VONVON_HOME` is `H_run`, then `P` also has this pid.
3. The port of (`H_run`, keystore), held by that daemon or by one of its Bot children, during a step that registers, refreshes, or onboards a bot, or removes a secret. A Bot child runs `daemon run --bot` and has that daemon's pid as its `PPid`.

The `admission` and `service` roles of any home, and every role of `H_neg` and `H_smoke`, are never allowed at a quiescent point.

The proof for a listener has four ordered parts:

1. Read field 22 of `/proc/<pid>/stat` as `b1`.
2. Read `status` (Uid, PPid), `cgroup`, `exe`, `cmdline`, `environ`, and `readlink fd/<fd>`.
3. Read field 22 again as `b2`.
4. Read `readlink fd/<fd>` again.

The proof holds only when all of the following are true:

- Every read succeeded.
- `b1 = b2`.
- Both readlinks equal `socket:[<inode>]`, where the inode is the one `ss` reported.
- The real and effective UID are `<U>`.
- `exe` is `/home/accept-user/.local/node/bin/node`.
- `VONVON_HOME` in `environ` is the declared home.
- The port is that home's port for the expected role.
- The cmdline matches the listener's row above.
- The cgroup is the caller's own: `app.slice/vonvon-bot.service` for the service daemon, the session's `session-<n>.scope` for a daemon started from SSH, or `app.slice/vonvon-bot-update-<hex>.scope` for a restart replacement. All three lie under `/user.slice/user-<U>.slice/`. A cgroup match never passes a proof alone.

A failed read, a changed birth, or a changed fd makes the proof inconclusive. An inconclusive proof stops the run as a difference does, even when a legitimate holder has just exited. A listener that matches no row stops the run. No listener is allowed because of its UID, its process, or its port range alone. Production listeners are compared by address only. Records are snapshots, and they do not show what happened between two records.

Root records `(pid, b1)` for every holder of the `H_run` host role.

### Outside-home inventory

Inventory I is taken by root. Record `findmnt -rn -o TARGET,FSTYPE,SOURCE,OPTIONS` before and after it. Then run:

    find / \( -path /proc -o -path /sys -o -path /home/accept-user \) -prune -o \( -uid <U> -o -gid <G> \) -printf '%y %i %n %U %G %m %s %T@ %p\n'

The command does not use `-xdev`. The inventory is valid only when both mount tables are identical, `find` exits 0, and its stderr is empty. Otherwise it is inconclusive, and the gate stops.

Each entry of I must be one of the following, shown by positive evidence:

- An account artifact. An example is the mail spool, when `/etc/default/useradd` or `/etc/login.defs` shows that `useradd` creates it.
- An entry under `/run/user/<U>`. That mount must be tmpfs with `uid=<U>`. Each socket under it must have an owner in `ss -xlpH` that is the user manager or one of its units.
- The quarantined residue Q, matched exactly.

Any other entry keeps T open.

A valid inventory proves only that, at that moment, no such entry exists outside these classes. It does not prove that no write happened outside the home and was later removed.

Hosts prepared under this text take I0 at step 7. On the current Tencent host, no inventory was taken before user workload, and I0 is recorded as `I0 unavailable`. Nothing that depends on I0 is claimed for that host.

### Account files

Account files AF is the observation of every account database file that `groupadd`, `useradd`, and `userdel` can write. It applies to a host whose fresh B0 recorded AF. The Tencent host recorded only the two hashes of `/etc/passwd` and `/etc/group` before preparation. It keeps that two-hash comparison and is labelled `AF unavailable`, in the same way as `I0 unavailable`. No AF claim is made for it.

AF covers 13 paths in `/etc`. These are the 12 database paths `passwd`, `passwd-`, `shadow`, `shadow-`, `group`, `group-`, `gshadow`, `gshadow-`, `subuid`, `subuid-`, `subgid`, and `subgid-`, plus `.pwd.lock`. Root takes two read-only observations. Each must exit 0 with an empty stderr.

    find /etc -mindepth 1 -maxdepth 1 \( -name passwd -o -name passwd- -o -name shadow -o -name shadow- -o -name group -o -name group- -o -name gshadow -o -name gshadow- -o -name subuid -o -name subuid- -o -name subgid -o -name subgid- -o -name .pwd.lock \) -printf '%y %n %U %G %m %s %i %p\n'
    find /etc -mindepth 1 -maxdepth 1 -type f \( -name passwd -o -name passwd- -o -name shadow -o -name shadow- -o -name group -o -name group- -o -name gshadow -o -name gshadow- -o -name subuid -o -name subuid- -o -name subgid -o -name subgid- \) -printf '%p %i %s\n' -exec base64 -w0 -- {} \; -printf '\n'

Root takes AF in every B, in the R after step 2 (called R2), and in the R after step 4. The content of `shadow` and `gshadow` is private evidence, and public summaries show only hashes.

Type gate at the fresh B0. The host is not eligible, and no account is created, unless every existing AF path has link count 1 and the following holds. Any other type, including a symlink, a directory, a FIFO, a socket, or a device, fails the gate.

| Path | Allowed at the fresh B0 |
| --- | --- |
| `passwd`, `shadow`, `group`, `gshadow` | exists, type `f` |
| `passwd-`, `shadow-`, `group-`, `gshadow-` | absent, or type `f` with the owner, group, and mode of its own primary |
| `subuid`, `subgid`, `subuid-`, `subgid-` | absent, or type `f` |
| `.pwd.lock` | absent, or type `f` with size 0 |

Correspondence. Each AF observation is malformed, and its gate stops, when any of the following is true:

- One of the 13 paths has more than one metadata row.
- A metadata row names a path outside the 13.
- A database path whose metadata row says `f` does not have exactly one content pair.
- A content pair exists for an absent path, for a path whose type is not `f`, or for `.pwd.lock`.
- A content pair's inode or size differs from its metadata row.
- The base64 is not strict and canonical.
- The decoded length differs from the size.

A difference between the two commands means a write happened between them. The observation is then inconclusive.

Owned lines. Each primary file is an ordered list of lines.

| File | Owned lines from step 2 until retirement |
| --- | --- |
| `passwd` | exactly `accept-user:x:<U>:<G>:vonvon native acceptance:/home/accept-user:/bin/bash` |
| `group` | exactly `accept-user:x:<G>:` |
| `shadow` | exactly one line whose first field is `accept-user` and whose password field is `!` or `!*`. Every field is frozen at R2. Field 3 must be the UTC day of step 2. |
| `gshadow` | exactly `accept-user:!::` |
| `subuid`, `subgid` | none |

Transitions. `X` is one of `passwd`, `shadow`, `group`, and `gshadow`, and `X-` is its backup. "Meta" means type, link count, owner, group, and mode.

| Point | `X` | `X-` | `subuid`, `subgid`, and their backups | `.pwd.lock` |
| --- | --- | --- | --- | --- |
| R2, the only account write in preparation | The fresh B0's `X` with exactly its owned line added and every other line in order. Meta as at the fresh B0. Any inode. | Exists as type `f`. Bytes equal the fresh B0's `X`. Meta of the fresh B0's `X`, link count 1. Any inode. | Bytes and every metadata field as at the fresh B0. Absent stays absent. | As at the fresh B0. If it was absent there, it may now be present as residue PL: type `f`, size 0, link count 1, owner 0, group 0, mode 600, any inode. |
| From R2 until the retirement commands | Every field of all 13 paths equals the R2 observation (FAF) exactly. That includes the R after step 4, every later-run B0, and every final B. | Equal to FAF | Equal to FAF | Equal to FAF |
| Retirement B, the only other write | Bytes and meta equal the fresh B0's `X`. Any inode. | Residue BK. Exists as type `f`. Bytes equal FAF's `X`. Meta of the fresh B0's `X`, link count 1. Any inode. | As at the fresh B0 | As at the fresh B0, or PL equal to its FAF row |

Any other change is a difference. That includes a type, link count, owner, group, or mode change, a size or inode change outside R2 and retirement, and a path that appears or disappears. A backup that still equals the fresh B0's backup at R2, because no write happened, is a difference. BK and PL are recorded at retirement as named residues and are never deleted.

Source qualification. These predictions rest on source claims about shadow-utils. S1: `-K SUB_UID_COUNT=0 -K SUB_GID_COUNT=0` stops subordinate-range allocation, because `main()` reads the counts after `process_flags()` applies `-K`. S2: `-l` skips the faillog, lastlog, and tallylog resets. S3: `-g` with an existing group and no `-G` writes no group entry. These three were read in upstream tag 4.13 `src/useradd.c`. S4: backups are written only when a database changes, and `lckpwdf()` may create `.pwd.lock`. S5: `groupadd` writes `group` and `gshadow`, and `userdel -r` removes the user's lines and its same-named primary group. S4 and S5 are inferred, not read. None of them has been checked against the installed version or Ubuntu's patches. That check is gate P-src. Before step 2, root records `dpkg-query -W -f='${Version}' passwd` and `useradd --help`, and the source of exactly that version must confirm S1 to S5. If a claim is wrong, a comparison above fails and the run stops.

## Sequence

The protective baseline B0 comes before every write to the host. All steps run strictly in this order. A failed gate stops the sequence at that step.

1. B0. Take record B. Gates: `systemctl --version` reports systemd 255, `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`, `cgroup.subtree_control` contains `memory`, `cpu`, and `pids`, and every start condition in the monitor table holds. If the cgroup mode is not `cgroup2fs`, the host is not eligible, and the work moves to the fallback VM under *Fallback VM F*. Root also builds Π under *Run listeners*. If any source is `unresolved`, the host is not eligible for the run, and the work moves to the fallback VM. For a host that has no `accept-user` user yet, root picks a numeric `<U>` and `<G>` that are absent from complete `getent passwd` and `getent group` enumerations, records them, and takes inventory I with them. That inventory must be valid and empty. Root also takes AF, which must pass the type gate under *Account files*, and records `dpkg-query -W -f='${Version}' passwd` and `useradd --help` for P-src.
2. Create the user. `-l` keeps `useradd` from writing login records, and the two `-K` values keep it from allocating subordinate ID ranges, under the source claims in *Account files*. Then take R, which includes AF (R2).

   ```
   groupadd -g <G> accept-user
   useradd -l -K SUB_UID_COUNT=0 -K SUB_GID_COUNT=0 -u <U> -g <G> --create-home --shell /bin/bash --comment "vonvon native acceptance" accept-user
   id accept-user                      # must print uid=<U> gid=<G>
   ```

3. Apply the caps before any process of the user exists. `systemctl set-property` applies the values to the running manager and stores them under `/etc/systemd/system.control/`. It needs no `daemon-reload`. Then check V1 and take R.

   ```
   U=$(id -u accept-user)
   systemctl set-property user-$U.slice MemoryMax=1536M MemorySwapMax=0 CPUQuota=200% TasksMax=512
   systemctl show user-$U.slice -p LoadState -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec -p TasksMax
   ```

   Check V1 passes when `LoadState=loaded`, `MemoryMax` prints the byte value of the cap, `MemorySwapMax=0`, `CPUQuotaPerSecUSec=2s`, and `TasksMax=512`. No process of the user exists yet. If `set-property` or V1 fails, the sequence stops here.

4. Enable linger. The R after this step includes AF. This starts `user@<U>.service`, the user's systemd manager, inside the capped slice. The kernel creates the slice's cgroup only when its first process starts, so the kernel files can be read only after this step. The manager is the only process of the user until step 5 passes. Then take R.

   ```
   loginctl enable-linger accept-user
   ```

5. Read back the containment from the kernel. This is check V. It must pass before any login as the user, before any user workload, and before every run.

   ```
   G=/sys/fs/cgroup/user.slice/user-$U.slice
   systemctl show user-$U.slice -p ActiveState -p ControlGroup -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec -p TasksMax
   cat /sys/fs/cgroup/user.slice/cgroup.subtree_control
   cat $G/memory.max $G/memory.swap.max $G/cpu.max $G/pids.max
   ```

   Pass when `ActiveState=active`, `ControlGroup=/user.slice/user-<U>.slice`, the parent's `cgroup.subtree_control` contains `memory`, `cpu`, and `pids`, `memory.max` prints the byte value of `MemoryMax`, `memory.swap.max` prints `0`, `cpu.max` prints `200000 100000`, and `pids.max` prints `512`. Membership check M must also pass, and its only processes must be the user manager's. The kernel enforces these files. No load probe runs on the production host, because a probe that reaches the cap would itself use the headroom that the cap protects.
6. Install the SSH key for the user. Then take R.

   ```
   install -d -m 0700 -o accept-user -g accept-user /home/accept-user/.ssh
   install -m 0600 -o accept-user -g accept-user /dev/stdin /home/accept-user/.ssh/authorized_keys <<'KEY'
   <Codex Mac mini public key, one line>
   KEY
   ```

7. Check W, as `accept-user`. Each of these must fail: `test -w` on `/var/www`, `/var/www/vonvon-site/current`, `/var/www/notelet-site/current`, `/opt/vonvon-account`, `/etc/nginx`, `/etc/systemd/system`, and `/www/server` when it exists. Then take R. Then root takes inventory I0. It must be valid, and each entry must be classified under *Outside-home inventory*.
8. User-level setup over SSH as `accept-user`. Take R after each line that changes state: the Node install, the clone, `npm ci`, `npm run build`, the pack, and the global install.
9. The acceptance run, with R before and after each native step or lane.
   - Before the first step, the test user saves `systemctl --user show-environment` as E0, decoded into a sorted map. E0 states whether `TMPDIR` is absent, present and empty, or present with a value. If the command fails or its output cannot be decoded, the run has no valid E0. The run then stops before its first native action, and the next item does not run.
   - With a valid E0, the test user runs `systemctl --user set-environment TMPDIR=/home/accept-user/tmp`, then reads and decodes `show-environment` again. The new map must equal E0 except that `TMPDIR` is `/home/accept-user/tmp`. Only then does the ledger record `setup=done`, and only `setup=done` permits native actions. If the command fails, the readback fails, or the map differs in any other way, the run stops and goes to T. Step 8 of T restores the environment whatever the command did.
   - After each daemon start, the first R reads `/proc/<pid>/environ` of the daemon and of every process in a `vonvon-bot-update-*.scope`. Each one must contain that `TMPDIR`.
   - The service gets the manager's environment when it starts. A restart helper inherits the daemon's environment (`host/lifecycle.ts`), not the manager's.
10. Owned teardown T.
11. The final record B, compared with B0.

Steps 2 to 7 run once per host. Step 5, W, and B0 run again before each later run, and B0 is then taken again for that run before its first state change.

Writes that preparation makes as root, and nothing else: the user and its home, its group, `/etc/shadow`, `/etc/gshadow`, the `-` backups of `passwd`, `shadow`, `group`, and `gshadow`, `/etc/.pwd.lock` when it was absent before, `/etc/systemd/system.control/user-<U>.slice.d/`, the linger file under `/var/lib/systemd/linger/`, and the user's `authorized_keys`. Preparation adds no sudoers rule, no package, no firewall rule, no nginx change, no `sshd_config` change, and no `daemon-reload`.

## Running as the test user

- All user work enters through `ssh accept-user@203.0.113.10`, or on F through ordinary SSH on port 22 to F. The root agent never starts user work with `su`, `runuser`, `sudo -u`, `machinectl shell`, or `systemd-run` from root. Those commands can place processes outside `user-<U>.slice`.
- Each SSH session first prints `cat /proc/self/cgroup`. The path must begin with `0::/user.slice/user-<U>.slice/`.
- Environment for every session:

  ```
  export XDG_RUNTIME_DIR=/run/user/$(id -u)
  export TMPDIR=$HOME/tmp npm_config_cache=$HOME/.npm
  export PATH=$HOME/.local/node/bin:$PATH
  mkdir -p "$TMPDIR"
  ```

  The global prefix is the user-local Node's own prefix. No `npm_config_prefix` and no `prefix` line in `~/.npmrc` is used, because the service unit captures `PATH` but not npm settings. With that prefix, `npm root -g` gives the same answer at install time and inside the unit.

- Membership check M, as root:

  ```
  for p in $(pgrep -u accept-user); do printf '%s %s\n' "$p" "$(cut -d: -f3- /proc/$p/cgroup)"; done
  ```

  Pass when every path begins with `/user.slice/user-<U>.slice/`. While a daemon, bridge, provider, build, or pack runs, its pid must be in the list.
- The daemon listens only on `127.0.0.1:<P>` and, until the transition is removed, on the role ports that *Run listeners* allows. `P` lies outside Π and outside `20000-49999`.
- The run writes only under `/home/accept-user`. SSH sessions export `TMPDIR` under the home before any setup work. Manager-launched processes get it from Sequence step 9. A process that clears its environment can still write to `/tmp`. The check is therefore inventory I, and `TMPDIR` is not the check.
- Node 22 is a user-local tarball from nodejs.org. It is pinned to the exact `22.x.y` that the Mac evidence manifest of the same head records, and its sha256 is checked against that release's `SHASUMS256.txt`. `/usr/bin/node` is never used or replaced.
- No self-hosted GitHub runner is registered on the host. No workflow file references the host, and GitHub stores no credential for it.

## Packaged build of the frozen head

The Linux half of a native box uses the `global-npm` distribution. The plan requires it at *Service gate* *Program*, because `install` refuses `development` and `unknown`. The package is the `vonvon-bot` tarball defined under *Package* in plan.md V5. It is built on the host from the frozen head and installed only on that host. It is never published to a registry, and it is never copied between machines.

1. Clone A. Clone the repository at the frozen head over HTTPS, or from a `git bundle` that Codex copies with `scp`. Record `git rev-parse HEAD`, which must equal the frozen head, and `git status --porcelain`, which must be empty. No `node_modules`, `dist`, `build`, `release`, or tarball is copied to the host.
2. In clone A, run `npm ci`, `npm run build`, and `npm run pack:vonvon-bot -- --out ~/artifacts/a`. Run the pack command again with `--out ~/artifacts/a2`. The two tarballs must have the same sha256. This proves that the packer itself is deterministic.
3. Run `node scripts/check-vonvon-bot-package.mjs ~/artifacts/a/vonvon-bot-<version>.tgz --head <frozen head>`. It must exit 0.
4. Clone B. Repeat step 1 and the first pack of step 2 in a second fresh clone, with `--out ~/artifacts/b`. Record both sha256 values. With equal head and lockfile, a different tarball hash is a finding that the auditor explains before the verdict, as for `dist` hashes under *CLI evidence bundle*. Then delete clone B and `~/artifacts/b`.
5. Install offline from an empty cache:

   ```
   npm_config_cache=$(mktemp -d) npm install -g --offline --ignore-scripts ~/artifacts/a/vonvon-bot-<version>.tgz
   npm config get prefix                 # must print the canonical path of $HOME/.local/node
   npm root -g
   npm ls -g --all vonvon-bot            # must report no missing or invalid package
   command -v vonvon
   ```

   The install must succeed with no network fetch, which proves that the tarball carries every runtime dependency.
6. Run `node scripts/smoke-vonvon-bot-package.mjs --installed "$(npm root -g)/vonvon-bot" --port <P> --manifest ~/artifacts/a/vonvon-bot-<version>.tgz.manifest.json --home <H_smoke>` from clone A. It must exit 0, and its first stdout line must name `<H_smoke>`. Until the script accepts `--home`, this step stays blocked on a shared host.
7. Negative control. With `VONVON_HOME=<H_neg>`, `node ~/src/vonvon-bot/packages/daemon/bin/vonvon.mjs service install --port <P>` from clone A must report `install_refused` and write nothing. The checkout is `development`.
8. The native box runs `vonvon` from the global install only. Its install step must not refuse the distribution. The unit it writes must name the canonical Node executable and `<npm root -g>/vonvon-bot/bin/vonvon.mjs`, and its `Environment="PATH=..."` must contain `$HOME/.local/node/bin`.
9. `native-systemd.txt` records the frozen head, the lockfile sha256, the Node and npm versions, the sha256 values from steps 2 and 4, the checker and smoke outputs, the install outputs, and the sha256 of the tarball's `build-manifest.json`.

The native box never uses a checkout build, `npm pack` of `@vonvon/daemon`, or a fixture package in place of this package. If the frozen head cannot produce a package that passes steps 2 to 8, the systemd half stays unchecked.

## Owned teardown T

Teardown runs after the last step of a run, and also after any stop. It is safe to run again, because each step either finds nothing or converges. It has two branches. The dedicated branch applies to `accept-user` on Linux and to `test-user` on the Mac. The `clay` branch applies only to V5 runs in `clay` under the user's override. No V8 lane runs in `clay`.

Common steps, in both branches:

1. With the run's `VONVON_HOME` exported, record `vonvon service status --json` and `vonvon daemon status --json`.
2. `vonvon service uninstall`. It must exit 0 and report `uninstalled` or `not installed`. Uninstall keeps a self-hosted daemon running, so step 3 stops that daemon.
3. `vonvon daemon stop`. It must exit 0. This drains through `stopHost` with no deadline.
4. `vonvon daemon status --json` must report `running: false`, and `$VONVON_HOME/daemon.pid` must not exist.

Dedicated branch, after steps 1 to 4:

5. If the run installed the test bridge and the bridge's unit file or plist still exists, run `feishu-codex-bridge stop` from the bridge clone. On Linux, `systemctl --user show -p LoadState` must print `not-found` for both `vonvon-bot.service` and `feishu-codex-bridge.service`. On the Mac as `test-user`, `launchctl print gui/$(id -u)/com.vonvon.bot.daemon` and `launchctl print gui/$(id -u)/ai.feishu-codex-bridge.bot` must both fail.
6. No owned process remains.
   - Linux. Under `/sys/fs/cgroup/user.slice/user-<U>.slice/user@<U>.service`, every `cgroup.procs` file outside `init.scope` is empty. No session scope of the user other than the current SSH session has a process.
   - Mac. `pgrep -U test-user -lf 'vonvon|feishu-codex-bridge|node|codex|claude'` prints nothing.
7. Linux. No port of any declared home is in `ss -ltnupeH`. If one is present, record its proof under *Run listeners*, stop with `teardown-blocked`, and send no signal. Every `(pid, b1)` that held the `H_run` host role matches a daemon start named in the run transcript, and none of them still runs.
8. Linux. Restore the manager environment. If the run has no valid E0, this step changes nothing and passes, because Sequence step 9 then never changed the environment. Otherwise the test user reads and decodes `systemctl --user show-environment`, and compares it with E0.
   - If the map equals E0, nothing is changed.
   - If it differs from E0 only in `TMPDIR`, restore that key. If E0 had `TMPDIR`, run `systemctl --user set-environment TMPDIR=<E0 value>`. The value may be empty. If E0 had no `TMPDIR`, run `systemctl --user unset-environment TMPDIR`. Then read and decode again. The map must equal E0.
   - If any other key differs, or a read, a decode, or the restore command fails, change nothing more and stop with `teardown-blocked`.
   - This step does not depend on `setup=done`. It acts only on a difference in `TMPDIR` from a valid E0, so running it again converges.
9. Linux. Root takes inventory I. It must be valid, and every entry must be classified under *Outside-home inventory*.
10. Only after steps 1 to 9 pass, delete the run's `VONVON_HOME`, the test user's `~/.feishu-codex-bridge`, the bridge clone, and the product clone. Before each deletion, the canonical path must begin with `/home/accept-user/` or `/Users/test-user/`. On Linux, after the last run of a frozen head, also run `npm uninstall -g vonvon-bot` and delete `~/artifacts`.

`clay` branch, after steps 1 to 4:

5. Vonvon absence. `launchctl print gui/$(id -u)/com.vonvon.bot.daemon` must fail, and `~/Library/LaunchAgents/com.vonvon.bot.daemon.plist` must not exist. The branch never runs `feishu-codex-bridge stop`, and it never checks that the bridge label is absent.
6. Daily bridge preserved. Take the bridge record from *Native acceptance environment* in plan.md: pid, `ps -o lstart=`, `lsof` listeners, the `launchctl print gui/$(id -u)/ai.feishu-codex-bridge.bot` summary, and the plist checksum. It must equal the run's preflight record. The label stays loaded and unchanged.
7. Owned work reconciled. This is a normative requirement for the run's own `VONVON_HOME` at the frozen head. No single existing command supplies it, and its readback stays pending until implementation and native verification show it. The step passes only when every item below holds.
   - Acknowledged stop. Step 3 sent `stopHost` to the verified owner that step 1 recorded, got `done`, and exited 0 because that owner, by `pid` and `startedAt`, no longer ran and the lock was gone. Under *Stop* and the release rules in *Lifecycle ownership* in plan.md, only this case proves that the owner released ownership and that the owned work it tracks was observed to end. Exit 0 with `already stopped`, missing output, or an unrecorded owner identity proves nothing. In the window that plan.md's *Stop wins until the release step* describes, `daemon stop` prints `already stopped` and exits 0, step 4 can find `running: false` and no `daemon.pid`, and a committed restart helper can still start a replacement.
   - Every identity reconciled. Every daemon identity in the run's transcript or in a `daemon-restart` line in `$VONVON_HOME/logs/` was recorded by the run and no longer runs. An identity that appears only in the log is of unknown ownership.
   - Every helper settled. Every request that spawns the detached helper has a terminal `daemon-restart` outcome in `$VONVON_HOME/logs/`, per *Stop wins until the release step* and *Failure* in plan.md. Under V5's *Restart, same port* those requests are every `restartHost` and `applyCoreUpdate` the run sent to a self-hosted daemon, and every `applyCoreUpdate` sent to a manager-launched daemon. The outcomes are `cancelled` or `helper_lost` from the old daemon, or `replaced`, `superseded`, or `start_failed` from the helper. The owner that a `replaced` or `superseded` line names is one of the reconciled identities. A request without a terminal outcome is pending. Its detached helper is tracked only in the old daemon's memory and can still run `daemon start` for this home.
   - Protected baseline. Steps 5 and 6 passed.
   - Supplementary only. Record `ps -E -o pid=,command= -U "$(id -u)"` filtered for the run's `VONVON_HOME` path. A listed process fails this step. An empty list proves nothing, because a run-owned process need not name that path in its command line or keep it in its environment, as a child that an exec secret provider spawns with a cleared environment shows. The daily bridge's pid is not in that list, because its environment does not name the run's `VONVON_HOME`.

   Teardown claims no process coverage beyond these items. When any item is missing, unconfirmed, or pending, or a process's ownership is unknown, this step fails.
8. Only after steps 1 to 7 pass, delete the run's `VONVON_HOME` and nothing else. The canonical path must be the run-owned temporary directory recorded at preflight. The branch never deletes or edits `~/.feishu-codex-bridge`, `~/.vonvon-bridge`, `~/.vonvon-bot`, any LaunchAgent other than the run's own Vonvon plist that `uninstall` removed, or any bridge clone.

When any step fails, teardown stops there. It deletes nothing, signals no process, and records `teardown-blocked` with the failing output. The run's `VONVON_HOME` and every lock in it stay in place, and the test bot stays held for the blocked run. In `clay`, a difference in the bridge record also fails the box under the plan's existing rule, and the bridge is never restarted to repair it. No run that uses the test bot starts in any context until a later teardown of the blocked run passes. A product command that cannot reach its own owner is a product finding returned through the PR.

Quarantined residue Q. One residue on the Tencent host is quarantined. It is not deleted.

- `C` is `/tmp/node-compile-cache/v22.22.0-x64-9de703df-1002`.
- `D` is `/tmp/node-compile-cache`.

Q is recorded once, by root, read-only. It contains:

- `stat -c '%F %u %g %a %i %d %h'` of `/tmp`, `D`, and `C`;
- `find "$D" -maxdepth 1 -printf '%y %i %U %G %m %p\n'`;
- `find "$C" -printf '%y %i %n %U %G %m %s %T@ %D %p\n'`;
- the sha256 of each regular file under `C` only;
- the stderr and exit status of each command.

Nothing in `C` or `D` is copied, moved, renamed, re-permissioned, or opened for writing.

Every later inventory must show `C` identical to Q in inode, link count, owner, mode, size, mtime, and hash. Any change is a difference.

The run that created Q failed. Its T stays open with the reason `quarantined residue Q`, and it is never recorded as passed. "No service runs and the final B matches B0" does not mean T passed.

Removing Q needs a separately reviewed deletion protocol, and this document authorizes none.

Retirement. When the program no longer needs the Linux host, the root runs teardown T, then `loginctl disable-linger accept-user`, `systemctl revert user-<U>.slice`, and `userdel -r accept-user`. It then takes record B and compares it with the B0 taken before preparation step 2. No owned addition is allowed except the named residues LP, BK, and PL where they apply, each compared under its frozen fields, *Account files*, and *Census on F*.

## Exclusive test bot

Two processes on the same Bot split its events. Before any run that connects the test bot, the run ledger in the evidence bundle must show a passed teardown for the previous run in every context. Step 6 of T must also pass in both dedicated contexts at that moment. The test bot's App ID must differ from the daily bridge's App ID. The daily App ID is read once, read-only, from `clay`.

## Fallback VM F

This section defines F, the owned fallback VM, and the parts of this document that it replaces for F. Independent source reviews gave it a METHOD PASS. No F exists. Nothing here is native evidence, and the gates at the end keep F ineligible.

### Scope

- F is a new, owned OrbStack machine on the Mac mini. It runs no production service. What it protects is F's own operating system, root's SSH access, and the Mac that hosts it, including the daily bridge in `clay`.
- Every rule in this document applies to F, except where this section names a replacement. That covers B, R, I, M, T, the caps, the monitors, PAM, SSH, and the rule that root sends no signal.
- The earlier fallback machine is not eligible for any V5 run. Nothing restarts, stops, signals, reconfigures, or deletes it. Its records stay as failed or unresolved evidence, and they never qualify F.
- Nothing here changes the Tencent host. If a Tencent source is `unresolved`, that host stays ineligible. Q and the old T keep their status.

### Construction

Root constructs F only after the docs that define it are merged. The candidate command has not been run:

    orb create --isolated --isolate-network --arch arm64 --user v5-admin --cpus 4 --memory 6G --disk 32G ubuntu:24.04 <new unique name>

- `--isolated` means no Mac mount and no Mac integration exists before B0. OrbStack documents that `--isolate-network` blocks other machines and host IPs and keeps internet access, which `npm ci` and the Node download need.
- The sizes follow the containment table. Four CPUs leave two outside `CPUQuota=200%`. The `MemoryMax` bound and the start rule need at least 3584 MiB, and 6 GiB leaves room for calibration. The start rule needs 20 GiB free, and 32 GiB covers the OS, two clones, and that free space.
- If OrbStack's global CPU or memory limit cannot hold these values, F is not eligible. No global setting changes.

Between creation and the fresh B0, root may make only these writes, and it records each command and its output:

1. Through `orb` or `v5-admin`, once: root's `authorized_keys`, and `openssh-server`, `git`, and `ca-certificates` from the Ubuntu archive if the image lacks them. The package list is recorded before and after.
2. The dispatch masks under *Cron and timers on F*.

After step 1, all root work uses ordinary SSH on port 22. Nobody logs in as `v5-admin` again.

### Identity and durability

The fresh B0 records each of the following, and every R, final B, and retirement B compares it:

- Identity tuple: `/etc/machine-id`, `/proc/sys/kernel/random/boot_id`, `readlink /proc/1/ns/mnt`, and F's OrbStack name and ID, read on the Mac. Any change stops the run, and no earlier record of F then qualifies anything.
- The mount table, under *Mount table on F*. No row may be of type `virtiofs`, `9p`, `nfs*`, `cifs`, or `fuse*`. No target or source may lie under `/mnt/mac`, `/Users`, `/Volumes`, or `/private`.
- F's OrbStack configuration, read only on the Mac: isolated and network-isolated true, 4 CPUs, 6G memory, 32G disk.
- Mac listeners. Each R reads `lsof -nP -iTCP -sTCP:LISTEN` on the Mac with no port filter. `P` and the twelve declared role ports must not appear. This detects a forwarded listener but does not prevent one. See G-fwd.
- Effective memory is the smaller of `MemTotal` and the machine's root-cgroup `memory.max` when that is a number. The `MemoryMax` bound and the start rule use it.
- The Mac must have at least 40 GiB free at B0, and each R samples it. Below that, the run stops. The Mac's daily processes are only observed.

All OrbStack machines share one kernel. The pressure files measure the shared VM. Their stop rules still apply.

### Baselines on F

- B0f is the fresh B0 of *Sequence* step 1, taken once per host before step 2. Its attempt holds preparation and the first run.
- B0p(k) is the B0 of each later attempt k. It is taken after V and W run again and before the run's first state change. It needs the retained preparation receipt on the same host.

Each record X is compared with Y, the B0 of its attempt. Retirement is the exception, and it is compared with B0f. The comparison passes only when all three of the following hold.

1. The owned part of X equals exactly O(stage of X).
2. The owned part of Y equals exactly O(stage of Y).
3. The rest of X equals the rest of Y in every compared field.

O(stage) is defined under *Census on F* and *Account files*.

| Point | Stage | Compared with |
| --- | --- | --- |
| B0f | F | itself. Gates: the name, U, and G absent from complete `getent passwd` and `getent group`, the AF type gate passed, an empty valid I, and Π complete. |
| Step 2, then R2 | A | B0f |
| Step 3, then R | A | B0f |
| Step 4 and every later preparation record, including I0 | L | B0f |
| First run: every R, monitor, T step, and final B | L | B0f |
| Before later run k: V, W, and the R after W | L | the previous attempt's B0 |
| B0p(k) | P | its own gates: same identity tuple as B0f, mount main list equal to B0f's, census without O(L) equal to B0f's, owned part exactly O(L) proven against the preparation receipt, AF equal to FAF. Its unit, listener, and HTTP content become run k's baseline. |
| Run k: every R, monitor, T step, and final B | L | B0p(k) |
| Retirement B | Ret | B0f |

### Mount table on F

On F, this replaces the rule that the mount table never changes.

Each table is the ordered list of `(target, fstype, source, options)` rows from `findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS`. Root keeps the raw output. Runtime rows are rows whose target is exactly `/run/user/<n>`. Every other row, including a row below `/run/user/<n>/`, belongs to the main list.

- The main list must equal the baseline's main list exactly, in order and with repeats. A reordered row, a lost stacked row, a repeated row or target added or removed, a changed field, or an unknown row fails.
- Runtime rows are compared per UID as multisets of complete rows. Their position is not compared.
  - For UID 0, the rows equal the baseline's rows.
  - For U, there are no rows before step 4. From step 4 until retirement, there is exactly one row, `R_U`: fstype and source `tmpfs`, with options containing `uid=<U>`, `gid=<G>`, and `mode=700`. Its full options are frozen at the first record after step 4. After retirement, there are no rows.
  - For any other UID, the rows equal the baseline's rows.
  - More than one row where one is required fails.
- Inside one inventory I, the raw before and after tables must still be byte-identical.

The position exemption exists because logind mounts and unmounts `/run/user/<n>` as sessions and linger come and go. Root's own sessions can end between records. This rationale is source reasoning, and it is gate G-runtime-order.

### Census on F

Root takes these read-only observations at B0f, B0p(k), every R, T6, T9, every final B, and the retirement B, always from a root SSH session:

| Name | Command |
| --- | --- |
| accounts | `getent passwd` |
| groups | `getent group` |
| linger | `find /var/lib/systemd -mindepth 1 -maxdepth 2 -path '/var/lib/systemd/linger*' -printf '%y %U %G %m %p\n'` |
| logind | `loginctl list-users --no-legend` |
| units | `systemctl list-units --all --full --no-legend --no-pager`, filtered to `user@*.service` and `user-runtime-dir@*.service` |
| runtime dirs | `find /run -mindepth 1 -maxdepth 2 -path '/run/user*' -printf '%y %U %G %m %p\n'` |
| managers | `ps -eo pid,uid,lstart,args`, filtered to `systemd --user` |

On F, the linger observation replaces the `ls /var/lib/systemd/linger` of *Records*. It splits into the parent state, `absent` or the parent row, and the entry rows at depth 2.

Owned sets:

| Stage | Owned census entries |
| --- | --- |
| F | none |
| A | the `passwd` and `group` owned lines under *Account files* |
| L and P | those of A, plus every entry in the next list |
| Ret | LP only, when B0f had no linger parent and LP's frozen fields are unchanged |

The entries added at stage L and P:

- The linger entry row `/var/lib/systemd/linger/accept-user`, with its type and owner frozen at the first stage-L record.
- LP, the linger parent row, only when B0f had no linger parent. Its type must be `d`, and its type, owner, group, and mode are frozen at the first stage-L record.
- The logind row for `<U>`.
- Exactly one listing row for each unit, with these exact columns:

  | Unit | LOAD | ACTIVE | SUB |
  | --- | --- | --- | --- |
  | `user-runtime-dir@<U>.service` | `loaded` | `active` | `exited` |
  | `user@<U>.service` | `loaded` | `active` | `running` |

- `/run/user/<U>`, type `d`, owner `<U>`, group `<G>`, mode 700.
- Exactly one `systemd --user` process with UID `<U>`.
- `R_U` under *Mount table on F*.

`user-runtime-dir@.service` is `Type=oneshot` with `RemainAfterExit=yes`, so a completed start stays `active` and `exited`. That comes from the retained unit text and the v255 source. Any other state, a missing row, or a duplicate row is a difference.

Root's own entries belong to the baseline. Those are `user@0.service`, `user-runtime-dir@0.service`, `/run/user/0`, its logind row, and one UID-0 manager.

A manager's pid and start time may change between records. Their count and UID may not.

The retirement commands do not remove the linger parent, and nothing removes it. LP is therefore a named, permanent residue.

### User managers on F

On F, this defines "every user manager" in Π's unit-file source.

- Live contexts. Before step 4 only root's manager may run, and only from root's own SSH login. From step 4, `accept-user`'s manager may also run. Any other live manager, or any linger entry other than `accept-user`, makes F ineligible. Nobody stops, impersonates, or connects to it.
- Each live context is listed only by its own account, over that account's own SSH session:
  - `systemctl --user list-unit-files --full --no-legend --no-pager`;
  - `busctl --user --auto-start=no --allow-interactive-authorization=no call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.DBus.Properties Get ss org.freedesktop.systemd1.Manager UnitPath`;
  - the same call for `Environment`.

  The path set is `UnitPath` in order. Root walks those directories with `lstat` and `readlink`. The walk must find the same names as the listing. Any difference, or any EACCES or ENOTDIR, makes the context `unresolved`. Snapshots are never merged.
- Closure for each listed name, in every state:

  | Case | Rule |
  | --- | --- |
  | Masked | A link to `/dev/null` or an empty file is `masked`. Its content is not read. |
  | Alias | Follow the link chain to its target. A dangling link or a loop is `unresolved`. |
  | Template | Expand each instance from the listing or from `.wants`, `.requires`, or `.upholds` links. A template with no instance and a `%i` or `%I` in a port-bearing field gives no ports. |
  | Drop-ins | Read `<name>.d/`, the template's `.d/` for an instance, `<type>.d/`, and each dash-prefix directory in every `UnitPath` directory. Apply them in systemd's documented order. An empty assignment resets the field. |
  | Environment files | A missing file with the `-` prefix is recorded as absent. A missing file without it, or an unreadable file, is `unresolved`. |
  | Expansion | `%h`, `%u`, `%U`, and `%t` come from the account and its runtime directory. Variables come from `Environment`, from `EnvironmentFile`, and from the manager's `Environment`. Anything unknown in a port-bearing token is `unresolved`. Nothing is executed. |

- Offline accounts are every other `passwd` account, including system accounts and `v5-admin`. They are not evaluated, and the record says so. In return, they may have no linger entry and no live manager at B0f. The census in every record must equal the baseline's apart from O(stage). An offline account can listen only through a manager, and a new manager stops the run. This guard applies only on F, where no production exists.

### nginx and BT on F

A source row is `absent, ports ∅` only when all of the following hold. A missing `PATH` entry proves nothing.

1. `dpkg-query -W -f='${Package}\t${Status}\n'` lists no package whose name contains `nginx`, `openresty`, or `angie`.
2. No listing on F names a unit matching `*nginx*` or `bt*.service`.
3. One root `find` over `/`, pruning only `/proc` and `/sys`, without `-xdev`, and bracketed by identical mount tables, prints nothing for `-name nginx`, `-name nginx.conf`, `-path /www`, `-path /etc/init.d/bt`, or `-path /etc/nginx`.
4. B0f's `ss -ltnupeH` shows no `nginx` process and no executable under `/www`.
5. No cron file, timer, or unit fragment contains `nginx` or `/www/`.

Any hit means the software is present, and its row is resolved under *Run listeners* or stays `unresolved`.

### Cron and timers on F

On F, schedulers are disabled at construction instead of tracing every scheduled program. Root runs `systemctl mask` on these units before B0f:

- `cron.service`, `anacron.service`, `anacron.timer`, `atd.service`, `cronie.service`, `crond.service`, and `systemd-cron*`;
- every `*.timer` in the system manager's listing.

Root also runs `systemctl --global mask` on every `*.timer` in root's user-scope listing.

B0f, every R, and every final B must then show all of the following. Π's cron and timer row then reads `no dispatcher, ports ∅`:

- every one of those units `masked` and inactive;
- an empty `systemctl list-timers --all --no-legend` in the system manager and in each live context;
- no `cron`, `anacron`, `atd`, or `crond` process, and no `run-parts` of a cron directory;
- no other scheduler package, or that package's unit masked as above.

The cron files and timer commands are still hashed in B. Any unmasked scheduler or timer, scheduler process, listed timer, transient timer, or change in unit-file state makes the row `unresolved`, and F is ineligible. There is no exemption for stock Ubuntu tasks.

### Command outcomes on F

- Reader observations are read-only commands that root collects. They must exit 0 with an empty stderr. An absence is derived from a complete zero-exit listing, never from a command that is expected to fail. Any other outcome is a collection failure. It sets the collector's failure latch and leaves the record incomplete. Retries are not allowed.

  On F, this requires replacing several commands:
  - `dpkg -S` is not used;
  - the linger and runtime listings use the `find` forms above;
  - `systemctl` listings take no name pattern or type filter;
  - the Mac `lsof` takes no port filter.
- Assertion actions are actions whose result is under test. They run as recorded actions over SSH, and the collector never runs them. Each one names its exact expected exit codes and stderr rule.

  Check W on F:
  - Each `test -w <path>` as `accept-user` must exit exactly 1 with an empty stderr.
  - Before W, one Reader observation records which W paths exist: `find / -maxdepth 4 \( -path /proc -o -path /sys \) -prune -o \( -path /var/www -o -path /var/www/vonvon-site/current -o -path /var/www/notelet-site/current -o -path /opt/vonvon-account -o -path /etc/nginx -o -path /etc/systemd/system -o -path /www/server \) -printf '%y %U %G %m %p\n'`.
  - For a path that exists, exit 1 is recorded as `protected`. For an absent path, it is recorded as `absent, not applicable`, which is not evidence of protection.
  - The native negative actions keep the outcomes that the native assertions define.

### Gates for F

F is not eligible while any gate below is OPEN. A METHOD PASS closes none of them.

| Gate | State |
| --- | --- |
| G-fwd | OPEN. OrbStack documents that servers in a machine are reachable on the Mac's `localhost`. It does not say whether isolation disables that. The method therefore assumes F's `P` and the twelve role ports may be forwarded. The gate closes only by one of two routes. The first is OrbStack documentation or a read-only configuration readback for F proving no forwarding. The second is a Mac port set Π_mac, built read-only and as complete as Π, that covers the Mac's listeners and the configured ports of the daily bridge and of every LaunchAgent and LaunchDaemon, with `P` and the twelve ports outside it and no `unresolved` source. An operator preference does not close it. |
| G-mask | OPEN. F's own records must show that the masks leave the schedulers inactive and the timer list empty. |
| G-noact | OPEN. That the `busctl` `Get` route loads and activates nothing on the installed v255 is a source claim. |
| G-runtime-order | OPEN. The runtime-row position exemption relies on logind's mount lifecycle, which is source reasoning. |
| G-W-F | OPEN. On F, most W paths are absent. Their W results are not evidence of protection. |
| G-loginacct | OPEN, not decided. SSH logins can update `/var/log/lastlog`, `wtmp`, `btmp`, and the auth logs. No comparison observes those. `useradd -l` does not cover them. |
| P-src | OPEN. The installed shadow version and its patched source must confirm S1 to S5 under *Account files*. |
| P-nat | OPEN. Only F's own records can show any rule here holding. |
| Formal CPU and window accounting, gap of at most 8 | OPEN |
| Capability pilot on the old machine only | Separate. It qualifies nothing on F. |

## Appendix: Linux harness contract

The Linux acceptance harness has a local contract, `selected-contract.md`. It is audit material and not tracked. Its sha256 is `3821aee188c1e260ea2c69c6dfa0b83e0ad867209550244f9fe8b8b5da3e1c18`. This appendix is the tracked statement of the changes that contract needs so that it matches this document. Where the two disagree, this document governs. The line numbers below refer to that hash.

### Changes to the local contract

| Contract location | Change |
| --- | --- |
| Line 42, fresh B0 | Add: AF taken, and the AF type gate under *Account files* passed. |
| Line 44, CREATE_ACCOUNT | The command in *Sequence* step 2. AF in the after-R matches the R2 transition table, and that observation becomes FAF. Exact owned lines in `passwd`, `shadow`, `group`, and `gshadow`. `subuid` and `subgid` unchanged. |
| Line 57, "No stage allows a mount change" | On F, replaced by *Mount table on F*. Section 6 of the contract still applies to the main list. |
| Line 88, row `passwd, group` | Replaced by an `account_files` row: every B, R2, and the R after step 4. The 13 metadata rows and 12 content pairs, the type gate, the correspondence rules, the R2 and retirement transitions, and FAF equality in between. No absent or error variant, except per-path absence where the type gate allows it. A host labelled `AF unavailable` keeps the two-hash form. |
| Line 93, additional evidence | Add the P-src version and help observations, and the AF metadata and content receipts. |
| Line 99, owned additions | Add the AF owned lines, the backups, PL and BK, and on F, LP and the census owned set under *Census on F*. |
| Line 101, full-B comparison | Replace "excluded passwd/group hashes" with "AF under *Account files*, or the two-hash form only where `AF unavailable` applies". |

### Command receipts wire

The collector records every command it runs in one top-level history:

    "command_receipts": {
      "schema": "linux-r3-command-history/1",
      "reader": "<the reader's fresh identity>",
      "complete": true | false,
      "abort": null | "<reason>",
      "entries": [ {"seq": 0, "receipt": <linux-r3-command-receipt/1>}, ... ]
    }

- `entries` holds every receipt the reader appended, in append order. `seq` runs from 0 to n-1 with no gap.
- `complete` is true only when the record finished normally. Then the reader's final count equals n and `abort` is null. An aborted record still emits its full prefix.
- Every record field that comes from a command carries `"receipt_refs": [seq, ...]`, in the order of its commands. Every `seq` is referenced exactly once. The exception is an `"unbound": [{"seq": k, "reason": "..."}]` entry, which is allowed only when `complete` is false and the receipt was appended after the last observation began. A missing `seq`, a double reference, an unreferenced `seq`, or a reference out of order is a finding.

Legal receipt states. Any other combination is the finding `illegal_receipt_state`. The decoder keeps it and never repairs it.

| `state` | `returncode` | `stdout` / `stderr` | `failure` | `cleanup_failures` | `output_complete` | `output_truncated` |
| --- | --- | --- | --- | --- | --- | --- |
| `blocked` | null | null / null | non-null | `[]` | false | false |
| `launch_failed` | null | null / null | non-null | `[]` | false | false |
| `started`, completed-zero | 0 | bytes / empty bytes | null | `[]` | true | false |
| `started`, other | an integer, or null only when `failure` is non-null | each bytes, or null only when `failure` is non-null | any | any list of strings | true only when both streams are bytes and `output_truncated` is false | true only when `output_complete` is false and `failure` is non-null |

Receipts and captures fail for different reasons:

- A receipt's completion is a property of the reader's process record. A completed-zero receipt says only that the process ran and finished. It does not say that the observation is valid.
- A capture is `{receipt, failure}`. Its `failure` records the observer's checks: exactly one new receipt, an unchanged history, matching argv, no stale equal receipt, returned bytes equal to stdout, and text decoding where text is needed.
- If a capture's `failure` is null, its receipt is completed-zero. If a receipt is not completed-zero, its capture's `failure` is non-null. A completed-zero receipt with a non-null capture failure is legal wire and is reported as `capture_failed`. Nothing clears a capture failure.

Inventory projection:

- `inventory.command_receipts` stays the three captures, in the order before, listing, after, and `inventory.receipt_refs` holds their three `seq` values.
- Each capture's `receipt` must equal its referenced entry's `receipt` field by field. Byte wrappers compare by `base64`, `sha256`, and `bytes`.
- Capture failures stay on the observation that owns them and never enter the global history.

Other rules:

- In each entry, `ended_monotonic_ns` is at least `started_monotonic_ns`, and `started_monotonic_ns` is at least 0. Across entries, `started_monotonic_ns` never decreases.
- Byte streams use strict, canonical base64, with a matching count and sha256.
- A record with `complete: false`, any finding, or any `unbound` entry cannot close command coverage.
- A valid shape grants no acceptance.
