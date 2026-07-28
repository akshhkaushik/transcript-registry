#!/bin/sh
set -eu

registry_cache_root="${XDG_CACHE_HOME:-${HOME}/.cache}/transcript-registry"
python_script="${registry_cache_root}/contribute.py"
virtual_environment="${registry_cache_root}/venv"
registry_origin="${TRANSCRIPT_REGISTRY_URL:-https://transcript-registry.vercel.app}"

mkdir -p "${registry_cache_root}"
curl -fsSL "${registry_origin}/contribute.py" -o "${python_script}"

if [ ! -x "${virtual_environment}/bin/python" ]; then
  python3 -m venv "${virtual_environment}"
fi

exec "${virtual_environment}/bin/python" "${python_script}" "$@" --install-tools
