#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

node scripts/verify-contract.mjs
npm test
npm run lint:types
npm run build
npm run test:compiled
npm run audit:dependencies
git diff --check
