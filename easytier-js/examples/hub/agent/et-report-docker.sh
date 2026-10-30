#!/bin/sh
# EasyTier 节点状态上报（Docker sidecar 版，POSIX sh + busybox wget）
#
# 为什么不用 et-report.sh：官方镜像是 Alpine 精简系统，只有 tzdata + tini，
# 没有 bash、没有 curl。这里用镜像自带的 sh + busybox wget，配合 network_mode: host
# 直连 easytier 容器的 RPC 127.0.0.1:15888。
#
# 已知残余风险：busybox wget 只支持把 header 放在命令行上，所以 token 会出现在
# /proc/<pid>/cmdline（ps 可见）。缓解：容器内不跑其他进程、不给其他用户 shell；
# 能换带 curl 的镜像时请改用 et-report.sh（token 走 0600 的 -K 配置文件）。
set -eu

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date; }
: "${ET_HUB_URL:?need ET_HUB_URL, e.g. https://et.yi.uy}"
: "${ET_REPORT_TOKEN:?need ET_REPORT_TOKEN}"
ET_CLI="${ET_CLI:-easytier-cli}"
ET_RPC="${ET_RPC:-127.0.0.1:15888}"
ET_REPORTER="${ET_REPORTER:-$(hostname)}"
ET_INTERVAL="${ET_INTERVAL:-120}"
ET_HUB_FALLBACK="${ET_HUB_FALLBACK:-}"
ET_TIMEOUT="${ET_TIMEOUT:-25}"
# 可选：自报坐标（同 et-report.sh，适用于上报出网被代理污染的节点）
#   ET_LAT=30.5928 ET_LON=114.3055 ET_CITY=Wuhan ET_COUNTRY=CN

# 这几个变量必须有默认值：set -u 下未定义会直接终止整个脚本（曾导致 sidecar 空转）
: "${ET_TIMEOUT:=25}"
: "${ET_HUB_FALLBACK:=}"

if ! printf '%s' "$ET_REPORTER" | grep -Eq '^[A-Za-z0-9_.-]{1,64}$'; then
  echo "ET_REPORTER 非法（只允许 [A-Za-z0-9_.-]{1,64}）: $ET_REPORTER" >&2
  exit 78
fi
case "$ET_HUB_URL" in
  https://*) ;;
  *) echo "ET_HUB_URL 必须是 https://（明文会把 token 暴露在链路上）" >&2; exit 78 ;;
esac
command -v "$ET_CLI" >/dev/null 2>&1 || { echo "找不到 $ET_CLI" >&2; exit 78; }

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
num_or_empty() { printf '%s' "$1" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$' && printf '%s' "$1"; return 0; }

payload_file="$(mktemp)"; chmod 600 "$payload_file"
trap 'rm -f "$payload_file"' EXIT INT TERM HUP

build_payload() {
  peers="$("$ET_CLI" -p "$ET_RPC" -o json peer)" || { echo "cli peer failed" >&2; return 1; }
  [ -n "$peers" ] || peers="[]"
  case "$peers" in
    \[*) ;;
    *) echo "cli peer 输出不是 JSON 数组，跳过本轮" >&2; return 1 ;;
  esac
  node="$("$ET_CLI" -p "$ET_RPC" -o json node 2>/dev/null)" || node="null"
  [ -n "$node" ] || node="null"

  geo=""
  if [ -n "${ET_LAT:-}" ] || [ -n "${ET_LON:-}" ]; then
    lat="$(num_or_empty "${ET_LAT:-}")"; lon="$(num_or_empty "${ET_LON:-}")"
    if [ -n "$lat" ] && [ -n "$lon" ]; then
      geo="$(printf ',"geo":{"lat":%s,"lon":%s,"city":"%s","country":"%s"}' \
        "$lat" "$lon" "$(json_str "${ET_CITY:-}")" "$(json_str "${ET_COUNTRY:-}")")"
    else
      echo "$(now_iso) ET_LAT/ET_LON 需同时为数字，已忽略自报坐标" >&2
    fi
  fi

  # body 写文件后用 --post-file 发送：至少把 peer 表与 node（含网络密钥）移出 argv
  printf '{"reporter":"%s","peers":%s,"node":%s%s}' \
    "$(json_str "$ET_REPORTER")" "$peers" "$node" "$geo" > "$payload_file"
}

# 0=成功 1=网络层失败（可回落） 2=HTTP 语义错误（不可回落）
post_to() {
  base="${1%/}"
  if wget -q -O /dev/null -T "$ET_TIMEOUT" \
      --header="Authorization: Bearer $ET_REPORT_TOKEN" \
      --header="Content-Type: application/json" \
      --post-file="$payload_file" \
      "$base/api/report"; then
    return 0
  fi
  # busybox wget 不区分网络失败与 4xx，这里用一次 HEAD 探测判断是否可达
  if wget -q -O /dev/null -T 5 --spider "$base/relay" 2>/dev/null; then
    echo "$(now_iso) hub $base 拒绝上报（HTTP 4xx/5xx）" >&2
    return 2
  fi
  return 1
}

report_once() {
  build_payload || return 1
  post_to "$ET_HUB_URL" && return 0
  rc=$?
  if [ "$rc" -eq 1 ] && [ -n "$ET_HUB_FALLBACK" ]; then
    echo "$(now_iso) primary hub 网络不可达，回落备用域" >&2
    post_to "$ET_HUB_FALLBACK" && return 0
  fi
  return 1
}

if [ "${1:-}" = "--once" ]; then report_once; exit $?; fi

fail=0
while :; do
  if report_once; then
    fail=0; delay="$ET_INTERVAL"
  else
    fail=$((fail + 1))
    case "$fail" in
      1) delay="$ET_INTERVAL" ;;
      2) delay=$((ET_INTERVAL * 2)) ;;
      *) delay=900 ;;
    esac
    [ "$delay" -le 900 ] || delay=900
  fi
  sleep $((delay + ($(date +%s) % 30)))
done
