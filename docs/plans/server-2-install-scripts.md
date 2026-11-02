# I2 `server-2-install-scripts`：`install.sh`、`uninstall.sh`（`install.ps1`、`uninstall.ps1` 已取消，2026-11-01）

依据 `docs/plans/devices.md` §7.2（布局）、§7.3（安装脚本）、§7.4 的退路、§15 的文案、§13 的 I2 行。契约（清单格式、签名公钥怎么进包、`current`/`current.txt`、`current-release.ts`、服务名）在 `docs/plans/server-3-update-engine.md` §4.1，本文按 C1–C8 的编号引用，不重写。缩写同 `devices.md`。

**2026-11-01 改动**（owner："Mac 和 Windows 上就直接通过安装包安装全部软件就好了，没有这种场景只安装 Server 端，也不用通过命令行安装"；`devices.md` 第 19 节）：脚本只在 Linux 上装。`install.sh`、`uninstall.sh` 在 macOS 上只打印一句中文，让用户到 https://vonvon.cc/get/ 下载安装包，退出 2，不联网、不写任何文件；别的系统同样退出 2。脚本里不再有 Mac 的 LaunchAgent、`Applications` 里的桌面端、无图形登录这些分支，Linux 照旧查"已装过"。I2b（`install.ps1`、`uninstall.ps1`、§4.5、§5.3、§6 的 Windows 清单）取消，那几节留作记录。服务端包只有 `linux-x64`、`linux-arm64`，签名清单的 `files` 也只有这两项（I3 C1）；I2a 的脚本已经只认这两项，多一项、少一项都 exit 4，I3 的 `SERVER_TARGETS` 在 I3 里改成同样两项（`devices.md` 第 13 节 I3 行）。下文已按这些改过。代码实际怎么做、和计划不一样的地方，见文末三节（I2a）。

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

常量（脚本头部，测试用 sed 换**公钥**那一段）：`BASE_URL="https://dl.vonvon.cc/bot/server"`、`ROOT="$HOME/.local/share/vonvon-bot/server"`、`DATA="$HOME/.vonvon-bot"`、`PUBKEY_PEM`（C2 那把钥匙的 SPKI PEM，夹在 `# BEGIN VONVON PUBKEY` / `# END VONVON PUBKEY` 两行之间）、`SERVER_MARKER="# Vonvon Bot server CLI v1"`、`DESKTOP_DOWNLOAD="https://vonvon.cc/get/"`（新版本只认 vonvon.cc，bot.vonvon.cc 只为 0.7.0 留着 301，`v1-plan.md` 第 10 节）（原来还有桌面端命令的标记 `DESKTOP_MARKER`，Linux 没有桌面端，I2a 删了）。

先看系统（2026-11-01）：`uname -s` 不是 `Linux` → 不联网、不写文件、不建临时目录，exit 2。`Darwin` 打印 devices.md §15"安装脚本：在 Mac 上"那句（到 https://vonvon.cc/get/ 下载安装包，里面带了服务端和 `vonvon` 命令）；别的系统（FreeBSD、Windows 的 Git Bash 这类）打印"安装脚本：不是 Linux、也不是 Mac"那句，带上 `uname -s` 的结果。这一步是 `main` 的第一步，在 root、`HOME`、已装过和公钥的检查之前。

0. **root**：`[ "$(id -u)" = 0 ]` 且 `VONVON_ALLOW_ROOT` 不是 `1` → 打印 §15"安装脚本：root"那段，exit 2。是 `1` → 打印"以 root 继续，Bot 和 AI 代理都会以 root 运行"继续。
1. **已装过**（任一命中 → 按 §15 文案打印、exit 0、不写任何文件）：
   - `$DATA/daemon.pid` 存在，用 `sed -n 's/.*"pid":\([0-9]*\).*/\1/p'` 取 pid，`kill -0 "$pid"` 成功；
   - `$ROOT/current` 存在，而且 `$ROOT/bin/vonvon --version` 能跑（只有 `current` 是设置那一步没做完，接着装）；
   - `$HOME/.config/systemd/user/vonvon-bot*.service` 有匹配（C7 的名字，带哈希后缀的也算）；
   - `command -v vonvon` 找到的文件里含 `$SERVER_MARKER`。
   文案：§15"安装脚本：已装过"（"……不用再装。直接用：`vonvon --version`"）。原来还查 macOS 的 LaunchAgent 和 `Applications` 里的桌面端、按有没有命令分两种文案，2026-11-01 起脚本只在 Linux 上装，不查了。
