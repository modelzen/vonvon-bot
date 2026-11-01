# I2 `server-2-install-scripts`：`install.sh` / `install.ps1` / `uninstall.*`

依据 `docs/plans/devices.md` §7.2（布局）、§7.3（安装脚本）、§7.4 的退路、§15 的文案、§13 的 I2 行。契约（清单格式、签名公钥怎么进包、`current`/`current.txt`、`current-release.ts`、服务名）在 `docs/plans/server-3-update-engine.md` §4.1，本文按 C1–C8 的编号引用，不重写。缩写同 `devices.md`。

**2026-11-01 改动**（owner："Mac 和 Windows 上就直接通过安装包安装全部软件就好了，没有这种场景只安装 Server 端，也不用通过命令行安装"；`devices.md` 第 19 节）：脚本只在 Linux 上装。`install.sh`、`uninstall.sh` 在 macOS 上只打印一句中文，让用户到 https://bot.vonvon.cc 下载桌面端安装包，退出 2，不联网、不写任何文件；别的系统同样退出 2。脚本里不再有 Mac 的 LaunchAgent、`Applications` 里的桌面端、无图形登录这些分支，Linux 照旧查"已装过"。I2b（`install.ps1`、`uninstall.ps1`、§4.5、§5.3、§6 的 Windows 清单）取消，那几节留作记录。服务端包只有 `linux-x64`、`linux-arm64`，签名清单的 `files` 也只有这两项（I3 C1）；I2a 已按六项写好的清单匹配先留着，I3 合入后由清理片 I6 改成两项。下文已按这些改过。

## 1. 做什么

一台没装过 Vonvon Bot 的 Linux 机器，跑一行命令就装好 `standalone` 服务端：选包、读签名清单、校验哈希（有 OpenSSL 3 再验签名）、解到 `releases/<v>/`、切 `current`、写 `vonvon` 命令和 PATH、装后台服务（能开 linger 就开），装不了服务就直接启动一次并说清为什么。已经装过就一个字不动、退出 0。在 macOS 上只打印去下载桌面端安装包的话、退出 2。`uninstall.*` 停服务、删服务定义、删安装根、留数据目录。脚本只做下载、解包和调 `vonvon`，逻辑放在 `vonvon` 的两条隐藏命令里，脚本好测、好升级。

## 2. 范围

做：
- `scripts/install.sh`、`scripts/uninstall.sh`（POSIX sh，`set -eu`，`main "$@"` 最后一行）。
- `scripts/install.ps1`、`scripts/uninstall.ps1`（PowerShell 5.1+）：这是 I2b，已取消（2026-11-01）。
- daemon 隐藏命令 `vonvon __standalone-setup --install-root <根> --version <v> [--json]` 和 `vonvon __standalone-teardown --install-root <根> [--json]`（`D/cli/commands/standalone-setup.ts`）：切 `current`、写启动器、写 / 删 PATH 块。
- PATH 块的文本和拼接逻辑从 `DT/cli-registration.ts` 挪到 `P/cli-path-block.ts`，桌面端和服务端写**同一块**（COEX-2）。
- `vonvon service install --linger --json` 的两处改动（LINGER-1）：linger 没开成不再非零退出；环境性拒绝带 `fallback: 'detached'` 和稳定的 `reason`。
- `daemon run`、`service install` 在 root 下打一行警告。
- 脚本测试：`scripts/install.test.mjs`（`node --test`，在 `mkdtemp` 的 HOME 里真跑 `sh`）。
- `D/service/current-release.ts`（C5）如果 I3 还没合入就由本片建。

不做：
- 升级（I3）、CDN 上放脚本（I5）、官网文档（W1）。
- macOS、Windows 上安装（owner 2026-11-01：这两个平台只用桌面端安装包）；找桌面端（Linux 没有桌面端）。
- 读 `VONVON_HOME`、自定义安装根。数据目录固定 `~/.vonvon-bot`，安装根固定 `~/.local/share/vonvon-bot/server/`。
- musl / Alpine、FreeBSD、32 位。
- 自动 `sudo`。脚本只打印命令。

## 3. 现在的代码

- 仓库里没有 `scripts/install.*`、`uninstall.*`。`scripts/build-server.mjs`（I1）导出 `TARGETS`、`archiveName`、`writeTarGz`、`writeZip`，测试能用它们打假包。
- `DT/cli-registration.ts`：marker `Vonvon Bot managed CLI v1`、`begin = '# >>> Vonvon Bot CLI >>>'`、`end = '# <<< Vonvon Bot CLI <<<'`、`startupBlock(bin)`、启动文件列表（`.zshrc`、`.zprofile`、`.bash_profile|.bash_login|.profile` 第一个存在的、`.bashrc`）、块替换。`observeCli` 遇到别的标记回 `error`（原来 U2 要改成认 `# Vonvon Bot server CLI v1`；2026-11-01 起 Linux 没有桌面端、Mac 没有脚本装的服务端，不改）。
- `D/cli/commands/service.ts`：`runServiceCommand('install', …)`；`--linger` 给了而 linger 没开成 → `throw new CommandError('failed', '服务已经装好，只是 linger 没开成。', { reason: 'linger_failed', partial })`，exit 1；`afterLinuxInstall` 的 `LINGER_QUESTION` 只在 TTY 问。`D/service/linux-session.ts` 的 `userManagerHint()` 分三种（没有 systemd、用户实例没在跑、没有 `XDG_RUNTIME_DIR`）；`D/service/launchd.ts` 在没有 GUI 域时拒绝。这些拒绝今天走 `CommandError('refused', …)`，`reason` 的字符串不统一。
- `D/cli/index.ts` 的 `preAction` 对 `open`、`status`、`logs`、`__restart-after-exit` 跳过 lease；隐藏命令用 `program.command(...)` 不加进 `visible` 即可（`commandList` 已有 `hidden` 字段，对齐测试会跳过隐藏命令）。
- `D/cli/commands/daemon.ts` `runStart`：没注册服务就 detached spawn。`--json` 由 C1 统一（没有的话本片加上）。
- 测试风格：`packages/desktop/test/cli-registration.test.ts` 用 `mkdtemp` 建假 home 和假资源目录；`scripts/*.test.mjs` 用 `node:test`。

