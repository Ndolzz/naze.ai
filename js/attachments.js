/* In-memory only (never persisted/serialized) cache of raw ZIP bytes, so
   "Buka di Naze Code" can load real editable file contents without a second
   upload — separate from att.text, which only holds the AI-context excerpt
   built by buildProjectContextText(). Cleared naturally on page reload. */
const nazeZipBufferCache = new Map();

/* ---------- Attachment chip builder ---------- */
function attIcon(kind){
  if(kind==='image') return '';
  if(kind==='code') return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>';
  if(kind==='zip') return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L8.6 3.9A2 2 0 0 0 6.91 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2Z"/><path d="M12 10v2M12 16v.01"/></svg>';
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>';
}
function buildAttChip(att, removable){
  const div = document.createElement('div');
  div.className = removable ? 'pv-chip' : 'att-chip';
  const thumb = att.kind==='image'
    ? `<img src="${att.dataUrl}" alt="">`
    : `<div class="ic">${attIcon(att.kind)}</div>`;
  let subtitle;
  if(att.kind==='zip' && att.processing){
    subtitle = escapeHtml(att.zipStatus || 'Memproses...');
  } else if(att.kind==='zip' && att.zipMeta){
    subtitle = `${att.zipMeta.fileCount} file · ${att.zipMeta.folderCount} folder`;
  } else {
    subtitle = `${att.unreadable? 'Tidak terbaca · ':''}${fmtSize(att.size)}`;
  }
  div.innerHTML = `${thumb}<div class="att-meta"><div class="n">${escapeHtml(att.name)}</div><div class="s">${subtitle}</div></div>`;
  if(removable){
    const rm = document.createElement('div'); rm.className='rm'; rm.innerHTML='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    rm.addEventListener('click', ()=>{ pendingAtts = pendingAtts.filter(a=>a.id!==att.id); renderPreviewStrip(); updateSendState(); });
    div.appendChild(rm);
  }
  if(att.kind==='zip' && att.processing){
    // Reuses the existing (previously-unused) .bar progress affordance from
    // the preview-chip styles instead of adding new CSS.
    div.style.position = 'relative';
    const bar = document.createElement('div'); bar.className='bar'; bar.style.width = (att.zipProgress||10)+'%';
    div.appendChild(bar);
  }
  if(!removable && att.kind==='zip' && att.zipMeta && !att.zipError){
    const openBtn = document.createElement('button');
    openBtn.className = 'zip-open-code-btn';
    openBtn.textContent = 'Buka di Naze Code';
    openBtn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const buf = nazeZipBufferCache.get(att.id);
      if(!buf){ showToastError('Buffer ZIP sudah tidak tersimpan di sesi ini — unggah ulang file ZIP untuk membukanya di Naze Code.'); return; }
      try{
        const project = await importZipBufferAsProject(buf, att.zipMeta.name);
        await openCodeWorkspace(project);
      }catch(err){ showToastError('Gagal membuka project: ' + (err.message||'file tidak valid')); }
    });
    div.appendChild(openBtn);
  }
  return div;
}
function renderPreviewStrip(){
  const strip = $('#preview-strip'); strip.innerHTML='';
  pendingAtts.forEach(a=> strip.appendChild(buildAttChip(a, true)));
}

/* ---------- File handling ---------- */
function classify(file){
  const ext = extOf(file.name);
  if(ext==='zip') return 'zip';
  if(IMAGE_EXT.includes(ext)) return 'image';
  if(TEXT_READABLE_EXT.includes(ext)) return (['js','jsx','ts','tsx','py','php','java','c','cpp','cs','sql','sh'].includes(ext) ? 'code' : 'doc');
  if(DOC_UNREADABLE_EXT.includes(ext)) return 'doc-unreadable';
  return 'unknown';
}

// Only images above this size get resized/recompressed before upload — small
// photos are sent as-is untouched, so quality is never degraded needlessly.
const IMAGE_COMPRESS_THRESHOLD = 1200*1024; // 1.2MB
const IMAGE_MAX_DIMENSION = 1600; // longest side, px