2. **工具**：`curl`、`tar`、`mktemp`、`sed`，以及 `sha512sum` 或 `shasum`，以及 `base64` 或 `openssl`；缺一个 → 列出缺的，exit 2。
3. **选包**：`uname -s` 在 `main` 第一步已核过是 `Linux`，`os=linux`；`uname -m` → `x86_64|amd64` → `x64`，`aarch64|arm64` → `arm64`，其他 exit 2。Linux 再查 musl：`ldd --version 2>&1 | head -n 1` 含 `musl`，或 `/lib/ld-musl-*.so.1` 存在 → "这一版不支持 musl（Alpine）"exit 2。`TARGET="$os-$arch"`、`EXT=tar.gz`。
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

0. 先看系统，同 §4.1：不是 Linux → exit 2，什么都不碰；`Darwin` 打印 §15"卸载脚本：在 Mac 上"那句，别的系统打印"卸载脚本：不是 Linux、也不是 Mac"那句。
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
- 环境性拒绝统一成 `CommandError('refused', message, { reason, fallback: 'detached', hint })`，`reason` 三个稳定值：`no_systemd`、`user_instance_down`、`no_runtime_dir`（Linux，来自 `userManagerHint()` 的三种）。原来还有第四个 `no_gui_session`（macOS，launchd GUI 域不可用），2026-11-01 起脚本不在 Mac 上跑，I2a 把它去掉了：launchd 没有图形会话时照旧是普通的 `failed`（exit 1），没有 `fallback`。`--json` 失败形状按 C1：`{ ok: false, error: { kind: 'refused', message, reason, fallback: 'detached', hint }, exitCode: 4 }`。`hint` 是 §15 的那句。
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
| root 拒绝 | `id` 替身 → exit 2，stderr 逐字是 §15"安装脚本：root"那句（2026-11-02 改成 `useradd -m -s /bin/bash vonvon` 加直接 SSH 登录，不再是 `su - vonvon`），没有网络调用（`curl.log` 不存在） | 是 |
| root 放行 | `VONVON_ALLOW_ROOT=1` → 走完，exit 0，stdout 含"以 root 继续" | 是 |
| 已装过：pid 活着 | `home/.vonvon-bot/daemon.pid` 写 `{"pid":<本测试进程 pid>}` → exit 0，"已经装过"，没有 `curl` 调用，安装根不存在 | 是 |
| 已装过：`current` 加能跑的 `bin/vonvon` / systemd unit 文件 / PATH 里有带服务端标记的 `vonvon` | 各 exit 0，文案是 §15"安装脚本：已装过"那句 | 是 |
| 在 macOS 上（2026-11-01） | `uname` 替身 `Darwin`/`arm64`，`install.sh` 和 `uninstall.sh` 各跑一次 → 都 exit 2，stdout 为空，stderr 逐字是 §15"在 Mac 上"那两句；没有 `curl` 调用（`curl.log` 不存在），`home/` 下什么都没写；`home/.local/share/vonvon-bot/server` 事先建好时 `uninstall.sh` 也不删它 | 是 |
| 不是 Linux、也不是 Mac | `uname` 替身 `FreeBSD`、`MINGW64_NT-10.0-19045`、空输出，同时 `id` 替身是 root、`daemon.pid` 的进程活着、脚本没带公钥 → `install.sh`、`uninstall.sh` 都 exit 2，stderr 逐字是 §15"不是 Linux、也不是 Mac"那两句；没有网络调用、没建临时目录、安装根没动 | 是 |
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
| `service-command.test.ts`（扩） | `--linger --json`、`enableLinger` 注入失败 → stdout `ok: true, linger: 'off', lingerUser`、exit 0；文字版 exit 0 且含 `loginctl enable-linger`；`userManagerHint` 三种 → `--json` 的 `error.reason` 分别是 `no_systemd`/`user_instance_down`/`no_runtime_dir`，`fallback: 'detached'`，exit 4；launchd 无 GUI → 照旧 `failed`、没有 `fallback`（I2a 去掉了 `no_gui_session`）；`lingerUser` 含空格 → 字段省略 | 是 |
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
- Mac 测试环境（2026-11-01 改）：`sh install.sh`、`sh uninstall.sh` 都退出非零，打印去 https://vonvon.cc/get/ 下载安装包的那句，HOME 下什么都没写，不碰已装的桌面端。
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
- `service install --linger --json`：linger 没开成 exit 0、带 `lingerUser`；三个 `reason` 稳定、带 `fallback: 'detached'`；脚本对 Linux 的三个 reason 的文案和 §15 一致。
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

