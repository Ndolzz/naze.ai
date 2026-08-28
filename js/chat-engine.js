/* ---------- Sending / streaming ---------- */
function setImageGenMode(v){
  imageGenMode = v;
  $('#imagegen-pill').style.display = v ? 'flex' : 'none';
  $('#text-input').placeholder = v ? 'Jelaskan gambar yang ingin dibuat NAZE...' : 'Tanyakan sesuatu ke NAZE AI...';
}

async function sendMessage(){
  const input = $('#text-input');
  const text = input.value.trim();
  if(!text && pendingAtts.length===0) return;
  if(isStreaming) return;

  if(imageGenMode){
    if(!text) return;
    await ensureChat(text);
    const userMsg = { id: uid(), role:'user', text, atts: [] };
    messages.push(userMsg);
    $('#welcome').style.display='none';
    $('#thread').appendChild(renderMessageEl(userMsg, true));
    input.value=''; input.style.height='auto';
    setImageGenMode(false);
    updateSendState();
    await persistMessages();
    scrollToBottom();
    await runImageGenTurn(text);
    return;
  }

  await ensureChat(text);
  const c = chats.find(x=>x.id===currentChatId); if(c){ c.thinking = thinkingOn; }

  const userMsg = { id: uid(), role:'user', text, atts: pendingAtts };
  messages.push(userMsg);
  $('#welcome').style.display='none';
  $('#thread').appendChild(renderMessageEl(userMsg, true));
  input.value=''; input.style.height='auto';
  const atts = pendingAtts; pendingAtts=[]; renderPreviewStrip();
  updateSendState();
  await persistMessages();
  scrollToBottom();

  await runAssistantTurn(atts);
}

async function regenerate(msgId){
  if(isStreaming) return;
  const idx = messages.findIndex(m=>m.id===msgId);
  if(idx<0) return;
  const wasImageGen = !!messages[idx].generatedImage;
  // The prompt that produced this image lived on the user message right before it.
  const priorUserMsg = wasImageGen ? [...messages.slice(0, idx)].reverse().find(m=>m.role==='user') : null;
  // drop this ai message and everything after, re-run based on prior user message
  messages = messages.slice(0, idx);
  const thread = $('#thread'); thread.innerHTML='';
  messages.forEach(m=>thread.appendChild(renderMessageEl(m)));
  await persistMessages();
  if(wasImageGen && priorUserMsg){
    await runImageGenTurn(priorUserMsg.text);
  } else {
    await runAssistantTurn([]);
  }
}

// Bug fix: previously buildApiMessages() re-sent the ENTIRE chat history
// (including every past image's full base64 data) on every single new
// message. In a long chat this made each request bigger and slower than
// the last, and burned through the free daily Gemini quota fast. The full
// history still stays in `messages` / local storage untouched — only the
// payload actually sent upstream is capped.
const MAX_HISTORY_MESSAGES = 25;  // ~12 back-and-forth turns of context
const MAX_IMAGE_LOOKBACK = 3;     // only the N most recent images keep full data

