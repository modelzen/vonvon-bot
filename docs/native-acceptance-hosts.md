# Native acceptance hosts

This document defines how Codex prepares and uses the dedicated Linux acceptance host, and how every native run that uses a dedicated test context tears down what it owns. [plan.md](plan.md) V5 *Native acceptance environment* and V8 *Verify, live* refer to it. It changes no pass criterion of any box.

## Scope and authority

- The user granted root SSH to the Tencent host `101.34.213.231` for independent use, and testing in `clay`. No further user permission is needed for anything in this document. The work waits only for the accepted design, its independent review, and the root's assignment.
- The protected services on the Tencent host are the bridge website, the notelet site and its automatic update path, the account service, and every other service that runs there. On `clay`, the protected service is the daily bridge.
- A real user action remains only where no agent can act: logging `manzana` into a macOS GUI session, and a provider credential that does not exist yet.

## Linux host facts and limits

Verified facts. Each comes from read-only evidence named in the corrected proposal.

- OpenCloudOS 9.6, x86_64, 4 CPU, 3655 MiB RAM, 1024 MiB swap, one root filesystem `/dev/vda1` of 40 G with 32 G free, from one snapshot.
- Production on the host includes nginx, `vonvon-account.service` on `127.0.0.1:8787`, `bt.service`, `site_total.service`, `postfix.service`, `crond.service`, and `sshd.service`.
- A read-only platform refresh by the root on 2026-10-12 recorded the following. Kernel `6.6.119-49.23.oc9.x86_64`. systemd 255 (`v255-20.oc9.ap.3`, `default-hierarchy=unified`). `/sys/fs/cgroup` is `cgroup2fs`. The available controllers are `cpuset cpu io memory net_cls hugetlb pids rdma misc`. Root filesystem 32794760 KiB free. RAM 3655 MiB total, 2784 MiB available. Swap 1024 MiB, none used. `getent passwd vonvon-accept` printed nothing, so the test user does not exist yet.
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
| `du -sxb /home/vonvon-accept` | not used as a start rule | above 6 GiB |
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
- User unit coverage: `ls /var/lib/systemd/linger`, and the path and sha256 of every file that `find / -xdev -path '*/systemd/user/*' -type f` lists outside `/usr`, `/etc`, and `/home/vonvon-accept`. Teardown T checks the test user's own units.
- `/etc/passwd` and `/etc/group` sha256, computed without the `vonvon-accept` lines.
- `readlink -f` of `/var/www/vonvon-site/current`, `/var/www/notelet-site/current`, `/var/www/vonvon-account/current`, and `/opt/vonvon-account/current`.
- `journalctl --disk-usage`.

Record R contains the following.

- For each unit running at B0: `systemctl show -p Id -p ActiveState -p SubState -p MainPID -p ExecMainStartTimestamp -p NRestarts`.
- `systemctl list-units --type=service --state=running --no-legend` as a sorted list of unit names.
- `ss -ltnH | awk '{print $4}' | sort`.
- Availability: `curl -sS -o /dev/null -w '%{http_code}\n' --resolve <name>:443:127.0.0.1 https://<name>/` for `bridge.vonvon.cc` and `notelet.vonvon.cc`. This is one read-only GET each, and it sends no test traffic to the account service.
- The monitors from the table above: `/proc/meminfo` `MemAvailable`, `df -B1 --output=avail /`, the `du` of the test home, and the two pressure files.
- After the slice exists: `memory.current`, `memory.peak` when it exists, `memory.events`, `cpu.stat`, and `pids.current` of the slice.
- After the slice exists: membership check M below.

Owned additions. Preparation creates the following host state. It belongs to the test user, not to production, and it persists across runs until retirement.

| Owned addition | Created by | Where it appears in a record |
| --- | --- | --- |
| `user@<U>.service` and `user-runtime-dir@<U>.service` | step 4 | running unit set |
| `/var/lib/systemd/linger/vonvon-accept` | step 4 | user unit coverage |
| `user-<U>.slice` and `/etc/systemd/system.control/user-<U>.slice.d/` | step 3 | not compared |
| The `vonvon-accept` lines in `/etc/passwd` and `/etc/group`, and `/home/vonvon-accept` | step 2 | already excluded |

Comparison rules.

