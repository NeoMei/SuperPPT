import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWrite, taskPath } from '../project/task-store.js';
import { attemptClipboardCopy, installReviewInteractions, renderReviewContent } from '../planning/review-view.js';
export { attemptClipboardCopy } from '../planning/review-view.js';
export type { ClipboardCopyApi } from '../planning/review-view.js';
import { reviewReply, type ReviewModel } from '../planning/review-model.js';
import type { StyleSelection } from './selection.js';
import { loadRemoteStyleAssets } from './remote-assets.js';

export type StyleSelectionView = {
  title: string;
  purpose: string;
  audience: string;
  selection: StyleSelection;
  review?: ReviewModel;
};

const html = (value: unknown) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const scriptJson = (value: unknown) => JSON.stringify(value)
  .replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

async function embedAsset(assetsRoot: string, path: string | null): Promise<string | null> {
  if (!path || isAbsolute(path) || path.includes('\\')) return null;
  const root = await realpath(assetsRoot);
  const target = resolve(root, path), fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('..' + sep)) return null;
  try {
    let cursor = root;
    for (const part of fromRoot.split(sep)) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) return null;
    }
    const finalTarget = await realpath(target), finalFromRoot = relative(root, finalTarget);
    if (!finalFromRoot || finalFromRoot === '..' || finalFromRoot.startsWith('..' + sep)) return null;
    const info = await lstat(finalTarget);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 500_000) return null;
    const extension = extname(path).toLowerCase();
    const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.png' ? 'image/png' : null;
    if (!mime) return null;
    const bytes = await readFile(finalTarget);
    return bytes.length <= 500_000 ? `data:${mime};base64,${bytes.toString('base64')}` : null;
  } catch (error: unknown) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

function imageMarkup(source: string | null, alt: string, missing: string): string {
  return source
    ? `<img src="${html(source)}" alt="${html(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="missing-image" hidden role="img" aria-label="图片加载失败"><span>图片加载失败</span><small>请检查网络或稍后重试；组合仍可选择</small></span>`
    : `<div class="missing-image" role="img" aria-label="${html(missing)}"><span>暂无图片</span><small>${html(missing)}</small></div>`;
}

