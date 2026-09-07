import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { atomicWrite, taskPath } from '../project/task-store.js';
import type { StyleSelection } from './selection.js';

export type StyleSelectionView = {
  title: string;
  purpose: string;
  audience: string;
  selection: StyleSelection;
};

const html = (value: unknown) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

async function embedAsset(assetsRoot: string, path: string | null): Promise<string | null> {
  if (!path || isAbsolute(path) || path.includes('\\')) return null;
  const root = await realpath(assetsRoot);
  const target = resolve(root, path), fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('..' + sep)) return null;
  try {
    const bytes = await readFile(target);
    if (bytes.length > 500_000) return null;
    const extension = extname(path).toLowerCase();
    const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.png' ? 'image/png' : null;
    return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function imageMarkup(source: string | null, alt: string, missing: string): string {
  return source
    ? `<img src="${source}" alt="${html(alt)}" loading="lazy">`
    : `<div class="missing-image" role="img" aria-label="${html(missing)}"><span>暂无图片</span><small>${html(missing)}</small></div>`;
}

export async function writeStyleSelectionView(root: string, relativePath: string, view: StyleSelectionView, assetsRoot: string): Promise<string> {
  const paths = new Set<string>();
  for (const style of view.selection.styles) {
    if (style.card.imagePath) paths.add(style.card.imagePath);
    for (const group of style.groups) for (const variant of group.variants) if (variant.previewPath) paths.add(variant.previewPath);
  }
  const embedded = new Map<string, string | null>();
  await Promise.all([...paths].map(async path => embedded.set(path, await embedAsset(assetsRoot, path))));

  const cards = view.selection.styles.map((style, index) => {
    const source = style.card.imagePath ? embedded.get(style.card.imagePath) ?? null : null;
    const imageLabel = !source
      ? style.card.imagePath ? '参考图路径缺失' : '没有代表展示图'
      : style.card.imageKind === 'showcase' ? '代表展示图' : '组合参考图';
    return `<article class="style-card">
      <button type="button" class="style-button" data-action="open-style" data-style-id="${html(style.id)}" aria-controls="style-${html(style.id)}">
        <span class="media">${imageMarkup(source, `${style.name} ${imageLabel}`, '此风格没有可嵌入的代表展示图')}</span>
        <span class="card-copy"><small>${String(index + 1).padStart(2, '0')} · ${html(imageLabel)}</small><strong>${html(style.name)}</strong><span>${style.groups.reduce((count, group) => count + group.variants.length, 0)} 个可选组合</span></span>
      </button>
    </article>`;
  }).join('\n');

  const panels = view.selection.styles.map(style => {
    const groups = style.groups.map(group => `<section class="level-group" aria-labelledby="style-${html(style.id)}-level-${group.level}">
      <header id="style-${html(style.id)}-level-${group.level}"><span>${group.level} 档</span><small>${group.variants.length} 种配色</small></header>
      <div class="variant-grid">${group.variants.map(variant => {
        const source = variant.previewPath ? embedded.get(variant.previewPath) ?? null : null;
        const missing = variant.previewStatus === 'missing' || !source;
        const choice = `选择${variant.styleName}，${variant.level} 档，${variant.paletteName}`;
        return `<button type="button" class="variant-button${missing ? ' is-missing' : ''}" data-action="choose" data-selectable="true" data-choice="${html(choice)}">
          <span class="media">${imageMarkup(source, `${choice}的精确预览`, missing ? '缺少该组合的精确预览；组合仍可选择' : '')}</span>
          <span class="variant-copy"><strong>${html(variant.paletteName)}</strong><code>${html(variant.styleId)}/${variant.level}/${html(variant.paletteId)}</code>${missing ? '<small>缺少该组合的精确预览 · 仍可选择</small>' : '<small>精确组合预览</small>'}</span>
        </button>`;
      }).join('')}</div>
    </section>`).join('');
    return `<section id="style-${html(style.id)}" class="style-panel" data-style-panel="${html(style.id)}" hidden>
      <button type="button" class="back" data-action="back">← 返回风格列表</button>
      <div class="panel-heading"><p>第二轮 · 档位与配色</p><h2>${html(style.name)}</h2><span>选择一个现有组合；缺图不会禁用该配方。</span></div>
      ${groups}
    </section>`;
  }).join('\n');

  const document = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(view.title)} · 风格选择</title>
<style>
:root{color-scheme:dark;--bg:#081018;--panel:#111b26;--line:#263748;--text:#f5f7fa;--muted:#9cafc1;--accent:#78dce8;--warn:#ffc66d}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#183044 0,transparent 32rem),var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(1440px,calc(100% - 32px));margin:auto;padding:42px 0 100px}header.hero{display:grid;grid-template-columns:1fr minmax(260px,420px);gap:28px;align-items:end;margin-bottom:28px}.eyebrow,.panel-heading p{color:var(--accent);letter-spacing:.14em;text-transform:uppercase;font-size:12px;font-weight:700}.hero h1,.panel-heading h2{font-size:clamp(30px,5vw,64px);line-height:1;margin:.25rem 0 1rem}.meta{display:grid;gap:10px;color:var(--muted);border-left:1px solid var(--line);padding-left:22px}.notice{grid-column:1/-1;border:1px solid #345066;background:#102131;padding:14px 16px;border-radius:12px}.style-grid,.variant-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.style-card{min-width:0}.style-button,.variant-button{width:100%;height:100%;padding:0;overflow:hidden;text-align:left;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:16px;cursor:pointer;transition:.18s transform,.18s border-color}.style-button:hover,.style-button:focus-visible,.variant-button:hover,.variant-button:focus-visible{transform:translateY(-2px);border-color:var(--accent);outline:none}.media{display:block;aspect-ratio:16/9;background:#071018}.media img{display:block;width:100%;height:100%;object-fit:cover}.missing-image{height:100%;display:grid;place-content:center;text-align:center;padding:20px;background:repeating-linear-gradient(135deg,#111d28,#111d28 12px,#152331 12px,#152331 24px);color:var(--warn)}.missing-image span{font-weight:700}.missing-image small{max-width:24ch;color:#d7b77f}.card-copy,.variant-copy{display:grid;gap:4px;padding:14px}.card-copy strong{font-size:20px}.card-copy small,.card-copy span,.variant-copy small{color:var(--muted)}.style-panel{animation:enter .2s ease}.back{border:0;background:transparent;color:var(--accent);padding:8px 0;cursor:pointer}.panel-heading{margin:22px 0 28px}.panel-heading h2{font-size:42px}.panel-heading span{color:var(--muted)}.level-group{margin:28px 0}.level-group>header{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:9px;margin-bottom:14px}.level-group>header span{font-size:22px;font-weight:700}.level-group>header small{color:var(--muted)}.variant-button.is-missing{border-style:dashed}.variant-copy code{color:var(--accent);font-size:12px}.choice-bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);width:min(760px,calc(100% - 32px));display:flex;gap:12px;align-items:center;padding:12px 14px;background:#172635eF;border:1px solid #47617a;border-radius:14px;box-shadow:0 14px 45px #0008;backdrop-filter:blur(16px)}.choice-bar output{flex:1;min-width:0}.choice-bar code{display:block;white-space:normal;color:var(--text)}.choice-bar button{border:0;border-radius:9px;background:var(--accent);color:#05202a;font-weight:700;padding:10px 16px;cursor:pointer}@keyframes enter{from{opacity:.2;transform:translateY(8px)}}@media(max-width:720px){main{width:min(100% - 20px,1440px);padding-top:24px}.hero{grid-template-columns:1fr!important}.meta{border-left:0;padding-left:0}.style-grid,.variant-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.card-copy{padding:10px}.card-copy strong{font-size:16px}.choice-bar{align-items:stretch;flex-direction:column}.choice-bar button{width:100%}}@media(max-width:440px){.style-grid,.variant-grid{grid-template-columns:1fr}}
</style></head><body><main>
<header class="hero"><div><p class="eyebrow">第一轮 · 选择风格</p><h1>${html(view.title)}</h1><p>先浏览全部风格，再进入单个风格查看其真实档位与配色组合。</p></div><div class="meta"><span><strong>用途</strong> ${html(view.purpose)}</span><span><strong>受众</strong> ${html(view.audience)}</span></div><div class="notice">选择本身不会发送请求。把选款回复交给 Agent 后，由现有 plan-review 决策披露并提交确切样页 prompt、1 次调用预算和输出位置。</div></header>
<section id="styles-view" aria-label="全部风格"><div class="style-grid">${cards}</div></section>
${panels}
</main><aside class="choice-bar" aria-live="polite"><output id="choice"><code>尚未选择组合</code></output><button type="button" id="copy-choice" disabled>复制回复</button></aside>
<script>
const list=document.getElementById('styles-view'),panels=[...document.querySelectorAll('[data-style-panel]')],choice=document.getElementById('choice'),copy=document.getElementById('copy-choice');
document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.action==='open-style'){list.hidden=true;panels.forEach(panel=>panel.hidden=panel.dataset.stylePanel!==button.dataset.styleId);document.getElementById('style-'+button.dataset.styleId).querySelector('button').focus();}if(button.dataset.action==='back'){panels.forEach(panel=>panel.hidden=true);list.hidden=false;list.querySelector('button').focus();}if(button.dataset.action==='choose'){choice.replaceChildren(Object.assign(document.createElement('code'),{textContent:button.dataset.choice}));copy.disabled=false;copy.dataset.choice=button.dataset.choice;}});
copy.addEventListener('click',async()=>{const text=copy.dataset.choice||'';try{await navigator.clipboard.writeText(text)}catch{const area=document.createElement('textarea');area.value=text;document.body.append(area);area.select();document.execCommand('copy');area.remove()}copy.textContent='已复制';setTimeout(()=>copy.textContent='复制回复',1200)});
</script></body></html>`;
  await atomicWrite(await taskPath(root, relativePath), document);
  return relativePath;
}
