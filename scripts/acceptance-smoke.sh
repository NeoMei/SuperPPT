#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "$#" -ne 1 ]]; then
  printf '用法: %s <SuperPPT 项目根目录>\n' "$0" >&2
  exit 64
fi

project_root="$1"
cd "$repository_root"

printf '正在通过 SuperPPT 公共 CLI 创建或定位受控 smoke copy：\n'
npm run --silent cli -- acceptance-smoke-copy --project "$project_root"

printf '\n人工验收清单（本脚本不操作 WPS/PowerPoint，也不声明验收通过）：\n'
printf '1. 选定对象：只在返回的 deck-smoke.pptx 中选定一个具体文字或对象并记录。\n'
printf '2. 临时修改：对该对象做一个容易辨认的临时修改。\n'
printf '3. 观察：确认临时修改在客户端中可见并记录观察结果。\n'
printf '4. 撤销：撤销临时修改并确认原内容恢复。\n'
printf '5. 丢弃/不保存：关闭时明确选择丢弃或不保存。\n'
printf '6. 关闭：确认受控 smoke copy 已关闭。\n'
printf '7. 重开：重新打开同一受控 smoke copy。\n'
printf '8. 核验原内容：确认重开后仍是原内容，再由人工填写私有 acceptance-record 输入。\n'
printf '禁止打开、编辑或保存 canonical output/revisions/<n>/deck.pptx。\n'
