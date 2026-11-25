#!/bin/sh

# 仅在明确不运行 db 用例、或仅收集且没有并行或自定义配置时启用离线通道。
heijin_is_offline() {
  [ -z "${PYTEST_ADDOPTS:-}" ] && [ -z "${PYTEST_XDIST_WORKER:-}" ] || return 1
  heijin_collect_only=0
  heijin_marker_count=0
  heijin_marker_value=""
  heijin_marker_pending=0
  heijin_ambiguous=0
  for heijin_arg in "$@"; do
    if [ "$heijin_marker_pending" -eq 1 ]; then
      heijin_marker_value=$heijin_arg
      heijin_marker_pending=0
      continue
    fi
    case "$heijin_arg" in
      --) break ;;
      --collect-only|--collectonly|--co) heijin_collect_only=1 ;;
      -m) heijin_marker_count=$((heijin_marker_count + 1)); heijin_marker_pending=1 ;;
      -m?*) heijin_ambiguous=1 ;;
      -n|-n?*|--numprocesses|--numprocesses=*|--dist|--dist=*|--tx|--tx=*) heijin_ambiguous=1 ;;
      -c|-c?*|-o|-o?*|--override-ini|--override-ini=*) heijin_ambiguous=1 ;;
    esac
  done
  [ "$heijin_ambiguous" -eq 0 ] || return 1
  [ "$heijin_collect_only" -eq 1 ] && return 0
  [ "$heijin_marker_count" -eq 1 ] && [ "$heijin_marker_pending" -eq 0 ] && [ "$heijin_marker_value" = "not db" ]
}
