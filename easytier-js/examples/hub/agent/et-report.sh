#!/usr/bin/env bash
# EasyTier 节点状态上报
set -euo pipefail
: "${ET_HUB_URL:?need ET_HUB_URL, e.g. https://et.example.com}"
: "${ET_REPORT_TOKEN:?need ET_REPORT_TOKEN}"
ET_CLI="${ET_CLI:-easytier-cli}"
ET_RPC="${ET_RPC:-127.0.0.1:15888}"
ET_REPORTER="${ET_REPORTER:-$(hostname -s)}"
ET_INTERVAL="${ET_INTERVAL:-15}"

report_once() {
  local peers node
  peers="$("$ET_CLI" -p "$ET_RPC" -o json peer)" || { echo "cli peer failed" >&2; return 1; }
  [[ -n "$peers" ]] || peers="[]"
  node="$("$ET_CLI" -p "$ET_RPC" -o json node 2>/dev/null)" || node="null"
  [[ -n "$node" ]] || node="null"
  printf '{"reporter":"%s","peers":%s,"node":%s}' "$ET_REPORTER" "$peers" "$node" |
    curl -fsS -m 10 -X POST "$ET_HUB_URL/api/report" \
      -H "Authorization: Bearer $ET_REPORT_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @- >/dev/null
}

if [[ "${1:-}" == "--once" ]]; then report_once; exit $?; fi
while true; do
  report_once || echo "$(date -Is) report failed" >&2
  sleep "$ET_INTERVAL"
done
