/* =========================================================================
   NAZE CODE — workspace UI controller
   Reuses the app's existing panel-overlay show/hide pattern (see settings
   panel in events.js) instead of inventing a new page/routing system.
   ========================================================================= */

let cpOpenTabs = []; // ordered list of open file paths (simple tab strip)
let cpAssetPreviewPath = null; // asset currently shown in the editor area instead of CodeMirror
let cpAssetPreviewObjectUrl = null; // object URL currently backing the asset preview pane — revoked on every switch/close (see revokeAssetPreviewUrl)

/* Per-file-type icons for the explorer ("ikon berdasarkan jenis file") —
   distinct glyphs for images, audio, video, fonts, and generic code, so
   an asset-heavy project doesn't read as an undifferentiated wall of the
   same icon. */
const ICON_IMAGE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;
const ICON_AUDIO = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
const ICON_VIDEO = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>`;
const ICON_FONT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20 9 4h1l5 16M6 14h7M17 8h3l3 12h-2l-.8-3h-4.4l-.8 3h-2Z"/></svg>`;
const ICON_PDF = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><text x="6" y="17" font-size="7" fill="currentColor" stroke="none">PDF</text></svg>`;
const ICON_CODE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
const ICON_DATA = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H6a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2M16 3h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2"/></svg>`;
const ICON_TEXT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`;
const AUDIO_EXT = new Set(['mp3','wav','ogg']);
const VIDEO_EXT = new Set(['mp4','webm']);
const FONT_EXT = new Set(['woff','woff2','ttf','otf','eot']);
function assetIconForExt(ext){
  ext = (ext||'').toLowerCase();
  if(ext==='pdf') return ICON_PDF;
  if(AUDIO_EXT.has(ext)) return ICON_AUDIO;
  if(VIDEO_EXT.has(ext)) return ICON_VIDEO;
  if(FONT_EXT.has(ext)) return ICON_FONT;
  return ICON_IMAGE; // png/jpg/jpeg/gif/webp/ico/bmp/avif and any other binary asset
}
function fileIconSvg(ext){
  ext = (ext||'').toLowerCase();
  if(ext==='json') return ICON_DATA;
  if(ext==='md'||ext==='txt') return ICON_TEXT;
  return ICON_CODE;
}
const folderIconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>`;

/* ---------- Open / close ---------- */
async function openCodeWorkspace(project){
  if(!codeProjects[project.id]) codeProjects[project.id] = project;
  activeCodeProject = project;
  activeCodeFilePath = project.activeFile || Object.keys(project.files)[0] || null;
  cpOpenTabs = activeCodeFilePath ? [activeCodeFilePath] : [];
  cpAssetPreviewPath = null;
  codeWorkspaceOpen = true;

  $('#codepage-overlay').classList.add('show');
  $('#cp-project-name').value = project.name;
  initNazeCodeEditor($('#cp-editor-container'));
  initNazeCodePreview($('#cp-preview-iframe'), appendConsoleEntry);
  $('#cp-autorun-toggle').checked = autoRunOn;
  renderCodeFileTree();
  renderCodeTabs();
  updateUndoButtonState();
  updateReviewButtonState();
  if(activeCodeFilePath) openCodeFile(activeCodeFilePath);
  clearConsolePanel();
  (project.consoleLog||[]).forEach(appendConsoleEntry); // restore last session's log, not just live output
  setPreviewLoading(true);
  refreshNazeCodePreview();
  setTimeout(()=>setPreviewLoading(false), 350);
  if(project.importStats && (project.importStats.skippedFiles>0)){
    showToastError(`Import selesai: ${project.importStats.includedFiles} file dimuat, ${project.importStats.skippedFiles} file dilewati (format tidak didukung).`);
    project.importStats = null;
  }
  if(project.pendingPatch) onPendingPatchReady(project.pendingPatch);
  await persistCodeProjects();
}

async function closeCodeWorkspace(){
  saveActiveFileFromEditor();
  revokeAssetPreviewUrl();
  await persistCodeProjects();
  codeWorkspaceOpen = false;
  $('#codepage-overlay').classList.remove('show');
}

/* Entry points used elsewhere in the app */
async function createProjectFromFilesAndOpen(filesObj, name){
  const project = newCodeProject(name, filesObj, []);
  await openCodeWorkspace(project);
}
async function openExistingProjectById(id){
  const project = codeProjects[id];
  if(project) await openCodeWorkspace(project);
}
/* Opens a project and immediately surfaces a specific pending patch — used
   by the chat bubble's "Tinjau N perubahan" badge (see message-render.js). */
async function openCodeWorkspaceWithDiff(projectId, patchId){
  const project = codeProjects[projectId];
  if(!project) return;
  await openCodeWorkspace(project);
  if(project.pendingPatch && (!patchId || project.pendingPatch.id===patchId)) onPendingPatchReady(project.pendingPatch);
}

/* ---------- Preview loading indicator ---------- */
function setPreviewLoading(on){
  const wrap = $('#cp-preview-wrap') || $('.cp-preview-wrap');
  if(wrap) wrap.classList.toggle('cp-loading', !!on);
}

