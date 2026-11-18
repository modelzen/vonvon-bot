#!/bin/sh
# Vonvon Bot 服务端的卸载脚本，只用于 Linux，docs/plans/server-2-install-scripts.md 4.2：
#   sh -c "$(curl -fsSL https://dl.vonvon.cc/bot/server/uninstall.sh)"
# 停后台服务、删服务定义、去掉启动文件里的 PATH 那几行、删安装根 ~/.local/share/vonvon-bot/server。
# 数据目录 ~/.vonvon-bot（Bot、记忆、设置）留着。
# 退出码：0 卸好了或没装过；1 后台服务或直接启动的服务端没停下来（或确认不了它停了），什么文件都没删，或者还有进程在跑
# 安装根里的程序，安装根和 PATH 块都没动，或者安装根没删完（再运行一次会接着删）；2 不是 Linux、HOME 或安装根不对，什么都没删。
# Mac、Windows 的服务端在桌面端安装包里，不由脚本装（owner 2026-11-01）：不是 Linux 就什么都不做。
set -eu

PATH_BY_HAND="请手动删掉 ~/.zshrc、~/.bashrc 等文件里从 \`# >>> Vonvon Bot CLI >>>\` 到 \`# <<< Vonvon Bot CLI <<<\` 的那几行。"

say() { printf '%s\n' "$*"; }

fail() {
  code=$1
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

show_output() {
  if [ -n "$1" ]; then printf '%s\n' "$1" >&2; fi
  if [ -s "$2" ]; then cat "$2" >&2; fi
}

checked_home() {
  case "${HOME:-}" in
    /*) ;;
    *) fail 2 "HOME 没有设置或不是绝对路径，不知道服务端装在哪里，什么都没删。" ;;
  esac
  if [ -z "$(printf '%s' "$HOME" | sed 's#/*$##')" ]; then fail 2 "HOME 是 /，什么都没删。"; fi
}

# 删安装根的四条（SCRIPT-1），缺一条就不删：HOME 不空也不是 /；目标是 HOME 下字面拼出来的那个路径；
# 不是符号链接；里面有服务端的标记。
checked_install_root() {
  checked_home
  : "${HOME:?}"
  target="$HOME/.local/share/vonvon-bot/server"
  if [ -L "$target" ]; then fail 2 "$target 是符号链接，什么都没删。"; fi
  if [ ! -d "$target" ]; then fail 2 "$target 不是目录，什么都没删。"; fi
  for marker in "$target"/releases/*/standalone.json; do
    if [ -f "$marker" ]; then return 0; fi
  done
  if [ -e "$target/current" ] || [ -L "$target/current" ]; then return 0; fi
  fail 2 "$target 里没有服务端的标记（releases/*/standalone.json 或 current），不像是安装脚本装的，什么都没删。"
}

# 删到一半被打断（Ctrl-C、SSH 断开）或删不动时留下的安装根。这个名字只有本脚本会起，改名之前它是查过上面四条的
# 安装根，所以名字就是它的标记（和安装脚本只删自己建的 releases/<版本>.part 一样）：里面的标记可能已经删掉了。
# 不是符号链接、是目录才删。
checked_leftover() {
  checked_home
  : "${HOME:?}"
  left="$HOME/.local/share/vonvon-bot/server.removing"
  if [ -L "$left" ]; then fail 2 "$left 是符号链接，不是卸载脚本留下的，什么都没删。"; fi
  if [ -e "$left" ] && [ ! -d "$left" ]; then fail 2 "$left 不是目录，不是卸载脚本留下的，什么都没删。"; fi
}

remove_leftover() {
  checked_leftover
  if [ -d "$left" ]; then
    rm -rf -- "$left" || fail 1 "上次卸载没删完的 $left 还是没删完。看一下上面 rm 说的原因，解决后再运行一次卸载。"
  fi
}

# 先把安装根改名成同一目录下的 server.removing（rename 是原子的），再删它：删到一半被打断，留下的是 server.removing，
# 再运行一次卸载会接着删；不会留下一个标记已经删掉、卸载认不出的安装根，安装脚本也不会把删了一半的版本当成解好的。
remove_install_root() {
  checked_install_root
  remove_leftover
  mv -- "$target" "$left" || fail 1 "安装目录 $target 没能改名，没删。看一下上面 mv 说的原因，解决后再运行一次卸载。"
  rm -rf -- "$left" || fail 1 "安装目录已经改名成 ${left}，但没删完。看一下上面 rm 说的原因，解决后再运行一次卸载，会接着删。"
}

# 能运行的 vonvon：先用 bin/vonvon；它坏了，就用 releases 里某个版本自带的 node 跑那个版本。
pick_cli() {
  CLI_NODE=''
  CLI_ENTRY=''
  if [ -x "$ROOT/bin/vonvon" ] && "$ROOT/bin/vonvon" --version </dev/null >/dev/null 2>&1; then return 0; fi
  for node in "$ROOT"/releases/*/node/bin/node; do
    release=${node%/node/bin/node}
    case "$release" in *.part) continue ;; esac
    if [ -x "$node" ] && "$node" "$release/app/bin/vonvon.mjs" --version </dev/null >/dev/null 2>&1; then
      CLI_NODE=$node
      CLI_ENTRY="$release/app/bin/vonvon.mjs"
      return 0
    fi
  done
  return 1
}

vv() {
  if [ -n "$CLI_NODE" ]; then "$CLI_NODE" "$CLI_ENTRY" "$@" </dev/null; else "$ROOT/bin/vonvon" "$@" </dev/null; fi
}

# 数据目录是 ~/.vonvon-bot 时服务定义的位置（D/service/identity.ts 的 serviceTarget）
service_defined() {
  [ -e "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/vonvon-bot.service" ] || [ -L "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/vonvon-bot.service" ]
}

# 还指着安装根的服务定义，找到就记进 DEFINED、返回 0；数据目录不是默认的那份时名字带哈希后缀。
# $1 是 others 时不看默认名字的那份：它由 service uninstall 卸掉。
defined_for_root() {
  for definition in "${XDG_CONFIG_HOME:-$HOME/.config}"/systemd/user/vonvon-bot*.service; do
    case "$1:${definition##*/}" in others:vonvon-bot.service) continue ;; esac
    if [ -f "$definition" ] && grep -qF 'vonvon-bot/server/current' "$definition" 2>/dev/null; then
      DEFINED=$definition
      return 0
    fi
  done
  return 1
}