## 和计划不一样的地方（I2a）

- `__standalone-setup` 的版本参数叫 `--release`，不叫 `--version`：commander 的程序级 `--version` 写在子命令后面也会被它截走，打印版本就退出。
- §4.3 第 1 步和第 6 步矛盾（版本目录不完整既是 `bad-args` 又是 `release_incomplete`）：不另做预检，交给 `switchCurrent` 判，统一 `failed`、`reason: 'release_incomplete'`，exit 1。
- `D/service/current-release.ts` 是 I3（server-3）同名文件的逐字副本，两边合进集成分支时内容相同、不冲突；以后只留一份由 I3 维护。
- PATH 块：已有的启动文件不可写时不靠 `rename` 绕过权限，记进 `pathNote`；启动文件是符号链接（dotfiles 仓库）时改它指向的文件，链接本身保留。
- `uninstall.sh`：只在 `~/.config/systemd/user/vonvon-bot.service` 在时才跑 `service uninstall`。安装时退回直接启动的环境（没有 systemd、连不上这个账号的 systemd）没有服务定义，`service uninstall` 在那里问不了服务管理器、回 `uninstall_incomplete`，照计划写会永远卸不掉（§6.2 的真包自测里碰到的）。`service uninstall` 没注册时回的是 `ok: true`（`result: 'not-installed'`），所以只要它成功就再跑一次 `daemon stop`（`connection` 当作没在跑）；`bin/vonvon` 坏了时，用 `releases/*/node` 里第一个能跑的版本走完整流程（停服务、停 daemon、去 PATH），不只是 teardown；一个都跑不了、而服务定义还指着安装根时，exit 1，什么都不删。删安装根时多两条：`HOME` 不是 `/`，目标是目录。
- `install.sh` 比计划严：清单 payload 整体对 C1 的形状（键顺序、`files` 里的目标、可选 `notes`）做字面匹配，不只看前缀；包成员用 `tar -tzvf` 只放行普通文件和目录（软链接、硬链接都拒绝），再查路径；OpenSSL 3 及以上都验签名；脚本里公钥是空的时直接 exit 4（真公钥等 owner 按 I5 §4.2 生成后填进 `# BEGIN VONVON PUBKEY` 那一段）。
- 两个脚本都 `unset VONVON_HOME`：数据目录固定是 `~/.vonvon-bot`，和"已装过"的判断对得上；设了的话 `install.sh` 说一句。
- `service install`：root 警告在失败时放进 `partial.notes`；`CommandError` 加了 `fallback`、`hint` 两个字段，JSON 里紧跟 `reason`。
- `README.md` 没加安装命令：脚本还没发到 dl.vonvon.cc，等 I5 上线时一起加。

## 审查后改了什么（I2a）

