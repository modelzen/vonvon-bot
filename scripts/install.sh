#!/bin/sh
# Vonvon Bot 服务端的安装脚本，只用于 Linux（glibc），docs/plans/server-2-install-scripts.md 4.1：
#   scripts/install-bootstrap.sh 的完整命令并行取得本脚本，再运行完整文件。
# 装到 ~/.local/share/vonvon-bot/server，数据目录是 ~/.vonvon-bot。已经装过服务端就什么都不动。
# Mac、Windows 用桌面端安装包（里面带着服务端）：不是 Linux 就什么都不做、退出 2（owner 2026-11-01）。
# 用 root 运行也照装，不另外提示，和 Paseo、Orca 一样（owner 2026-11-03）。
# 退出码：0 装好了或已经装过；1 设置命令或后台服务失败；2 环境不支持；3 下载失败；4 校验没通过。
# 整个脚本只定义函数，最后一行才调用 main：下载中途断了，sh 读到半截脚本什么也不做。不读标准输入。
set -eu

BASE_URL="https://dl.vonvon.cc/bot/server"
GLOBAL_BASE_URL="https://vonvon-linux-download.amber2clay.workers.dev/bot/server"
GUIDE_URL="https://vonvon.cc/docs/remote/"
DESKTOP_DOWNLOAD="https://vonvon.cc/get/"
SERVER_MARKER="# Vonvon Bot server CLI v1"
# 服务端发布清单的签名公钥（server-3 C2，SPKI PEM），和 packages/daemon/server-update.json 是同一把。
# 发布前换成真的那把（server-5 4.2）；空着时脚本不安装。
# BEGIN VONVON PUBKEY
PUBKEY_PEM='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5ndbqSZ5/Y1yJ6oJ4lRM+oRxogGPlfBJko76kIK7GoU=
-----END PUBLIC KEY-----'
# END VONVON PUBKEY

say() { printf '%s\n' "$*"; }

