/* ---------- Naze Sources card ---------- */
function buildSourcesCard(grounding){
  const card = document.createElement('div'); card.className='sources-card';
  const head = document.createElement('div'); head.className='sources-head';
  head.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/></svg> Naze Sources`;
  card.appendChild(head);
  const list = document.createElement('div'); list.className='sources-list';
  grounding.sources.forEach(s=>{
    let uri = String(s.uri||'');
    // Only ever render http(s) links — never let an unexpected scheme (e.g. javascript:) through.
    if(!/^https?:\/\//i.test(uri)) return;
    let domain = uri;
    try{ domain = new URL(uri).hostname.replace(/^www\./,''); }catch(e){}
    const a = document.createElement('a');
    a.className='source-chip'; a.href = uri; a.target='_blank'; a.rel='noopener noreferrer';
    a.innerHTML = `<span class="s-title">${escapeHtml(s.title||domain)}</span><span class="s-domain">${escapeHtml(domain)}</span>`;
    list.appendChild(a);
  });
  card.appendChild(list);
  if(grounding.queries && grounding.queries.length){
    const q = document.createElement('div'); q.className='sources-queries';
    q.textContent = 'Dicari: ' + grounding.queries.join(' · ');
    card.appendChild(q);
  }
  return card;
}

/* ---------- Render a message element ---------- */
function renderMessageEl(m, animate){
  const row = document.createElement('div');
  row.className = 'msg-row ' + (m.role==='user'?'user':'ai') + (animate?' msg-in':'');
  const avatar = document.createElement('div');
  avatar.className = 'avatar' + (m.role==='ai'?' ai':'');
  avatar.innerHTML = m.role==='ai'
    ? `<svg viewBox="0 0 24 24" fill="none"><path d="M6 16V6l10 10V6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>`;
  const col = document.createElement('div'); col.className='bubble-col';

  if(m.atts && m.atts.length){
    const attRow = document.createElement('div'); attRow.className='att-row';
    m.atts.forEach(a=> attRow.appendChild(buildAttChip(a,false)));
    col.appendChild(attRow);
  }

  const bubble = document.createElement('div'); bubble.className='bubble';
  if(m.role==='ai' && m.generatedImage){
    const wrap = document.createElement('div'); wrap.className='gen-image-wrap';
    const img = document.createElement('img'); img.src = m.generatedImage; img.alt = m.text || 'Gambar buatan NAZE'; img.className='gen-image';
    wrap.appendChild(img);
    bubble.appendChild(wrap);
    const badge = document.createElement('div'); badge.className='gen-image-badge';
    badge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg> Dibuat oleh Hugging Face (FLUX.1-schnell)`;
    bubble.appendChild(badge);
  } else if(m.role==='ai'){
    if(markdownOn){
      bubble.appendChild(renderMarkdown(m.text||''));
    } else {
      bubble.style.whiteSpace = 'pre-wrap';
      bubble.appendChild(document.createTextNode(m.text||''));
    }
  } else {
    m.text && bubble.appendChild(document.createTextNode(m.text));
  }
  col.appendChild(bubble);

  if(m.role==='ai' && m.fallbackProvider){
    const badge = document.createElement('div');
    badge.className='fallback-badge';
    badge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg> Dijawab oleh ${escapeHtml(m.fallbackProvider)} — Gemini sedang tidak tersedia, jadi tanpa gambar/Auto Browse untuk pesan ini`;
    col.insertBefore(badge, bubble);
  }

  if(m.role==='ai' && m.grounding && m.grounding.sources && m.grounding.sources.length){
    col.appendChild(buildSourcesCard(m.grounding));
  }

  if(m.role==='ai' && m.nazeCodeBlocks && m.nazeCodeBlocks.length){
    const btn = document.createElement('button');
    btn.className = 'naze-code-open-btn';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg> Open in Naze Code`;
    btn.addEventListener('click', async ()=>{
      const files = {};
      m.nazeCodeBlocks.forEach(b=> files[b.path] = b.content);
      const guessedName = m.nazeCodeBlocks.find(b=>/index\.html?$/i.test(b.path)) ? 'Web project' : 'Project baru';
      await createProjectFromFilesAndOpen(files, guessedName);
    });
    col.appendChild(btn);
  }
  if(m.role==='ai' && m.nazeCodePending){
    const badge = document.createElement('button');
    badge.className = 'naze-code-applied-badge';
    badge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Tinjau ${m.nazeCodePatchFiles.length} perubahan file`;
    badge.addEventListener('click', ()=> openCodeWorkspaceWithDiff(m.nazeCodeProjectId, m.nazeCodePatchId));
    col.appendChild(badge);
  }

  if(m.role==='ai' && m.text){
    const actions = document.createElement('div'); actions.className='msg-actions';
    actions.innerHTML = `
      <button data-a="copy" aria-label="Salin"><span class="copy-tip">Tersalin!</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      <button data-a="regen" aria-label="Buat ulang"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
      <button data-a="like" aria-label="Suka"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14Z"/></svg></button>
      <button data-a="dislike" aria-label="Tidak suka"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10Z"/></svg></button>
      <button data-a="share" aria-label="Bagikan"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5 15.4 17M15.4 7l-6.8 3.5"/></svg></button>`;
    bindCopyBtn(actions.querySelector('[data-a="copy"]'), m.text);
    actions.querySelector('[data-a="regen"]').addEventListener('click', ()=>regenerate(m.id));
    actions.querySelector('[data-a="like"]').addEventListener('click', (e)=>{ e.currentTarget.classList.toggle('active-like'); actions.querySelector('[data-a="dislike"]').classList.remove('active-dislike'); });
    actions.querySelector('[data-a="dislike"]').addEventListener('click', (e)=>{ e.currentTarget.classList.toggle('active-dislike'); actions.querySelector('[data-a="like"]').classList.remove('active-like'); });
    actions.querySelector('[data-a="share"]').addEventListener('click', async ()=>{
      if(navigator.share){ try{ await navigator.share({text:m.text}); }catch(e){} }
      else { navigator.clipboard.writeText(m.text); showToastError('Teks jawaban disalin ke clipboard.'); }
    });
    col.appendChild(actions);
  }

  row.appendChild(avatar); row.appendChild(col);
  return row;
}