## 4. 怎么改

### 4.1 `install.sh` 的步骤（按执行顺序；每步的失败和退出码）

退出码：0 装好或已装过；1 setup / 服务步骤失败；2 环境不支持（root、平台、缺工具）；3 下载失败；4 校验失败（清单、签名、哈希、包内容）。所有失败都先打印一行中文原因，再 `exit`。脚本里的 `curl` 一律 `curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2`。

常量（脚本头部，测试用 sed 换**公钥**那一段）：`BASE_URL="https://dl.vonvon.cc/bot/server"`、`ROOT="$HOME/.local/share/vonvon-bot/server"`、`DATA="$HOME/.vonvon-bot"`、`PUBKEY_PEM`（C2 那把钥匙的 SPKI PEM，夹在 `# BEGIN VONVON PUBKEY` / `# END VONVON PUBKEY` 两行之间）、`SERVER_MARKER="# Vonvon Bot server CLI v1"`、`DESKTOP_MARKER="Vonvon Bot managed CLI v1"`。

先看系统（2026-11-01）：`uname -s` 不是 `Linux` → 不联网、不写文件，exit 2。`Darwin` 打印 devices.md §15"安装脚本：在 Mac 上"那句（到 https://bot.vonvon.cc 下载桌面端安装包，它自带服务端）；别的系统打印"不是 Linux、也不是 Mac"那句。这一步在 root 检查之前。

0. **root**：`[ "$(id -u)" = 0 ]` 且 `VONVON_ALLOW_ROOT` 不是 `1` → 打印 §15"安装脚本：root"那段，exit 2。是 `1` → 打印"以 root 继续，Bot 和 AI 代理都会以 root 运行"继续。
1. **已装过**（任一命中 → 按 §15 文案打印、exit 0、不写任何文件）：
   - `$DATA/daemon.pid` 存在，用 `sed -n 's/.*"pid":\([0-9]*\).*/\1/p'` 取 pid，`kill -0 "$pid"` 成功；
   - `$ROOT/current` 存在（服务端装过）；
   - `$HOME/.config/systemd/user/vonvon-bot*.service` 有匹配（C7 的名字，带哈希后缀的也算）；
   - `command -v vonvon` 找到的文件里含 `$SERVER_MARKER` 或 `$DESKTOP_MARKER`。
   文案：§15"安装脚本：已装过"（"……不用再装。直接用：`vonvon --version`"）。原来还查 macOS 的 LaunchAgent 和 `Applications` 里的桌面端、按有没有命令分两种文案，2026-11-01 起脚本只在 Linux 上装，不查了。
2. **工具**：`curl`、`tar`、`mktemp`、`sed`，以及 `sha512sum` 或 `shasum`，以及 `base64` 或 `openssl`；缺一个 → 列出缺的，exit 2。
3. **选包**：`uname -s` 开头已核过是 `Linux`，`os=linux`；`uname -m` → `x86_64|amd64` → `x64`，`aarch64|arm64` → `arm64`，其他 exit 2。Linux 再查 musl：`ldd --version 2>&1 | head -n 1` 含 `musl`，或 `/lib/ld-musl-*.so.1` 存在 → "这一版不支持 musl（Alpine）"exit 2。`TARGET="$os-$arch"`、`EXT=tar.gz`。
4. **临时目录**：`TMP=$(mktemp -d)`，`trap 'rm -rf -- "${TMP:?}"' EXIT`。这是脚本里唯一一处对临时目录的 `rm`。
5. **清单**：`curl … -o "$TMP/manifest.json" "$BASE_URL/stable/manifest.json"` 失败 → exit 3。文件 > 65536 字节 → exit 4。
   - 取信封字段（信封是 `JSON.stringify` 的紧凑 JSON，键顺序 `payload`、`signature`）：`sed -n 's/.*"payload":"\([A-Za-z0-9+\/=]*\)".*/\1/p'`，`signature` 同理；任一为空 → exit 4。
   - base64 解码：依次试 `base64 -d`、`base64 -D`（旧 macOS）、`openssl base64 -d -A`，写 `$TMP/payload.bin`、`$TMP/sig.bin`；`sig.bin` 不是 64 字节 → exit 4。
   - **验签**：`openssl version 2>/dev/null` 以 `OpenSSL 3` 开头 → 写 `$TMP/pub.pem`，`openssl pkeyutl -verify -pubin -inkey "$TMP/pub.pem" -rawin -in "$TMP/payload.bin" -sigfile "$TMP/sig.bin"` 非零 → "发布清单的签名不对"exit 4。否则打印 §15"没验签名"那句，继续。
   - **校验 payload**（C1 的键顺序和紧凑格式让 sh 能用字面匹配）：`case "$payload" in '{"schemaVersion":1,"product":"vonvon-bot-server","channel":"stable","version":"'*) ;; *) exit 4;; esac`；`VERSION=$(printf %s "$payload" | sed -n 's/^{"schemaVersion":1,"product":"vonvon-bot-server","channel":"stable","version":"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/p')`，空或不匹配 `^[0-9]+\.[0-9]+\.[0-9]+$`（用 `case` 和 `expr` 做，不用 `grep -E` 的方言）→ exit 4。
   - 取本平台那一项：`sed -n 's/.*"'"$TARGET"'":{"url":"\([^"]*\)","sha512":"\([0-9a-f]*\)","size":\([0-9]*\)}.*/\1 \2 \3/p'` → `URL`、`SHA`、`SIZE`；`URL` 必须**字面等于** `$BASE_URL/$VERSION/vonvon-server-$VERSION-$TARGET.$EXT`，`SHA` 长度 128，`SIZE` 非空 → 否则 exit 4。