export async function writeStyleSelectionView(root: string, relativePath: string, view: StyleSelectionView, assetsRoot: string): Promise<string> {
  const paths = new Set<string>();
  for (const style of view.selection.styles) {
    if (style.card.imagePath) paths.add(style.card.imagePath);
    for (const group of style.groups) for (const variant of group.variants) if (variant.previewPath) paths.add(variant.previewPath);
  }
  const embedded = new Map<string, string | null>();
  const remoteAssets = await loadRemoteStyleAssets(assetsRoot);
  await Promise.all([...paths].map(async path => embedded.set(path,
    Object.hasOwn(remoteAssets, path) ? remoteAssets[path]!.url : await embedAsset(assetsRoot, path))));
  const imageNotice = [...paths].some(path => Object.hasOwn(remoteAssets, path))
    ? '打开页面会从图床加载公开的风格图片；选款不会调用生成服务。'
    : '选择本身不会发送请求。';

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
        const key = `${variant.styleId}/${variant.level}/${variant.paletteId}`;
        return `<button type="button" class="variant-button${missing ? ' is-missing' : ''}" data-action="choose" data-selectable="true" data-variant-key="${html(key)}" data-choice="${html(choice)}">
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

  const reviewContent = view.review ? renderReviewContent(view.review) : '';
  const reviewModelScript = view.review ? `const reviewModel=${scriptJson(view.review)};` : '';
  const reviewInteractionScript = view.review
    ? `const __name=(target,value)=>Object.defineProperty(target,'name',{value,configurable:true});\n${reviewReply.toString()}\n${installReviewInteractions.toString()}\ninstallReviewInteractions(reviewModel);`
    : '';

  const document = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(view.title)} · 风格选择</title>
<style>
:root{color-scheme:dark;--bg:#081018;--panel:#111b26;--line:#263748;--text:#f5f7fa;--muted:#9cafc1;--accent:#78dce8;--warn:#ffc66d}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#183044 0,transparent 32rem),var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(1440px,calc(100% - 32px));margin:auto;padding:42px 0 100px}header.hero{display:grid;grid-template-columns:1fr minmax(260px,420px);gap:28px;align-items:end;margin-bottom:28px}.eyebrow,.panel-heading p{color:var(--accent);letter-spacing:.14em;text-transform:uppercase;font-size:12px;font-weight:700}.hero h1,.panel-heading h2{font-size:clamp(30px,5vw,64px);line-height:1;margin:.25rem 0 1rem}.meta{display:grid;gap:10px;color:var(--muted);border-left:1px solid var(--line);padding-left:22px}.notice{grid-column:1/-1;border:1px solid #345066;background:#102131;padding:14px 16px;border-radius:12px}.style-grid,.variant-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.style-card{min-width:0}.style-button,.variant-button{width:100%;height:100%;padding:0;overflow:hidden;text-align:left;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:16px;cursor:pointer;transition:.18s transform,.18s border-color}.style-button:hover,.style-button:focus-visible,.variant-button:hover,.variant-button:focus-visible{transform:translateY(-2px);border-color:var(--accent);outline:none}.media{display:block;aspect-ratio:16/9;background:#071018}.media img{display:block;width:100%;height:100%;object-fit:cover}.missing-image{height:100%;display:grid;place-content:center;text-align:center;padding:20px;background:repeating-linear-gradient(135deg,#111d28,#111d28 12px,#152331 12px,#152331 24px);color:var(--warn)}.missing-image span{font-weight:700}.missing-image small{max-width:24ch;color:#d7b77f}.card-copy,.variant-copy{display:grid;gap:4px;padding:14px}.card-copy strong{font-size:20px}.card-copy small,.card-copy span,.variant-copy small{color:var(--muted)}.style-panel{animation:enter .2s ease}.back{border:0;background:transparent;color:var(--accent);padding:8px 0;cursor:pointer}.panel-heading{margin:22px 0 28px}.panel-heading h2{font-size:42px}.panel-heading span{color:var(--muted)}.level-group{margin:28px 0}.level-group>header{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:9px;margin-bottom:14px}.level-group>header span{font-size:22px;font-weight:700}.level-group>header small{color:var(--muted)}.variant-button.is-missing{border-style:dashed}.variant-copy code{color:var(--accent);font-size:12px}.choice-bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);width:min(760px,calc(100% - 32px));display:flex;gap:12px;align-items:center;padding:12px 14px;background:#172635eF;border:1px solid #47617a;border-radius:14px;box-shadow:0 14px 45px #0008;backdrop-filter:blur(16px)}.choice-bar output{flex:1;min-width:0}.choice-bar code{display:block;white-space:normal;color:var(--text)}.choice-bar button{border:0;border-radius:9px;background:var(--accent);color:#05202a;font-weight:700;padding:10px 16px;cursor:pointer}@keyframes enter{from{opacity:.2;transform:translateY(8px)}}@media(max-width:720px){main{width:min(100% - 20px,1440px);padding-top:24px}.hero{grid-template-columns:1fr!important}.meta{border-left:0;padding-left:0}.style-grid,.variant-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.card-copy{padding:10px}.card-copy strong{font-size:16px}.choice-bar{align-items:stretch;flex-direction:column}.choice-bar button{width:100%}}@media(max-width:440px){.style-grid,.variant-grid{grid-template-columns:1fr}}
.media img[hidden],.missing-image[hidden]{display:none}
.section-heading{margin:56px 0 22px}.section-heading h2{font-size:clamp(28px,4vw,48px);line-height:1.1;margin:.2rem 0 .8rem}.section-heading>p:last-child,.empty{color:var(--muted)}.review-content,.review-confirmation{overflow-wrap:anywhere}.review-content{display:grid;gap:22px}.context-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.context-grid>section,.review-references,.review-confirmation{padding:20px;background:#0d1721;border:1px solid var(--line);border-radius:16px}.context-grid h3,.review-references h3{margin-top:0}.context-grid dl div,.review-references dl div{display:grid;grid-template-columns:minmax(90px,.35fr) 1fr;gap:12px;padding:8px 0;border-top:1px solid var(--line)}dt{color:var(--accent)}dd{margin:0}.review-slides{display:grid;gap:18px}.review-slide{padding:22px;background:var(--panel);border:1px solid var(--line);border-radius:18px}.review-slide.is-sample{border-color:#5a788f}.review-slide>header{display:grid;grid-template-columns:auto 1fr auto;gap:16px;align-items:start}.review-slide h3{font-size:24px;margin:0}.review-slide header p{color:var(--muted);margin:.35rem 0}.slide-number{color:var(--accent);font:700 22px/1 ui-monospace,monospace}.sample-badge{padding:5px 9px;border-radius:999px;background:#23445a;color:#bff8ff}.review-slide details,.selected-prompt details{margin:14px 0;border:1px solid var(--line);border-radius:10px;padding:10px 13px}.review-slide summary,.selected-prompt summary{cursor:pointer;color:var(--accent)}.full-copy{white-space:pre-wrap}.note-field{display:grid;gap:7px;margin-top:16px}.note-field span{font-weight:700}.note-field textarea,.review-actions textarea{width:100%;resize:vertical;border:1px solid #3b536a;border-radius:9px;background:#071018;color:var(--text);padding:10px;font:inherit}.overall-note{padding:18px;border:1px solid var(--line);border-radius:14px;background:#0d1721}.visual-heading{margin-bottom:20px}.review-confirmation{margin:56px 0 24px}.selected-prompt pre{max-height:28rem;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#d8eff3}.review-actions{position:sticky;left:auto;bottom:0;transform:none;width:min(1120px,calc(100% - 32px));display:grid;grid-template-columns:minmax(220px,1fr) auto auto;align-items:center;margin:0 auto 20px}.review-actions p{margin:0;color:var(--muted)}.review-actions textarea{grid-column:1/-1;max-height:9rem}.choice-bar button:disabled{cursor:not-allowed;opacity:.45}
@media(max-width:900px){.context-grid{grid-template-columns:1fr}.review-actions{position:static;grid-template-columns:1fr}.review-actions textarea{grid-column:auto}}
</style></head><body><main>
<header class="hero"><div><p class="eyebrow">${view.review ? '方案确认' : '第一轮 · 选择风格'}</p><h1>${html(view.title)}</h1><p>${view.review ? '核对内容、再选择视觉组合，最后复制回复发给 Agent。' : '先浏览全部风格，再进入单个风格查看其真实档位与配色组合。'}</p></div><div class="meta"><span><strong>用途</strong> ${html(view.purpose)}</span><span><strong>受众</strong> ${html(view.audience)}</span>${view.review ? `<span><strong>总页数</strong> ${view.review.slides.length} 页</span>` : ''}</div><div class="notice">${imageNotice}${view.review ? '页面选择和意见是未提交草稿，刷新不保证保留。复制后发送给 Agent 才会执行。' : '把选款回复交给 Agent 后，由现有 plan-review 决策披露并提交确切样页 prompt、1 次调用预算和输出位置。'}</div></header>
${reviewContent}
${view.review ? `<div class="section-heading visual-heading"><p class="eyebrow">视觉方向</p><h2>风格 → 档位 → 配色</h2><p>先选风格，再在该风格中选择一个现有组合。</p></div>` : ''}
<section id="styles-view" aria-label="全部风格"><div class="style-grid">${cards}</div></section>
${panels}
${view.review ? `<section class="review-confirmation" aria-labelledby="confirmation-title"><div class="section-heading"><p class="eyebrow">生成边界</p><h2 id="confirmation-title">样页生成确认</h2><p>代表页：${html(view.review.slides.find(slide => slide.isSample)?.title ?? '未标记')}；新增生图预算：${view.review.callBudget} 次；输出位置：${html(view.review.output)}。</p><p>方案版本：${html(view.review.revision)}；决定编号：${html(view.review.decisionId)}。</p><p>选择风格不会授权生成。只有复制确认回复并发送给 Agent 后才会执行。</p></div><section class="selected-prompt" id="selected-prompt" hidden><h3>已选组合的完整样页 prompt</h3><details open><summary>展开完整 prompt</summary><pre id="selected-prompt-text"></pre></details></section></section>` : ''}
</main>${view.review ? `<aside class="choice-bar review-actions" aria-live="polite"><output id="choice">尚未选择组合</output><p id="action-status">选择组合或填写修改意见。</p><button type="button" id="copy-revision" disabled>复制修改回复</button><button type="button" id="copy-confirm" disabled>复制确认回复</button><textarea id="manual-reply" hidden readonly aria-label="手动复制的完整回复"></textarea></aside>` : `<aside class="choice-bar" aria-live="polite"><output id="choice"><code>尚未选择组合</code></output><button type="button" id="copy-choice" disabled>复制回复</button></aside>`}
<script>
${attemptClipboardCopy.toString()}
${reviewModelScript}
const list=document.getElementById('styles-view'),panels=[...document.querySelectorAll('[data-style-panel]')],choice=document.getElementById('choice'),copyChoice=document.getElementById('copy-choice');
document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.action==='open-style'){list.hidden=true;panels.forEach(panel=>panel.hidden=panel.dataset.stylePanel!==button.dataset.styleId);document.getElementById('style-'+button.dataset.styleId).querySelector('button').focus();}if(button.dataset.action==='back'){panels.forEach(panel=>panel.hidden=true);list.hidden=false;list.querySelector('button').focus();}if(copyChoice&&button.dataset.action==='choose'){choice.textContent=button.dataset.choice;copyChoice.disabled=false;copyChoice.dataset.choice=button.dataset.choice;}});
if(copyChoice)copyChoice.addEventListener('click',async()=>{const text=copyChoice.dataset.choice||'';const copied=await attemptClipboardCopy(text,{writeText:navigator.clipboard&&typeof navigator.clipboard.writeText==='function'?value=>navigator.clipboard.writeText(value):undefined,legacyCopy:value=>{const area=document.createElement('textarea');area.value=value;document.body.append(area);area.select();try{return document.execCommand('copy')===true}finally{area.remove()}}});if(copied){copyChoice.textContent='已复制'}else{choice.textContent=text;const selection=window.getSelection?window.getSelection():null;if(selection){const range=document.createRange();range.selectNodeContents(choice);selection.removeAllRanges();selection.addRange(range)}copyChoice.textContent='复制失败，请手动复制上方回复'}setTimeout(()=>copyChoice.textContent='复制回复',copied?1200:3000)});
${reviewInteractionScript}
</script></body></html>`;
  await atomicWrite(await taskPath(root, relativePath), document);
  return relativePath;
}