function buildApiMessages(extraUserText){
  // Keep only the most recent messages. Always trim from the front so we
  // keep the tail end intact, then make sure we still start on a 'user'
  // turn (never a stray leading 'assistant' message).
  let trimmed = messages.length > MAX_HISTORY_MESSAGES ? messages.slice(-MAX_HISTORY_MESSAGES) : messages;
  if(trimmed.length && trimmed[0].role === 'assistant'){ trimmed = trimmed.slice(1); }

  // Walking backwards, only let the most recent few image attachments keep
  // their full base64 data — older photos in the same chat get replaced
  // with a short text note instead of being re-uploaded every single turn.
  let imageBudget = MAX_IMAGE_LOOKBACK;
  const fullImageIds = new Set();
  for(let i=trimmed.length-1; i>=0; i--){
    const m = trimmed[i];
    if(m.role!=='user' || !m.atts) continue;
    for(let j=m.atts.length-1; j>=0; j--){
      const a = m.atts[j];
      if(a.kind==='image' && a.b64 && imageBudget>0){ fullImageIds.add(a.id); imageBudget--; }
    }
  }

  // Convert local `messages` into Anthropic API message format
  const apiMsgs = trimmed.map((m, i)=>{
    if(m.role==='user'){
      const content = [];
      (m.atts||[]).forEach(a=>{
        if(a.kind==='image' && a.b64){
          if(fullImageIds.has(a.id)){
            content.push({type:'image', source:{type:'base64', media_type:a.mediaType||'image/jpeg', data:a.b64}});
          } else {
            content.push({type:'text', text:`[Gambar terlampir sebelumnya: ${a.name} — tidak dikirim ulang ke AI supaya lebih hemat & cepat]`});
          }
        } else if(a.kind==='zip' && !a.unreadable && a.text){
          // Already formatted as a [PROJECT_CONTEXT]...[/PROJECT_CONTEXT]
          // block (plus prioritized file excerpts) by processZipAttachment()
          // in attachments.js — sent as-is so the model can use it directly.
          content.push({type:'text', text:a.text});
        } else if(a.kind==='zip' && a.unreadable){
          content.push({type:'text', text:`[File ZIP terlampir: ${a.name} — gagal diekstrak/dibaca oleh NAZE AI]`});
        } else if((a.kind==='doc' || a.kind==='code') && !a.unreadable && a.text){
          const trimmed2 = a.text.length>15000 ? a.text.slice(0,15000)+'\n...(dipotong)':a.text;
          content.push({type:'text', text:`[File terlampir: ${a.name}]\n\`\`\`\n${trimmed2}\n\`\`\``});
        } else if(a.unreadable){
          content.push({type:'text', text:`[File terlampir: ${a.name} — format ini belum bisa dibaca langsung di browser oleh NAZE AI]`});
        }
      });
      // Only the most recent user turn gets the (potentially sizeable)
      // Naze Code project context — same "don't resend everything every
      // message" budget approach used for images above.
      if(typeof activeCodeProject !== 'undefined' && activeCodeProject && i === trimmed.length-1){
        content.push({type:'text', text: buildCodeContextBlock(activeCodeProject, activeCodeFilePath)});
      }
      content.push({type:'text', text: m.text || '(lihat lampiran)'});
      return {role:'user', content};
    }
    return {role:'assistant', content:[{type:'text', text:m.text}]};
  });
  // Used only to resume a response that was cut short mid-stream (see
  // "Response interrupted" -> Continue). Never pushed into the visible
  // `messages` array or persisted — it exists purely for this one request
  // so the model knows to keep writing instead of restarting.
  if(extraUserText){
    apiMsgs.push({role:'user', content:[{type:'text', text: extraUserText}]});
  }
  return apiMsgs;
}

/* ---------- NAZE loading indicator (Thinking / Generating / Searching / Analyzing) ---------- */
const NAZE_LOAD_LABELS = { thinking:'Thinking...', generating:'Generating...', searching:'Searching...', analyzing:'Analyzing...' };
const NAZE_N_SVG = '<svg viewBox="0 0 40 40" fill="none"><path d="M12 27V13l16 14V13" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function setNazeLoadState(row, state){
  row.className = 'naze-load state-' + state;
  row.innerHTML = `<span class="n-badge">${NAZE_N_SVG}</span><span class="label">${NAZE_LOAD_LABELS[state] || NAZE_LOAD_LABELS.thinking}</span>`;
}
function createNazeLoadRow(state){
  const row = document.createElement('div');
  setNazeLoadState(row, state);
  return row;
}