# 失败：一行中文原因，然后按退出码退出。
fail() {
  code=$1
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

# 一条命令的输出和错误输出，原样转给用户。
show_output() {
  if [ -n "$1" ]; then printf '%s\n' "$1" >&2; fi
  if [ -s "$2" ]; then cat "$2" >&2; fi
}

# 小文件限制总时长；大文件只限制连接和无数据的时间，慢但持续下载可以一直进行。
download() {
  curl --proto '=https' --tlsv1.2 -fS --progress-bar --connect-timeout 5 --speed-limit 1 --speed-time 15 --max-filesize "$3" --write-out '%{http_code}' -o "$2" "$1" </dev/null >"$2.http" &
  ACTIVE_DOWNLOAD_PID=$!
  if wait "$ACTIVE_DOWNLOAD_PID"; then download_status=0; else download_status=$?; fi
  ACTIVE_DOWNLOAD_PID=''
  if [ "$download_status" = 0 ] && [ "$(cat "$2.http")" != 200 ]; then download_status=22; fi
  return "$download_status"
}

stop_probes() {
  for probe_pid in ${PROBE_PIDS:-}; do kill "$probe_pid" 2>/dev/null || true; done
  for probe_pid in ${PROBE_PIDS:-}; do wait "$probe_pid" 2>/dev/null || true; done
  PROBE_PIDS=''
}

cleanup_downloads() {
  stop_probes
  if [ -n "${ACTIVE_DOWNLOAD_PID:-}" ]; then
    kill "$ACTIVE_DOWNLOAD_PID" 2>/dev/null || true
    wait "$ACTIVE_DOWNLOAD_PID" 2>/dev/null || true
  fi
  rm -rf -- "${TMP:?}"
}

# 每个候选有独立文件和校验过程；只有完整、通过校验的清单才可以赢。
probe_manifest() {
  TMP=$2
  curl_pid=''
  trap 'probe_code=$?; if [ -n "$curl_pid" ]; then kill "$curl_pid" 2>/dev/null || true; wait "$curl_pid" 2>/dev/null || true; fi; printf "%s\n" "$probe_code" >"$TMP/exit"' EXIT
  trap 'exit 130' HUP INT TERM
  curl --proto '=https' --tlsv1.2 -fsS --connect-timeout 5 --max-time 8 --max-filesize 65536 --write-out '%{http_code}' -o "$TMP/manifest.json" "$1/stable/manifest.json" </dev/null >"$TMP/http-status" &
  curl_pid=$!
  wait "$curl_pid" || exit 3
  curl_pid=''
  [ "$(cat "$TMP/http-status")" = 200 ] || exit 3
  validate_manifest
  : >"$TMP/ready"
}

read_manifest() {
  mkdir "$TMP/domestic" "$TMP/global"
  PROBE_PIDS=''
  probe_manifest "$BASE_URL" "$TMP/domestic" 2>"$TMP/domestic/error" &
  PROBE_PIDS=$!
  probe_manifest "$GLOBAL_BASE_URL" "$TMP/global" 2>"$TMP/global/error" &
  PROBE_PIDS="$PROBE_PIDS $!"
  preference_ticks=0
  chosen=''
  while :; do
    if [ -f "$TMP/domestic/ready" ]; then chosen=domestic; break; fi
    if [ -f "$TMP/global/ready" ]; then
      # 国内源已经失败，或海外源就绪后给国内的约 300 ms 优先时间已经结束。
      if [ -f "$TMP/domestic/exit" ] || [ "$preference_ticks" -ge 3 ]; then chosen=global; break; fi
      preference_ticks=$((preference_ticks + 1))
    fi
    if [ -f "$TMP/domestic/exit" ] && [ -f "$TMP/global/exit" ]; then break; fi
    sleep 0.1
  done
  stop_probes
  if [ -z "$chosen" ]; then
    for candidate in domestic global; do
      if [ "$(cat "$TMP/$candidate/exit" 2>/dev/null || true)" = 4 ]; then
        cat "$TMP/$candidate/error" >&2
        fail 4 "两个下载源都没有可用的发布清单，没有安装。"
      fi
    done
    fail 3 "下载发布清单失败：国内和海外源都没有返回有效清单。"
  fi
  if [ "$chosen" = domestic ]; then DOWNLOAD_BASE_URL=$BASE_URL; else DOWNLOAD_BASE_URL=$GLOBAL_BASE_URL; fi
  mv "$TMP/$chosen/manifest.json" "$TMP/manifest.json"
  validate_manifest
  if [ "$chosen" = domestic ]; then say "已连接国内下载源。"; else say "已连接海外下载源。"; fi
}

# 安装根里的 bin/vonvon 是服务端的启动器，而且能运行。
server_cli_runs() {
  [ -f "$ROOT/bin/vonvon" ] && grep -qF "$SERVER_MARKER" "$ROOT/bin/vonvon" 2>/dev/null \
    && "$ROOT/bin/vonvon" --version </dev/null >/dev/null 2>&1
}

# 已经装过就说一句、返回 0；什么文件都不写，也不连网。
# 只有 current、没有能运行的 bin/vonvon，是设置那一步没做完（切了 current 才失败或被打断）：不算装过，接着装。
already_installed() {
  found=''
  if [ -f "$DATA/daemon.pid" ]; then
    pid=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$DATA/daemon.pid" 2>/dev/null | head -n 1)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then found=1; fi
  fi
  if { [ -e "$ROOT/current" ] || [ -L "$ROOT/current" ]; } && server_cli_runs; then found=1; fi
  # systemd 的服务定义；数据目录不是默认的那份会带哈希后缀
  for definition in "${XDG_CONFIG_HOME:-$HOME/.config}"/systemd/user/vonvon-bot*.service; do
    if [ -e "$definition" ]; then found=1; fi
  done
  command_path=$(command -v vonvon 2>/dev/null || true)
  if [ -n "$command_path" ] && [ -f "$command_path" ] && grep -qF "$SERVER_MARKER" "$command_path" 2>/dev/null; then
    if [ "$command_path" != "$ROOT/bin/vonvon" ] || server_cli_runs; then found=1; fi
  fi
  if [ -z "$found" ]; then return 1; fi
  say "这台机器已经装过 Vonvon Bot，不用再装。直接用：\`vonvon --version\`。"
  return 0
}

need_tools() {
  missing=''
  for tool in curl tar mktemp sed grep head tr wc find mkdir mv rm uname cat sleep; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  command -v sha512sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || missing="$missing sha512sum（或 shasum）"
  command -v base64 >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1 || missing="$missing base64（或 openssl）"
  if [ -n "$missing" ]; then fail 2 "缺少这些命令：${missing}。装上以后再运行。"; fi
}

pick_target() {
  # 系统在 main 的第一步已经核过是 Linux
  machine=$(uname -m)
  case "$machine" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) fail 2 "不支持这种处理器：${machine}。只有 x64 和 arm64 的包。" ;;
  esac
  # ldd 是 libc 自己的；它说不清时 getconf 认得 glibc。都认不出 glibc，有 ld-musl 才算 musl：
  # glibc 的系统装了 musl 包（musl-tools）也会有 /lib/ld-musl-*.so.1
  libc=''
  case "$(ldd --version 2>&1 | head -n 1 || true)" in
    *musl*) libc=musl ;;
    *GLIBC*|*'GNU libc'*|*'GNU C Library'*) libc=glibc ;;
  esac
  if [ -z "$libc" ] && getconf GNU_LIBC_VERSION >/dev/null 2>&1; then libc=glibc; fi
  if [ -z "$libc" ]; then
    for loader in /lib/ld-musl-*.so.1; do
      if [ -e "$loader" ]; then libc=musl; fi
    done
  fi
  if [ "$libc" = musl ]; then fail 2 "这一版不支持 musl（Alpine 这类系统），只支持 glibc 的 Linux。"; fi
  TARGET="linux-$ARCH"
}

