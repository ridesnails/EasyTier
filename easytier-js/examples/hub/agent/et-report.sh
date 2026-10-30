#!/usr/bin/env bash
# EasyTier 节点状态上报
set -euo pipefail

# macOS 的 BSD date 不支持 -Is；统一用可移植写法
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date; }
: "${ET_HUB_URL:?need ET_HUB_URL, e.g. https://et.example.com}"
: "${ET_REPORT_TOKEN:?need ET_REPORT_TOKEN}"
ET_CLI="${ET_CLI:-easytier-cli}"
ET_RPC="${ET_RPC:-127.0.0.1:15888}"
ET_REPORTER="${ET_REPORTER:-$(hostname -s)}"
ET_INTERVAL="${ET_INTERVAL:-120}"
# 可选：主域名失败时的备用域（与主域名是同一个 Worker）。主域名偶尔 TLS 握手会拖到
# 15s+，超时后自动回落备用域重试一次，而不用把主域名换掉。
ET_HUB_FALLBACK="${ET_HUB_FALLBACK:-}"
ET_TIMEOUT="${ET_TIMEOUT:-25}"
# 可选：节点自报坐标。用于"上报出网被代理/NAT 污染"的节点（例如主路由的所有 HTTPS
# 都走本机 sing-box 出去，Cloudflare 会把来源 IP 判成海外代理节点）。设了这组变量，
# Worker 会用这里的坐标而不是按请求来源 IP 反查。
#   ET_LAT=30.5928 ET_LON=114.3055 ET_CITY=Wuhan ET_COUNTRY=CN

post() {  # $1 = hub base url, $2 = payload file
  curl -fsS -m "$ET_TIMEOUT" -X POST "$1/api/report" \
    -H "Authorization: Bearer $ET_REPORT_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @"$2" >/dev/null
}

report_once() {
  local peers node geo payload
  peers="$("$ET_CLI" -p "$ET_RPC" -o json peer)" || { echo "cli peer failed" >&2; return 1; }
  [[ -n "$peers" ]] || peers="[]"
  node="$("$ET_CLI" -p "$ET_RPC" -o json node 2>/dev/null)" || node="null"
  [[ -n "$node" ]] || node="null"
  geo=""
  if [[ -n "${ET_LAT:-}" && -n "${ET_LON:-}" ]]; then
    geo=$(printf ',"geo":{"lat":%s,"lon":%s,"city":"%s","country":"%s"}' \
      "$ET_LAT" "$ET_LON" "${ET_CITY:-}" "${ET_COUNTRY:-}")
  fi
  payload="$(mktemp)"
  printf '{"reporter":"%s","peers":%s,"node":%s%s}' \
    "$ET_REPORTER" "$peers" "$node" "$geo" > "$payload"

  if post "$ET_HUB_URL" "$payload"; then rm -f "$payload"; return 0; fi
  if [[ -n "$ET_HUB_FALLBACK" ]]; then
    echo "$(now_iso) primary hub unreachable, retrying fallback" >&2
    if post "$ET_HUB_FALLBACK" "$payload"; then rm -f "$payload"; return 0; fi
  fi
  rm -f "$payload"
  return 1
}

if [[ "${1:-}" == "--once" ]]; then report_once; exit $?; fi
while true; do
  report_once || echo "$(now_iso) report failed" >&2
  sleep "$ET_INTERVAL"
done