/* ---------- Error UI (no raw provider/server errors ever shown) ---------- */
function classifyError(err, timedOut){
  if(timedOut) return {title:'Response timed out', subtitle:'The AI took too long to respond.'};
  // Offline is checked before the generic "connection lost" network-error
  // match below, since a real offline device should get an unambiguous
  // message instead of being lumped in with any other fetch/network error.
  if(typeof navigator!=='undefined' && navigator.onLine===false){
    return {title:"You're offline", subtitle:'NAZE sedang offline. Periksa koneksi internet kamu.'};
  }
  if(err && (err.name==='TypeError' || /fetch|network/i.test(String(err.message||'')))){
    return {title:'Connection lost', subtitle:'Check your internet connection and try again.'};
  }
  if(err && err.status===429){
    const retryAfter = err.retryAfter;
    return {
      title:'Too many requests',
      subtitle: retryAfter ? `Terlalu banyak permintaan. Coba lagi dalam ${retryAfter} detik.` : 'The current AI provider reached its limit.',
      retryAfter
    };
  }
  if(err && err.status){
    return {title:'Something went wrong', subtitle:"Naze couldn't generate a response."};
  }
  return {title:'Something went wrong', subtitle:'Please try again.'};
}
function buildErrorBox({title, subtitle, onRetry, final, retryAfter}){
  const box = document.createElement('div');
  box.className = 'err-box' + (final ? ' final' : '');
  box.style.maxWidth='780px'; box.style.margin='10px auto 0';
  const finalNote = final ? `<div class="err-sub" style="margin-top:4px;">Send a new message to try again.</div>` : '';
  // 429s carry a server-provided cooldown (Retry-After): show a countdown
  // and only enable the retry button once it elapses, instead of letting
  // the user immediately hammer the endpoint again.
  const hasCountdown = !final && retryAfter && retryAfter > 0;
  box.innerHTML = `
    <svg class="err-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg>
    <div class="err-text">
      <div class="err-title">${escapeHtml(title)}</div>
      <div class="err-sub">${escapeHtml(subtitle)}</div>
      ${finalNote}
    </div>
    ${final ? '' : `<button type="button" class="retry-btn"${hasCountdown?' disabled':''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/></svg><span class="retry-btn-label">${hasCountdown? ('Coba lagi ('+retryAfter+'s)') : 'Try again'}</span></button>`}
  `;
  if(!final && onRetry){
    const btn = box.querySelector('.retry-btn');
    if(hasCountdown){
      let remaining = retryAfter;
      const label = btn.querySelector('.retry-btn-label');
      const iv = setInterval(()=>{
        remaining -= 1;
        if(remaining <= 0){
          clearInterval(iv);
          btn.disabled = false;
          label.textContent = 'Try again';
        } else {
          label.textContent = `Coba lagi (${remaining}s)`;
        }
      }, 1000);
    }
    btn.addEventListener('click', ()=>{ if(btn.disabled) return; box.remove(); onRetry(); });
  }
  return box;
}

/* ---------- Streaming interrupted (connection dropped mid-answer) ---------- */
function buildInterruptedNotice(aiMsgId){
  const box = document.createElement('div');
  box.className = 'interrupt-box';
  box.style.maxWidth='780px'; box.style.margin='10px auto 0';
  box.innerHTML = `
    <span class="it-title">Response interrupted</span>
    <div class="it-actions">
      <button type="button" class="it-continue">Continue</button>
      <button type="button" class="it-regen primary">Regenerate</button>
    </div>
  `;
  box.querySelector('.it-continue').addEventListener('click', ()=>{ box.remove(); continueMessage(aiMsgId); });
  box.querySelector('.it-regen').addEventListener('click', ()=>{ box.remove(); regenerate(aiMsgId); });
  return box;
}
async function continueMessage(msgId){
  if(isStreaming) return;
  const idx = messages.findIndex(m=>m.id===msgId);
  if(idx<0) return;
  await runAssistantTurn([], 1, 'Lanjutkan jawabanmu sebelumnya persis dari kata terakhir yang sudah kamu tulis. Jangan mengulang bagian yang sudah ada dan jangan menyapa ulang — langsung sambung isinya.');
}

async function runAssistantTurn(atts, attempt=1, hiddenContinueText=null){
  isStreaming = true;
  $('#send-btn').disabled=false;
  $('#send-icon').outerHTML = `<svg id="send-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;
  $('#send-btn').classList.add('stop');

  const thread = $('#thread');
  const lastUserMsg = messages[messages.length-1];
  const hasAnyAtt = !!(lastUserMsg && lastUserMsg.atts && lastUserMsg.atts.length>0);
  const canBrowse = browseMode !== 'never';
  let initialLoadState = 'thinking';
  if(hiddenContinueText){ initialLoadState = 'generating'; }
  else if(hasAnyAtt){ initialLoadState = 'analyzing'; }
  else if(canBrowse){ initialLoadState = 'searching'; }
  const thinkRow = createNazeLoadRow(initialLoadState);
  thinkRow.style.maxWidth='780px'; thinkRow.style.margin='0 auto'; thinkRow.style.padding='0 16px';
  thread.appendChild(thinkRow); scrollToBottom();

  let sysPrompt = thinkingOn
    ? 'Kamu adalah NAZE AI, asisten AI premium yang menjawab dalam Bahasa Indonesia (kecuali diminta bahasa lain). Untuk pertanyaan ini, pikirkan secara menyeluruh dan hati-hati sebelum menjawab: pertimbangkan berbagai sudut pandang, periksa logikamu, lalu berikan jawaban akhir yang jelas, terstruktur, dan akurat. Jangan tampilkan proses berpikir mentah — langsung berikan jawaban akhir yang matang. Gunakan Markdown (heading, list, code block dengan nama bahasa, tabel, quote) bila relevan.'
    : 'Kamu adalah NAZE AI, asisten AI premium yang cepat dan ringkas, menjawab dalam Bahasa Indonesia (kecuali diminta bahasa lain). Gunakan Markdown (heading, list, code block dengan nama bahasa, tabel, quote) bila relevan. Jika ada file terlampir yang ditandai belum bisa dibaca, jangan berpura-pura sudah membacanya — beri tahu keterbatasan itu dengan jujur.';

  // If this turn attaches a ZIP project NAZE managed to read, teach the
  // model how to use the injected [PROJECT_CONTEXT] block: greet with a
  // proper analysis first, then answer follow-ups from the file excerpts
  // included — and stay honest about what wasn't included in those excerpts.
  const hasZipAtt = !!(lastUserMsg && lastUserMsg.atts && lastUserMsg.atts.some(a=>a.kind==='zip'));
  if(hasZipAtt){
    sysPrompt += ' Jika pesan pengguna berisi blok [PROJECT_CONTEXT]...[/PROJECT_CONTEXT] hasil ekstraksi file ZIP project, gunakan isinya (nama project, teknologi/bahasa, framework, dependency utama, entry point, struktur folder, dan cuplikan file) untuk memberi ringkasan analisis project secara natural — jangan menampilkan tag mentahnya. Untuk pertanyaan lanjutan tentang project ini (audit, cari error, jelaskan struktur, cari file tertentu, dsb.), jawab berdasarkan cuplikan file yang tersedia di context tersebut; jika bagian yang ditanyakan tidak termasuk dalam cuplikan yang diberikan (misalnya karena dipotong atau diabaikan seperti node_modules), katakan dengan jujur bahwa bagian itu tidak ikut terbaca, jangan mengarang isinya.';
  }

  // Naze Code: ask the model to tag file blocks (see NAZE_CODE_SYS_HINT in
  // code-state.js) whenever a Code Workspace is open, or the message itself
  // looks like a coding request — this is what lets a plain chat reply turn
  // into an actual editable project / patch instead of a wall of code.
  const wantsCodeBlocks = (typeof activeCodeProject !== 'undefined' && activeCodeProject)
    || (typeof looksLikeCodeRequest === 'function' && looksLikeCodeRequest(lastUserMsg && lastUserMsg.text));
  if(wantsCodeBlocks && typeof NAZE_CODE_SYS_HINT !== 'undefined'){
    sysPrompt += NAZE_CODE_SYS_HINT;
  }

  let aiMsg = { id: uid(), role:'ai', text:'', grounding:null, fallbackProvider:null };
  let bubbleEl = null;
  // Small, transient "Naze melanjutkan respons..." note shown while the
  // server is auto-continuing a reply that hit a provider's token ceiling
  // mid-answer. Purely a live status — not saved onto aiMsg, so it just
  // disappears once real content resumes or the message finalizes.
  let continuingNoteEl = null;
  function clearContinuingNote(){
    if(continuingNoteEl){ continuingNoteEl.remove(); continuingNoteEl = null; }
  }
  const controller = new AbortController();
  streamAbort = controller;

  // Dev-only performance timing (TTFT = Time To First Token). Never shown in
  // the UI — just logged to the browser console for debugging, per design.
  const t0 = performance.now();
  let ttft = null;
  let timedOut = false;
  const TTFT_TIMEOUT_MS = 25000; // if no token at all arrives in 25s, treat as a stalled request
  const ttftTimer = setTimeout(()=>{
    timedOut = true;
    controller.abort();
  }, TTFT_TIMEOUT_MS);

  try{
    const resp = await fetch('/api/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal: controller.signal,
      body: JSON.stringify({
        // Server now auto-continues a reply that hits this ceiling
        // (finishReason/finish_reason "length") instead of cutting it off,
        // so this is just an initial-round budget, not a hard cap on
        // answer length.
        max_tokens: 8000,
        system: sysPrompt,
        messages: buildApiMessages(hiddenContinueText),
        stream: true,
        browseMode: browseMode
      })
    });

    // The server accepted the request and is now actually generating —
    // reflect that in the loading indicator regardless of which state it
    // started in (Thinking / Searching / Analyzing all lead here).
    if(resp.ok && resp.body){ setNazeLoadState(thinkRow, 'generating'); }

    if(!resp.ok || !resp.body){
      let serverMsg = '';
      try{
        const j = await resp.json();
        if(j){
          const parts = [];
          if(j.error) parts.push(String(j.error));
          if(j.detail) parts.push(String(j.detail).slice(0,300));
          serverMsg = parts.join(' — ');
        }
      }catch(e){}
      const httpErr = new Error('HTTP '+resp.status);
      httpErr.status = resp.status;
      httpErr.serverMsg = serverMsg;
      const retryAfterHeader = resp.headers.get('Retry-After');
      if(retryAfterHeader && !isNaN(parseInt(retryAfterHeader,10))) httpErr.retryAfter = parseInt(retryAfterHeader,10);
      throw httpErr;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let started = false;

    // Perf fix: re-parsing Markdown + re-running syntax highlighting on the
    // *entire* answer for every single streamed chunk (which can arrive dozens
    // of times per second) is what made long / code-heavy answers feel laggy.
    // Instead we just accumulate text as it arrives, and only pay for the
    // expensive render once per animation frame (max ~60x/sec, in practice far
    // less since chunks are batched), so the browser never falls behind.
    let renderScheduled = false;
    function scheduleRender(){
      if(renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(()=>{
        renderScheduled = false;
        if(!bubbleEl) return;
        // Check the scroll position BEFORE mutating the DOM — checking after
        // would be skewed by the height change from the new content itself.
        const wasNearBottom = isNearBottom();
        bubbleEl.innerHTML='';
        bubbleEl.appendChild(renderMarkdown(aiMsg.text, {skipHighlight:true}));
        const cur = document.createElement('span'); cur.className='cursor-blink';
        bubbleEl.appendChild(cur);
        // Only auto-scroll if the user was already near the bottom — if they
        // scrolled up to read earlier messages, don't yank them back down.
        if(wasNearBottom && autoScrollOn) scrollToBottom();
      });
    }

    // Safety net: some edge/streaming connections don't send a clean "done"
    // signal right after the last token even though the answer is already
    // fully displayed — the typing cursor would then blink forever and the
    // reaction buttons (salin/suka/dll) would never get attached. So: if no
    // new token arrives for a long while after we've started receiving
    // text, treat the stream as finished instead of waiting indefinitely.
    // BUG FIX: this used to be only 4000ms, which is way too aggressive —
    // Gemini can legitimately pause for well over 4s mid-answer (especially
    // while Naze Auto Browse is running a google_search call before it keeps
    // writing), so the app was routinely deciding "done" and cancelling the
    // reader while more text_delta events were still on their way, chopping
    // the AI's reply off mid-sentence. Raised to a much safer grace period so
    // this only catches connections that are genuinely hung, not normal
    // generation pauses. Fallback providers (Groq/OpenRouter/Mistral free
    // tiers) can pause even longer, so once we know we're on a fallback
    // provider we use a longer grace period still.
    let idleFinalizeMs = 20000;
    let idleTimer = null;

    while(true){
      const readPromise = reader.read();
      const idlePromise = started
        ? new Promise((resolve)=>{ idleTimer = setTimeout(()=>resolve({idle:true}), idleFinalizeMs); })
        : null;
      const result = idlePromise ? await Promise.race([readPromise, idlePromise]) : await readPromise;
      clearTimeout(idleTimer);
      if(result && result.idle){
        try{ reader.cancel(); }catch(e){}
        break;
      }
      const {done, value} = result;
      if(done) break;
      buf += decoder.decode(value, {stream:true});
      const lines = buf.split('\n');
      buf = lines.pop();
      for(const line of lines){
        if(!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if(!jsonStr || jsonStr==='[DONE]') continue;
        let evt;
        try{ evt = JSON.parse(jsonStr); }catch(e){ continue; }
        if(evt.type==='content_block_delta' && evt.delta && evt.delta.type==='text_delta'){
          if(!started){
            started = true;
            ttft = performance.now() - t0;
            clearTimeout(ttftTimer);
            console.debug(`[NAZE perf] TTFT: ${(ttft/1000).toFixed(2)}s`);
            thinkRow.remove();
            const row = renderMessageEl(aiMsg, true);
            thread.appendChild(row);
            bubbleEl = row.querySelector('.bubble');
            bubbleEl.innerHTML = '<span class="cursor-blink"></span>';
          }
          aiMsg.text += evt.delta.text;
          clearContinuingNote(); // real text is flowing again — status note no longer needed
          scheduleRender();
        } else if(evt.type==='continuation_notice'){
          // Backend hit a provider's token ceiling mid-answer and is
          // automatically asking it to keep going — surface a small,
          // non-blocking note rather than letting the cursor just sit
          // there looking stuck.
          if(bubbleEl && !continuingNoteEl){
            continuingNoteEl = document.createElement('div');
            continuingNoteEl.className = 'fallback-badge';
            continuingNoteEl.textContent = 'Naze melanjutkan respons...';
            const col = bubbleEl.parentElement;
            if(col) col.appendChild(continuingNoteEl);
          }
        } else if(evt.type==='grounding_metadata'){
          aiMsg.grounding = { queries: evt.queries||[], sources: evt.sources||[] };
        } else if(evt.type==='provider_notice'){
          aiMsg.fallbackProvider = evt.provider || null;
          idleFinalizeMs = 35000; // fallback providers can pause longer between tokens than Gemini
        }
      }
    }

    if(!started){ thinkRow.remove(); }
    clearTimeout(ttftTimer);
    if(bubbleEl){
      bubbleEl.innerHTML=''; bubbleEl.appendChild(renderMarkdown(aiMsg.text));
    }
    if(!aiMsg.text){ throw new Error('empty'); }

    if(typeof handleNazeFileBlocksInMessage === 'function'){
      try{ await handleNazeFileBlocksInMessage(aiMsg); }catch(e){ console.warn('Naze Code patch failed', e); }
    }

    console.debug(`[NAZE perf] Generation total: ${((performance.now()-t0)/1000).toFixed(2)}s`);
    messages.push(aiMsg);
    // re-render final row with action buttons
    const rows = thread.querySelectorAll('.msg-row.ai');
    const lastRow = rows[rows.length-1];
    if(lastRow) lastRow.replaceWith(renderMessageEl(aiMsg));
    await persistMessages();

  } catch(err){
    clearTimeout(ttftTimer);
    thinkRow.remove();
    if(err.name === 'AbortError' && !timedOut){
      // User pressed Stop — not a real error, just keep whatever text streamed in so far.
      if(aiMsg.text){
        if(bubbleEl){ bubbleEl.innerHTML=''; bubbleEl.appendChild(renderMarkdown(aiMsg.text)); }
        messages.push(aiMsg);
        const rows = thread.querySelectorAll('.msg-row.ai');
        const lastRow = rows[rows.length-1];
        if(lastRow) lastRow.replaceWith(renderMessageEl(aiMsg));
        await persistMessages();
      }
    } else if(aiMsg.text && bubbleEl){
      // STREAMING ERROR: the connection dropped mid-answer. The partial
      // reply itself is still good — don't throw it away. Finalize it as a
      // normal message and offer Continue / Regenerate instead of a
      // generic error box.
      bubbleEl.innerHTML=''; bubbleEl.appendChild(renderMarkdown(aiMsg.text));
      messages.push(aiMsg);
      const rows = thread.querySelectorAll('.msg-row.ai');
      const lastRow = rows[rows.length-1];
      if(lastRow) lastRow.replaceWith(renderMessageEl(aiMsg));
      await persistMessages();
      thread.appendChild(buildInterruptedNotice(aiMsg.id));
    } else {
      // No text ever arrived — a real failure. Never surface the raw
      // provider/server error; map it to one of a few honest, friendly
      // messages and offer Retry (capped at 3 attempts total).
      const {title, subtitle, retryAfter} = classifyError(err, timedOut);
      const final = attempt >= 3;
      thread.appendChild(buildErrorBox({
        title, subtitle, final, retryAfter,
        onRetry: final ? null : ()=>{ runAssistantTurn(atts, attempt+1, hiddenContinueText); }
      }));
    }
  } finally {
    isStreaming = false;
    streamAbort = null;
    $('#send-icon').outerHTML = `<svg id="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/></svg>`;
    $('#send-btn').classList.remove('stop');
    updateSendState();
    scrollToBottomIfNear();
  }
}

