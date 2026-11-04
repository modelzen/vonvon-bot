#!/bin/sh
# 官网复制这段完整命令（内嵌在 sh 的 here-document 中），不再先从单个源下载引导脚本。
# 只下载完整 install.sh；TLS 验证、脚本末行和语法通过后才执行，不把网络流直接交给 sh。
set -eu

bootstrap() {
  domestic='https://dl.vonvon.cc/bot/server'
  global='https://vonvon-linux-download.amber2clay.workers.dev/bot/server'
  for tool in curl mktemp mkdir mv rm tail sh sleep cat; do
    command -v "$tool" >/dev/null 2>&1 || { printf '缺少命令：%s\n' "$tool" >&2; exit 2; }
  done
  work=$(mktemp -d) || exit 2
  pids=''
  installer_pid=''
  stop_downloads() {
    for pid in $pids; do kill "$pid" 2>/dev/null || true; done
    for pid in $pids; do wait "$pid" 2>/dev/null || true; done
    pids=''
  }
  cleanup_bootstrap() {
    stop_downloads
    if [ -n "$installer_pid" ]; then
      kill "$installer_pid" 2>/dev/null || true
      wait "$installer_pid" 2>/dev/null || true
    fi
    rm -rf -- "${work:?}"
  }
  trap 'cleanup_bootstrap' EXIT
  trap 'exit 130' HUP INT TERM
  fetch_script() {
    directory=$2
    curl_pid=''
    trap 'if [ -n "$curl_pid" ]; then kill "$curl_pid" 2>/dev/null || true; wait "$curl_pid" 2>/dev/null || true; fi; : >"$directory/done"' EXIT
    trap 'exit 130' HUP INT TERM
    curl --proto '=https' --tlsv1.2 -fsS --connect-timeout 5 --max-time 8 --max-filesize 131072 --write-out '%{http_code}' -o "$directory/install.part" "$1/install.sh" </dev/null >"$directory/http-status" &
    curl_pid=$!
    wait "$curl_pid" || exit 3
    curl_pid=''
    [ "$(cat "$directory/http-status")" = 200 ] || exit 3
    [ "$(tail -n 1 "$directory/install.part")" = 'main "$@"' ] || exit 4
    sh -n "$directory/install.part" </dev/null || exit 4
    mv "$directory/install.part" "$directory/install.sh"
  }
  mkdir "$work/domestic" "$work/global"
  printf '%s\n' '正在获取安装脚本…'
  fetch_script "$domestic" "$work/domestic" 2>"$work/domestic/error" &
  pids=$!
  fetch_script "$global" "$work/global" 2>"$work/global/error" &
  pids="$pids $!"
  grace=0
  selected=''
  while :; do
    if [ -f "$work/domestic/install.sh" ]; then selected=domestic; break; fi
    if [ -f "$work/global/install.sh" ]; then
      if [ -f "$work/domestic/done" ] || [ "$grace" -ge 3 ]; then selected=global; break; fi
      grace=$((grace + 1))
    fi
    if [ -f "$work/domestic/done" ] && [ -f "$work/global/done" ]; then break; fi
    sleep 0.1
  done
  stop_downloads
  if [ -z "$selected" ]; then
    printf '%s\n' '国内和海外下载源都未返回完整安装脚本，请检查网络后重试。' >&2
    exit 3
  fi
  sh "$work/$selected/install.sh" "$@" </dev/null &
  installer_pid=$!
  if wait "$installer_pid"; then installed=0; else installed=$?; fi
  installer_pid=''
  return "$installed"
}

bootstrap "$@"