function loadImageEl(dataUrl){
  return new Promise((res,rej)=>{
    const img = new Image();
    img.onload = ()=>res(img);
    img.onerror = rej;
    img.src = dataUrl;
  });
}

async function compressImageIfNeeded(file){
  const originalDataUrl = await readAsDataURL(file);
  if(file.size <= IMAGE_COMPRESS_THRESHOLD){
    return { dataUrl: originalDataUrl, mediaType: file.type || 'image/jpeg' };
  }
  try{
    const img = await loadImageEl(originalDataUrl);
    const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width*scale));
    const h = Math.max(1, Math.round(img.height*scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
    // Only keep the compressed version if it's actually smaller — otherwise
    // fall back to the original untouched (e.g. a huge but simple PNG icon
    // sometimes re-encodes larger as JPEG).
    return compressedDataUrl.length < originalDataUrl.length
      ? { dataUrl: compressedDataUrl, mediaType: 'image/jpeg' }
      : { dataUrl: originalDataUrl, mediaType: file.type || 'image/jpeg' };
  }catch(e){
    // Canvas failed for any reason (CORS/decoding/etc.) — just use the original file.
    return { dataUrl: originalDataUrl, mediaType: file.type || 'image/jpeg' };
  }
}

async function handleFiles(fileList){
  const files = Array.from(fileList);
  for(const file of files){
    const kind0 = classify(file);

    if(kind0==='zip'){
      if(file.size > LIMITS.zip){
        showToastError(`Ukuran file ZIP melebihi batas ${fmtSize(LIMITS.zip)}. (${sanitizeFilename(file.name)})`);
        continue;
      }
      const att = { id: uid(), name: sanitizeFilename(file.name), size: file.size, mime: file.type||'application/zip', kind:'zip', unreadable:false, processing:true, zipStatus:'Uploading...', zipProgress:10 };
      pendingAtts.push(att);
      renderPreviewStrip(); updateSendState();
      // Deliberately not awaited here — the chip re-renders itself as the
      // extraction/analysis progresses, and updateSendState() blocks Send
      // until att.processing clears, so nothing can be sent half-read.
      processZipAttachment(att, file);
      continue;
    }

    const limitKind = kind0==='image' ? 'image' : (kind0==='code' ? 'code' : 'document');
    if(file.size > LIMITS[limitKind]){
      showToastError(`Ukuran file melebihi batas. (${sanitizeFilename(file.name)})`);
      continue;
    }
    const att = { id: uid(), name: sanitizeFilename(file.name), size: file.size, mime: file.type, kind: kind0==='doc-unreadable'?'doc':(kind0==='unknown'?'doc':kind0), unreadable: kind0==='doc-unreadable' || kind0==='unknown' };
    if(kind0==='image'){
      const needsCompress = file.size > IMAGE_COMPRESS_THRESHOLD;
      if(needsCompress) showToastError('Menyiapkan gambar...');
      const { dataUrl, mediaType } = await compressImageIfNeeded(file);
      att.dataUrl = dataUrl;
      att.b64 = dataUrl.split(',')[1];
      att.mediaType = mediaType;
      att.size = Math.round(att.b64.length * 0.75); // reflect actual size sent, post-compression
    } else if(kind0==='doc' || kind0==='code'){
      try{ att.text = await readAsText(file); }catch(e){ att.text=''; att.unreadable=true; }
    }
    pendingAtts.push(att);
  }
  renderPreviewStrip(); updateSendState();
}
function readAsDataURL(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }
function readAsText(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsText(file); }); }
function nextTick(){ return new Promise(r=>setTimeout(r,0)); }

function showToastError(text){
  const thread = $('#thread');
  const box = document.createElement('div'); box.className='err-box'; box.style.maxWidth='780px'; box.style.margin='0 auto';
  box.innerHTML = `<span>${escapeHtml(text)}</span>`;
  thread.appendChild(box); scrollToBottom();
  setTimeout(()=>box.remove(), 4500);
}

