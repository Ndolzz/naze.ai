/* ---------- Utility ---------- */
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m])); }
function fmtSize(b){ if(b<1024) return b+' B'; if(b<1024*1024) return (b/1024).toFixed(1)+' KB'; return (b/1024/1024).toFixed(1)+' MB'; }
function extOf(name){ return (name.split('.').pop()||'').toLowerCase(); }
function sanitizeFilename(name){ return name.replace(/[\/\\?%*:|"<>]/g,'-').slice(0,120); }
function uid(){ return Math.random().toString(36).slice(2,10); }
function scrollToBottom(){ const s=$('#scroll'); s.scrollTop = s.scrollHeight; }
function isNearBottom(){ const s=$('#scroll'); return (s.scrollHeight - s.scrollTop - s.clientHeight) < 150; }
function scrollToBottomIfNear(){ if(isNearBottom()) scrollToBottom(); }
function autoSizeTextarea(){
  const t = $('#text-input');
  t.addEventListener('input', ()=>{ t.style.height='auto'; t.style.height=Math.min(t.scrollHeight,180)+'px'; updateSendState(); });
}
function updateSendState(){
  const has = $('#text-input').value.trim().length>0 || pendingAtts.length>0;
  const stillProcessing = pendingAtts.some(a=>a.processing); // e.g. a ZIP still being extracted/analyzed
  $('#send-btn').disabled = isStreaming ? false : (!has || stillProcessing);
}

