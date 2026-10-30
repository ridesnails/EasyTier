#!/usr/bin/env bash
# EasyTier 节点状态上报（bash + curl，Linux / macOS 常驻）
#
# 设计要点（都是踩过的坑）：
#  - 主域名优先，失败才回落备用域：主域名偶发 TLS 卡顿，但不该因此弃用它
#  - token 不进 argv：curl 用 0600 的 -K 配置文件传 Authorization
#  - body 走 stdin，不放临时文件，避免含 network_secret 的 payload 落盘
#  - 3xx/4xx 是确定性错误，不重试；只有网络层失败才回落
set -euo pipefail

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date; }
: "${ET_HUB_URL:?need ET_HUB_URL, e.g. https://et.example.com}"
: "${ET_REPORT_TOKEN:?need ET_REPORT_TOKEN}"
ET_CLI="${ET_CLI:-easytier-cli}"
ET_RPC="${ET_RPC:-127.0.0.1:15888}"
ET_REPORTER="${ET_REPORTER:-$(hostname -s 2>/dev/null || hostname)}"
ET_INTERVAL="${ET_INTERVAL:-120}"
ET_HUB_FALLBACK="${ET_HUB_FALLBACK:-}"
ET_TIMEOUT="${ET_TIMEOUT:-25}"
# 可选：节点自报坐标。适用于「上报出网被代理/NAT 污染」的节点（Cloudflare 会把来源 IP
# 判成代理出口，按请求来源反查城市就是错的）。设了就用这里的坐标。
#   ET_LAT=30.5928 ET_LON=114.3055 ET_CITY=Wuhan ET_COUNTRY=CN

# reporter 是快照主键，格式必须与 Worker 的 ^[\w.-]{1,64}$ 对齐，否则每轮都 400
if ! printf '%s' "$ET_REPORTER" | grep -Eq '^[A-Za-z0-9_.-]{1,64}$'; then
  echo "ET_REPORTER 非法（只允许 [A-Za-z0-9_.-]{1,64}）: $ET_REPORTER" >&2
  exit 78
fi
case "$ET_HUB_URL" in
  https://*) ;;
  *) echo "ET_HUB_URL 必须是 https://（明文会把 token 暴露在链路上）" >&2; exit 78 ;;
esac

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
num_or_empty() { printf '%s' "$1" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$' && printf '%s' "$1"; return 0; }

# token 只写在 0600 的 curl 配置里，不进命令行（ps 看不到）
cred="$(mktemp)"; chmod 600 "$cred"
trap 'rm -f "$cred"' EXIT INT TERM HUP
printf 'header = "Authorization: Bearer %s"\n' "$ET_REPORT_TOKEN" > "$cred"

# 返回 0=成功  1=网络层失败（可回落）  2=HTTP 语义错误（不可回落）
post() {
  local base="${1%/}" code
  code="$(curl -sS -m "$ET_TIMEOUT" -X POST "$base/api/report" \
    -K "$cred" -H "Content-Type: application/json" \
    --data-binary @- -o /dev/null -w '%{http_code}')" || return 1
  case "$code" in
    2??) return 0 ;;
    *) echo "$(now_iso) hub $base 返回 HTTP $code" >&2; return 2 ;;
  esac
}

payload() {
  local peers node geo lat lon
  peers="$("$ET_CLI" -p "$ET_RPC" -o json peer)" || { echo "cli peer failed" >&2; return 1; }
  [ -n "$peers" ] || peers="[]"
  case "$peers" in
    \[*) ;;
    *) echo "cli peer 输出不是 JSON 数组，跳过本轮" >&2; return 1 ;;
  esac
  node="$("$ET_CLI" -p "$ET_RPC" -o json node 2>/dev/null)" || node="null"
  node="${node:-null}"

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

  printf '{"reporter":"%s","peers":%s,"node":%s%s}' \
    "$(json_str "$ET_REPORTER")" "$peers" "$node" "$geo"
}

report_once() {
  local rc=0 body
  body="$(payload)" || return 1
  printf '%s' "$body" | post "$ET_HUB_URL" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  if [ "$rc" -eq 1 ] && [ -n "$ET_HUB_FALLBACK" ]; then
    echo "$(now_iso) primary hub 网络不可达，回落备用域" >&2
    printf '%s' "$body" | post "$ET_HUB_FALLBACK" && return 0
  fi
  return 1
}

if [ "${1:-}" = "--once" ]; then report_once; exit $?; fi

# 失败退避（封顶 900s）+ 0-29s 抖动，避免全网节点同一秒打同一个 Worker
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