- Every R and the final B are compared with B0. In each record, first remove the owned additions that exist at that point. The remaining running unit set must equal B0's set without its owned additions. The identity fields of every unit running at B0, excluding owned additions, must equal B0. The listener list and the availability codes must also equal B0. During the run only, the listener list may also contain the run's own `127.0.0.1:<P>`.
- In the final B, the definition hashes, the cron and timer coverage, the user unit coverage without the owned linger entry, and the `passwd` and `group` hashes must also equal B0.
- Only the table names owned additions. An added unit, linger entry, user, or listener that is not in the table is a difference.
- The `readlink -f` targets and `journalctl --disk-usage` are observations, not pass conditions. A production publisher may change a `current` target legitimately. The test user cannot write those paths, and check W below proves it.
- Any difference in a compared field stops the run. The box stays unchecked, and every record is kept. The record classifies the difference as test-attributable, production-scheduled with its evidence, or unknown. A production-scheduled difference still fails the run. That run is repeated later, and the failed run is never counted as a pass. No production unit is repaired, restarted, or reloaded by the run.

## Sequence

The protective baseline B0 comes before every write to the host. All steps run strictly in this order. A failed gate stops the sequence at that step.

1. B0. Take record B. Gates: `systemctl --version` reports systemd 255, `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`, `cgroup.subtree_control` contains `memory`, `cpu`, and `pids`, and every start condition in the monitor table holds. If the cgroup mode is not `cgroup2fs`, the host is not eligible, and the work moves to the fallback VM.
2. Create the user. Then take R.

   ```
   useradd --create-home --shell /bin/bash --comment "vonvon native acceptance" vonvon-accept
   id vonvon-accept
   ```

3. Apply the caps before any process of the user exists. `systemctl set-property` applies the values to the running manager and stores them under `/etc/systemd/system.control/`. It needs no `daemon-reload`. Then check V1 and take R.

   ```
   U=$(id -u vonvon-accept)
   systemctl set-property user-$U.slice MemoryMax=1536M MemorySwapMax=0 CPUQuota=200% TasksMax=512
   systemctl show user-$U.slice -p LoadState -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec -p TasksMax
   ```

   Check V1 passes when `LoadState=loaded`, `MemoryMax` prints the byte value of the cap, `MemorySwapMax=0`, `CPUQuotaPerSecUSec=2s`, and `TasksMax=512`. No process of the user exists yet. If `set-property` or V1 fails, the sequence stops here.

4. Enable linger. This starts `user@<U>.service`, the user's systemd manager, inside the capped slice. The kernel creates the slice's cgroup only when its first process starts, so the kernel files can be read only after this step. The manager is the only process of the user until step 5 passes. Then take R.

   ```
   loginctl enable-linger vonvon-accept
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
   install -d -m 0700 -o vonvon-accept -g vonvon-accept /home/vonvon-accept/.ssh
   install -m 0600 -o vonvon-accept -g vonvon-accept /dev/stdin /home/vonvon-accept/.ssh/authorized_keys <<'KEY'
   <Codex Mac mini public key, one line>
   KEY
   ```

7. Check W, as `vonvon-accept`. Each of these must fail: `test -w` on `/var/www`, `/var/www/vonvon-site/current`, `/var/www/notelet-site/current`, `/opt/vonvon-account`, `/etc/nginx`, `/etc/systemd/system`, and `/www/server` when it exists. Then take R.
8. User-level setup over SSH as `vonvon-accept`. Take R after each line that changes state: the Node install, the clone, `npm ci`, `npm run build`, the pack, and the global install.
9. The acceptance run, with R before and after each native step or lane.
10. Owned teardown T.
11. The final record B, compared with B0.

Steps 2 to 7 run once per host. Step 5, W, and B0 run again before each later run, and B0 is then taken again for that run before its first state change.

Writes that preparation makes as root, and nothing else: the user and its home, its group, `/etc/systemd/system.control/user-<U>.slice.d/`, the linger file under `/var/lib/systemd/linger/`, and the user's `authorized_keys`. Preparation adds no sudoers rule, no package, no firewall rule, no nginx change, no `sshd_config` change, and no `daemon-reload`.

## Running as the test user