- F1 接受：`shell-path.ts` 按字节读写启动文件（latin1 一字节对一字符，PATH 块先转成它的 UTF-8 字节），GBK 这类不是 UTF-8 的内容装完再卸载字节不变；加了测试（含非 ASCII 的安装根路径）。桌面端 `cli-registration.ts` 的 utf8 读写是 dev 上原有的，不在这一片改。
- F2 接受：`install.sh` 只有 `current`、`bin/vonvon` 不在或跑不了 `--version` 时不算装过，接着用 `releases/<v>` 重跑 setup；service、直接启动失败的提示写明"再运行安装命令不会重做这一步"和要跑的命令；加了"切了 current 才失败、重跑补完"的测试。
- F3 接受：启动文件是指向不存在文件的符号链接时不写，链接留着，记进 `pathNote`（"符号链接指向的文件不存在"）；卸载时跳过；加了测试。
- F4 接受：`uninstall.sh` 能跑 vonvon 时，先查默认名字以外、还指着 `vonvon-bot/server/current` 的服务定义（别的 `VONVON_HOME` 装的、带哈希后缀），有就 exit 1、什么都不动，提示用它的 `VONVON_HOME` 先 `service uninstall`；和跑不了 vonvon 时的扫描共用一个函数；加了测试。
- F5 接受：两个脚本以 root 运行而 `HOME` 不归当前用户（`[ -O "$HOME" ]` 不成立，sudo 留着原用户 HOME 时）就 exit 2、什么都不写；只对 root 查，普通用户不受影响；加了测试（用不存在的 HOME，测试不需要第二个账号）。
- F6 接受：musl 的判断先看 `ldd --version`（说 musl 就是 musl，说 GLIBC/GNU libc 就是 glibc），再看 `getconf GNU_LIBC_VERSION`，都认不出 glibc 时 `/lib/ld-musl-*.so.1` 才算 musl；加了测试（测试里把加载器路径换到临时目录）。
- 任务 216、217（同一条）接受：`uninstall.sh` 一个能跑的 vonvon 都没有、也没有服务定义时，原来不看直接启动的 daemon 就删安装根。现在先读数据目录 `~/.vonvon-bot/daemon.pid`（pid-lock 写的 `pid`、`bootId`）：进程还活着、`bootId` 和这次开机一样、`/proc/<pid>/exe` 是安装根里的程序 → exit 1，什么都不删，提示"先停掉它：`kill <pid>`，等它退出后再运行一次卸载"；`/proc` 看不出它跑的是什么 → 也不删，提示用 `ps -p <pid> -o args=` 看清是不是服务端，是就 `kill`、不是就删掉 `daemon.pid`。进程号已经归了别的程序（容器重启后进程号常被重用，`/proc` 看得出它不是安装根里的程序）、`bootId` 不同（重启过）、别的账号的进程（`kill -0` 失败）、`daemon.pid` 不在或读不出 pid → 不算在跑，照旧删。脚本不替用户杀进程；数据目录照旧不动。加了测试：安装根里的程序在跑 → exit 1、安装根完好、进程没被动；（Linux）进程号归了测试自己的 Node、`bootId` 不同 → 照删；进程停了 → 照删、`daemon.pid` 还在。
- 任务 216、218（同一条）接受：`/run/user/<uid>` 在、用户实例却连不上（没起来或已经退出，目录还被会话留着）时，`userManagerProblem` 原来回 undefined，`service install --json` 成了普通的 `install_refused`、exit 1、没有 `fallback`，安装脚本不直接启动。现在先看用户实例自己的套接字 `systemd/private` 和 `bus`（`bus` 要 dbus-user-session 才有）：`XDG_RUNTIME_DIR` 不对而套接字在 → `no_runtime_dir`（原来只看 `bus`）；目录在而两个套接字都没有，或者 systemctl 说 `Failed to connect to bus`（systemd 255）/`Failed to connect to user scope bus`（256 起）→ `user_instance_down`，提示"`/run/user/<uid>` 还在，但里面的用户实例连不上……用这个账号重新 SSH 登录后再试；还不行，用管理员权限看 `systemctl status user@<uid>`"。`--json` 和另外几种退路一样：`error.kind: 'refused'`、`reason: 'user_instance_down'`、`fallback: 'detached'`、exit 4，`install.sh` 照旧打印 §15"用户实例不可用"那句并 `daemon start`；用户实例在回话但状态不对（如 `stopping`）照旧 `failed`、没有 `fallback`。`service status` 的提示走同一个函数。加了测试：分类本身，和用真分类函数经 `runServiceCommand` 得到 `install.sh` 用 sed 读的那一段。
- 任务 218 P3 接受：启动文件末尾没有换行时，`spliceBlock` 在块前补的那个换行卸载后留着。块的文本不变（和桌面端逐字相同），文件装着时照旧以换行结尾（之后有人 `echo … >>` 追加也不会并到块的最后一行里）；`__standalone-setup` 把补过换行的文件和补之前的字节数记在安装根的记录里（现在是 `path-block.json` 的 `breaks`，见下一轮），`__standalone-teardown` 只在块还紧跟着那段原文、后面什么都没有时连这个换行一起去掉，块后面有人加过行或者前面那段原文的长度变了就留着换行（只比位置，长度不变的改动照样去掉这个换行，无害）。有、没有末尾换行，空文件、CRLF 的文件，中间再跑一次 setup（升级）都按字节还原；记录写不进去时记进 `pathNote`，卸载后那几个文件末尾多一个换行（原来的行为）。桌面端只加不删，`P/cli-path-block.ts` 没改。文件原来不存在、装时新建的，卸载后留一个空文件，照旧。加了测试。
- 复查这三条修复时的 P3（修复前就有）：`uninstall.sh` 的 `rm -rf` 删到一半被打断（Ctrl-C、SSH 断开）或删不动时，可能留下一个标记（`releases/*/standalone.json`、`current`）已经删掉的安装根，再跑卸载 exit 2"不像是安装脚本装的"，安装脚本说 `releases/<v>` 残缺，只能手动删。接受，没用"先删大头、最后删标记"：`install.sh` 看到 `standalone.json` 就当版本解好了、跳过下载，留下一个只剩标记的版本会让重装一直失败。现在 `remove_install_root` 查完四条后先把安装根 `mv` 成同一目录下的 `server.removing`（rename 是原子的），再 `rm -rf` 它；删不完 exit 1，提示再运行一次会接着删。下一次卸载先删 `server.removing`：安装根不在时删完它就 exit 0（"已删完上次卸载没删完的……"），安装根在时先删它再照常走。`server.removing` 这个名字只有卸载脚本会起，名字就是它的标记（同安装脚本只删自己的 `releases/<v>.part`），它里面的标记可能已经删掉了；它是符号链接或不是目录时 exit 2，在停任何东西之前就查。安装脚本不看它，照常装在 `server`。加了测试：让 `rm` 删不动一个目录（非 root 时），第一次 exit 1、`server` 已不在、`server.removing` 还在，再跑一次删不动照样 exit 1，恢复权限后 exit 0、不调用 vonvon、数据目录还在；只剩没有标记的 `server.removing` 时照常重装，之后一次卸载两个都删掉；`server.removing` 是符号链接或文件时 exit 2、什么都没停也没删。
- 复查这三条修复时的另一条 P3（修复前就有）：`__standalone-teardown` 按卸载时的环境重新算启动文件，安装后才有 `.bash_profile`（rvm、sdkman 这类工具会建）时只看它，`~/.profile` 里的块留着，PATH 里还排着已经删掉的 `<根>/bin`；ZDOTDIR 装时和卸时不同、文件里有两份块（teardown 只删第一份）也一样。接受：setup 把每次写进块的文件记在安装根的 `path-block.json`（`{ files, breaks }`，取代上一轮的 `path-breaks.json`，`breaks` 不变），teardown 看的是记下的文件加上现在所有可能的文件（ZDOTDIR 和家目录下 zsh 的两个、`.bash_profile`、`.bash_login`、`.profile`、`.bashrc`），每个文件里所有和 `startupBlock('<根>/bin')` 逐字相同的块都去掉，在别的块（桌面端的）后面的也去掉，别的块照旧不动。记录读不出来时只看现在所有可能的文件。加了测试：装后才有 `.bash_profile`（有、没有记录）、装时有 ZDOTDIR 卸时没有、装时没有卸时有，块都去掉、`.bash_profile` 不动；一个文件里多份块、在桌面端的块前后，都去掉，桌面端的块留着。
- 复查 246067b7 时的 P3：`uninstall.sh` 看服务端还在不在只读 `~/.vonvon-bot/daemon.pid`，用别的数据目录直接启动的服务端（`VONVON_HOME=<别的> vonvon daemon start`）、`daemon.pid` 读不出来的服务端都看不到：能跑 vonvon 时 `daemon stop --json` 对默认数据目录答 `{"ok":true,"stopped":false}`，没有 vonvon 时 `daemon.pid` 那一查也过了，安装根删了它还在跑，exit 0"已卸载服务端"。脚本原来只拦别的数据目录的服务定义，不拦直接启动的进程。接受：服务停完（能跑 vonvon 时在 `service uninstall`、`daemon stop` 之后、去 PATH 块之前；没有 vonvon 时在服务定义和 `daemon.pid` 两查之后）、删任何东西之前，扫一遍 `/proc/[0-9]*/exe`：`readlink` 得到的路径去掉末尾的" (deleted)"，在安装根里（按 `$HOME` 拼的路径和 `pwd -P` 的真实路径各比一次）就 exit 1，安装根、PATH 块都不动，提示"还有程序在用安装目录里的文件运行（进程 <pid…>），可能是用别的数据目录启动的服务端，安装目录没删。先停掉它们：`kill <pid…>`，等它们退出后再运行一次卸载。"启动器 exec 的是 `<根>/current/node/bin/node`，真的服务端的程序一定在安装根里。别的账号读不到的进程、脚本自己不算；`/proc` 用不了（`readlink /proc/$$/exe` 失败）时不扫，照原来的做法。`daemon.pid` 那一查留着（常见情形提示更准）；它因 `bootId` 不同放过的、还跑着安装根里程序的进程，现在由这一扫拦下。脚本照旧不替用户杀进程。加了测试（Linux）：别的数据目录、detach 启动的安装根里的程序，能跑 vonvon 时 exit 1、安装根完好、进程没被动、没去 PATH 块，停了以后照删、数据目录还在；没有能跑的 vonvon、`daemon.pid` 是坏的；程序文件已经删了（" (deleted)"）；`HOME` 经符号链接（靠 `pwd -P` 认出）。四条在 246067b7 上都失败。
- 任务 223 P2 接受：上一条的 `/proc` 扫描把 `readlink /proc/<pid>/exe` 失败一律当成别的账号的进程跳过；这个账号的进程设了不可转储（`PR_SET_DUMPABLE 0`）时 exe 也读不出来，它若跑的是安装根里的程序、用的是别的数据目录、默认 `daemon.pid` 又不指着它，卸载 exit 0 删掉安装根，它还在跑。没有改成"这个账号读不出来的一律不删"：ssh-agent、gpg-agent 这类常故意设成不可转储，那样大多数人都卸不掉。现在逐个进程看：exe 读得到的照旧比路径；读不到的，`/proc/<pid>/status` 的 `Uid` 实际和有效 UID 都不是这个账号 → 不算；是这个账号的，看还读得到的命令行（`/proc/<pid>/cmdline`，NUL 隔开，用 `tr '\0' '\n'` 拆开）和工作目录（读得到时），有一项是安装根或在安装根里（按 `$HOME` 拼的路径和 `pwd -P` 的真实路径各比一次）才算在跑，提示和上一条相同；读的时候进程已经退出的不算。启动器 exec 的是 `<根>/current/node/bin/node <根>/current/app/bin/vonvon.mjs`，服务端的命令行一定带安装根。仍是 POSIX sh，`dash -n` 通过。加了测试（Linux，要 python3，`prctl` 设不了时跳过）：把真实的 python3 拷进安装根，起它并用 ctypes 调 `prctl(PR_SET_DUMPABLE, 0)`（非 root 时先确认读它的 exe 得到 EACCES），没有能跑的 vonvon、没有服务定义、没有 `daemon.pid` → exit 1、安装根完好、进程没被动，`HOME` 经符号链接也一样，停了以后照删；同样不可转储、但从安装根外起的 python3 → 能跑和不能跑 vonvon 两种都照删、进程没被动。前一条在 8d811380 上失败（exit 0），后一条在 8d811380 上本来就过，防的是改过头。
- 任务 223 P3 接受：PATH 块的文本里是 setup 拿到的 `--install-root` 下的 `bin`，也就是当时 `$HOME` 的写法；装时 `HOME` 是真实路径、卸时经符号链接（或者反过来），teardown 用 `join(installRoot, 'bin')` 算出的块文本不同，`path-block.json` 找到了文件，块却留着。现在 setup 把写进块的 `bin` 路径也记进 `path-block.json`（`bins`，每次 setup 写进了文件就补上没记过的），teardown 去掉的块是这几个 `bin` 之一的 `startupBlock` 逐字相同的块：记下的每一个、现在的 `join(installRoot, 'bin')`、安装根真实路径下的 `bin`（取 `realpath(installRoot)` 再拼 `bin`，不跟 `bin` 自己的符号链接走，免得指到别的目录，比如桌面端的）；桌面端的块和用户自己的内容照旧不动。同一个启动文件经两种写法出现两次（链接下的 `~/.bashrc` 和记录里真实路径的那个）时按真实路径只处理一次，`breaks` 也按真实路径找，块前补的换行照样去掉。旧记录没有 `bins` 时只用后两个，装时经链接、卸时用真实路径的那种去不掉（和原来一样）。加了测试：真实 `HOME` 装、链接 `HOME` 卸，链接 `HOME` 装、真实 `HOME` 卸，启动文件按字节还原、桌面端的块不动；记录删掉时真实 `HOME` 装、链接 `HOME` 卸也去掉块（`.bashrc` 末尾多一个换行，同记录写不进去时）。在 8d811380 上失败（块留着）。
- 复查 c678aa41 时的 P3，部分接受：上一条 P2 的修复只认写成 `$ROOT` 或它 `pwd -P` 真实路径的绝对参数；工作目录那一支对不可转储的进程永远走不到（`/proc/<pid>/cwd` 和 exe 过同一道 ptrace 检查，测试里非 root 时读它得到 EACCES；这台机器上 `systemd --user` 也是这样）。经符号链接起的（链接指着安装根，或者指着安装根里的程序）和用相对路径起的，卸载 exit 0、删掉安装根，进程还在跑。现在去掉工作目录那一支，逐个看命令行参数：绝对路径照旧按 `$ROOT` 和真实路径比，再用 `readlink -f` 解开符号链接按真实路径比一次；相对路径不知道从哪个目录算起，只认写着安装目录名（以 `vonvon-bot/server` 结尾或带 `vonvon-bot/server/`）的，比如从 `HOME` 起的 `.local/share/vonvon-bot/server/…`。没有照建议把"带斜杠的相对路径"都当成在跑：ssh 登录会话的进程是这个账号的、不可转储，命令行是 `sshd: <用户>@pts/0`，带斜杠，这样从 ssh 登录的人都卸不掉；在临时副本里按这条改，下面"安装根外"那条测试就失败（exit 1）。所以从安装根里的目录用 `./python3` 这类相对路径手动起的不可转储进程仍拦不下，脚本注释写明了；启动器和服务 exec 的都是安装根下的绝对路径，服务端不受影响。加了测试：安装根里的 python3 不可转储，经指着安装根的目录链接、经指着它的文件链接、从 `HOME` 用相对路径起，三种都 exit 1、安装根完好、进程没被动（非 root 时先确认读它的 cwd 得到 EACCES），停了以后照删；"安装根外"那条测试的第二轮用 `argv0` 设成 `sshd: me@pts/0`，照删。前一条在 c678aa41 上失败（exit 0）。