/* ---------- File explorer ---------- */
function renderCodeFileTree(){
  const root = buildCodeFileTree(activeCodeProject);
  const container = $('#cp-filetree');
  container.innerHTML = '';
  function renderDir(dir, depth){
    const wrap = document.createElement('div');
    Object.values(dir.children).sort((a,b)=> (a.type===b.type ? a.name.localeCompare(b.name) : ((a.type==='dir')?-1:(b.type==='dir'?1:0)))).forEach(node=>{
      if(node.type==='dir'){
        const row = document.createElement('div');
        row.className='cp-tree-row cp-tree-dir'; row.style.paddingLeft=(depth*14+8)+'px';
        row.innerHTML = folderIconSvg + `<span>${escapeHtml(node.name)}</span>`;
        row.addEventListener('contextmenu', (e)=>{ e.preventDefault(); showFolderContextMenu(node.path); });
        wrap.appendChild(row);
        wrap.appendChild(renderDir(node, depth+1));
      } else {
        const isAsset = node.type==='asset';
        const isActive = isAsset ? (node.path===cpAssetPreviewPath) : (node.path===activeCodeFilePath && !cpAssetPreviewPath);
        const row = document.createElement('div');
        row.className = 'cp-tree-row ' + (isAsset ? 'cp-tree-asset' : 'cp-tree-file') + (isActive ? ' active' : '');
        row.style.paddingLeft=(depth*14+8)+'px';
        row.innerHTML = (isAsset ? assetIconForExt(fileExtOf(node.name)) : fileIconSvg(fileExtOf(node.name))) + `<span>${escapeHtml(node.name)}</span>`;
        row.addEventListener('click', ()=> isAsset ? openAssetPreview(node.path) : openCodeFile(node.path));
        row.addEventListener('contextmenu', (e)=>{ e.preventDefault(); showFileContextMenu(node.path, isAsset); });
        let pressTimer = null;
        row.addEventListener('touchstart', ()=>{ pressTimer = setTimeout(()=>showFileContextMenu(node.path, isAsset), 500); });
        row.addEventListener('touchend', ()=> clearTimeout(pressTimer));
        wrap.appendChild(row);
      }
    });
    return wrap;
  }
  container.appendChild(renderDir(root, 0));
}

function showFileContextMenu(path, isAsset){
  const choice = prompt(`"${path}"\nKetik salah satu:\n- rename <nama-baru-atau-folder/nama>  (rename/move)\n- delete`, '');
  if(choice==null) return;
  if(choice.trim()==='delete'){ isAsset ? deleteCodeAsset(path) : deleteCodeFile(path); return; }
  const m = choice.trim().match(/^rename\s+(.+)$/i);
  if(m) isAsset ? renameCodeAsset(path, sanitizeCodePath(m[1])) : renameCodeFile(path, sanitizeCodePath(m[1]));
}
function showFolderContextMenu(path){
  const choice = prompt(`Folder "${path}"\nKetik: rename <nama-baru> / delete`, '');
  if(choice==null) return;
  if(choice.trim()==='delete'){ deleteCodeFolder(path); return; }
  const m = choice.trim().match(/^rename\s+(.+)$/i);
  if(m) renameCodeFolder(path, sanitizeCodePath(m[1]));
}

/* ---------- Asset preview (editor area swaps to an <img>/generic preview) ----------
   Uses a real Blob + object URL instead of a giant `data:` string — cheaper
   for large media, and lets us actually manage the URL's lifecycle: exactly
   one preview object URL is ever alive at a time, revoked before the next
   one is created and on close, so switching between many assets (or
   closing the workspace) can't leak them. */
function revokeAssetPreviewUrl(){
  if(cpAssetPreviewObjectUrl){
    try{ URL.revokeObjectURL(cpAssetPreviewObjectUrl); }catch(e){}
    cpAssetPreviewObjectUrl = null;
  }
}
function openAssetPreview(path){
  saveActiveFileFromEditor();
  cpAssetPreviewPath = path;
  const asset = activeCodeProject.assets[path];
  const container = $('#cp-editor-container');
  const wrap = $('#cp-asset-preview');
  if(!asset || !wrap) return;
  revokeAssetPreviewUrl();
  let uri;
  try{
    const blob = new Blob([b64ToU8(asset.b64)], { type: asset.mime||'application/octet-stream' });
    uri = URL.createObjectURL(blob);
    cpAssetPreviewObjectUrl = uri;
  }catch(e){
    uri = `data:${asset.mime};base64,${asset.b64}`; // defensive fallback if Blob/URL API is unavailable
  }
  if(/^image\//.test(asset.mime)){
    wrap.innerHTML = `<div class="cp-asset-meta">${escapeHtml(path)} · ${fmtSize(asset.size||0)} · ${escapeHtml(asset.mime)}</div><img src="${uri}" alt="${escapeHtml(path)}">`;
  } else if(/^audio\//.test(asset.mime)){
    wrap.innerHTML = `<div class="cp-asset-meta">${escapeHtml(path)} · ${fmtSize(asset.size||0)}</div><audio controls src="${uri}"></audio>`;
  } else if(/^video\//.test(asset.mime)){
    wrap.innerHTML = `<div class="cp-asset-meta">${escapeHtml(path)} · ${fmtSize(asset.size||0)}</div><video controls src="${uri}"></video>`;
  } else if(/^font\//.test(asset.mime)){
    wrap.innerHTML = `<div class="cp-asset-meta">${escapeHtml(path)} · ${fmtSize(asset.size||0)}</div><div class="cp-asset-font-sample" style="font-family:'cp-preview-font'">AaBbCc 123 — pratinjau font tidak didukung penuh di semua browser.</div><style>@font-face{font-family:'cp-preview-font';src:url('${uri}');}</style>`;
  } else {
    wrap.innerHTML = `<div class="cp-asset-meta">${escapeHtml(path)} · ${fmtSize(asset.size||0)} · ${escapeHtml(asset.mime)}</div><div class="cp-asset-generic">Berkas biner — tidak ada pratinjau langsung. Gunakan Download project untuk membukanya di aplikasi lain.</div>`;
  }
  container.style.display = 'none';
  wrap.style.display = 'flex';
  renderCodeFileTree();
  renderCodeTabs();
}
function closeAssetPreview(){
  cpAssetPreviewPath = null;
  revokeAssetPreviewUrl();
  const container = $('#cp-editor-container');
  const wrap = $('#cp-asset-preview');
  if(wrap){ wrap.style.display = 'none'; wrap.innerHTML=''; }
  container.style.display = '';
}

