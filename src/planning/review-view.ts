import { reviewReply, type ReviewModel, type ReviewNote } from './review-model.js';

export type ClipboardCopyApi = {
  writeText?: (text: string) => Promise<void>;
  legacyCopy: (text: string) => boolean;
};

export async function attemptClipboardCopy(text: string, api: ClipboardCopyApi): Promise<boolean> {
  if (api.writeText) {
    try {
      await api.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path when clipboard permission is unavailable.
    }
  }
  try {
    return api.legacyCopy(text) === true;
  } catch {
    return false;
  }
}

const html = (value: unknown) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const list = (items: string[], empty: string) => items.length
  ? `<ul>${items.map(item => `<li>${html(item)}</li>`).join('')}</ul>`
  : `<p class="empty">${html(empty)}</p>`;

export function renderReviewContent(model: ReviewModel): string {
  const facts = model.answers.filter(answer => answer.kind === 'fact');
  const preferences = model.answers.filter(answer => answer.kind === 'preference');
  const answers = (items: ReviewModel['answers'], empty: string) => items.length
    ? `<dl>${items.map(item => `<div><dt>${html(item.key)}</dt><dd>${html(item.value)}</dd></div>`).join('')}</dl>`
    : `<p class="empty">${html(empty)}</p>`;
  const slides = model.slides.map(slide => {
    const noteLabel = `第 ${slide.number} 页「${slide.title}」`;
    return `<article class="review-slide${slide.isSample ? ' is-sample' : ''}" data-slide-number="${slide.number}">
      <header><span class="slide-number">${String(slide.number).padStart(2, '0')}</span><div><h3>${html(slide.title)}</h3><p>${html(slide.coreMessage)}</p></div>${slide.isSample ? '<strong class="sample-badge">样页</strong>' : ''}</header>
      <section><h4>内容关系</h4>${list(slide.relationships, '未提供内容关系')}</section>
      <details><summary>展开完整文字</summary><div class="full-copy">${slide.requiredText.length ? slide.requiredText.map(text => `<p>${html(text)}</p>`).join('') : '<p class="empty">未提供页面文字</p>'}</div></details>
      <section><h4>来源</h4>${list(slide.sourceRefs, '未标注来源')}</section>
      <label class="note-field"><span>${html(noteLabel)}修改意见</span><textarea rows="3" data-review-note data-note-label="${html(noteLabel)}" placeholder="可选：写下这一页需要修改的内容"></textarea></label>
    </article>`;
  }).join('\n');

  return `<section class="review-content" aria-labelledby="review-title">
    <div class="section-heading"><p class="eyebrow">方案回看</p><h2 id="review-title">整体方案</h2><p>${html(model.narrativeSummary)}</p></div>
    <div class="context-grid">
      <section><h3>已确认事实</h3>${answers(facts, '未记录额外事实')}</section>
      <section><h3>用户偏好</h3>${answers(preferences, '未记录额外偏好')}</section>
      <section><h3>关键假设</h3>${list(model.assumptions, '无额外假设')}</section>
    </div>
    <label class="note-field overall-note"><span>整体方案修改意见</span><textarea rows="4" data-review-note data-note-label="整体方案" placeholder="可选：写下整体叙事或取舍需要修改的内容"></textarea></label>
    <div class="review-slides" aria-label="逐页方案">${slides}</div>
    <section class="review-references"><h3>方案参考文件</h3>${model.references.length ? `<dl>${model.references.map(reference => `<div><dt>${reference.role === 'art-direction' ? '画风参考' : '内容参考'}</dt><dd>${html(reference.path)}</dd></div>`).join('')}</dl>` : '<p class="empty">未附加参考文件</p>'}</section>
  </section>`;
}

