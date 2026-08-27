#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
case_root="$(mktemp -d "${TMPDIR:-/tmp}/superppt-acceptance.XXXXXX")"

finish() {
  status="$?"
  if [[ "$status" -eq 0 && "${SUPERPPT_KEEP_ACCEPTANCE:-0}" != "1" ]]; then
    case "$case_root" in
      */superppt-acceptance.*)
        rm -rf -- "$case_root"
        printf 'Offline acceptance passed; temporary artifacts cleaned: %s\n' "$case_root"
        printf 'Set SUPERPPT_KEEP_ACCEPTANCE=1 to preserve a successful run.\n'
        ;;
      *)
        printf 'Refusing to clean unexpected acceptance path: %s\n' "$case_root" >&2
        status=1
        ;;
    esac
  else
    printf 'Offline acceptance artifacts preserved for inspection: %s\n' "$case_root"
  fi
  exit "$status"
}
trap finish EXIT

cd "$repository_root"
SUPERPPT_ACCEPTANCE_ROOT="$case_root" node --import tsx --test tests/e2e.test.ts
npm run lint:types
npm run build
npm run test:compiled