6. **已有这个版本？** `$ROOT/releases/$VERSION/standalone.json` 存在 → 跳过 7–9（上次装到一半、setup 失败）。`$ROOT/releases/$VERSION` 存在但没有 `standalone.json` → "`releases/<v>` 残缺，删掉它再运行"exit 1（脚本不删它：它不是本次建的）。
7. **下载**：`curl … -o "$TMP/pkg.$EXT" "$URL"` 失败 → exit 3。`wc -c` 不等于 `SIZE` → exit 4。`sha512sum` 或 `shasum -a 512` 的前 128 字符不等于 `SHA` → "下载内容和发布清单不一致"exit 4。
8. **解包**：`mkdir -p "$ROOT/releases"`；`PART="$ROOT/releases/$VERSION.part"`；存在就 `remove_part`（函数：`$PART` 非空、以 `.part` 结尾、以 `$ROOT/releases/` 开头、不是符号链接，四条都满足才 `rm -rf -- "$PART"`，否则 exit 1）。先 `tar -tzf "$TMP/pkg.$EXT"` 逐行检查：以 `/` 开头、含 `..` 路径段（`case "$m" in /*|../*|*/../*|*/..) ;;`）→ exit 4。`mkdir "$PART"`，`tar -xzf … -C "$PART"`。检查 `standalone.json`、`app/bin/vonvon.mjs`、`node/bin/node` 存在、`node/bin/node` 可执行；`find "$PART" -type l -print -quit` 非空 → exit 4（I1 保证包里无 symlink；如果 I1 的 POSIX 包有 node_modules 的相对 symlink，这条改成只拒绝绝对目标和逃出 `$PART` 的目标——I2 开工时核对 I1 的 `checkServerTree`）。`standalone.json` 里 `"version":"$VERSION"` 字面匹配，否则 exit 4。
9. `mv "$PART" "$ROOT/releases/$VERSION"`（同一文件系统，原子）。
10. **setup**：`"$ROOT/releases/$VERSION/node/bin/node" "$ROOT/releases/$VERSION/app/bin/vonvon.mjs" __standalone-setup --install-root "$ROOT" --version "$VERSION" --json` → 一行 JSON（§4.3）。退出非零或输出不含 `"ok":true` → 打印它的 stdout/stderr，exit 1。记下 `pathAlreadyOnPath`（`"pathAlreadyOnPath":true` 字面匹配）。
11. **服务**：`"$ROOT/bin/vonvon" service install --linger --json`（§4.4）：
    - 输出含 `"ok":true`：`"linger":"on"` → 不说；`"linger":"off"` → 取 `"lingerUser":"<名>"`（只含 `[A-Za-z0-9._-]`，TS 保证，测试盯着），打印 §15"linger 要 sudo"。
    - 输出含 `"ok":false`：取 `"reason":"<x>"`；`x ∈ no_systemd | user_instance_down | no_runtime_dir` → 打印 §15 对应那句（`no_runtime_dir` 和 `user_instance_down` 共用"用户实例不可用"那句），再跑 `"$ROOT/bin/vonvon" daemon start --json`，非零或没有 `"ok":true` → exit 1。其他 reason → 原样打印那行 JSON 和"服务没装上"，exit 1。
    - 命令本身起不来（启动器坏）→ exit 1。
12. **完成**：§15"安装脚本：完成"；`pathAlreadyOnPath` 为假加"重开一个终端，或 `. ~/.bashrc`（zsh 用 `. ~/.zshrc`）再运行 `vonvon`"。退路分支（第 11 步跑了 `daemon start`）第一行换成"装好了。已直接启动一次。"，不说"登录后自动运行"。

脚本结构：所有函数在上，`main() { … }`，最后一行 `main "$@"`；`curl | sh` 管道中途断开，`sh` 读到不完整的文件也不会执行半截（`main` 调用在最后）。不读 stdin。`set -eu`，每个外部命令的失败都被显式判断或靠 `set -e` 中止在 `trap` 之前。

### 4.2 `uninstall.sh`

0. 先看系统，同 §4.1：不是 Linux → exit 2，什么都不碰；`Darwin` 打印 §15"卸载脚本：在 Mac 上"那句。
1. root 检查同上（root 下的安装根不同，照样按 `$HOME` 算；只警告不拒绝）。
2. `ROOT` 不存在 → "没有装过服务端"exit 0。
3. 有 `$ROOT/bin/vonvon` 且能跑（`"$ROOT/bin/vonvon" --version` 退 0）：
   - `"$ROOT/bin/vonvon" service uninstall --json`；`ok:false` 且 `reason` 是 `not_registered` → `"$ROOT/bin/vonvon" daemon stop --json`（`connection` 错误当作没在跑，忽略）；别的错误 → 打印、exit 1（不删文件：服务定义还在，删了代码它会一直拉起坏的 `current`）。
   - `"$ROOT/bin/vonvon" __standalone-teardown --install-root "$ROOT" --json`（删 PATH 块，§4.3）；失败只警告。
   跑不了 → 对 `$ROOT/releases/*/node/bin/node` 的每一个试 `… app/bin/vonvon.mjs __standalone-teardown`，第一个成功就停；都不行 → 打印"请手动删掉 `~/.zshrc`、`~/.bashrc` 等里 `# >>> Vonvon Bot CLI >>>` 到 `# <<< Vonvon Bot CLI <<<` 那几行"。
4. `remove_install_root`（SCRIPT-1 的四条，缺一不删，exit 2）：`${HOME:?}` 非空；`target="$HOME/.local/share/vonvon-bot/server"`（字面拼法，不用 `$ROOT` 以外的变量）；`[ ! -L "$target" ]`；`$target/releases/*/standalone.json` 至少一个或 `$target/current` 存在。然后 `rm -rf -- "$target"`。
5. 打印"已卸载服务端。数据目录 `~/.vonvon-bot`（Bot、记忆、设置）保留着；不要了就自己删。"exit 0。

### 4.3 `__standalone-setup` / `__standalone-teardown`（`D/cli/commands/standalone-setup.ts`）

隐藏命令，不进 `visible`，`preAction` 跳过 lease。只在 `standalone` 的包里有意义，但不检查发行种类（脚本调它时 `current` 还没切，`classifyDistribution` 会判成别的）。