async function createNewCodeFile(){
  const name = prompt('Nama file baru (contoh: js/script.js):');
  if(!name) return;
  const path = sanitizeCodePath(name);
  if(!path) return;
  if(pathExistsAnywhere(activeCodeProject, path)){ showToastError(`"${path}" sudah ada.`); return; }
  activeCodeProject.files[path] = '';
  touchProject(activeCodeProject);
  renderCodeFileTree();
  openCodeFile(path);
  await persistCodeProjects();
}
async function createNewCodeFolder(){
  const name = prompt('Nama folder baru:');
  if(!name) return;
  const path = sanitizeCodePath(name);
  if(!path) return;
  if(folderExistsInProject(activeCodeProject, path)){ showToastError(`Folder "${path}" sudah ada.`); return; }
  activeCodeProject.folders = activeCodeProject.folders||[];
  activeCodeProject.folders.push(path);
  touchProject(activeCodeProject);
  renderCodeFileTree();
  await persistCodeProjects();
}

/* ---------- Upload & drag-drop ("Upload & Import") ----------
   Separate from ZIP import: this is for adding individual assets (or a
   dragged folder of them) into an ALREADY-open project — multi-file at
   once, preserving relative folder structure, filenames with spaces/
   Unicode/special characters kept exactly as given (sanitizeCodePath only
   strips path-traversal segments and backslashes, nothing else). Every
   file is classified by extension against the same whitelist ZIP import
   uses (CODE_EDITABLE_EXT / CODE_ASSET_EXT); anything else, or anything
   over the per-file size cap, is skipped and counted for the summary toast
   — nothing is silently dropped without being accounted for. */
