#!/bin/sh
# EasyTier 节点状态上报（Docker sidecar 版，POSIX sh）
# 为什么不用 et-report.sh：官方镜像是 Alpine 精简系统，只装了 tzdata + tini，
# 没有 bash、没有 curl，所以原脚本（bash + curl）在该镜像里跑不起来。
# 这个版本改用镜像自带的 sh + busybox wget，跑在同一个 compose 里做 reporter
# sidecar：network_mode: host 让它能直接连 easytier 容器的 RPC 127.0.0.1:15888。
# 用法见组网指南 4.4 的 compose reporter 服务；先单次验证再 up -d 常驻。
set -eu
: "${ET_HUB_URL:?need ET_HUB_URL, e.g. https://et.yi.uy}"
: "${ET_REPORT_TOKEN:?need ET_REPORT_TOKEN}"
ET_CLI="${ET_CLI:-easytier-cli}"
ET_RPC="${ET_RPC:-127.0.0.1:15888}"
ET_REPORTER="${ET_REPORTER:-$(hostname)}"
ET_INTERVAL="${ET_INTERVAL:-120}"
# 可选：自报坐标（同 et-report.sh，适用于上报出网被代理污染的节点）
#   ET_LAT=30.5928 ET_LON=114.3055 ET_CITY=Wuhan ET_COUNTRY=CN

report_once() {
  peers="$("$ET_CLI" -p "$ET_RPC" -o json peer)" || { echo "cli peer failed" >&2; return 1; }
  [ -n "$peers" ] || peers="[]"
  node="$("$ET_CLI" -p "$ET_RPC" -o json node 2>/dev/null)" || node="null"
  [ -n "$node" ] || node="null"
  body="{\"reporter\":\"$ET_REPORTER\",\"peers\":$peers,\"node\":$node}"
  wget -q -O /dev/null --timeout=10 \
    --header="Authorization: Bearer $ET_REPORT_TOKEN" \
    --header="Content-Type: application/json" \
    --post-data="$body" \
    "$ET_HUB_URL/api/report"
}

if [ "${1:-}" = "--once" ]; then report_once; exit $?; fi
while true; do
  report_once || echo "$(date '+%Y-%m-%dT%H:%M:%S%z') report failed" >&2
  sleep "$ET_INTERVAL"
done