# 服务定义还在时不删文件：删了代码，服务管理器会一直拉起不存在的 current。
# 没有服务定义（安装时退回了直接启动：容器里没有 systemd、连不上这个账号的 systemd）就不问服务管理器，它在这些环境里答不上来。
stop_service() {
  if service_defined; then
    output=$(vv service uninstall --json 2>"$TMP/service.err") && code=0 || code=$?
    case "$output" in
      '{"ok":true'*) ;;
      *)
        show_output "$output" "$TMP/service.err"
        fail 1 "后台服务没卸掉（退出码 ${code}），安装目录没动。"
        ;;
    esac
  fi
  # 没注册成服务、直接启动的那个 daemon（安装时的退路）也要停
  output=$(vv daemon stop --json 2>"$TMP/stop.err") && code=0 || code=$?
  case "$output" in
    '{"ok":true'*|*'"kind":"connection"'*) ;;
    *)
      show_output "$output" "$TMP/stop.err"
      fail 1 "服务端没停下来（退出码 ${code}），安装目录没动。"
      ;;
  esac
}

remove_path_block() {
  output=$(vv __standalone-teardown --install-root "$ROOT" --json 2>"$TMP/teardown.err") && code=0 || code=$?
  case "$output" in
    '{"ok":true'*) ;;
    *) say "没能从启动文件里去掉 PATH（退出码 ${code}）。$PATH_BY_HAND" ;;
  esac
}