async function runImageGenTurn(prompt, attempt=1){
  isStreaming = true;
  $('#send-btn').disabled=false;
  $('#send-icon').outerHTML = `<svg id="send-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;
  $('#send-btn').classList.add('stop');

  const thread = $('#thread');
  const thinkRow = createNazeLoadRow('generating');
  thinkRow.style.maxWidth='780px'; thinkRow.style.margin='0 auto'; thinkRow.style.padding='0 16px';
  thread.appendChild(thinkRow); scrollToBottom();

  const controller = new AbortController();
  streamAbort = controller;

  try{
    const resp = await fetch('/api/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal: controller.signal,
      body: JSON.stringify({ action:'generate_image', prompt })
    });
    let j = null;
    try{ j = await resp.json(); }catch(e){}
    thinkRow.remove();
    if(!resp.ok || !j || !j.image){
      const final = attempt >= 3;
      const retryAfterHeader = resp.headers.get('Retry-After');
      const retryAfter = (retryAfterHeader && !isNaN(parseInt(retryAfterHeader,10))) ? parseInt(retryAfterHeader,10) : null;
      thread.appendChild(buildErrorBox({
        title: resp.status===429 ? 'Too many requests' : 'Something went wrong',
        subtitle: resp.status===429 ? 'Naze sedang membatasi permintaan gambar sementara.' : ((j && (j.error || j.detail)) || "Naze couldn't generate an image."),
        final,
        retryAfter,
        onRetry: final ? null : ()=>{ runImageGenTurn(prompt, attempt+1); }
      }));
    } else {
      const aiMsg = { id: uid(), role:'ai', text:`Gambar untuk: "${prompt}"`, generatedImage: j.image };
      messages.push(aiMsg);
      thread.appendChild(renderMessageEl(aiMsg, true));
      scrollToBottomIfNear();
      await persistMessages();
    }
  } catch(err){
    thinkRow.remove();
    if(err.name !== 'AbortError'){
      const final = attempt >= 3;
      const {title, subtitle, retryAfter} = classifyError(err, false);
      thread.appendChild(buildErrorBox({
        title, subtitle, final, retryAfter,
        onRetry: final ? null : ()=>{ runImageGenTurn(prompt, attempt+1); }
      }));
    }
  }

  isStreaming = false;
  streamAbort = null;
  $('#send-icon').outerHTML = `<svg id="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/></svg>`;
  $('#send-btn').classList.remove('stop');
  updateSendState();
}

