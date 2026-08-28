/* ---------- Events ---------- */
function closeSidebarMobile(){
  if(window.innerWidth<=860){ $('#sidebar').classList.remove('open'); }
}
function bindEvents(){
  $('#menu-btn').addEventListener('click', ()=> $('#sidebar').classList.toggle('open'));
  $('#sidebar-overlay').addEventListener('click', ()=> $('#sidebar').classList.remove('open'));
  $('#new-chat-btn').addEventListener('click', startNewChat);
  let searchDebounceTimer = null;
  $('#search-input').addEventListener('input', e=>{
    const val = e.target.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(()=> renderChatList(val), 250);
  });

  $$('.suggest-card').forEach(c=> c.addEventListener('click', ()=>{
    $('#text-input').value = c.dataset.prompt;
    $('#text-input').dispatchEvent(new Event('input'));
    $('#text-input').focus();
  }));

  $('#send-btn').addEventListener('click', ()=>{
    if(isStreaming){ if(streamAbort) streamAbort.abort(); }
    else sendMessage();
  });
  $('#text-input').addEventListener('keydown', e=>{
    if(e.key==='Enter' && !e.shiftKey && enterToSendOn){ e.preventDefault(); if(!isStreaming) sendMessage(); }
  });

  $('#think-toggle').addEventListener('click', ()=>{
    thinkingOn = !thinkingOn; updateThinkToggleUI();
    const c = chats.find(x=>x.id===currentChatId); if(c){ c.thinking=thinkingOn; stSet('chats-index', chats); }
  });

  // plus menu
  $('#plus-btn').addEventListener('click', (e)=>{ e.stopPropagation(); $('#plus-menu').classList.toggle('show'); });
  document.addEventListener('click', ()=> $('#plus-menu').classList.remove('show'));
  $('#plus-menu').addEventListener('click', e=>e.stopPropagation());
  $('#plus-menu [data-action="camera"]').addEventListener('click', ()=>{ $('#file-camera').click(); $('#plus-menu').classList.remove('show'); });
  $('#plus-menu [data-action="gallery"]').addEventListener('click', ()=>{ $('#file-gallery').click(); $('#plus-menu').classList.remove('show'); });
  $('#plus-menu [data-action="file"]').addEventListener('click', ()=>{ $('#file-doc').click(); $('#plus-menu').classList.remove('show'); });
  $('#plus-menu [data-action="imagegen"]').addEventListener('click', ()=>{ setImageGenMode(true); $('#plus-menu').classList.remove('show'); $('#text-input').focus(); });
  $('#imagegen-cancel').addEventListener('click', ()=> setImageGenMode(false));
  $('#file-camera').addEventListener('change', e=>{ handleFiles(e.target.files); e.target.value=''; });
  $('#file-gallery').addEventListener('change', e=>{ handleFiles(e.target.files); e.target.value=''; });
  $('#file-doc').addEventListener('change', e=>{ handleFiles(e.target.files); e.target.value=''; });

  // drag & drop (desktop)
  ['dragover','drop'].forEach(evt=> document.addEventListener(evt, e=>e.preventDefault()));
  document.addEventListener('drop', e=>{ if(e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

  // theme / accent
  $('#theme-btn').addEventListener('click', ()=>{
    const cur = document.body.dataset.themePref || 'dark';
    const order = ['dark','light','system'];
    const next = order[(order.indexOf(cur)+1)%3];
    applyTheme(next); savePrefs();
  });
  $('#theme-seg').addEventListener('click', e=>{
    const b = e.target.closest('button'); if(!b) return;
    applyTheme(b.dataset.v); savePrefs();
  });
  $('#accent-row').addEventListener('click', e=>{
    const b = e.target.closest('.accent-dot'); if(!b) return;
    applyAccent(b.dataset.v); savePrefs();
  });
  $('#browse-seg').addEventListener('click', e=>{
    const b = e.target.closest('button'); if(!b) return;
    applyBrowseMode(b.dataset.v); savePrefs();
  });

  // settings / about panels
  $('#settings-btn').addEventListener('click', ()=>{ $('#settings-overlay').classList.add('show'); settingsReset(); closeSidebarMobile(); });
  $('#settings-close').addEventListener('click', ()=> $('#settings-overlay').classList.remove('show'));
  $('#settings-overlay').addEventListener('click', e=>{ if(e.target.id==='settings-overlay') $('#settings-overlay').classList.remove('show'); });
  $('#settings-back').addEventListener('click', settingsBack);
  $('#about-btn').addEventListener('click', ()=>{ $('#about-overlay').classList.add('show'); closeSidebarMobile(); });
  $('#about-close').addEventListener('click', ()=> $('#about-overlay').classList.remove('show'));
  $('#about-overlay').addEventListener('click', e=>{ if(e.target.id==='about-overlay') $('#about-overlay').classList.remove('show'); });
  $('#about-naze-link').addEventListener('click', ()=>{ $('#about-overlay').classList.add('show'); });

  // settings navigation (category list -> page, with back stack)
  $$('#settings-panel [data-nav]').forEach(el=>{
    el.addEventListener('click', ()=> settingsPush(el.dataset.nav));
  });

  $('#clear-history-btn').addEventListener('click', async ()=>{
    if(!confirm('Hapus semua riwayat chat? Tindakan ini tidak bisa dibatalkan.')) return;
    for(const c of chats){ await stDel('chat-messages:'+c.id); }
    chats = []; await stSet('chats-index', chats);
    startNewChat(); $('#settings-overlay').classList.remove('show');
  });

  $('#clear-alldata-btn').addEventListener('click', async ()=>{
    if(!confirm('Hapus semua data lokal? Ini termasuk riwayat chat, memori, dan pengaturan. Tindakan ini tidak bisa dibatalkan.')) return;
    for(const c of chats){ await stDel('chat-messages:'+c.id); }
    chats = []; await stSet('chats-index', chats);
    await stDel('prefs');
    if(window.NazeMemory){ try{ await NazeMemory.clearMemories(); }catch(e){} }
    applyTheme('dark'); applyAccent('blue'); applyBrowseMode('auto');
    applyAnimations(true); applyEnterToSend(true); applyAutoScroll(true);
    applyMarkdown(true); applyCodeHighlight(true); applyDensity('comfortable');
    applyDefaultMode('fast'); applyMemoryOn(true);
    await savePrefs();
    startNewChat();
    $('#settings-overlay').classList.remove('show');
  });

  // toggles
  $('#anim-toggle').addEventListener('click', ()=>{ applyAnimations(!animationsOn); savePrefs(); });
  $('#enter-toggle').addEventListener('click', ()=>{ applyEnterToSend(!enterToSendOn); savePrefs(); });
  $('#autoscroll-toggle').addEventListener('click', ()=>{ applyAutoScroll(!autoScrollOn); savePrefs(); });
  $('#markdown-toggle').addEventListener('click', ()=>{ applyMarkdown(!markdownOn); savePrefs(); rerenderCurrentThread(); });
  $('#codehl-toggle').addEventListener('click', ()=>{ if(!markdownOn) return; applyCodeHighlight(!codeHighlightOn); savePrefs(); rerenderCurrentThread(); });
  $('#memory-toggle').addEventListener('click', ()=>{ applyMemoryOn(!memoryOn); savePrefs(); });

  $('#density-seg').addEventListener('click', e=>{
    const b = e.target.closest('button'); if(!b) return;
    applyDensity(b.dataset.v); savePrefs();
  });
  $('#defaultmode-seg').addEventListener('click', e=>{
    const b = e.target.closest('button'); if(!b) return;
    applyDefaultMode(b.dataset.v); savePrefs();
  });

  // memory management
  $('#clear-memory-btn').addEventListener('click', async ()=>{
    if(!confirm('Hapus semua memori? Tindakan ini tidak bisa dibatalkan.')) return;
    if(window.NazeMemory){ try{ await NazeMemory.clearMemories(); }catch(e){} }
    renderMemoryList();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{
    if(document.body.dataset.themePref==='system') applyTheme('system');
  });
}