- All user work enters through `ssh vonvon-accept@101.34.213.231`. The root agent never starts user work with `su`, `runuser`, `sudo -u`, `machinectl shell`, or `systemd-run` from root. Those commands can place processes outside `user-<U>.slice`.
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
  for p in $(pgrep -u vonvon-accept); do printf '%s %s\n' "$p" "$(cut -d: -f3- /proc/$p/cgroup)"; done
  ```

  Pass when every path begins with `/user.slice/user-<U>.slice/`. While a daemon, bridge, provider, build, or pack runs, its pid must be in the list.
- The daemon listens only on `127.0.0.1:<P>`. `P` is absent from the B0 listener list and is never 22, 25, 80, 443, 8787, or 8888.
- The run writes only under `/home/vonvon-accept`. At the end, `find /tmp /var/tmp -xdev -user vonvon-accept` must print nothing.
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
6. Run `node scripts/smoke-vonvon-bot-package.mjs --installed "$(npm root -g)/vonvon-bot" --port <P> --manifest ~/artifacts/a/vonvon-bot-<version>.tgz.manifest.json` from clone A. It must exit 0.
7. Negative control. With a throwaway `VONVON_HOME`, `node ~/src/vonvon-bot/packages/daemon/bin/vonvon.mjs service install --port <P>` from clone A must report `install_refused` and write nothing. The checkout is `development`.
8. The native box runs `vonvon` from the global install only. Its install step must not refuse the distribution. The unit it writes must name the canonical Node executable and `<npm root -g>/vonvon-bot/bin/vonvon.mjs`, and its `Environment="PATH=..."` must contain `$HOME/.local/node/bin`.
9. `native-systemd.txt` records the frozen head, the lockfile sha256, the Node and npm versions, the sha256 values from steps 2 and 4, the checker and smoke outputs, the install outputs, and the sha256 of the tarball's `build-manifest.json`.

The native box never uses a checkout build, `npm pack` of `@vonvon/daemon`, or a fixture package in place of this package. If the frozen head cannot produce a package that passes steps 2 to 8, the systemd half stays unchecked.

## Owned teardown T

Teardown runs after the last step of a run, and also after any stop. It is safe to run again, because each step either finds nothing or converges. It has two branches. The dedicated branch applies to `vonvon-accept` on Linux and to `manzana` on the Mac. The `clay` branch applies only to V5 runs in `clay` under the user's override. No V8 lane runs in `clay`.

Common steps, in both branches:

1. With the run's `VONVON_HOME` exported, record `vonvon service status --json` and `vonvon daemon status --json`.
2. `vonvon service uninstall`. It must exit 0 and report `uninstalled` or `not installed`. Uninstall keeps a self-hosted daemon running, so step 3 stops that daemon.
3. `vonvon daemon stop`. It must exit 0. This drains through `stopHost` with no deadline.
4. `vonvon daemon status --json` must report `running: false`, and `$VONVON_HOME/daemon.pid` must not exist.

Dedicated branch, after steps 1 to 4:

5. If the run installed the test bridge and the bridge's unit file or plist still exists, run `feishu-codex-bridge stop` from the bridge clone. On Linux, `systemctl --user show -p LoadState` must print `not-found` for both `vonvon-bot.service` and `feishu-codex-bridge.service`. On the Mac as `manzana`, `launchctl print gui/$(id -u)/com.vonvon.bot.daemon` and `launchctl print gui/$(id -u)/ai.feishu-codex-bridge.bot` must both fail.
6. No owned process remains.
   - Linux. Under `/sys/fs/cgroup/user.slice/user-<U>.slice/user@<U>.service`, every `cgroup.procs` file outside `init.scope` is empty. No session scope of the user other than the current SSH session has a process.
   - Mac. `pgrep -U manzana -lf 'vonvon|feishu-codex-bridge|node|codex|claude'` prints nothing.
7. Only after steps 1 to 6 pass, delete the run's `VONVON_HOME`, the test user's `~/.feishu-codex-bridge`, the bridge clone, and the product clone. Before each deletion, the canonical path must begin with `/home/vonvon-accept/` or `/Users/manzana/`. On Linux, after the last run of a frozen head, also run `npm uninstall -g vonvon-bot` and delete `~/artifacts`.

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

Retirement. When the program no longer needs the Linux host, the root runs teardown T, then `loginctl disable-linger vonvon-accept`, `systemctl revert user-<U>.slice`, and `userdel -r vonvon-accept`. It then takes record B and compares it with the B0 taken before preparation step 2, with no owned additions allowed.

## Exclusive test bot

Two processes on the same Bot split its events. Before any run that connects the test bot, the run ledger in the evidence bundle must show a passed teardown for the previous run in every context. Step 6 of T must also pass in both dedicated contexts at that moment. The test bot's App ID must differ from the daily bridge's App ID. The daily App ID is read once, read-only, from `clay`.
