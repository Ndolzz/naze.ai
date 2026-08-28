/* ---------- Sidebar / chat list ---------- */
function renderChatList(filter){
  const list = $('#chat-list'); list.innerHTML='';
  let items = [...chats].sort((a,b)=>b.updatedAt-a.updatedAt);
  if(filter){ items = items.filter(c=>c.title.toLowerCase().includes(filter.toLowerCase())); }
  if(!items.length){
    list.innerHTML = `<div class="chat-group-label">${filter? 'Tidak ditemukan':'Belum ada riwayat'}</div>`;
    return;
  }
  list.innerHTML = '<div class="chat-group-label">Riwayat</div>';
  items.forEach(c=>{
    const el = document.createElement('div');
    el.className = 'chat-item' + (c.id===currentChatId?' active':'');
    el.setAttribute('role','listitem');
    el.innerHTML = `<span class="ttl">${escapeHtml(c.title)}</span>
      <span class="actions">
        <button data-act="rename" aria-label="Ganti nama"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button data-act="delete" aria-label="Hapus"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>
      </span>`;
    el.addEventListener('click', (e)=>{ if(e.target.closest('[data-act]')) return; loadChat(c.id); });
    el.querySelector('[data-act="rename"]').addEventListener('click', async ()=>{
      const nn = prompt('Ganti nama chat:', c.title);
      if(nn && nn.trim()){ c.title = nn.trim().slice(0,80); c.updatedAt=Date.now(); await stSet('chats-index', chats); if(c.id===currentChatId) $('#chat-title').textContent=c.title; renderChatList($('#search-input').value); }
    });
    el.querySelector('[data-act="delete"]').addEventListener('click', async ()=>{
      if(!confirm('Hapus chat ini?')) return;
      chats = chats.filter(x=>x.id!==c.id);
      await stSet('chats-index', chats);
      await stDel('chat-messages:'+c.id);
      if(c.id===currentChatId) startNewChat();
      renderChatList($('#search-input').value);
    });
    list.appendChild(el);
  });
}

async function loadChat(id){
  currentChatId = id;
  const c = chats.find(x=>x.id===id);
  messages = await stGet('chat-messages:'+id) || [];
  thinkingOn = !!c?.thinking;
  updateThinkToggleUI();
  $('#chat-title').textContent = c ? c.title : 'Chat';
  $('#welcome').style.display = 'none';
  const thread = $('#thread'); thread.innerHTML='';
  messages.forEach(m=> thread.appendChild(renderMessageEl(m)));
  hlAll(); scrollToBottom();
  renderChatList($('#search-input').value);
  closeSidebarMobile();
}

function updateWelcomeGreeting(){
  const h = new Date().getHours();
  let greeting;
  if(h>=4 && h<11) greeting='Selamat pagi, ada yang bisa NAZE bantu?';
  else if(h>=11 && h<15) greeting='Selamat siang, ada yang bisa NAZE bantu?';
  else if(h>=15 && h<19) greeting='Selamat sore, ada yang bisa NAZE bantu?';
  else greeting='Selamat malam, ada yang bisa NAZE bantu?';
  const el = $('#welcome-title');
  if(el) el.textContent = greeting;
}

function startNewChat(){
  currentChatId = null; messages=[]; pendingAtts=[];
  thinkingOn = (defaultMode === 'deep'); updateThinkToggleUI();
  $('#thread').innerHTML=''; $('#welcome').style.display='';
  updateWelcomeGreeting();
  $('#chat-title').textContent='Chat Baru';
  renderPreviewStrip();
  renderChatList($('#search-input').value);
  closeSidebarMobile();
  $('#text-input').focus();
}

async function ensureChat(firstText){
  if(currentChatId) return currentChatId;
  const id = 'c' + Date.now() + Math.random().toString(36).slice(2,7);
  const title = (firstText||'Percakapan Baru').slice(0,48);
  const c = {id, title, updatedAt:Date.now(), thinking:thinkingOn};
  chats.unshift(c);
  currentChatId = id;
  await stSet('chats-index', chats);
  $('#chat-title').textContent = title;
  renderChatList($('#search-input').value);
  return id;
}

async function persistMessages(){
  if(!currentChatId) return;
  await stSet('chat-messages:'+currentChatId, messages);
  const c = chats.find(x=>x.id===currentChatId);
  if(c){ c.updatedAt = Date.now(); await stSet('chats-index', chats); }
}