/* ==================================================================
   ZIP project reading & analysis
   ------------------------------------------------------------------
   Fully client-side, on purpose: NAZE has no upload/storage backend
   today (attachments are read in-browser and sent as message content,
   see the doc/code branch above) — this reuses that exact same
   pipeline instead of standing up a new upload endpoint, a new
   storage layer, or a separate parsing system for one file type.
   "Extraction workspace" here is just JS objects in memory; there is
   nothing written to disk, and nothing to clean up afterwards beyond
   letting those objects fall out of scope once processing finishes.
   Requires the fflate library (pure JS, no native/WASM deps) loaded
   globally via <script> in index.html.
   ================================================================== */

/* ---- Safe extraction: entry filter (also doubles as path-traversal /
   zip-slip guard, and tallies real file/folder counts along the way) ---- */
function makeZipEntryFilter(){
  const stats = { totalFiles:0, allDirs:new Set(), includedFiles:0, includedBytes:0 };
  function filter(entry){
    const name = entry.name || '';
    if(name.endsWith('/')){
      const clean = name.replace(/\/+$/,'');
      if(clean) stats.allDirs.add(clean);
      return false; // directory marker entry, nothing to extract
    }
    // Zip-slip / path traversal guard. fflate itself does not write to disk
    // (everything stays in memory), so this is defense-in-depth rather than
    // the primary protection — but a path like this should never be trusted
    // or even displayed back to the user.
    if(name.includes('..') || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) return false;

    stats.totalFiles++;
    const parts = name.split('/');
    for(let i=1;i<parts.length;i++) stats.allDirs.add(parts.slice(0,i).join('/'));
    const base = parts[parts.length-1];
    const lowerBase = base.toLowerCase();

    if(parts.some(p=>ZIP_IGNORE_DIR_NAMES.has(p.toLowerCase()))) return false;
    // Dotfolders anywhere in the path are skipped by default (.git, .idea, ...)
    if(parts.some((p,i)=> i<parts.length-1 && p.startsWith('.') && !ZIP_DOTFILE_ALLOW.has(p.toLowerCase()))) return false;

    const isExplicitlyAllowedDotfile = ZIP_DOTFILE_ALLOW.has(lowerBase);
    // The allow-list is a small, explicit set of known-safe dotfiles — it
    // must win over the secret-pattern check below, otherwise ".env.example"
    // (a template with no real secrets) would get caught by the ".env*" rule
    // meant for the real ".env". Every other dotfile still goes through the
    // normal checks and is blocked by default.
    if(!isExplicitlyAllowedDotfile){
      if(lowerBase.startsWith('.') && !ZIP_CONFIG_FILES.includes(base)) return false;
      if(ZIP_SECRET_PATTERNS.some(rx=>rx.test(base))) return false; // .env, keys, tokens, credentials — never read
    }
    if(lowerBase.endsWith('.zip')) return false; // nested archives are ignored, never recursed into
    if(ZIP_IGNORE_FILE_PATTERNS.some(rx=>rx.test(name))) return false;

    const size = (entry.originalSize!=null ? entry.originalSize : entry.size) || 0;
    if(size > ZIP_MAX_FILE_TEXT_SIZE) return false;
    if(stats.includedFiles >= ZIP_MAX_FILES) return false;
    if(stats.includedBytes + size > ZIP_MAX_TOTAL_UNCOMPRESSED) return false;

    stats.includedFiles++; stats.includedBytes += size;
    return true;
  }
  return { filter, stats };
}