`__standalone-setup --install-root <根> --version <v> [--json]`：
1. 参数：根必须是绝对路径且存在；`v` 匹配语义版本；`releases/<v>/standalone.json` 存在且 `version === v`，否则 `bad-args`（exit 2）。
2. `switchCurrent(root, v)`（C5）→ `previous`。
3. 写启动器（POSIX）`<根>/bin/vonvon`：
   ```sh
   #!/bin/sh
   # Vonvon Bot server CLI v1
   root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
   PATH="$root/current/node/bin:$PATH"
   export PATH
   exec "$root/current/node/bin/node" "$root/current/app/bin/vonvon.mjs" "$@"
   ```
   写 `bin/vonvon.tmp`，`chmod 0755`，`rename` 到 `bin/vonvon`。`$0` 经 PATH 找到时是完整路径，`pwd -P` 解析符号链接；`current` 不在这条解析里（我们 `cd` 的是 `bin/..`，不是 `current`），所以启动器总跟着 `current` 走。win32 不支持（I4a 已取消，2026-11-01），回 `failed`、`reason: 'unsupported_platform'`。
4. PATH 块：`P/cli-path-block.ts` 导出 `CLI_PATH_BLOCK_BEGIN`、`CLI_PATH_BLOCK_END`、`startupBlock(binDir)`（和今天 `DT/cli-registration.ts:33` 的文本**逐字相同**）、`shellStartupFiles(home, { zdotdir?, exists })`（同今天的选择规则）、`spliceBlock(content, block | null)`（替换或删除两标记之间的内容，没有标记就追加，保留末尾换行）。`D/platform/shell-path.ts` 用它们读写：每个文件 `readFile`（ENOENT 当空）→ `spliceBlock` → 内容没变就跳过 → 写同目录 `.<名>.vonvon-tmp` 再 `rename`（保留原 mode；新文件 0644）。桌面端 `cli-registration.ts` 改成从 `P/` 取文本和拼接，行为不变（它的测试照旧绿）。`pathAlreadyOnPath = process.env.PATH.split(':').includes(binDir)`。
5. 输出 `{ ok: true, version, previous, launcher, pathFiles: [...], pathAlreadyOnPath }`；文字版打印三行。
6. 失败：第 2 步抛 → `failed`、`reason: 'release_incomplete'`；第 3 步 EACCES → `failed`、`reason: 'launcher_write_failed'`（`current` 已切，脚本的下一次运行会走第 6 步"已有这个版本"直接重跑 setup）；第 4 步某个文件写不了 → **不算失败**，`pathFiles` 里不列它，加 `pathNote: '<文件> 没写进去：<errno>'`。

`__standalone-teardown --install-root <根> [--json]`：对 `shellStartupFiles` 的每个文件 `spliceBlock(content, null)`，但只在现有块的 `startupBlock` 文本等于 `startupBlock('<根>/bin')` 时删（桌面端的块不动）。输出 `{ ok: true, pathFiles }`。不碰安装根。

root 警告：`daemon run` 和 `service install` 在 `process.getuid?.() === 0` 时 stderr 打一行"以 root 运行 Vonvon Bot：AI 代理会有整机权限。"（`--json` 时放进 `notes`）。

### 4.4 `service install --linger --json`（`D/cli/commands/service.ts`）

- linger 没开成：不再 `throw`。`--json` → `{ ok: true, ...outcome, linger: 'off', lingerUser: <os.userInfo().username>, notes }`，exit 0；文字版打印 `enableFailed(...)` 那句加 `sudo loginctl enable-linger <user>`，exit 0。`linger` 字段：`on`（已开或刚开成）、`off`、`unsupported`（非 Linux）。`lingerUser` 只允许 `^[A-Za-z0-9._-]+$`，不匹配就省略字段（脚本退回打印不带用户名的那句）。
- 环境性拒绝统一成 `CommandError('refused', message, { reason, fallback: 'detached', hint })`，`reason` 四个稳定值：`no_systemd`、`user_instance_down`、`no_runtime_dir`（Linux，来自 `userManagerHint()` 的三种）、`no_gui_session`（macOS，launchd GUI 域不可用；2026-11-01 起脚本不在 Mac 上跑，脚本不认它）。`--json` 失败形状按 C1：`{ ok: false, error: { kind: 'refused', message, reason, fallback: 'detached', hint }, exitCode: 4 }`。`hint` 是 §15 的那句。
- 别的失败（`systemctl` 退非零、写 unit 文件 EACCES）照旧 `failed`，没有 `fallback`。
- `daemon start --json` 成功输出 `{ ok: true, pid, port }`（C1 已定就不动）。

### 4.5 `install.ps1` / `uninstall.ps1`

> 已取消（owner 2026-11-01：Mac、Windows 只用安装包装全部软件，不做命令行只装服务端）