sha512_of() {
  if command -v sha512sum >/dev/null 2>&1; then sha512sum <"$1"; else shasum -a 512 <"$1"; fi | sed 's/[^0-9a-f].*//'
}

base64_decode() {
  if base64 -d <"$1" >"$2" 2>/dev/null; then return 0; fi
  if base64 -D <"$1" >"$2" 2>/dev/null; then return 0; fi
  openssl base64 -d -A <"$1" >"$2" 2>/dev/null
}

# 签名清单（server-3 C1）：信封是 JSON.stringify 的紧凑 JSON，payload 的键顺序固定，所以能用字面匹配逐项核对。
validate_manifest() {
  size=$(wc -c <"$TMP/manifest.json" | tr -d ' ')
  if [ "$size" -gt 65536 ]; then fail 4 "发布清单太大（$size 字节），没有安装。"; fi
  if [ "$(wc -l <"$TMP/manifest.json" | tr -d ' ')" -gt 1 ]; then fail 4 "发布清单的格式不对，没有安装。"; fi
  envelope=$(LC_ALL=C sed -n 's#^{"payload":"\([A-Za-z0-9+/=]*\)","signature":"\([A-Za-z0-9+/=]*\)"}$#\1 \2#p' "$TMP/manifest.json")
  payload_b64=${envelope%% *}
  signature_b64=${envelope#* }
  if [ -z "$envelope" ] || [ -z "$payload_b64" ] || [ -z "$signature_b64" ]; then fail 4 "发布清单的格式不对，没有安装。"; fi
  printf '%s' "$payload_b64" >"$TMP/payload.b64"
  printf '%s' "$signature_b64" >"$TMP/signature.b64"
  base64_decode "$TMP/payload.b64" "$TMP/payload.bin" || fail 4 "发布清单的格式不对，没有安装。"
  base64_decode "$TMP/signature.b64" "$TMP/signature.bin" || fail 4 "发布清单的格式不对，没有安装。"
  if [ "$(wc -c <"$TMP/signature.bin" | tr -d ' ')" != 64 ]; then fail 4 "发布清单的签名不对，没有安装。"; fi

  SIGNATURE_CHECKED=no
  case "$(openssl version 2>/dev/null || true)" in
    "OpenSSL "[3-9]*)
      printf '%s\n' "$PUBKEY_PEM" >"$TMP/public.pem"
      openssl pkeyutl -verify -pubin -inkey "$TMP/public.pem" -rawin -in "$TMP/payload.bin" -sigfile "$TMP/signature.bin" </dev/null >/dev/null 2>&1 \
        || fail 4 "发布清单的签名不对，没有安装。"
      SIGNATURE_CHECKED=yes
      ;;
  esac

  # payload 整个对上 C1 的形状：键、顺序、两个 Linux 包都在、没有别的键；不用里面任何没核对过的值
  if [ "$(wc -l <"$TMP/payload.bin" | tr -d ' ')" != 0 ]; then fail 4 "发布清单的内容不对，没有安装。"; fi
  file='{"url":"[^"]*","sha512":"[0-9a-f]\{128\}","size":[1-9][0-9]*}'
  shape='^{"schemaVersion":1,"product":"vonvon-bot-server","channel":"stable","version":"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)","publishedAt":[1-9][0-9]*,"files":{"linux-x64":'"$file"',"linux-arm64":'"$file"'}\(,"notes":"[^"\\]*\(\\.[^"\\]*\)*"\)\{0,1\}}$'
  VERSION=$(LC_ALL=C sed -n "s#$shape#\\1#p" "$TMP/payload.bin")
  case "$VERSION" in
    ''|*[!0-9.]*|.*|*.|*..*) fail 4 "发布清单的内容不对，没有安装。" ;;
  esac
  if [ "$(expr "$VERSION" : '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$')" != "${#VERSION}" ]; then fail 4 "发布清单的内容不对，没有安装。"; fi
  entry=$(LC_ALL=C sed -n 's#.*"'"$TARGET"'":{"url":"\([^"]*\)","sha512":"\([0-9a-f]*\)","size":\([0-9]*\)}.*#\1 \2 \3#p' "$TMP/payload.bin")
  URL=${entry%% *}
  rest=${entry#* }
  SHA=${rest%% *}
  SIZE=${rest#* }
  if [ "$URL" != "$BASE_URL/$VERSION/vonvon-server-$VERSION-$TARGET.tar.gz" ]; then fail 4 "发布清单里 $TARGET 的下载地址不对，没有安装。"; fi
  if [ "${#SHA}" != 128 ]; then fail 4 "发布清单的内容不对，没有安装。"; fi
  case "$SIZE" in ''|*[!0-9]*) fail 4 "发布清单的内容不对，没有安装。" ;; esac
}

