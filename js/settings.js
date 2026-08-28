/* ---------- Settings navigation (stack-based) ---------- */
let settingsStack = ['root'];
const SETTINGS_TITLES = {
  root:'Pengaturan', account:'Akun', general:'General', chat:'Chat', ai:'AI', memory:'Memory',
  'manage-memory':'Kelola Memori', privacy:'Data & Privasi', about:'Tentang',
  changelog:'Yang Baru', licenses:'Lisensi Sumber Terbuka'
};
function showSettingsView(view){
  $$('#settings-panel .settings-view').forEach(v=>{ v.hidden = (v.dataset.view !== view); });
  const title = $('#settings-title'); if(title) title.textContent = SETTINGS_TITLES[view] || 'Pengaturan';
  const back = $('#settings-back'); if(back) back.hidden = (view === 'root');
  if(view === 'manage-memory') renderMemoryList();
  if(view === 'account') renderAccountView();
}
function settingsPush(view){ settingsStack.push(view); showSettingsView(view); }
function settingsBack(){ if(settingsStack.length>1){ settingsStack.pop(); showSettingsView(settingsStack[settingsStack.length-1]); } }
function settingsReset(){ settingsStack = ['root']; showSettingsView('root'); }

/* ---------- Manage memories (NazeMemory integration) ---------- */
async function renderMemoryList(){
  const wrap = $('#memory-list'); if(!wrap) return;
  wrap.innerHTML = '<div class="mem-loading">Memuat memori...</div>';
  if(!window.NazeMemory){
    wrap.innerHTML = '<div class="mem-empty">Fitur memory tidak tersedia di perangkat ini.</div>';
    return;
  }
  try{
    const items = await NazeMemory.getMemories();
    if(!items.length){
      wrap.innerHTML = '<div class="mem-empty">Belum ada memori yang tersimpan.</div>';
      return;
    }
    wrap.innerHTML = '';
    items.forEach(m=>{
      const row = document.createElement('div'); row.className = 'mem-item';
      let dateStr = '';
      try{ dateStr = new Date(m.createdAt).toLocaleDateString('id-ID', {day:'numeric', month:'short', year:'numeric'}); }catch(e){}
      const txt = document.createElement('div'); txt.className = 'mem-txt';
      txt.innerHTML = `<div>${escapeHtml(m.content)}</div><div class="mem-meta">${escapeHtml(m.category||'general')}${dateStr? ' · '+dateStr : ''}</div>`;
      const del = document.createElement('button'); del.className = 'mem-del'; del.setAttribute('aria-label','Hapus memori');
      del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>';
      del.addEventListener('click', async ()=>{
        if(!confirm('Hapus memori ini?')) return;
        try{ await NazeMemory.deleteMemory(m.id); }catch(e){}
        renderMemoryList();
      });
      row.appendChild(txt); row.appendChild(del);
      wrap.appendChild(row);
    });
  }catch(e){
    wrap.innerHTML = '<div class="mem-empty">Gagal memuat memori.</div>';
  }
}