/* Decode the entries fflate actually extracted into {path, ext, text} records. */
function collectZipFiles(unzipped){
  const files = [];
  for(const path in unzipped){
    if(!Object.prototype.hasOwnProperty.call(unzipped, path)) continue;
    const bytes = unzipped[path];
    const ext = extOf(path);
    const base = path.split('/').pop();
    let text = null;
    const looksText = ZIP_TEXT_EXT.has(ext) || ZIP_CONFIG_FILES.includes(base) || base.toLowerCase()==='dockerfile';
    if(looksText){
      try{
        text = fflate.strFromU8(bytes);
        // Quick binary sniff — a real text file shouldn't have a NUL byte
        // in its first couple KB. Guards against a misleading extension.
        const nul = text.indexOf('\u0000');
        if(nul!==-1 && nul<2000) text = null;
      }catch(e){ text = null; }
    }
    files.push({ path, ext, base, size: bytes.length, text });
  }
  return files;
}

// GitHub-style zip exports wrap everything in one "<repo>-<branch>/" folder.
// Detect and strip it so reported paths/structure reflect the real project.
function detectCommonRoot(files){
  if(!files.length) return null;
  const first = files[0].path.split('/');
  if(first.length<2) return null;
  const candidate = first[0];
  return files.every(f=> f.path.startsWith(candidate+'/')) ? candidate : null;
}

function findConfigFile(files, name){
  const matches = files.filter(f=>f.base===name);
  if(!matches.length) return null;
  matches.sort((a,b)=> a.path.split('/').length - b.path.split('/').length);
  return matches[0];
}

function detectLanguages(files){
  const counts = {};
  files.forEach(f=>{
    const lang = ZIP_LANG_BY_EXT[f.ext];
    if(lang) counts[lang] = (counts[lang]||0)+1;
  });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([lang])=>lang);
}

const ZIP_FRAMEWORK_MARKERS = {
  'next':'Next.js', 'nuxt':'Nuxt', 'react':'React', 'react-dom':'React', 'vue':'Vue',
  'svelte':'Svelte', '@angular/core':'Angular', 'express':'Express', 'fastify':'Fastify',
  'koa':'Koa', '@nestjs/core':'NestJS', 'electron':'Electron', 'react-native':'React Native',
  'tailwindcss':'Tailwind CSS', 'vite':'Vite', 'gatsby':'Gatsby'
};

function analyzeNodeProject(files, meta){
  const pkgFile = findConfigFile(files, 'package.json');
  if(!pkgFile || !pkgFile.text) return;
  let pkg; try{ pkg = JSON.parse(pkgFile.text); }catch(e){ return; }
  if(pkg.name && !meta.name) meta.name = pkg.name;
  const deps = Object.assign({}, pkg.dependencies||{}, pkg.devDependencies||{});
  Object.keys(deps).forEach(dep=>{
    const label = ZIP_FRAMEWORK_MARKERS[dep];
    if(label && !meta.frameworks.includes(label)) meta.frameworks.push(label);
  });
  if(Object.keys(pkg.dependencies||{}).length) meta.mainDeps = Object.keys(pkg.dependencies).slice(0,10);
  if(pkg.main && !meta.entryPoint) meta.entryPoint = pkg.main.replace(/^\.\//,'');
}
function analyzePythonProject(files, meta){
  const req = findConfigFile(files,'requirements.txt') || findConfigFile(files,'pyproject.toml') || findConfigFile(files,'Pipfile');
  if(!req || !req.text) return;
  const t = req.text.toLowerCase();
  if(t.includes('django')) meta.frameworks.push('Django');
  if(t.includes('flask')) meta.frameworks.push('Flask');
  if(t.includes('fastapi')) meta.frameworks.push('FastAPI');
  if(!meta.mainDeps.length) meta.mainDeps = req.text.split('\n').map(l=>l.trim()).filter(l=>l && !l.startsWith('#')).slice(0,10);
}
function analyzeGoProject(files, meta){
  const mod = findConfigFile(files,'go.mod');
  if(!mod || !mod.text) return;
  const m = mod.text.match(/module\s+(\S+)/);
  if(m && !meta.name) meta.name = m[1].split('/').pop();
}
function analyzeRustProject(files, meta){
  const cargo = findConfigFile(files,'Cargo.toml');
  if(!cargo || !cargo.text) return;
  const m = cargo.text.match(/name\s*=\s*"([^"]+)"/);
  if(m && !meta.name) meta.name = m[1];
}
function analyzeJavaProject(files, meta){
  const pom = findConfigFile(files,'pom.xml');
  if(pom){ meta.frameworks.push('Maven'); if(pom.text && pom.text.includes('spring-boot')) meta.frameworks.push('Spring Boot'); }
  if(findConfigFile(files,'build.gradle') || findConfigFile(files,'build.gradle.kts')) meta.frameworks.push('Gradle');
}
function analyzePhpProject(files, meta){
  const composer = findConfigFile(files,'composer.json');
  if(!composer || !composer.text) return;
  try{
    const c = JSON.parse(composer.text);
    if(c.name && !meta.name) meta.name = c.name;
    const req = Object.keys(c.require||{});
    if(req.some(r=>r.includes('laravel'))) meta.frameworks.push('Laravel');
    if(req.some(r=>r.includes('symfony'))) meta.frameworks.push('Symfony');
  }catch(e){}
}
function analyzeRubyProject(files, meta){
  const gem = findConfigFile(files,'Gemfile');
  if(gem && gem.text && gem.text.includes('rails')) meta.frameworks.push('Ruby on Rails');
}

