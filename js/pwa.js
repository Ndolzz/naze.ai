/* ---------- PWA: service worker + install prompt ---------- */
function registerServiceWorker(){
  if(!('serviceWorker' in navigator)) return;
  // Registration only succeeds when served over http(s) from a real origin
  // (it will silently no-op inside this sandboxed preview, which is expected).
  navigator.serviceWorker.register('./sw.js').catch(()=>{ /* not available in this context; fine */ });
}
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  $('#install-btn').style.display = 'flex';
});
window.addEventListener('appinstalled', ()=>{
  deferredInstallPrompt = null;
  $('#install-btn').style.display = 'none';
});
document.addEventListener('DOMContentLoaded', ()=>{
  const btn = document.getElementById('install-btn');
  if(btn) btn.addEventListener('click', async ()=>{
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btn.style.display = 'none';
  });
});

