marked.setOptions({ breaks:true, gfm:true });

/* ---------- Storage helpers ---------- */
/* Uses window.storage when available (Claude artifact preview).
   Falls back to localStorage when deployed standalone (e.g. GitHub Pages/Vercel),
   so history keeps working outside the Claude sandbox too. */
const hasCloudStorage = (typeof window !== 'undefined' && !!window.storage);
async function stGet(key){
  try{
    if(hasCloudStorage){ const r = await window.storage.get(key,false); return r? JSON.parse(r.value): null; }
    const v = localStorage.getItem('naze:'+key); return v? JSON.parse(v): null;
  }catch(e){ return null; }
}
async function stSet(key,val){
  try{
    if(hasCloudStorage){ await window.storage.set(key, JSON.stringify(val), false); return; }
    localStorage.setItem('naze:'+key, JSON.stringify(val));
  }catch(e){ console.warn('storage set failed',e); }
}
async function stDel(key){
  try{
    if(hasCloudStorage){ await window.storage.delete(key,false); return; }
    localStorage.removeItem('naze:'+key);
  }catch(e){}
}