function detectProjectMeta(files, fallbackName){
  const meta = { name:null, languages:[], frameworks:[], mainDeps:[], entryPoint:null, configFiles:[], topDirs:[] };
  meta.languages = detectLanguages(files);
  analyzeNodeProject(files, meta);
  analyzePythonProject(files, meta);
  analyzeGoProject(files, meta);
  analyzeRustProject(files, meta);
  analyzeJavaProject(files, meta);
  analyzePhpProject(files, meta);
  analyzeRubyProject(files, meta);
  if(!meta.name) meta.name = fallbackName;
  if(!meta.entryPoint){
    for(const cand of ZIP_ENTRY_CANDIDATES){
      const hit = files.find(f=> f.path===cand);
      if(hit){ meta.entryPoint = hit.path; break; }
    }
  }
  meta.configFiles = ZIP_CONFIG_FILES.filter(name=> files.some(f=>f.base===name)).map(name=> findConfigFile(files,name).path);
  const dirSet = new Set();
  files.forEach(f=>{ const parts=f.path.split('/'); if(parts.length>1) dirSet.add(parts[0]); });
  meta.topDirs = Array.from(dirSet).sort().slice(0,15);
  return meta;
}

function buildProjectContextText(meta, files, stats){
  const lines = [];
  lines.push('[PROJECT_CONTEXT]');
  lines.push(`Project: ${meta.name}`);
  lines.push(`Files: ${stats.totalFiles} file, ${stats.allDirs.size} folder total dalam ZIP (${stats.includedFiles} file dianalisis; sisanya diabaikan otomatis — node_modules/.git/build/binari/dll)`);
  lines.push(`Structure: ${meta.topDirs.length ? meta.topDirs.join(', ') : '(tidak ada subfolder tingkat atas)'}`);
  lines.push(`Technology: ${meta.languages.length ? meta.languages.join(', ') : 'tidak terdeteksi'}`);
  lines.push(`Framework: ${meta.frameworks.length ? meta.frameworks.join(', ') : '-'}`);
  lines.push(`Dependency utama: ${meta.mainDeps.length ? meta.mainDeps.join(', ') : '-'}`);
  lines.push(`Entry point: ${meta.entryPoint || 'tidak terdeteksi'}`);
  lines.push(`Important files: ${meta.configFiles.length ? meta.configFiles.join(', ') : '-'}`);
  lines.push(`Analysis: Project "${meta.name}" menggunakan ${meta.languages[0]||'bahasa yang belum teridentifikasi'}${meta.frameworks.length? ' dengan '+meta.frameworks.join(', '):''}. Struktur utama berada di folder ${meta.topDirs.slice(0,5).join(', ')||'root'}.`);
  lines.push('[/PROJECT_CONTEXT]');

  // Prioritized file-content excerpts under a strict global character budget
  // so a large project never blows up the prompt sent to the model. Config
  // files and the detected entry point are favored; everything is truncated
  // per-file on top of the overall budget.
  const ranked = files.filter(f=>f.text).map(f=>{
    let score = 0;
    if(meta.configFiles.includes(f.path)) score += 100;
    if(meta.entryPoint===f.path) score += 200;
    if(f.path.split('/').length<=2) score += 10;
    return { f, score };
  }).sort((a,b)=> b.score-a.score);

  let budget = ZIP_CONTEXT_CHAR_BUDGET;
  const snippets = [];
  for(const {f} of ranked){
    if(budget<=0) break;
    const cap = Math.min(ZIP_PER_FILE_CHAR_CAP, budget);
    const content = f.text.length>cap ? f.text.slice(0,cap)+'\n...(dipotong)' : f.text;
    snippets.push(`### ${f.path}\n\`\`\`\n${content}\n\`\`\``);
    budget -= content.length;
  }
  if(snippets.length){
    lines.push('');
    lines.push('--- Cuplikan isi file penting (dibatasi agar hemat token) ---');
    lines.push(snippets.join('\n\n'));
  }
  return lines.join('\n');
}