# 只删本脚本建的 releases/<版本>.part：路径对、名字对、不是链接，都满足才删。
remove_part() {
  name=${PART#"$ROOT/releases/"}
  case "$PART" in "$ROOT/releases/"*.part) ;; *) fail 1 "不删 ${PART}：不是本脚本建的临时目录。" ;; esac
  case "$name" in ''|*/*) fail 1 "不删 ${PART}：不是本脚本建的临时目录。" ;; esac
  if [ -z "$ROOT" ] || [ -L "$PART" ]; then fail 1 "不删 ${PART}：不是本脚本建的临时目录。"; fi
  rm -rf -- "$PART"
}

fetch_release() {
  if [ "$DOWNLOAD_BASE_URL" = "$BASE_URL" ]; then fallback_base=$GLOBAL_BASE_URL; else fallback_base=$BASE_URL; fi
  download_code=3
  download_error="下载安装包失败：国内和海外源都无法完成下载。"
  # 重试固定的已验签版本；跨源从头写文件，绝不把不同响应盲目拼接。
  for source_base in "$DOWNLOAD_BASE_URL" "$fallback_base"; do
    if [ "$source_base" = "$fallback_base" ]; then say "正在尝试另一个下载源…"; fi
    if download "$source_base/${URL#"$BASE_URL/"}" "$TMP/package.tar.gz" "$SIZE"; then
      got=$(wc -c <"$TMP/package.tar.gz" | tr -d ' ')
      if [ "$got" != "$SIZE" ]; then
        download_code=4
        download_error="下载的安装包大小（$got 字节）和发布清单（$SIZE 字节）不一致，没有安装。"
      elif [ "$(sha512_of "$TMP/package.tar.gz")" != "$SHA" ]; then
        download_code=4
        download_error="下载内容和发布清单不一致（sha512 不对），没有安装。"
      else
        DOWNLOAD_BASE_URL=$source_base
        return 0
      fi
    elif [ "$?" = 63 ]; then
      download_code=4
      download_error="下载的安装包超过发布清单里的大小，没有安装。"
    fi
  done
  fail "$download_code" "$download_error"
}

unpack_release() {
  mkdir -p "$ROOT/releases"
  PART="$ROOT/releases/$VERSION.part"
  if [ -e "$PART" ] || [ -L "$PART" ]; then remove_part; fi
  # 解包之前先看成员：只要普通文件和目录，路径不能是绝对的、不能有 ..
  tar -tzvf "$TMP/package.tar.gz" >"$TMP/types" 2>/dev/null </dev/null || fail 4 "安装包解不开，没有安装。"
  tar -tzf "$TMP/package.tar.gz" >"$TMP/members" 2>/dev/null </dev/null || fail 4 "安装包解不开，没有安装。"
  # bsdtar 把硬链接列成普通文件加 "link to"
  odd=$(grep -v '^[-d]' "$TMP/types" | head -n 1)
  if [ -z "$odd" ]; then odd=$(grep -e ' link to ' -e ' -> ' "$TMP/types" | head -n 1); fi
  if [ -n "$odd" ]; then fail 4 "安装包里有链接或特殊文件，没有安装：$odd"; fi
  while IFS= read -r member; do
    case "$member" in
      /*|..|../*|*/..|*/../*) fail 4 "安装包里有越界的路径，没有安装：$member" ;;
    esac
  done <"$TMP/members"
  mkdir "$PART"
  if ! tar -xzf "$TMP/package.tar.gz" -C "$PART" </dev/null; then
    remove_part
    fail 4 "安装包解不开，没有安装。"
  fi
  for required in standalone.json app/bin/vonvon.mjs node/bin/node; do
    if [ ! -f "$PART/$required" ]; then
      remove_part
      fail 4 "安装包里缺 ${required}，没有安装。"
    fi
  done
  link=$(find "$PART" -type l -print | head -n 1)
  version_pattern=$(printf '%s' "$VERSION" | sed 's/\./\\./g')
  if [ ! -x "$PART/node/bin/node" ] || [ -n "$link" ] || ! grep -q "\"version\": *\"$version_pattern\"" "$PART/standalone.json"; then
    remove_part
    fail 4 "安装包的内容和发布清单对不上，没有安装。"
  fi
  mv "$PART" "$RELEASE"
}

# 切 current、写 bin/vonvon 和 PATH，都由刚解开的版本自己做（server-2 4.3）。
set_up() {
  output=$("$RELEASE/node/bin/node" "$RELEASE/app/bin/vonvon.mjs" __standalone-setup --install-root "$ROOT" --release "$VERSION" --json </dev/null 2>"$TMP/setup.err") && code=0 || code=$?
  case "$code:$output" in
    '0:{"ok":true'*) ;;
    *)
      show_output "$output" "$TMP/setup.err"
      fail 1 "设置 vonvon 命令这一步失败了（退出码 ${code}）。安装包已经解好，再运行一次安装命令会从这一步接着做。"
      ;;
  esac
  case "$output" in *'"pathAlreadyOnPath":true'*) ON_PATH=yes ;; *) ON_PATH=no ;; esac
}

start_detached() {
  output=$("$ROOT/bin/vonvon" daemon start --json </dev/null 2>"$TMP/start.err") && code=0 || code=$?
  case "$code:$output" in
    '0:{"ok":true'*) ;;
    *)
      show_output "$output" "$TMP/start.err"
      fail 1 "后台服务装不上，直接启动也没成功（退出码 ${code}）。文件已经装好，再运行安装命令不会重做这一步；问题解决后运行 \`$ROOT/bin/vonvon daemon start\`。"
      ;;
  esac
  case "$1" in
    no_systemd) say "这台机器没有 systemd（可能是容器）。已改为直接启动，崩溃后不会自动重启；需要时运行 \`vonvon daemon start\`。" ;;
    *) say "连不上这个账号的 systemd（用 sudo 切过来时常见）。已直接启动一次；用这个账号 SSH 登录后运行 \`vonvon service install\` 装成后台服务。" ;;
  esac
  DETACHED=yes
}

install_service() {
  DETACHED=no
  AUTOSTART=yes
  BOOT_USER=
  output=$("$ROOT/bin/vonvon" service install --linger --json </dev/null 2>"$TMP/service.err") && code=0 || code=$?
  case "$output" in
    '{"ok":true'*)
      # 少数系统不让账号自己开开机自启：装好照样算装好，最后给一句可选的提示
      case "$output" in
        *'"linger":"off"'*)
          AUTOSTART=no
          BOOT_USER=$(printf '%s' "$output" | LC_ALL=C sed -n 's/.*"lingerUser":"\([A-Za-z0-9._-]*\)".*/\1/p')
          ;;
      esac
      ;;
    '{"ok":false'*)
      reason=$(printf '%s' "$output" | LC_ALL=C sed -n 's/.*"reason":"\([a-z_]*\)","fallback":"detached".*/\1/p')
      case "$reason" in
        no_systemd|user_instance_down|no_runtime_dir) start_detached "$reason" ;;
        *)
          show_output "$output" "$TMP/service.err"
          fail 1 "后台服务没装上（退出码 ${code}）。文件已经装好，再运行安装命令不会重做这一步；问题解决后运行 \`$ROOT/bin/vonvon service install\`。"
          ;;
      esac
      ;;
    *)
      show_output "$output" "$TMP/service.err"
      fail 1 "后台服务没装上：$ROOT/bin/vonvon 没有正常运行（退出码 ${code}）。问题解决后运行 \`$ROOT/bin/vonvon service install\`。"
      ;;
  esac
}