# 没有能运行的 vonvon 时自己看数据目录的 daemon.pid（D/server/pid-lock.ts 写的 pid、bootId）：安装时退回直接启动的
# daemon 没有服务定义，安装目录删了它也还在跑。记下的进程还活着就返回 0，PID 是它；/proc 里看得出它跑的是安装目录里的
# 程序时 FROM_ROOT=yes，看不出时 FROM_ROOT=no（当它还在跑，不猜）。进程号已经归了别的程序的不算：重启过（bootId 不同），
# 或者 /proc 里看得出它跑的不是安装目录里的程序（容器重启后进程号又从小数起，常被重用）。
daemon_alive() {
  pidfile="$HOME/.vonvon-bot/daemon.pid"
  [ -f "$pidfile" ] || return 1
  PID=$(LC_ALL=C sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$pidfile" 2>/dev/null | head -n 1)
  [ -n "$PID" ] || return 1
  # 别的账号的进程 kill -0 也失败：服务端跟着这个账号跑，那不是它
  kill -0 "$PID" 2>/dev/null || return 1
  boot=$(LC_ALL=C sed -n 's/.*"bootId":"\([0-9a-f-]*\)".*/\1/p' "$pidfile" 2>/dev/null | head -n 1)
  booted=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)
  if [ -n "$boot" ] && [ -n "$booted" ] && [ "$boot" != "$booted" ]; then return 1; fi
  FROM_ROOT=no
  program=$(readlink "/proc/$PID/exe" 2>/dev/null) || return 0
  real=$(CDPATH= cd -- "$ROOT" 2>/dev/null && pwd -P) || return 0
  case "$program" in
    "$ROOT"/*|"$real"/*) FROM_ROOT=yes ;;
    *) return 1 ;;
  esac
  return 0
}

no_cli() {
  if defined_for_root all; then
    fail 1 "安装目录里没有能运行的 vonvon，后台服务 $DEFINED 还在，什么都没删。先停掉并删掉这个服务，再运行一次卸载。"
  fi
  if daemon_alive; then
    if [ "$FROM_ROOT" = yes ]; then
      fail 1 "安装目录里没有能运行的 vonvon，服务端还在运行（进程 ${PID}），什么都没删。先停掉它：\`kill $PID\`，等它退出后再运行一次卸载。"
    fi
    fail 1 "安装目录里没有能运行的 vonvon，数据目录里记的服务端进程 $PID 还在，看不出它是不是服务端，什么都没删。用 \`ps -p $PID -o args=\` 看一下：是 vonvon 的服务端就先停掉它（\`kill $PID\`），不是就删掉 \`~/.vonvon-bot/daemon.pid\`；再运行一次卸载。"
  fi
  nothing_runs_from_root
  say "安装目录里没有能运行的 vonvon。$PATH_BY_HAND"
}

# 上面只看得到 ~/.vonvon-bot 的服务端：用别的数据目录直接启动的（VONVON_HOME=… vonvon daemon start），daemon.pid
# 读不出来的，`daemon stop` 答"没在跑"，没有 vonvon 时也看不到，删了安装目录它们还在跑。服务停完、去 PATH 块和删安装目录
# 之前，看一遍 /proc：有进程跑的是安装目录里的程序就不删（启动器 exec 的是 <根>/current/node/bin/node，服务端一定是）。
# 程序文件已经删了的，readlink 在路径后面加" (deleted)"；本脚本自己不算。/proc 用不了时不看，照原来的做法。
nothing_runs_from_root() {
  readlink "/proc/$$/exe" >/dev/null 2>&1 || return 0
  root_real=$(CDPATH= cd -- "$ROOT" 2>/dev/null && pwd -P) || root_real=$ROOT
  me=$(id -u 2>/dev/null) || me=''
  running=''
  for proc in /proc/[0-9]*; do
    if [ "${proc#/proc/}" = "$$" ]; then continue; fi
    if exe=$(readlink "$proc/exe" 2>/dev/null); then
      exe=${exe% (deleted)}
      case "$exe" in
        "$ROOT"/*|"$root_real"/*) running="${running:+$running }${proc#/proc/}" ;;
      esac
    elif runs_from_root_unreadable "$proc"; then
      running="${running:+$running }${proc#/proc/}"
    fi
  done
  if [ -n "$running" ]; then
    fail 1 "还有程序在用安装目录里的文件运行（进程 ${running}），可能是用别的数据目录启动的服务端，安装目录没删。先停掉它们：\`kill $running\`，等它们退出后再运行一次卸载。"
  fi
}

# exe 读不出来的进程：别的账号的（status 里的 Uid，实际和有效的都不是这个账号）不算。这个账号的读不出来，是它不可转储
# （PR_SET_DUMPABLE 0：ssh-agent、gpg-agent 自己设，systemd --user、ssh 登录会话这类换过账号起来的也是），工作目录、内存
# 映射和 exe 一样读不出来，读得到的只有命令行（argv 用 NUL 隔开）。不能当成别的账号的放过，也不能一概不删（那样大多数人
# 都卸不掉）：有一项参数指着安装目录才算。绝对路径按 $ROOT 和 pwd -P 的真实路径比，再用 readlink -f 解开符号链接比一次；
# 相对路径不知道从哪个目录算起（工作目录读不到），只认写着安装目录名（vonvon-bot/server）的。别的相对路径不拦：ssh 登录
# 会话的命令行是"sshd: <用户>@pts/0"，带斜杠，按"带斜杠的相对路径"拦，从 ssh 登录的人就都卸不掉了。读的时候进程已经退出了
# 的，不算。启动器和服务 exec 的都是安装目录下的绝对路径，服务端一定拦得下。
runs_from_root_unreadable() {
  uids=$(LC_ALL=C sed -n 's/^Uid:[[:space:]]*\([0-9][0-9]*\)[[:space:]][[:space:]]*\([0-9][0-9]*\).*/\1 \2/p' "$1/status" 2>/dev/null) || return 1
  case " $uids " in *" $me "*) ;; *) return 1 ;; esac
  args=$(tr '\0' '\n' 2>/dev/null <"$1/cmdline") || return 1
  while IFS= read -r arg; do
    case "$arg" in
      "$ROOT"|"$ROOT"/*|"$root_real"|"$root_real"/*) return 0 ;;
      /*)
        arg=$(readlink -f "$arg" 2>/dev/null) || continue
        case "$arg" in "$root_real"|"$root_real"/*) return 0 ;; esac
        ;;
      *vonvon-bot/server|*vonvon-bot/server/*) return 0 ;;
    esac
  done <<EOF
$args
EOF
  return 1
}

main() {
  system=$(uname -s 2>/dev/null || true)
  case "$system" in
    Linux) ;;
    Darwin) fail 2 "这个脚本只卸载 Linux 上的服务端。Mac 上的 Vonvon Bot 是桌面端安装包装的，说明见 https://vonvon.bot/get/" ;;
    *) fail 2 "这个脚本只卸载 Linux 上的服务端（这台是 ${system:-认不出的系统}），什么都没动。" ;;
  esac
  checked_home
  ROOT="$HOME/.local/share/vonvon-bot/server"
  if [ "$(id -u 2>/dev/null || true)" = 0 ]; then
    # sudo 常留着原来用户的 HOME：那是别人的服务端
    if [ ! -O "$HOME" ]; then fail 2 "HOME（${HOME}）不是 root 的，什么都没删。卸载哪个用户的服务端，就用那个用户自己运行，不要 sudo。"; fi
    say "你正在用 root 运行：卸载的是 root 这个账号下的服务端（${ROOT}）。"
  fi
  checked_leftover
  if [ ! -e "$ROOT" ] && [ ! -L "$ROOT" ]; then
    # 改名之前服务已经停了，留下的只有文件
    if [ -d "$left" ]; then
      remove_leftover
      say "已删完上次卸载没删完的 ${left}。数据目录 \`~/.vonvon-bot\`（Bot、记忆、设置）保留着；不要了就自己删。"
      exit 0
    fi
    say "没有装过服务端（$ROOT 不存在）。"
    exit 0
  fi
  # 先确认能删，再停服务：删不了就什么都不动
  checked_install_root
  unset VONVON_HOME
  TMP=$(mktemp -d) || fail 2 "建不了临时目录。"
  trap 'rm -rf -- "${TMP:?}"' EXIT
  trap 'exit 130' HUP INT TERM
  if pick_cli; then
    # 用别的数据目录装的服务（VONVON_HOME=… vonvon service install）这里卸不掉：先停下，什么都不动
    if defined_for_root others; then
      fail 1 "后台服务 $DEFINED 还指着安装目录，什么都没删。先用它的数据目录卸掉它：\`VONVON_HOME=<这个文件里 VONVON_HOME 的值> vonvon service uninstall\`，再运行一次卸载。"
    fi
    stop_service
    nothing_runs_from_root
    remove_path_block
  else
    no_cli
  fi
  remove_install_root
  say "已卸载服务端。数据目录 \`~/.vonvon-bot\`（Bot、记忆、设置）保留着；不要了就自己删。"
}

main "$@"
