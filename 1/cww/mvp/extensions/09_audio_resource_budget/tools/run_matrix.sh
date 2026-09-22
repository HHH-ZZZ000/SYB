#!/usr/bin/env bash
set -euo pipefail

mode="${1:?usage: $0 MODE CPU_DEFAULTS [PORT]}"
cpu_defaults="${2:?usage: $0 MODE CPU_DEFAULTS [PORT]}"
port="${3:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${script_dir}/.." && pwd)"

case "$mode" in
  vad) bench_mode=1 ;;
  wakenet) bench_mode=2 ;;
  multinet) bench_mode=3 ;;
  *) echo "mode must be vad, wakenet, or multinet" >&2; exit 2 ;;
esac

case "$cpu_defaults" in
  cpu160|cpu240) ;;
  *) echo "CPU_DEFAULTS must be cpu160 or cpu240" >&2; exit 2 ;;
esac

build_dir="${project_dir}/build/${mode}_${cpu_defaults}"
export SDKCONFIG="${build_dir}/sdkconfig"
export SDKCONFIG_DEFAULTS="${project_dir}/sdkconfig.defaults;${project_dir}/configs/${cpu_defaults}.defaults"
idf.py -C "${project_dir}" -B "${build_dir}" \
  -D "SDKCONFIG=${build_dir}/sdkconfig" \
  -D "SDKCONFIG_DEFAULTS=${SDKCONFIG_DEFAULTS}" \
  -D "BENCH_MODE=${bench_mode}" reconfigure
if [[ -n "$port" ]]; then
  idf.py -B "${build_dir}" -p "$port" build monitor
else
  idf.py -B "${build_dir}" build
fi