async function importFilesIntoProject(fileList, folderPrefix){
  if(!activeCodeProject) return;
  const files = Array.from(fileList||[]);
  if(!files.length) return;
  let addedText=0, addedAsset=0, renamed=0, rejected=0;
  for(const file of files){
    const relPath = (file.webkitRelativePath && file.webkitRelativePath.length) ? file.webkitRelativePath : file.name;
    let path = sanitizeCodePath((folderPrefix?folderPrefix+'/':'') + relPath);
    if(!path){ rejected++; continue; }
    const ext = fileExtOf(path);
    const isText = CODE_EDITABLE_EXT.has(ext);
    const isAsset = CODE_ASSET_EXT.has(ext);
    if(!isText && !isAsset){ rejected++; continue; }
    const cap = isAsset ? NAZE_CODE_MAX_ASSET_BYTES : NAZE_CODE_MAX_FILE_BYTES;
    if(file.size > cap){ rejected++; continue; } // file.size===0 (empty file) passes fine — never treated as "too small to keep"
    if(projectSizeExceeded(activeCodeProject, file.size)){ rejected++; continue; }
    // Never silently overwrite an existing file/asset — auto-dedupe the
    // name instead ("Jangan menimpa asset yang sudah ada tanpa konfirmasi").
    if(pathExistsAnywhere(activeCodeProject, path)){
      const deduped = dedupeAssetOrFilePath(activeCodeProject, path);
      if(deduped!==path){ path = deduped; renamed++; }
    }
    try{
      if(isText){
        activeCodeProject.files[path] = await file.text();
        addedText++;
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        activeCodeProject.assets = activeCodeProject.assets||{};
        activeCodeProject.assets[path] = { mime: file.type || mimeForExt(ext), b64: u8ToB64(bytes), size: bytes.length };
        addedAsset++;
      }
    }catch(e){ rejected++; }
  }
  touchProject(activeCodeProject);
  renderCodeFileTree();
  if(autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
  const parts = [];
  if(addedText||addedAsset) parts.push(`${addedText+addedAsset} file ditambahkan`);
  if(renamed) parts.push(`${renamed} diganti nama otomatis (nama bentrok)`);
  if(rejected) parts.push(`${rejected} dilewati (format/ukuran tidak didukung)`);
  showToastError(parts.length ? parts.join(', ') : 'Tidak ada file yang diimpor.');
}

/* Recursively walks dropped DataTransferItems (files AND folders) into a
   flat list of File objects with `webkitRelativePath` set so
   importFilesIntoProject() preserves the dropped folder structure. Falls
   back to a flat file list on browsers without the entries API (e.g. some
   mobile WebViews) — multi-file drop still works there, just without
   nested-folder support. */
function readEntriesAsFiles(entries){
  return new Promise(resolve=>{
    const out = [];
    let pending = 0, scanDone = false;
    const checkDone = ()=>{ if(scanDone && pending===0) resolve(out); };
    function walk(entry, prefix){
      if(!entry) return;
      if(entry.isFile){
        pending++;
        entry.file(file=>{
          try{ Object.defineProperty(file, 'webkitRelativePath', { value: prefix+file.name, configurable:true }); }catch(e){}
          out.push(file); pending--; checkDone();
        }, ()=>{ pending--; checkDone(); });
      } else if(entry.isDirectory){
        pending++;
        const reader = entry.createReader();
        const readBatch = ()=> reader.readEntries(batch=>{
          if(!batch.length){ pending--; checkDone(); return; }
          batch.forEach(child=> walk(child, prefix+entry.name+'/'));
          readBatch(); // readEntries may not return everything in one call
        }, ()=>{ pending--; checkDone(); });
        readBatch();
      }
    }
    entries.forEach(en=> walk(en, ''));
    scanDone = true; checkDone();
  });
}
function bindAssetDragDrop(){
  const zone = $('#cp-explorer');
  if(!zone) return;
  ['dragenter','dragover'].forEach(evt=> zone.addEventListener(evt, e=>{ e.preventDefault(); e.stopPropagation(); zone.classList.add('cp-dragover'); }));
  ['dragleave'].forEach(evt=> zone.addEventListener(evt, e=>{ e.preventDefault(); e.stopPropagation(); zone.classList.remove('cp-dragover'); }));
  zone.addEventListener('drop', async (e)=>{
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove('cp-dragover');
    if(!activeCodeProject) return;
    const items = e.dataTransfer && e.dataTransfer.items;
    if(items && items.length && items[0].webkitGetAsEntry){
      const entries = Array.from(items).map(it=> it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
      if(entries.length){ await importFilesIntoProject(await readEntriesAsFiles(entries), ''); return; }
    }
    await importFilesIntoProject(e.dataTransfer.files, '');
  });
}

/* Bug fix: the old check `if(!activeCodeProject.files[path])` treated an
   EMPTY file's content ('') as falsy, so a freshly-created blank file could
   never be deleted. Use an explicit existence check instead. */
async function deleteCodeFile(path){
  if(activeCodeProject.files[path]==null) return;
  delete activeCodeProject.files[path];
  cpOpenTabs = cpOpenTabs.filter(p=>p!==path);
  if(activeCodeFilePath===path){
    activeCodeFilePath = cpOpenTabs[0] || Object.keys(activeCodeProject.files)[0] || null;
    if(activeCodeFilePath) openCodeFile(activeCodeFilePath); else closeAssetPreview();
  }
  touchProject(activeCodeProject);
  renderCodeFileTree(); renderCodeTabs();
  if(autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
}
async function deleteCodeAsset(path){
  if(!activeCodeProject.assets || activeCodeProject.assets[path]==null) return;
  delete activeCodeProject.assets[path];
  if(cpAssetPreviewPath===path) closeAssetPreview();
  touchProject(activeCodeProject);
  renderCodeFileTree();
  if(autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
}
async function deleteCodeFolder(path){
  activeCodeProject.folders = (activeCodeProject.folders||[]).filter(f=>f!==path);
  const prefix = path + '/';
  Object.keys(activeCodeProject.files).filter(p=>p.startsWith(prefix)).forEach(p=>{ delete activeCodeProject.files[p]; cpOpenTabs = cpOpenTabs.filter(x=>x!==p); if(activeCodeFilePath===p) activeCodeFilePath=null; });
  Object.keys(activeCodeProject.assets||{}).filter(p=>p.startsWith(prefix)).forEach(p=>{ delete activeCodeProject.assets[p]; if(cpAssetPreviewPath===p) closeAssetPreview(); });
  if(!activeCodeFilePath){ activeCodeFilePath = cpOpenTabs[0] || Object.keys(activeCodeProject.files)[0] || null; if(activeCodeFilePath) openCodeFile(activeCodeFilePath); }
  touchProject(activeCodeProject);
  renderCodeFileTree(); renderCodeTabs();
  if(autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
}
/* Bug fix: renaming used to overwrite any existing file at newPath with no
   warning (silent data loss). Now refuses the collision instead. Also
   doubles as "move" — a path containing '/' just becomes the new folder.
   Rewrites references BEFORE the actual key rename (see
   rewriteReferencesAfterMove — it needs oldPath to still resolve). */
async function renameCodeFile(oldPath, newPath){
  if(!newPath || activeCodeProject.files[oldPath]==null) return;
  if(newPath===oldPath) return;
  if(pathExistsAnywhere(activeCodeProject, newPath)){ showToastError(`"${newPath}" sudah ada — pilih nama lain.`); return; }
  const touched = rewriteReferencesAfterMove(activeCodeProject, oldPath, newPath);
  activeCodeProject.files[newPath] = activeCodeProject.files[oldPath];
  delete activeCodeProject.files[oldPath];
  cpOpenTabs = cpOpenTabs.map(p=> p===oldPath ? newPath : p);
  if(activeCodeFilePath===oldPath) activeCodeFilePath = newPath;
  touchProject(activeCodeProject);
  renderCodeFileTree(); renderCodeTabs();
  if(activeCodeFilePath===newPath) openCodeFile(newPath);
  if(autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
  if(touched) showToastError(`Referensi diperbarui di ${touched} file.`);
}
async function renameCodeAsset(oldPath, newPath){
  if(!newPath || !activeCodeProject.assets || activeCodeProject.assets[oldPath]==null) return;
  if(newPath===oldPath) return;
  if(pathExistsAnywhere(activeCodeProject, newPath)){ showToastError(`"${newPath}" sudah ada — pilih nama lain.`); return; }
  const touched = rewriteReferencesAfterMove(activeCodeProject, oldPath, newPath);
  activeCodeProject.assets[newPath] = activeCodeProject.assets[oldPath];
  delete activeCodeProject.assets[oldPath];
  if(cpAssetPreviewPath===oldPath){ cpAssetPreviewPath=null; openAssetPreview(newPath); }
  touchProject(activeCodeProject);
  renderCodeFileTree();
  if(autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
  if(touched) showToastError(`Referensi diperbarui di ${touched} file.`);
}
async function renameCodeFolder(oldPath, newPath){
  if(!newPath || newPath===oldPath) return;
  if(folderExistsInProject(activeCodeProject, newPath)){ showToastError(`Folder "${newPath}" sudah ada.`); return; }
  const oldPrefix = oldPath + '/';
  // Build the full old->new path map for every file/asset under this folder
  // FIRST, then rewrite references against the pre-move project state for
  // each pair, and only after all of that actually move the keys — moving
  // first would make resolveAssetPath unable to find the old paths anymore.
  const moves = [];
  Object.keys(activeCodeProject.files).filter(p=>p.startsWith(oldPrefix)).forEach(p=> moves.push({ path:p, newPath: newPath+'/'+p.slice(oldPrefix.length), kind:'text' }));
  Object.keys(activeCodeProject.assets||{}).filter(p=>p.startsWith(oldPrefix)).forEach(p=> moves.push({ path:p, newPath: newPath+'/'+p.slice(oldPrefix.length), kind:'asset' }));
  // Note: when two files inside the same folder reference each other and
  // both move together, the rewritten reference can end up longer than
  // necessary (e.g. "../new/img.png" instead of the still-valid "img.png")
  // because each move is resolved independently against the pre-move
  // state — it still resolves correctly, just isn't always the shortest
  // possible path. Fully optimizing that is out of scope for a best-effort
  // static rewrite.
  let touched = 0;
  moves.forEach(mv=>{ touched += rewriteReferencesAfterMove(activeCodeProject, mv.path, mv.newPath); });
  moves.forEach(mv=>{
    if(mv.kind==='text'){
      activeCodeProject.files[mv.newPath] = activeCodeProject.files[mv.path]; delete activeCodeProject.files[mv.path];
      cpOpenTabs = cpOpenTabs.map(x=> x===mv.path?mv.newPath:x);
      if(activeCodeFilePath===mv.path) activeCodeFilePath = mv.newPath;
    } else {
      activeCodeProject.assets[mv.newPath] = activeCodeProject.assets[mv.path]; delete activeCodeProject.assets[mv.path];
      if(cpAssetPreviewPath===mv.path) cpAssetPreviewPath = mv.newPath;
    }
  });
  activeCodeProject.folders = (activeCodeProject.folders||[]).map(f=> f===oldPath?newPath:f);
  touchProject(activeCodeProject);
  renderCodeFileTree(); renderCodeTabs();
  if(autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
  if(touched) showToastError(`Referensi diperbarui di ${touched} file.`);
}

/* ---------- Tabs / editor ---------- */
function saveActiveFileFromEditor(){
  if(!activeCodeProject || !activeCodeFilePath || cpAssetPreviewPath) return;
  activeCodeProject.files[activeCodeFilePath] = nazeCodeEditorGetValue();
}
function openCodeFile(path){
  if(cpAssetPreviewPath) closeAssetPreview();
  else if(activeCodeFilePath) saveActiveFileFromEditor();
  activeCodeFilePath = path;
  activeCodeProject.activeFile = path;
  if(!cpOpenTabs.includes(path)) cpOpenTabs.push(path);
  nazeCodeEditorOpenFile(path, activeCodeProject.files[path]||'', onCodeEditorChange);
  renderCodeFileTree();
  renderCodeTabs();
}
function onCodeEditorChange(value){
  if(!activeCodeProject || !activeCodeFilePath) return;
  if(projectSizeExceeded(activeCodeProject, value.length - (activeCodeProject.files[activeCodeFilePath]||'').length)){
    showToastError(`Project mendekati/melebihi batas ukuran (${fmtSize(NAZE_CODE_MAX_PROJECT_BYTES)}). Hapus file yang tidak perlu.`);
  }
  activeCodeProject.files[activeCodeFilePath] = value;
  touchProject(activeCodeProject);
  persistCodeProjects();
  scheduleNazeAutoRun();
}
function renderCodeTabs(){
  const bar = $('#cp-tabs'); bar.innerHTML = '';
  cpOpenTabs.forEach(path=>{
    const isAssetTab = path===cpAssetPreviewPath;
    const tab = document.createElement('div');
    tab.className = 'cp-tab' + (path===(isAssetTab?cpAssetPreviewPath:activeCodeFilePath) && (isAssetTab || !cpAssetPreviewPath) ? ' active' : '');
    tab.innerHTML = `<span>${escapeHtml(path.split('/').pop())}</span><button aria-label="Tutup tab">&times;</button>`;
    tab.querySelector('span').addEventListener('click', ()=> isAssetOnlyPath(path) ? openAssetPreview(path) : openCodeFile(path));
    tab.querySelector('button').addEventListener('click', (e)=>{
      e.stopPropagation();
      cpOpenTabs = cpOpenTabs.filter(p=>p!==path);
      if(activeCodeFilePath===path || cpAssetPreviewPath===path){
        const next = cpOpenTabs[0] || null;
        if(next) (isAssetOnlyPath(next) ? openAssetPreview(next) : openCodeFile(next));
        else { activeCodeFilePath=null; closeAssetPreview(); renderCodeTabs(); }
      } else renderCodeTabs();
    });
    bar.appendChild(tab);
  });
}
function isAssetOnlyPath(path){ return activeCodeProject && activeCodeProject.assets && activeCodeProject.assets[path]!=null && activeCodeProject.files[path]==null; }

/* ---------- AI patch review (diff panel: Accept / Reject / Undo) ----------
   Root-cause fix for "AI edits overwrite files without confirmation":
   handleNazeFileBlocksInMessage() (code-state.js) now only STAGES a
   pendingPatch; nothing here writes to project.files until the user acts. */
function onPendingPatchReady(patch){
  updateReviewButtonState();
  if(codeWorkspaceOpen) openDiffPanel();
  showToastError(`Naze mengusulkan perubahan pada ${patch.files.length} file. Tinjau di panel Diff.`);
}
function updateReviewButtonState(){
  const btn = $('#cp-review-btn');
  if(!btn) return;
  const n = activeCodeProject && activeCodeProject.pendingPatch ? activeCodeProject.pendingPatch.files.length : 0;
  btn.style.display = n ? 'inline-flex' : 'none';
  btn.textContent = ''; // rebuilt below with icon + count
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Review (${n})`;
}
function updateUndoButtonState(){
  const btn = $('#cp-undo-btn');
  if(!btn) return;
  const has = activeCodeProject && activeCodeProject.patchHistory && activeCodeProject.patchHistory.length>0;
  btn.disabled = !has;
}
function renderDiffLineHtml(op){
  const cls = op.type==='add' ? 'cp-diffline add' : op.type==='del' ? 'cp-diffline del' : 'cp-diffline eq';
  const sign = op.type==='add' ? '+' : op.type==='del' ? '-' : ' ';
  return `<div class="${cls}"><span class="sign">${sign}</span><span class="txt">${escapeHtml(op.text)}</span></div>`;
}
function renderDiffPanel(){
  const body = $('#cp-diff-body');
  const patch = activeCodeProject && activeCodeProject.pendingPatch;
  if(!patch || !patch.files.length){ body.innerHTML = '<div class="cp-diff-empty">Tidak ada perubahan yang menunggu.</div>'; return; }
  body.innerHTML = '';
  patch.files.forEach((f, idx)=>{
    const card = document.createElement('div');
    card.className = 'cp-diff-file';
    const statusLabel = f.isNew ? 'File baru' : 'Diubah';
    const ops = diffLines(f.before, f.after).filter(o=>true);
    // Only render changed lines + minimal context to keep huge files readable.
    const shown = [];
    let ctx = 0;
    ops.forEach((op,i)=>{
      if(op.type!=='eq'){ shown.push(op); ctx=2; }
      else if(ctx>0){ shown.push(op); ctx--; }
    });
    card.innerHTML = `
      <div class="cp-diff-file-head">
        <span class="cp-diff-path">${escapeHtml(f.path)}</span>
        <span class="cp-diff-status">${statusLabel}</span>
        <div class="cp-diff-file-actions">
          <button data-a="accept" class="cp-diff-accept">Accept</button>
          <button data-a="reject" class="cp-diff-reject">Reject</button>
        </div>
      </div>
      <div class="cp-diff-lines">${(shown.length? shown : ops.slice(0,20)).map(renderDiffLineHtml).join('')}</div>
    `;
    card.querySelector('[data-a="accept"]').addEventListener('click', ()=> resolvePatchFile(idx, true));
    card.querySelector('[data-a="reject"]').addEventListener('click', ()=> resolvePatchFile(idx, false));
    body.appendChild(card);
  });
}
async function resolvePatchFile(idx, accept){
  const patch = activeCodeProject.pendingPatch;
  if(!patch) return;
  const f = patch.files[idx];
  if(!f) return;
  if(accept){
    applyPatchFiles(activeCodeProject, [{ path: f.path, content: f.after }], `Naze: ${f.path}`);
    if(!cpOpenTabs.includes(f.path)) cpOpenTabs.push(f.path);
    if(activeCodeFilePath===f.path) openCodeFile(f.path);
  }
  patch.files.splice(idx, 1);
  if(!patch.files.length) activeCodeProject.pendingPatch = null;
  touchProject(activeCodeProject);
  renderCodeFileTree(); renderCodeTabs(); renderDiffPanel();
  updateReviewButtonState(); updateUndoButtonState();
  if(accept && autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
  if(!activeCodeProject.pendingPatch) closeDiffPanel();
}
async function resolveAllPendingPatch(accept){
  const patch = activeCodeProject.pendingPatch;
  if(!patch) return;
  if(accept){
    applyPatchFiles(activeCodeProject, patch.files.map(f=>({path:f.path, content:f.after})), `Naze: ${patch.files.length} file`);
    patch.files.forEach(f=>{ if(!cpOpenTabs.includes(f.path)) cpOpenTabs.push(f.path); });
    if(activeCodeFilePath) openCodeFile(activeCodeFilePath);
  }
  activeCodeProject.pendingPatch = null;
  touchProject(activeCodeProject);
  renderCodeFileTree(); renderCodeTabs();
  updateReviewButtonState(); updateUndoButtonState();
  if(accept && autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
  closeDiffPanel();
  showToastError(accept ? 'Semua perubahan diterapkan.' : 'Semua perubahan ditolak.');
}
function openDiffPanel(){ renderDiffPanel(); $('#cp-diff-overlay').classList.add('show'); }
function closeDiffPanel(){ $('#cp-diff-overlay').classList.remove('show'); }

async function undoLastCodeChange(){
  if(!activeCodeProject) return;
  const undone = undoLastPatch(activeCodeProject);
  if(!undone) return;
  renderCodeFileTree(); renderCodeTabs();
  if(activeCodeFilePath) openCodeFile(activeCodeFilePath);
  updateUndoButtonState();
  if(autoRunOn) refreshNazeCodePreview();
  await persistCodeProjects();
  showToastError(`Dibatalkan: ${undone.label}`);
}

/* ---------- Console panel + debugging loop ---------- */
function clearConsolePanel(){ $('#cp-console-body').innerHTML=''; }
function appendConsoleEntry(entry){
  const body = $('#cp-console-body');
  const row = document.createElement('div');
  row.className = 'cp-console-row level-' + entry.level;
  row.textContent = `[${entry.level.toUpperCase()}] ${entry.text}`;
  body.appendChild(row);
  body.scrollTop = body.scrollHeight;
}
/* "Debugging Loop": send the most recent console errors (plus whatever
   project context is already wired into chat — see buildCodeContextBlock)
   straight to Naze as a chat message, so a failed Run can go
   error -> ask Naze -> fix -> Run again without leaving the flow. */
function sendConsoleErrorsToNaze(){
  const errors = (activeCodeProject && activeCodeProject.consoleLog || nazeConsoleEntries).filter(e=>e.level==='error').slice(-8);
  if(!errors.length){ showToastError('Tidak ada error di console untuk dikirim.'); return; }
  const text = 'Preview Naze Code menghasilkan error berikut, tolong analisis dan perbaiki:\n' + errors.map(e=>`- ${e.text}`).join('\n');
  $('#text-input').value = text;
  closeCodeWorkspace();
  if(typeof updateSendState==='function') updateSendState();
  if(typeof sendMessage==='function') sendMessage();
}

/* ---------- Project browser (list of saved projects + create new) ----------
   Fixes the previous structural gap: projects were persisted via
   loadCodeProjectsIndex()/persistCodeProjects(), but the only way to *open*
   one was through the exact chat message that created it (its "Open in
   Naze Code" button / "N file diperbarui" badge). Close that message's chat,
   start a new chat, or just close the workspace, and a saved project became
   permanently unreachable even though the data was still in storage — the
   editor genuinely had nothing to show. This adds a real entry point. */
function fmtRelativeTime(ts){
  const diff = Date.now() - ts;
  const min = Math.floor(diff/60000);
  if(min < 1) return 'baru saja';
  if(min < 60) return `${min} menit lalu`;
  const hr = Math.floor(min/60);
  if(hr < 24) return `${hr} jam lalu`;
  const day = Math.floor(hr/24);
  if(day < 30) return `${day} hari lalu`;
  return new Date(ts).toLocaleDateString('id-ID');
}
function renderCodeProjectsList(){
  const list = $('#cp-list');
  list.innerHTML = '';
  if(!codeProjectsOrder.length){
    list.innerHTML = '<div class="cp-list-empty">Belum ada project. Buat satu untuk mulai coding.</div>';
    return;
  }
  codeProjectsOrder.forEach(id=>{
    const project = codeProjects[id];
    if(!project) return; // stale id left over from a dropped/corrupted entry
    const fileCount = Object.keys(project.files||{}).length + Object.keys(project.assets||{}).length;
    const row = document.createElement('div');
    row.className = 'cp-list-item';
    row.innerHTML = `
      <div class="ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg></div>
      <div class="meta">
        <div class="n">${escapeHtml(project.name||'Project')}</div>
        <div class="s">${fileCount} file · ${fmtSize(projectByteSize(project))} · ${fmtRelativeTime(project.updatedAt||project.createdAt||Date.now())}</div>
      </div>
      <div class="actions">
        <button data-a="rename" aria-label="Ganti nama"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button data-a="delete" class="danger" aria-label="Hapus"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg></button>
      </div>`;
    row.addEventListener('click', async ()=>{ closeCodeProjectsList(); await openExistingProjectById(id); });
    row.querySelector('[data-a="rename"]').addEventListener('click', async (e)=>{
      e.stopPropagation();
      const name = prompt('Nama baru untuk project:', project.name||'');
      if(!name || !name.trim()) return;
      project.name = name.trim();
      touchProject(project);
      await persistCodeProjects();
      renderCodeProjectsList();
    });
    row.querySelector('[data-a="delete"]').addEventListener('click', async (e)=>{
      e.stopPropagation();
      if(!confirm(`Hapus project "${project.name||'Project'}"? Tindakan ini tidak bisa dibatalkan.`)) return;
      delete codeProjects[id];
      codeProjectsOrder = codeProjectsOrder.filter(x=>x!==id);
      if(activeCodeProject && activeCodeProject.id===id){
        activeCodeProject = null; activeCodeFilePath = null;
        $('#codepage-overlay').classList.remove('show');
        codeWorkspaceOpen = false;
      }
      await persistCodeProjects();
      renderCodeProjectsList();
    });
    list.appendChild(row);
  });
}
function openCodeProjectsList(){
  renderCodeProjectsList();
  $('#codelist-overlay').classList.add('show');
}
function closeCodeProjectsList(){ $('#codelist-overlay').classList.remove('show'); }

/* A brand-new project used to be impossible to create without first asking
   the AI to generate one — there was no blank-slate starting point. This
   seeds a minimal editable HTML/CSS/JS trio so the workspace is immediately
   usable (editor has content, preview has something to render). */
async function createBlankCodeProject(){
  const name = prompt('Nama project baru:', 'Project baru');
  if(name==null) return;
  const files = {
    'index.html': '<!doctype html>\n<html lang="id">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Project baru</title>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n<h1>Halo dari Naze Code</h1>\n<script src="script.js"><\/script>\n</body>\n</html>\n',
    'style.css': 'body{font-family:system-ui,sans-serif; padding:24px;}\n',
    'script.js': 'console.log("Naze Code siap.");\n'
  };
  const project = newCodeProject(name.trim() || 'Project baru', files, []);
  closeCodeProjectsList();
  await openCodeWorkspace(project);
}

/* ---------- ZIP import from the project list ("Import ZIP" entry point) ---------- */
async function importZipIntoNewProject(fileObj){
  if(!fileObj) return;
  showToastError('Mengimpor ZIP...');
  try{
    const buf = await fileObj.arrayBuffer();
    const project = await importZipBufferAsProject(buf, fileObj.name.replace(/\.zip$/i,''));
    closeCodeProjectsList();
    await openCodeWorkspace(project);
  }catch(e){
    showToastError('Gagal mengimpor ZIP: ' + (e.message||'error tidak diketahui'));
  }
}

/* ---------- Wire up buttons (called once from main.js init) ---------- */
function bindCodeWorkspaceEvents(){
  $('#naze-code-btn').addEventListener('click', ()=>{ openCodeProjectsList(); if(typeof closeSidebarMobile==='function') closeSidebarMobile(); });
  $('#codelist-close').addEventListener('click', closeCodeProjectsList);
  $('#codelist-overlay').addEventListener('click', e=>{ if(e.target.id==='codelist-overlay') closeCodeProjectsList(); });
  $('#cp-list-new-btn').addEventListener('click', createBlankCodeProject);
  if($('#cp-list-import-btn') && $('#cp-zip-input')){
    $('#cp-list-import-btn').addEventListener('click', ()=> $('#cp-zip-input').click());
    $('#cp-zip-input').addEventListener('change', (e)=>{
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if(f) importZipIntoNewProject(f);
    });
  }
  $('#codepage-close').addEventListener('click', closeCodeWorkspace);
  $('#codepage-back').addEventListener('click', async ()=>{
    await closeCodeWorkspace();
    openCodeProjectsList();
  });
  $('#cp-save-btn').addEventListener('click', async ()=>{
    saveActiveFileFromEditor();
    activeCodeProject.name = $('#cp-project-name').value.trim() || activeCodeProject.name;
    await persistCodeProjects();
    showToastError('Project disimpan.');
  });
  $('#cp-download-btn').addEventListener('click', async ()=>{
    saveActiveFileFromEditor();
    await downloadProjectZip(activeCodeProject);
  });
  $('#cp-run-btn').addEventListener('click', ()=>{ saveActiveFileFromEditor(); setPreviewLoading(true); refreshNazeCodePreview(); setTimeout(()=>setPreviewLoading(false),300); });
  $('#cp-preview-refresh').addEventListener('click', ()=>{ saveActiveFileFromEditor(); setPreviewLoading(true); refreshNazeCodePreview(); setTimeout(()=>setPreviewLoading(false),300); });
  $('#cp-preview-fullscreen').addEventListener('click', ()=>{
    const el = $('#cp-preview-iframe');
    if(el.requestFullscreen) el.requestFullscreen();
  });
  $('#cp-autorun-toggle').addEventListener('change', (e)=>{ autoRunOn = e.target.checked; });
  $('#cp-console-clear').addEventListener('click', clearConsolePanel);
  if($('#cp-console-send')) $('#cp-console-send').addEventListener('click', sendConsoleErrorsToNaze);
  $('#cp-new-file').addEventListener('click', createNewCodeFile);
  $('#cp-new-folder').addEventListener('click', createNewCodeFolder);
  if($('#cp-upload-btn') && $('#cp-upload-input')){
    $('#cp-upload-btn').addEventListener('click', ()=> $('#cp-upload-input').click());
    $('#cp-upload-input').addEventListener('change', async (e)=>{
      const files = e.target.files;
      e.target.value = '';
      if(files && files.length) await importFilesIntoProject(files, '');
    });
  }
  bindAssetDragDrop();
  $('#cp-find-btn').addEventListener('click', nazeCodeEditorFind);
  $('#cp-toggle-files').addEventListener('click', ()=> $('#cp-explorer').classList.toggle('cp-drawer-open'));
  $('#cp-toggle-preview').addEventListener('click', ()=> $('#cp-right').classList.toggle('cp-drawer-open'));
  $('#cp-toggle-console').addEventListener('click', ()=> $('#cp-console').classList.toggle('cp-console-open'));
  if($('#cp-undo-btn')) $('#cp-undo-btn').addEventListener('click', undoLastCodeChange);
  if($('#cp-review-btn')) $('#cp-review-btn').addEventListener('click', openDiffPanel);
  if($('#cp-diff-close')) $('#cp-diff-close').addEventListener('click', closeDiffPanel);
  if($('#cp-diff-accept-all')) $('#cp-diff-accept-all').addEventListener('click', ()=>resolveAllPendingPatch(true));
  if($('#cp-diff-reject-all')) $('#cp-diff-reject-all').addEventListener('click', ()=>resolveAllPendingPatch(false));
}