/* ---------- Think toggle ---------- */
function updateThinkToggleUI(){
  $('#think-toggle').classList.toggle('on', thinkingOn);
  $('#think-toggle').setAttribute('aria-pressed', String(thinkingOn));
  const brainSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9.5 2A4.5 4.5 0 0 0 5 6.5v.55A3.5 3.5 0 0 0 3 10.5 3.5 3.5 0 0 0 4.8 13.5 3.5 3.5 0 0 0 4 15.5 3.5 3.5 0 0 0 6.5 19H8v1a2 2 0 0 0 2 2v-6.34A4.5 4.5 0 0 1 7 11.5V6.5A4.5 4.5 0 0 1 9.5 2ZM14.5 2A4.5 4.5 0 0 1 19 6.5v.55A3.5 3.5 0 0 1 21 10.5 3.5 3.5 0 0 1 19.2 13.5 3.5 3.5 0 0 1 20 15.5 3.5 3.5 0 0 1 17.5 19H16v1a2 2 0 0 1-2 2v-6.34A4.5 4.5 0 0 0 17 11.5V6.5A4.5 4.5 0 0 0 14.5 2Z"/></svg>';
  const boltSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg>';
  $('#mode-pill').innerHTML = thinkingOn ? (brainSvg+' Berpikir Keras') : (boltSvg+' Cepat');
}

