#!/bin/sh
# Vonvon Bot 服务端的卸载脚本，只用于 Linux，docs/plans/server-2-install-scripts.md 4.2：
#   sh -c "$(curl -fsSL https://dl.vonvon.cc/bot/server/uninstall.sh)"
# 停后台服务、删服务定义、去掉启动文件里的 PATH 那几行、删安装根 ~/.local/share/vonvon-bot/server。
# 数据目录 ~/.vonvon-bot（Bot、记忆、设置）留着。
# 退出码：0 卸好了或没装过；1 后台服务没停下来，什么文件都没删；2 不是 Linux、HOME 或安装根不对，什么都没删。
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

remove_install_root() {
  checked_install_root
  rm -rf -- "$target"
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
        fail 1 "后台服务没卸掉（退出码 $code），安装目录没动。"
        ;;
    esac
  fi
  # 没注册成服务、直接启动的那个 daemon（安装时的退路）也要停
  output=$(vv daemon stop --json 2>"$TMP/stop.err") && code=0 || code=$?
  case "$output" in
    '{"ok":true'*|*'"kind":"connection"'*) ;;
    *)
      show_output "$output" "$TMP/stop.err"
      fail 1 "服务端没停下来（退出码 $code），安装目录没动。"
      ;;
  esac
}

remove_path_block() {
  output=$(vv __standalone-teardown --install-root "$ROOT" --json 2>"$TMP/teardown.err") && code=0 || code=$?
  case "$output" in
    '{"ok":true'*) ;;
    *) say "没能从启动文件里去掉 PATH（退出码 $code）。$PATH_BY_HAND" ;;
  esac
}

no_cli() {
  if defined_for_root all; then
    fail 1 "安装目录里没有能运行的 vonvon，后台服务 $DEFINED 还在，什么都没删。先停掉并删掉这个服务，再运行一次卸载。"
  fi
  say "安装目录里没有能运行的 vonvon。$PATH_BY_HAND"
}

main() {
  system=$(uname -s 2>/dev/null || true)
  case "$system" in
    Linux) ;;
    Darwin) fail 2 "这个脚本只卸载 Linux 上的服务端。Mac 上的 Vonvon Bot 是桌面端安装包装的，说明见 https://bot.vonvon.cc" ;;
    *) fail 2 "这个脚本只卸载 Linux 上的服务端（这台是 ${system:-认不出的系统}），什么都没动。" ;;
  esac
  checked_home
  ROOT="$HOME/.local/share/vonvon-bot/server"
  if [ "$(id -u 2>/dev/null || true)" = 0 ]; then
    # sudo 常留着原来用户的 HOME：那是别人的服务端
    if [ ! -O "$HOME" ]; then fail 2 "HOME（$HOME）不是 root 的，什么都没删。卸载哪个用户的服务端，就用那个用户自己运行，不要 sudo。"; fi
    say "你正在用 root 运行：卸载的是 root 这个账号下的服务端（$ROOT）。"
  fi
  if [ ! -e "$ROOT" ] && [ ! -L "$ROOT" ]; then
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
    remove_path_block
  else
    no_cli
  fi
  remove_install_root
  say "已卸载服务端。数据目录 \`~/.vonvon-bot\`（Bot、记忆、设置）保留着；不要了就自己删。"
}

main "$@"