同 §4.1 的 12 步，差别：
- `Set-StrictMode -Version 2`、`$ErrorActionPreference = 'Stop'`、`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`；`Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0`。整个脚本是函数 + 最后一行 `Main`。
- root 一步换成"管理员"：`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')` 为真 → 警告（不拒绝：Windows 上管理员账号就是普通用法；计划任务仍 `LeastPrivilege`）。
- 已装过：`$env:USERPROFILE\.vonvon-bot\daemon.pid` 的 pid `Get-Process -Id` 存在；`$env:LOCALAPPDATA\VonvonBot\server\current.txt` 存在；计划任务 `schtasks /Query /TN "\VonvonBot\<sid-hash12>-<root-hash12>"` 退 0（C7 的哈希在 PS 里算：SID 来自 `WindowsIdentity.GetCurrent().User.Value`，数据目录小写、去尾 `\`，`[Security.Cryptography.SHA256]`）；桌面端：`HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*` 里 `DisplayName -eq 'Vonvon Bot'` 或 `$env:LOCALAPPDATA\Programs\Vonvon Bot` 存在。文案用"打开 Vonvon Bot 就能用"那句（Windows 桌面端不注册 `vonvon`）。
- 选包：`[Environment]::Is64BitOperatingSystem` 为假 → 不支持；`$env:PROCESSOR_ARCHITECTURE`（`AMD64` → `win-x64`，`ARM64` → `win-arm64`；PS 5.1 x86 进程在 ARM64 上跑时读 `PROCESSOR_ARCHITEW6432`）。
- **签名**：.NET Framework 4.x 没有 Ed25519，PowerShell 5.1 验不了签名；用包里刚解出来的 `node.exe` 来验也不行——它就是待验的内容。所以 `.ps1` 固定打印"这台机器上没能核对发布签名；已核对下载内容的哈希，来源是 https://dl.vonvon.cc"（和没有 OpenSSL 3 的 sh 同一个信任根），payload 照样做 C1 的全部字面校验（`ConvertFrom-Json` 后逐字段比对，不靠键顺序）。
- 解包：先 `[IO.Compression.ZipFile]::OpenRead` 枚举 `Entries`，`FullName` 含 `..` 段、以 `/` 或 `\` 开头、含 `:` → 拒；再 `Expand-Archive -DestinationPath "<根>\releases\<v>.part"`；`Move-Item` 改名。
- setup：`releases\<v>\node\node.exe releases\<v>\app\bin\vonvon.mjs __standalone-setup …`，它写 `bin\vonvon.cmd`、`bin\vonvon-server.cmd`（I4a 的模板）和 `current.txt`；PATH：`__standalone-setup` 在 win32 上**不**写 PATH，由脚本做：读 `HKCU\Environment` 的 `Path`（`Get-ItemProperty`，REG_EXPAND_SZ 原样），不含 `<根>\bin` 就追加 `;<根>\bin`，`[Environment]::SetEnvironmentVariable('Path', $new, 'User')`（它会广播 `WM_SETTINGCHANGE`）；打印"当前这个窗口要重开才认得 `vonvon`"。
- 服务：`bin\vonvon.cmd service install --json`（没有 `--linger`）；`ok:false` 且 `reason` 是 `schtasks_denied`（I4a 定的 reason 之一：组策略禁了计划任务）→ 打印并 `daemon start --json`；其他失败 exit 1。
- 完成文案加"保持登录"那行。
- `uninstall.ps1`：`service uninstall --json` → `__standalone-teardown`（win32 不动 PATH 块；脚本自己从 `HKCU\Environment\Path` 里去掉 `<根>\bin` 那一段）→ 受保护删除：`$env:LOCALAPPDATA` 非空、目标是 `$env:LOCALAPPDATA\VonvonBot\server` 字面拼法、不是重解析点（`(Get-Item).Attributes` 不含 `ReparsePoint`）、目录里有 `releases\*\standalone.json` 或 `current.txt`，四条都满足才 `Remove-Item -Recurse -Force`；`node.exe` 被占用删不掉 → 打印"有进程还在用，注销后再运行一次"exit 1。

### 4.6 和总设计不一样的地方

| 总设计 | 这里 | 原因 |
|---|---|---|
| §7.2 PATH 块"和桌面端今天一样"，文本在 `DT/cli-registration.ts` | 文本和拼接搬到 `P/cli-path-block.ts`，桌面端和 daemon 都从那里取 | daemon 不能 import desktop（依赖方向反了，desktop 也不依赖 daemon）；protocol 是两边唯一共同的底层包 |
| §7.3 第 1 步用 `mdfind` 找桌面端 | 只看 `/Applications` 和 `~/Applications` | `mdfind` 慢、Spotlight 关了就不准；两个目录覆盖 Finder 和 Homebrew cask 的默认位置 |
| §7.3 "有 openssl 3 就验签"同样适用于 `.ps1` 的说法 | `.ps1` 不验签，固定打印没验签名那句 | PS 5.1 / .NET Framework 没有 Ed25519；用包里的 node.exe 验是循环信任 |
| §7.4 Windows 的 PATH 在 `__standalone-setup` 里写 | `.ps1` 自己写注册表并广播，`__standalone-setup` 在 win32 不碰 PATH | 广播 `WM_SETTINGCHANGE` 用 .NET 一行就有；Node 里要 `reg` 子进程加原生广播，I4a 不想带这个 |
| §7.3 没说 `releases/<v>` 已存在怎么办 | 完整就复用、跳过下载；残缺就拒绝并让人删 | 脚本只删自己建的 `.part`（SCRIPT-1） |

第 2、3、4 行（找桌面端、`.ps1` 验签、Windows 的 PATH）随 2026-11-01 的决定用不上了：脚本只在 Linux 上装。

## 5. 测试

### 5.1 `scripts/install.test.mjs`（`node --test`，`npm test` 已包含 `scripts/*.test.mjs`）

跑法：`flock /tmp/vonvon-heavy.lock node --test scripts/install.test.mjs`。每个用例 `mkdtemp` 一个根 `R`，里面 `home/`、`cdn/`、`shims/`、`scripts/`；子进程用 `execFile('sh', [R/scripts/install.sh], { env: { ...process.env, HOME: R/home, PATH: R/shims + ':' + process.env.PATH, VONVON_ALLOW_ROOT: … } })`，`HOME` 只出现在这个 `env` 对象里。结束 `rm(R, { recursive: true })`（`R` 来自 `mkdtemp`）。

夹具：
- 测试里 `generateKeyPairSync('ed25519')` 现生成钥匙；`R/scripts/install.sh` 是仓库脚本的副本，`# BEGIN VONVON PUBKEY` 到 `# END VONVON PUBKEY` 之间换成测试公钥的 PEM。**没有别的改动**：`BASE_URL` 不换，靠 `curl` 替身映射。
- 假包：目录树 `standalone.json`（`{ v: 1, version, target, node: 'test' }`）、`app/package.json`、`app/bin/vonvon.mjs`（替身，下一条）、`node/bin/node`（`#!/bin/sh` + `exec "<真 process.execPath>" "$@"`，0755）；用 `build-server.mjs` 的 `writeTarGz` 打包到 `R/cdn/<v>/vonvon-server-<v>-linux-x64.tar.gz`；`sha512`、`size` 算出来写进 payload；`R/cdn/stable/manifest.json` 是用测试私钥签的信封（键顺序照 C1）。
- `app/bin/vonvon.mjs` 替身：把 `process.argv.slice(2)` 追加到 `<安装根>/calls.log`（安装根 = 自己路径的 `../../../..`）；按第一个参数回应：`__standalone-setup` → 真的 `symlink('releases/<v>', 'current.next') + rename`、写 `bin/vonvon` 启动器（和 §4.3 同文本）、输出 `{"ok":true,"version":…,"previous":null,"launcher":…,"pathFiles":[],"pathAlreadyOnPath":false}`；`service install` / `daemon start` / `service uninstall` / `daemon stop` / `__standalone-teardown` / `--version` → 读 `<安装根>/scenario.json`（测试事先 `mkdir -p` 安装根并写好；脚本不在意多出来的文件）里对应的 `{ stdout, exit }`。
- 替身（`R/shims/` 里的 sh 脚本，0755；替身里的路径在生成时写死，不靠环境变量）：`curl`（把全部参数追加到 `R/shims/curl.log`；取 `-o` 后面的文件名和最后一个 `https://` 参数，把 `https://dl.vonvon.cc/bot/server/` 前缀换成 `R/cdn/`，`cp`；源文件不存在 → exit 22）；`openssl`（可选：`version` 打 `OpenSSL 1.1.1w`，别的子命令 exit 127）；`id`（`-u` 打 `0`）；`uname`（按用例打 `Darwin`/`arm64` 或 `Linux`/`x86_64`）；`ldd`（打 `musl libc (x86_64)`）。真 `openssl 3`（JP-VPS 有）用于验签通过/失败的用例。

| 用例 | 输入 → 期望 | main 必败 |
|---|---|---|
| 正常安装（Linux x64，真 openssl） | exit 0；stdout 含"正在安装 Vonvon Bot 服务端 1.0.0（linux-x64）"和"装好了"；`home/.local/share/vonvon-bot/server/current` 是指向 `releases/1.0.0` 的相对链接；`releases/1.0.0.part` 不存在；`calls.log` 三行顺序 `__standalone-setup …`、`service install --linger --json`、无 `daemon start`；`curl.log` 每行含 `--proto =https` 和 `--tlsv1.2`，第一行 URL 以 `/stable/manifest.json` 结尾；stdout 不含"没验签名" | 是（脚本不存在） |
| 没有 openssl 3 | `openssl` 替身 → exit 0，stdout 含"没能核对发布签名" | 是 |
| 坏签名 | 用另一把钥匙签 → exit 4，stdout 含"签名不对"，安装根下没有 `releases/` | 是 |
| 没有 openssl 3 + 坏签名 | exit 0（验不了就是验不了，哈希对就装）；这条用例是**文档化**这个信任边界 | 是 |
| payload 多一个键 / `channel: beta` / `version: 1.0` / `url` 换主机 / sha512 127 位 | 各 exit 4，不下载包（`curl.log` 只有一行） | 是 |
| 哈希不对 | 包字节改一个 → exit 4，"和发布清单不一致"，`releases/` 为空 | 是 |
| size 不对 | 清单 `size` + 1 → exit 4，没算哈希（stdout 文字区分） | 是 |
| 包含 `../x` 成员 | 手工 `writeTarGz` 一个带 `../evil` 的包 → exit 4，`home/` 下没有 `evil` | 是 |
| 包含 symlink 成员 | → exit 4（或按 I1 核对结果改为"相对不逃出根则接受"） | 是 |
| root 拒绝 | `id` 替身 → exit 2，stdout 含 `useradd -m vonvon`，没有网络调用（`curl.log` 不存在） | 是 |
| root 放行 | `VONVON_ALLOW_ROOT=1` → 走完，exit 0，stdout 含"以 root 继续" | 是 |
| 已装过：pid 活着 | `home/.vonvon-bot/daemon.pid` 写 `{"pid":<本测试进程 pid>}` → exit 0，"已经装过"，没有 `curl` 调用，安装根不存在 | 是 |
| 已装过：`current` 存在 / systemd unit 文件 / PATH 里有带桌面端标记的 `vonvon` / 带服务端标记的 `vonvon` | 各 exit 0，文案含 `vonvon --version` | 是 |
| 在 macOS 上（2026-11-01） | `uname` 替身 `Darwin`/`arm64`，`install.sh` 和 `uninstall.sh` 各跑一次 → 都 exit 2，stdout 含 `https://bot.vonvon.cc`；没有 `curl` 调用（`curl.log` 不存在），`home/` 下什么都没写；`home/.local/share/vonvon-bot/server` 事先建好时 `uninstall.sh` 也不删它 | 是 |
| 不是 Linux、也不是 Mac | `uname` 替身 `FreeBSD` → exit 2，含"只支持 Linux"，没有网络调用 | 是 |
| musl | `ldd` 替身 → exit 2，含"musl" | 是 |
| 缺工具 | `PATH` 里去掉 `tar`（替身目录里放一个 exit 127 的 `tar`，并把 PATH 只给替身目录 + 一个只含 sh/sed/mktemp 的目录）→ exit 2，列出 `tar` | 是 |
| 清单下载失败 | `cdn/stable/manifest.json` 不存在 → exit 3 | 是 |
| 包下载失败 | 清单对、包文件不在 → exit 3，`.part` 不残留 | 是 |
| linger off | scenario `service install` 回 `{"ok":true,"linger":"off","lingerUser":"alice"}` → exit 0，stdout 含 `sudo loginctl enable-linger alice` | 是 |
| 没有 systemd | scenario 回 `{"ok":false,"error":{"kind":"refused","reason":"no_systemd","fallback":"detached"},"exitCode":4}`，`daemon start` 回 `{"ok":true}` → exit 0，stdout 含"没有 systemd"和"已直接启动一次"，`calls.log` 第三行是 `daemon start --json` | 是 |
| 用户实例不可用 / `no_runtime_dir` | 同上两种文案 | 是 |
| 服务其他失败 | `reason: "unit_write_failed"` → exit 1，没有 `daemon start` | 是 |
| setup 失败 | 替身对 `__standalone-setup` 回 exit 1 → 脚本 exit 1，`releases/1.0.0/standalone.json` 还在，`current` 不存在；**再跑一次** → 不下载（`curl.log` 只有清单那一行），直接到 setup，exit 0 | 是 |
| `releases/1.0.0` 残缺 | 事先建空目录 → exit 1，含"残缺"，目录没被删 | 是 |
| `.part` 残留 | 事先建 `releases/1.0.0.part/junk` → 被清掉后正常装完 | 是 |
| 管道中断 | 把脚本截到 `main "$@"` 之前的任一位置喂给 `sh -s` → 没有任何输出中的"正在安装"，安装根不存在（`sh` 对不完整脚本的行为：函数定义完整就什么都不做；最后一行才调用） | 是 |
| uninstall 正常 | 装好后跑 `uninstall.sh`（scenario：`service uninstall` ok、teardown ok）→ exit 0，安装根不存在，`home/.vonvon-bot` 还在，`calls.log` 末两行是 `service uninstall --json`、`__standalone-teardown …` | 是 |
| uninstall：`HOME` 为空 | `env.HOME = ''` → exit 2，含"HOME"，什么都没删（事先在 `R/home2` 放个标记目录确认没动） | 是 |
| uninstall：安装根是符号链接 / 没有标记 | 各 exit 2，链接目标目录完好 | 是 |
| uninstall：没装过 | exit 0，"没有装过" | 是 |
| uninstall：`service uninstall` 失败（非 `not_registered`） | exit 1，安装根还在 | 是 |
| uninstall：`not_registered` | 接着 `daemon stop`，然后删 | 是 |

### 5.2 daemon（vitest，`packages/daemon/test/`）

| 文件 | 输入 → 期望 | main 必败 |
|---|---|---|
| `standalone-setup.test.ts` | mkdtemp 根 + `releases/1.0.0/standalone.json` → 跑 setup（直接调函数，注入 home 和 `platform`）→ `current` 相对链接、`bin/vonvon` 0755 且含 `# Vonvon Bot server CLI v1`、`bin/vonvon.tmp` 不存在；`.zshrc` 等四个文件都有 `>>>`/`<<<` 块且和 `startupBlock('<根>/bin')` 相同；再跑一次 → 文件内容不变；`.bashrc` 只读 → `pathNote`、`ok: true`；`standalone.json` 版本不符 → `release_incomplete`；用 `current/node/bin/node`=假 node（打印 argv）真跑 `bin/vonvon a b` → 打印的 argv 里是 `.../current/app/bin/vonvon.mjs a b`、`PATH` 以 `<根>/current/node/bin:` 开头 | 是 |
| `standalone-setup.test.ts` | teardown：桌面端的块（bin 是 `~/.local/share/vonvon-bot/bin`）不删，服务端的块删，文件末尾换行保留 | 是 |
| `cli-path-block.test.ts`（`packages/protocol/test/`） | `spliceBlock` 四种：无标记追加、有标记替换、`null` 删除、标记残缺（只有 begin）→ 追加完整块并保留原文；`startupBlock` 文本和旧 `DT/cli-registration.ts` 的 snapshot 一致 | 是 |
| `cli-registration.test.ts`（desktop，已有） | 不改断言，改 import 后仍绿 | 否 |
| `service-command.test.ts`（扩） | `--linger --json`、`enableLinger` 注入失败 → stdout `ok: true, linger: 'off', lingerUser`、exit 0；文字版 exit 0 且含 `loginctl enable-linger`；`userManagerHint` 三种 → `--json` 的 `error.reason` 分别是 `no_systemd`/`user_instance_down`/`no_runtime_dir`，`fallback: 'detached'`，exit 4；launchd 无 GUI → `no_gui_session`；`lingerUser` 含空格 → 字段省略 | 是 |
| `cli-root-warning.test.ts` | 注入 `getuid: () => 0` → `daemon run` 的 stderr 第一行含 "root"；`service install --json` 的 `notes` 含那句 | 是 |

### 5.3 `install.ps1` 静态测试（`scripts/install-ps1.test.mjs`，JP-VPS 没有 pwsh）

> 已取消（owner 2026-11-01：Mac、Windows 只用安装包装全部软件，不做命令行只装服务端）

| 输入 → 期望 | main 必败 |
|---|---|
| 最后一个非空行是 `Main`；文件里恰好一个 `function Main` | 是 |
| 含 `SecurityProtocolType]::Tls12`、每个 `Invoke-WebRequest` 同一行有 `-UseBasicParsing`；不含 `Invoke-Expression`、`iex `、`Start-Process -Verb RunAs` | 是 |
| `$BaseUrl = 'https://dl.vonvon.cc/bot/server'` 和 sh 的 `BASE_URL`、`packages/daemon/server-update.json` 的 `baseURL` 三处相同；`.ps1` 和 `.sh` 的"没验签名"句相同 | 是 |
| 删除只出现在一个函数里，且该函数含 `LOCALAPPDATA`、`ReparsePoint`、`standalone.json` 三个字面 | 是 |
| 以 UTF-8 带 BOM 保存（PS 5.1 读无 BOM 的 UTF-8 会把中文当 ANSI） | 是 |

## 6. 自测和验收

JP-VPS 自测：
1. `flock /tmp/vonvon-heavy.lock npm run build`、daemon 和 protocol 的 typecheck / lint、§5 的全部测试。
2. 真脚本 + 真包（不碰真用户的服务管理器）：`T=$(mktemp -d)`；用 I1 的 `build-server.mjs --targets linux-x64 --update-public-key … --update-base-url …`（I3 加的选项；没有就手工把 `server-update.json` 放进包）打一个真包，放进 `$T/cdn`，用测试私钥签清单；用 §5.1 的 `curl` 替身目录；`HOME=$T/home PATH=$T/shims:$PATH sh scripts/install.sh`——但 `service install` 会碰 `systemctl --user`：所以这一步**在 `PATH` 里放一个 `systemctl` 替身**（打印 `no systemd` 并 exit 1，让 `linux-session.ts` 判成 `no_systemd`）走退路分支，期望 `daemon start` 真的起了一个 detached daemon（`HOME=$T/home VONVON_HOME=$T/home/.vonvon-bot $T/home/.local/share/vonvon-bot/server/bin/vonvon status --json` 能连上），`vonvon --version` 对，`vonvon open --print` 回 200；然后 `… daemon stop`，`HOME=$T/home sh scripts/uninstall.sh`，安装根没了、`$T/home/.vonvon-bot` 还在。`rm -rf -- "${T:?}"`。
3. 真 systemd 的分支（`systemctl --user enable/start`）**不在 JP-VPS 的真用户上跑**；交给 I5 的 CI 冒烟（GitHub Linux runner 的一次性用户实例）和下面的验收。

验收（owner / Mac Codex / Windows Codex；本片合入前不要求，和 I5 一起）：
- JP-VPS 干净测试用户，SSH 登录（不用 `sudo -u`）：`sh -c "$(curl -fsSL <assets>/install.sh)"` → `systemctl --user status vonvon-bot` 运行中、linger 已开或打印了 sudo 提示且 exit 0；再跑一次 → "已经装过了"；`uninstall.sh` 后 unit 没了、`~/.vonvon-bot` 还在。
- Mac 测试环境（2026-11-01 改）：`sh install.sh`、`sh uninstall.sh` 都退出非零，打印去 https://bot.vonvon.cc 下载桌面端安装包的那句，HOME 下什么都没写，不碰已装的桌面端。
- Windows（随 I4a/I4b 的任务一起发给 Windows Codex；验收清单）：

  > 已取消（owner 2026-11-01：Mac、Windows 只用安装包装全部软件，不做命令行只装服务端）

  1. 标准用户 PowerShell 5.1：`irm <assets>/install.ps1 | iex` → exit 0；`%LOCALAPPDATA%\VonvonBot\server\current.txt` 第 1 行是版本；`bin\vonvon.cmd --version` 对；`schtasks /Query /TN "\VonvonBot\<名>"` 存在；重开 PowerShell 后 `vonvon --version` 直接能用。
  2. 再跑一次 → "已经装过"，exit 0，`current.txt` 的修改时间没变。
  3. 装了桌面端（NSIS）没开时跑 → 跳过，文案是"打开 Vonvon Bot 就能用"。
  4. 第二个本地用户登录后跑 → 也装上，任务名不同。
  5. 清单里 `sha512` 改一位（本机 hosts 指向假 CDN）→ exit 4，`releases\` 为空。
  6. `uninstall.ps1` → 任务删了、安装根删了、`%USERPROFILE%\.vonvon-bot` 还在、`HKCU\Environment\Path` 里没有 `<根>\bin`；daemon 还在跑时先跑 `uninstall.ps1` → 它先停 daemon。
  7. `$env:LOCALAPPDATA = ''` 下跑 `uninstall.ps1` → 拒绝，什么都没删。
  8. PS 7 (`pwsh`) 下 1 和 6 也过。

## 7. 文档

- `docs/product.md` 3.3（磁盘上的位置）：加服务端安装根、`releases/<v>`、`current`、`bin/vonvon`、PATH 块两边共用；3.10：加"只装服务端"的一段（只在 Linux、一行命令、装成后台服务、装不了服务时直接启动并说明、root 默认拒绝、已装过就跳过、在 Mac 上只提示去下载桌面端安装包）和卸载保留数据目录；3.11：加"安装脚本核对发布清单的哈希，有 OpenSSL 3 再验签名"。
- `docs/architecture.md`：加安装布局一段，指向 I3 §4.1 的 C5。
- `README.md`：安装一节加服务端的一行命令（URL 等 I5 的 CDN 路径）。
- `docs/plans/devices.md` §7.3 加一行指到本文 §4.6。

## 8. 验收要点

- `install.sh`：`set -eu`、函数在上、最后一行 `main "$@"`、不读 stdin；所有 `curl` 带 `--proto '=https' --tlsv1.2`；退出码 0/1/2/3/4 和 §4.1 一致，每个失败都有一行中文。
- 已装过的四种命中各有测试，命中时没有任何网络调用、不写文件；在 macOS 和别的系统上两个脚本 exit 2，没有网络调用、不写文件。
- 清单的字面校验（前缀、版本正则、`url` 字面相等、sha512 128 位）全在 sh 里做，不信 payload 的任何没校验的字段；验签只在 OpenSSL 3 下做，没有时**明说**。
- 解包前检查成员路径，解到 `.part` 再 `mv`；脚本里唯一的 `rm -rf` 对象是 `$TMP` 和满足四条件的 `.part`；`uninstall.sh` 的删除走四条件函数，`HOME` 为空、符号链接、无标记各有测试。
- `__standalone-setup` 写启动器和 PATH 块都是写临时文件再 `rename`；PATH 块文本和桌面端的来自同一个 `P/cli-path-block.ts`，桌面端测试不改断言仍绿。
- `service install --linger --json`：linger 没开成 exit 0、带 `lingerUser`；四个 `reason` 稳定、带 `fallback: 'detached'`；脚本对 Linux 的三个 reason 的文案和 §15 一致。
- `.ps1` 那几条随 I2b 取消。
- 测试在 `mkdtemp` 的 HOME 里跑 `sh`，`HOME` 只在子进程 `env` 里；不碰真服务管理器、不连网。
- diff 里没有真实 id、密钥、本机路径；测试钥匙现生成；脚本里的公钥是 C2 那把的公开部分（owner 生成后提交）。

## 9. 风险和行数

- `sed` 取 JSON 字段依赖 C1 的键顺序和紧凑格式；I5 的签名脚本用同一个 `JSON.stringify` 顺序，I5 的测试里有"sh 能取出 TS 写的清单"这一条交叉验证。
- `.ps1` 随 I2b 取消（2026-11-01），没有这项风险了。
- 公钥还没有：owner 要先按 I5 §4.2 生成服务端签名密钥并提交公开部分（`packages/daemon/server-update.json`），I2、I3 的代码才能带真公钥；之前用占位会让已发出去的脚本验不过真清单。
- 行数估计 ~1,550（`install.sh` 260、`uninstall.sh` 90、`install.ps1` 260、`uninstall.ps1` 80、`standalone-setup.ts` 150、`P/cli-path-block.ts` + `D/platform/shell-path.ts` 100、`service.ts` 60、desktop 改 import 净 -30、测试 ~580），超过 1,500，**拆两片**（2026-11-01 起 I2b 取消，只做 I2a）：
  - **I2a**（本片主体，B2 道，依赖 I1）：sh 两个脚本、TS 两条隐藏命令、PATH 块搬家、`service.ts`、root 警告、§5.1 和 §5.2 的测试。~1,150。
  - **I2b**（D 道，依赖 I2a、I4a）：`install.ps1`、`uninstall.ps1`、§5.3 静态测试、§6 的 Windows 验收清单（写进发给 Windows Codex 的任务）。~400。