## 只支持 Linux（I2a，owner 2026-11-01）

按开头"2026-11-01 改动"收窄，代码实际这样做：

- `install.sh`、`uninstall.sh` 只用于 Linux。`main` 的第一步看 `uname -s`：不是 `Linux` 就 exit 2，先于 root、`HOME`、已装过和公钥的检查，不建临时目录、不写文件、不连网。`Darwin` 打印 `devices.md` §15"在 Mac 上"那句（指向 https://vonvon.cc/get/ 的桌面端安装包），别的系统（FreeBSD、Windows 的 Git Bash 这类）打印"不是 Linux、也不是 Mac"那句，带上 `uname -s` 的结果。四句和 §15 逐字一样，`install.test.mjs` 按全文核对。
- 删掉的 macOS 分支：已装过里的 LaunchAgent 和两个 `Applications` 目录、桌面端命令的标记（`Vonvon Bot managed CLI v1`，Linux 没有桌面端）、Rosetta 判断、`darwin-*` 目标、`no_gui_session` 退路和 Mac 的"保持登录"完成文案；卸载时只看 systemd 的服务定义。Linux 的部分都留着：root 和 `HOME` 检查、musl 判断、linger、已装过的四种命中（这个数据目录上在跑的 daemon、`current` 加能跑的 `bin/vonvon`、`vonvon-bot*.service`、PATH 里带服务端标记的 `vonvon`），已装过的文案统一成 §15"安装脚本：已装过"那句。
- 清单的字面校验跟着改：`files` 只有 `linux-x64`、`linux-arm64` 两项，按这个顺序，多一项、少一项都 exit 4。服务端升级清单（server-3 C1）也只列这两项：I3 的 `SERVER_TARGETS`（连同 `fake-cdn` 和它的测试）要改成同样两项，在 I5 产出第一份清单之前两边必须一致（`devices.md` 第 13 节 I3、I6 行）。
- `scripts/build-server.mjs`（I1）：新导出 `PUBLISHED_TARGETS = ['linux-x64', 'linux-arm64']`，不带 `--targets` 时只打这两个包，发布也只发这两个。`TARGETS` 里的 macOS、Windows 目标暂时还能用 `--targets` 点名打包；Windows 的 `.zip`、260 字符路径预算、`current.txt`、`unpackZip` 这些独立服务端在 Windows、macOS 上的代码已经用不上，等 I3 合入后由一次清理统一删掉，不算功能。
- daemon：`service install` 不再把 launchd 没有图形会话说成带 `fallback: 'detached'` 的 `no_gui_session`，回到原来的 `failed`（exit 1）；三种 Linux 的 `reason` 照旧。`__standalone-setup` 在 Linux 以外回 `failed`、`reason: 'unsupported_platform'`，提示去下载安装包，什么都不切、不写；`__standalone-teardown` 去掉了 Windows 特判（它只删指向这个安装根的 PATH 块，在哪儿跑都无害）。`current-release.ts` 是 I3 那份的副本，`current.txt` 那段不在这里删。
- 留着的：PATH 块搬到 `@vonvon/protocol` 的 `cli-path-block.ts`、桌面端 `cli-registration.ts` 改用它。这不是为 Mac 上脚本装的服务端和桌面端共存才做的：daemon 不能 import desktop，Linux 的 `__standalone-setup` 要用同一段文本，放在 protocol 里只有一份。
- 退出规则（`docs/product.md` 3.10"桌面端的关闭与退出"和 3.14：桌面端自带的或没注册成后台服务的停，安装脚本装的不停）：Mac、Windows 上已经没有脚本装的服务端，3.10、3.14 的改写交给文档那一片，本片不碰桌面端的退出代码；本片把自己在 3.10 加的 Windows 签名那句和卸载那句的改动退回集成分支的原文，只留 3.3 里 Linux 安装布局那一条。