async function processZipAttachment(att, file){
  att.processing = true;
  try{
    if(typeof fflate==='undefined'){
      throw new Error('Pustaka ZIP belum termuat — cek koneksi internet lalu coba lagi');
    }
    att.zipStatus = 'Mengekstrak...'; att.zipProgress = 30; renderPreviewStrip(); await nextTick();
    const buf = new Uint8Array(await file.arrayBuffer());
    nazeZipBufferCache.set(att.id, buf);
    const { filter, stats } = makeZipEntryFilter();
    let unzipped;
    try{ unzipped = fflate.unzipSync(buf, { filter }); }
    catch(e){ throw new Error('File ZIP rusak atau tidak valid'); }

    att.zipStatus = 'Membaca isi...'; att.zipProgress = 60; renderPreviewStrip(); await nextTick();
    let files = collectZipFiles(unzipped);
    const rootPrefix = detectCommonRoot(files);
    if(rootPrefix) files = files.map(f=> ({ ...f, path: f.path.slice(rootPrefix.length+1) }));
    const fallbackName = (rootPrefix ? rootPrefix.replace(/-(main|master|dev|develop)$/i,'') : att.name.replace(/\.zip$/i,''));

    att.zipStatus = 'Menganalisis...'; att.zipProgress = 85; renderPreviewStrip(); await nextTick();
    const meta = detectProjectMeta(files, fallbackName);
    const contextText = buildProjectContextText(meta, files, stats);

    att.text = contextText;
    att.zipMeta = { fileCount: stats.totalFiles, folderCount: stats.allDirs.size, analyzedCount: stats.includedFiles, name: meta.name };
    att.unreadable = false;
    att.zipProgress = 100; att.zipStatus = 'Completed';
  }catch(e){
    att.unreadable = true;
    att.zipError = true;
    att.text = '';
    showToastError(`Gagal membaca ZIP: ${e.message||'file tidak valid'}. (${att.name})`);
  }finally{
    att.processing = false;
    att.zipStatus = null;
    renderPreviewStrip(); updateSendState();
  }
}

/* Salin teks + tampilkan feedback singkat "Tersalin!" pada tombol */
function bindCopyBtn(btn, text){
  btn.addEventListener('click', async ()=>{
    try{ await navigator.clipboard.writeText(text||''); }
    catch(e){
      // fallback untuk browser/webview yang tidak izinkan clipboard API
      const ta=document.createElement('textarea'); ta.value=text||''; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); }catch(_){}
      ta.remove();
    }
    btn.classList.add('copied');
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(()=>btn.classList.remove('copied'), 1400);
  });
}