finish() {
  if [ "$DETACHED" = yes ]; then say "装好了。已直接启动一次。"
  elif [ "$AUTOSTART" = yes ]; then say "装好了。Vonvon Bot 已在后台运行，开机自动启动。"
  else
    say "装好了。Vonvon Bot 已在后台运行。"
    say "这台机器没让它开机自动启动，退出登录后它会停。需要的话运行一次：\`sudo loginctl enable-linger ${BOOT_USER:-你的用户名}\`"
  fi
  say "试一下：\`vonvon --version\`"
  if [ "$ON_PATH" != yes ]; then say "重开一个终端，或 \`. ~/.bashrc\`（zsh 用 \`. ~/.zshrc\`）再运行 \`vonvon\`。"; fi
  say "要从别的电脑连过来管理？看 $GUIDE_URL"
}

main() {
  # Mac、Windows 的安装包里已经带着服务端：不是 Linux 就先于一切检查、写文件和连网退出
  system=$(uname -s 2>/dev/null || true)
  case "$system" in
    Linux) ;;
    Darwin) fail 2 "Mac 请下载安装包：$DESKTOP_DOWNLOAD ，安装包里已经带了服务端和 vonvon 命令。这个脚本只用于 Linux，什么都没动。" ;;
    *) fail 2 "这个安装脚本只支持 Linux（这台是 ${system:-认不出的系统}）。Mac、Windows 请下载 Vonvon Bot 桌面端安装包：$DESKTOP_DOWNLOAD" ;;
  esac
  case "${HOME:-}" in
    /*) ;;
    *) fail 2 "HOME 没有设置或不是绝对路径，不知道装到哪里。" ;;
  esac
  if [ -z "$(printf '%s' "$HOME" | sed 's#/*$##')" ]; then fail 2 "HOME 是 /，不往根目录里装。"; fi
  # sudo 常留着原来用户的 HOME：root 往里写，启动文件和数据目录都会变成 root 的
  if [ "$(id -u 2>/dev/null || true)" = 0 ] && [ ! -O "$HOME" ]; then
    fail 2 "HOME（${HOME}）不是 root 的，没有安装。要装给那个用户，就用那个用户自己运行，不要 sudo；坚持装在 root 下，用 \`sudo -H\` 或 \`su -\` 切成 root 再运行。"
  fi
  ROOT="$HOME/.local/share/vonvon-bot/server"
  DATA="$HOME/.vonvon-bot"
  if already_installed; then exit 0; fi
  if [ -z "$PUBKEY_PEM" ]; then fail 4 "这份安装脚本没有带发布公钥，不能用来安装。请用官网上的安装命令。"; fi
  need_tools
  pick_target
  # 数据目录固定是 ~/.vonvon-bot：「已装过」的判断、服务名和卸载脚本都按这一份算
  if [ -n "${VONVON_HOME:-}" ]; then say "安装脚本不看 VONVON_HOME，数据目录用 ~/.vonvon-bot。"; fi
  unset VONVON_HOME
  TMP=$(mktemp -d) || fail 2 "建不了临时目录。"
  PROBE_PIDS=''
  trap 'cleanup_downloads' EXIT
  trap 'exit 130' HUP INT TERM
  say "正在连接下载服务…"
  read_manifest
  say "正在安装 Vonvon Bot 服务端 ${VERSION}（${TARGET}）…"
  RELEASE="$ROOT/releases/$VERSION"
  if [ -L "$RELEASE" ]; then fail 1 "$RELEASE 是符号链接，不是本脚本建的。删掉它再运行。"; fi
  if [ -f "$RELEASE/standalone.json" ]; then
    say "releases/$VERSION 已经解好了，不再下载。"
  elif [ -e "$RELEASE" ]; then
    fail 1 "$RELEASE 残缺（没有 standalone.json）。删掉它再运行。"
  else
    fetch_release
    unpack_release
  fi
  if [ "$SIGNATURE_CHECKED" != yes ]; then say "这台机器没有 openssl 3，没能核对发布签名；已核对下载内容的哈希，来源是 ${DOWNLOAD_BASE_URL%/bot/server}。"; fi
  set_up
  install_service
  finish
}

main "$@"