export function installReviewInteractions(model: ReviewModel): void {
  const notes = [...document.querySelectorAll<HTMLTextAreaElement>('[data-review-note]')];
  const choice = document.getElementById('choice')!;
  const confirmButton = document.getElementById('copy-confirm') as HTMLButtonElement;
  const reviseButton = document.getElementById('copy-revision') as HTMLButtonElement;
  const status = document.getElementById('action-status')!;
  const manualReply = document.getElementById('manual-reply') as HTMLTextAreaElement;
  const promptSection = document.getElementById('selected-prompt')!;
  const promptText = document.getElementById('selected-prompt-text')!;
  const variantButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-action="choose"]')];
  let selectedKey: string | null = null;
  let copyPending = false;

  const currentNotes = (): ReviewNote[] => notes.map(note => ({
    label: note.dataset.noteLabel ?? '修改意见',
    text: note.value,
  }));
  const invalidateCopy = () => {
    manualReply.value = '';
    manualReply.hidden = true;
    status.textContent = '草稿已更新；请重新复制当前回复。';
  };
  const refresh = (invalidate = false) => {
    if (invalidate) invalidateCopy();
    const notesNow = currentNotes();
    const hasNotes = notesNow.some(note => note.text.trim());
    const hasVariant = selectedKey !== null && Object.hasOwn(model.variants, selectedKey);
    confirmButton.disabled = !hasVariant || hasNotes;
    reviseButton.disabled = !hasNotes;
  };
  const copy = async (reply: string) => {
    if (copyPending) return;
    copyPending = true;
    const previousNoteStates = notes.map(note => note.readOnly);
    const previousVariantStates = variantButtons.map(button => button.disabled);
    const previousConfirmState = confirmButton.disabled;
    const previousReviseState = reviseButton.disabled;
    notes.forEach(note => { note.readOnly = true; });
    variantButtons.forEach(button => { button.disabled = true; });
    confirmButton.disabled = true;
    reviseButton.disabled = true;
    status.textContent = '正在复制当前回复，期间暂停修改和换款…';
    try {
      const copied = await attemptClipboardCopy(reply, {
        writeText: navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
          ? value => navigator.clipboard.writeText(value) : undefined,
        legacyCopy: value => {
          const area = document.createElement('textarea');
          area.value = value;
          document.body.append(area);
          area.select();
          try { return document.execCommand('copy') === true; } finally { area.remove(); }
        },
      });
      if (copied) {
        manualReply.hidden = true;
        status.textContent = '已复制；请将回复发送给 Agent。页面未提交方案。';
      } else {
        manualReply.value = reply;
        manualReply.hidden = false;
        manualReply.select();
        status.textContent = '剪贴板复制失败，已选中下方完整回复，请手动复制。';
      }
    } finally {
      notes.forEach((note, index) => { note.readOnly = previousNoteStates[index] ?? false; });
      variantButtons.forEach((button, index) => { button.disabled = previousVariantStates[index] ?? false; });
      confirmButton.disabled = previousConfirmState;
      reviseButton.disabled = previousReviseState;
      copyPending = false;
      refresh();
    }
  };

  notes.forEach(note => note.addEventListener('input', () => {
    if (!copyPending) refresh(true);
  }));
  document.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest('button');
    if (copyPending || !button || button.dataset.action !== 'choose') return;
    const key = button.dataset.variantKey ?? '';
    if (!Object.hasOwn(model.variants, key)) return;
    selectedKey = key;
    invalidateCopy();
    choice.textContent = model.variants[key]!.choice;
    promptText.textContent = model.variants[key]!.prompt;
    promptSection.hidden = false;
    status.textContent = '已选择组合；请核对完整 prompt。选择本身不会生成图片。';
    refresh();
  });
  confirmButton.addEventListener('click', async () => {
    const notesNow = currentNotes();
    if (copyPending || confirmButton.disabled || notesNow.some(note => note.text.trim())) return;
    const reply = reviewReply(model, selectedKey, notesNow);
    if (reply) await copy(reply);
  });
  reviseButton.addEventListener('click', async () => {
    const notesNow = currentNotes();
    if (copyPending || reviseButton.disabled || !notesNow.some(note => note.text.trim())) return;
    const reply = reviewReply(model, selectedKey, notesNow);
    if (reply) await copy(reply);
  });
  refresh();
}
