/* =========================================================================
   NAZE CODE — state & data model
   Virtual project/file system + persistence + AI file-block parsing.
   Reuses existing storage helpers (stGet/stSet), the fflate lib already
   loaded for ZIP, and the ZIP_* safety constants already defined in state.js
   (ZIP_IGNORE_DIR_NAMES, ZIP_SECRET_PATTERNS, ZIP_IGNORE_FILE_PATTERNS, ...).

   Data model (per project):
     files:   path -> string (source/text, editable in CodeMirror)
     assets:  path -> { mime, b64, size }  (binary — images/fonts/audio/etc,
              never decoded as text so ZIP import/export never corrupts them)
     folders: explicit empty-folder paths
     pendingPatch: { id, ts, source:'ai', files:[{path,before,after,isNew,isDelete}] } | null
              — AI edits are staged here first; nothing touches `files` until
              the user accepts (see applyPatchFiles / discardPendingPatch).
     patchHistory: [{ id, ts, label, files:{path: prevContentOrNull} }]
              — undo stack, most recent last, capped at NAZE_CODE_MAX_HISTORY.
   ========================================================================= */

/* ---------- Runtime state ---------- */
let codeProjects = {};        // id -> project object (kept in memory)
let codeProjectsOrder = [];   // ids, most-recently-used first
let activeCodeProject = null; // project object currently open in Naze Code (or null)
let activeCodeFilePath = null;// path of file currently open in the editor
let autoRunOn = true;
let codeWorkspaceOpen = false;

const NAZE_CODE_STORE_KEY = 'codeProjects';
const NAZE_CODE_MAX_PROJECTS = 15;     // oldest projects beyond this are dropped
const NAZE_CODE_MAX_PROJECT_BYTES = 4*1024*1024; // ~4MB of source+asset bytes per project (safety net)
const NAZE_CODE_MAX_FILE_BYTES = 400*1024; // a single text file above this is refused (keeps the editor responsive)
const NAZE_CODE_MAX_ASSET_BYTES = 1.5*1024*1024; // a single binary asset above this is refused
const NAZE_CODE_MAX_HISTORY = 20; // undo stack depth

const CODE_EDITABLE_EXT = new Set([
  'html','htm','css','scss','js','jsx','ts','tsx','json','md','txt','svg',
  'xml','yml','yaml','py','php','vue','svelte'
]);

/* Binary/asset extensions — never decoded as UTF-8 text, stored as base64
   in project.assets instead so ZIP round-trips (import -> edit -> export)
   never corrupt them. */
const CODE_ASSET_EXT = new Set([
  'png','jpg','jpeg','gif','webp','ico','bmp','avif',
  'woff','woff2','ttf','otf','eot',
  'mp3','wav','ogg','mp4','webm',
  'pdf'
]);
const ASSET_MIME_BY_EXT = {
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
  webp:'image/webp', ico:'image/x-icon', bmp:'image/bmp', avif:'image/avif',
  svg:'image/svg+xml',
  woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf', eot:'application/vnd.ms-fontobject',
  mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', mp4:'video/mp4', webm:'video/webm',
  pdf:'application/pdf', json:'application/json'
};
function mimeForExt(ext){ return ASSET_MIME_BY_EXT[(ext||'').toLowerCase()] || 'application/octet-stream'; }

/* ---------- Persistence ---------- */
async function loadCodeProjectsIndex(){
  const saved = await stGet(NAZE_CODE_STORE_KEY);
  if(saved && typeof saved === 'object'){
    codeProjects = saved.projects || {};
    codeProjectsOrder = saved.order || Object.keys(codeProjects);
    // Migrate projects saved before assets/patch fields existed.
    Object.values(codeProjects).forEach(p=>{
      if(!p.assets) p.assets = {};
      if(!p.folders) p.folders = [];
      if(!p.patchHistory) p.patchHistory = [];
      if(p.pendingPatch === undefined) p.pendingPatch = null;
      if(!p.consoleLog) p.consoleLog = [];
    });
  }
}
async function persistCodeProjects(){
  // Touch the order list so the active project floats to the front.
  if(activeCodeProject){
    codeProjectsOrder = [activeCodeProject.id, ...codeProjectsOrder.filter(id=>id!==activeCodeProject.id)];
  }
  while(codeProjectsOrder.length > NAZE_CODE_MAX_PROJECTS){
    const dropId = codeProjectsOrder.pop();
    delete codeProjects[dropId];
  }
  await stSet(NAZE_CODE_STORE_KEY, { projects: codeProjects, order: codeProjectsOrder });
}

/* ---------- Project helpers ---------- */
function projectByteSize(project){
  let total = 0;
  for(const p in project.files){ total += (project.files[p]||'').length; }
  for(const p in (project.assets||{})){ total += Math.ceil((project.assets[p].b64||'').length * 0.75); }
  return total;
}
function projectSizeExceeded(project, extraBytes){
  return (projectByteSize(project) + (extraBytes||0)) > NAZE_CODE_MAX_PROJECT_BYTES;
}
function sanitizeCodePath(path){
  return String(path||'')
    .replace(/\\/g,'/')          // normalize Windows separators
    .replace(/^\/+/,'')
    .split('/')
    .filter(seg => seg && seg!=='.' && seg!=='..') // strips traversal segments — see ZIP zip-slip note below
    .join('/');
}
function fileExtOf(path){
  const base = path.split('/').pop()||'';
  const dot = base.lastIndexOf('.');
  return dot>0 ? base.slice(dot+1).toLowerCase() : '';
}
function isAssetPath(project, path){ return !!(project.assets && project.assets[path]!=null); }
function pathExistsAnywhere(project, path){
  return project.files[path]!=null || (project.assets && project.assets[path]!=null) || (project.folders||[]).includes(path);
}
/* Collision-safe path for uploads/drag-drop: never silently overwrites an
   existing file/asset — appends " (2)", " (3)", ... before the extension
   until a free path is found. */
function dedupeAssetOrFilePath(project, path){
  if(!pathExistsAnywhere(project, path)) return path;
  const slash = path.lastIndexOf('/');
  const dir = slash>=0 ? path.slice(0, slash+1) : '';
  const base = slash>=0 ? path.slice(slash+1) : path;
  const dot = base.lastIndexOf('.');
  const stem = dot>0 ? base.slice(0,dot) : base;
  const ext = dot>0 ? base.slice(dot) : '';
  let n=2, candidate;
  do{ candidate = `${dir}${stem} (${n})${ext}`; n++; }while(pathExistsAnywhere(project, candidate));
  return candidate;
}
/* True if `path` is a folder that already exists — either explicitly (empty
   folder) or implicitly (some file/asset lives under it). Used to stop
   "+ Folder" from silently creating a second, duplicate entry. */
function folderExistsInProject(project, path){
  if((project.folders||[]).includes(path)) return true;
  const prefix = path + '/';
  return Object.keys(project.files).some(p=>p.startsWith(prefix))
      || Object.keys(project.assets||{}).some(p=>p.startsWith(prefix));
}

/* ---------- base64 helpers (browser-safe, no Buffer) ---------- */
function u8ToB64(u8){
  let binary = '';
  const chunk = 0x8000;
  for(let i=0; i<u8.length; i+=chunk){
    binary += String.fromCharCode.apply(null, u8.subarray(i, i+chunk));
  }
  return btoa(binary);
}
function b64ToU8(b64){
  const binary = atob(b64);
  const u8 = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) u8[i] = binary.charCodeAt(i);
  return u8;
}

function newCodeProject(name, files, folders, assets){
  const id = uid();
  const now = Date.now();
  const project = {
    id, name: name || 'Project baru',
    createdAt: now, updatedAt: now,
    files: {},         // path -> string content
    assets: {},         // path -> {mime, b64, size}
    folders: [],         // explicit empty-folder paths
    activeFile: null,
    consoleLog: [],       // last N console entries, kept for AI context ("Recent Changes / Console Errors")
    pendingPatch: null,   // AI-proposed change awaiting Accept/Reject (see diff UI)
    patchHistory: []      // undo stack of previously-applied patches
  };
  Object.entries(files||{}).forEach(([p,content])=>{
    const clean = sanitizeCodePath(p);
    if(!clean) return;
    project.files[clean] = String(content).slice(0, NAZE_CODE_MAX_FILE_BYTES);
  });
  Object.entries(assets||{}).forEach(([p,a])=>{
    const clean = sanitizeCodePath(p);
    if(!clean || !a || !a.b64) return;
    project.assets[clean] = { mime: a.mime || mimeForExt(fileExtOf(clean)), b64: a.b64, size: a.size||0 };
  });
  (folders||[]).forEach(f=>{ const c=sanitizeCodePath(f); if(c) project.folders.push(c); });
  const firstHtml = Object.keys(project.files).find(p=>/\.html?$/i.test(p));
  project.activeFile = firstHtml || Object.keys(project.files)[0] || null;
  codeProjects[id] = project;
  codeProjectsOrder = [id, ...codeProjectsOrder.filter(x=>x!==id)];
  return project;
}
function touchProject(project){ project.updatedAt = Date.now(); }

/* Build a { path -> ['folder-a','folder-b',...] } tree for the explorer.
   Assets are included alongside files, tagged type:'asset' so the UI can
   render a distinct (non-editable) icon/row for them. */
function buildCodeFileTree(project){
  const root = { type:'dir', name:'', path:'', children:{} };
  function ensureDir(pathParts, node){
    if(!pathParts.length) return node;
    const [head,...rest] = pathParts;
    if(!node.children[head]) node.children[head] = { type:'dir', name:head, path:(node.path?node.path+'/':'')+head, children:{} };
    return ensureDir(rest, node.children[head]);
  }
  Object.keys(project.files).sort().forEach(path=>{
    const parts = path.split('/');
    const fileName = parts.pop();
    const dir = ensureDir(parts, root);
    dir.children[fileName] = { type:'file', name:fileName, path };
  });
  Object.keys(project.assets||{}).sort().forEach(path=>{
    const parts = path.split('/');
    const fileName = parts.pop();
    const dir = ensureDir(parts, root);
    dir.children[fileName] = { type:'asset', name:fileName, path };
  });
  (project.folders||[]).forEach(path=>{ ensureDir(path.split('/'), root); });
  return root;
}

/* ---------- AI file-block convention ----------
   Fenced code blocks whose FIRST line is a tag comment identifying the file
   path are auto-applied to the open project. Understood tags:
     /* NAZE_FILE: path/to/file.js *\/        (js/css/json/etc.)
     <!-- NAZE_FILE: path/to/file.html -->    (html/xml/markdown/svelte/vue)
   This keeps AI edits patch-like (only changed files are sent back) instead
   of the model re-emitting the whole project every turn. */
const NAZE_FILE_TAG_LINE_RE = /^\s*(?:\/\*\s*NAZE_FILE:\s*(.+?)\s*\*\/|<!--\s*NAZE_FILE:\s*(.+?)\s*-->)\s*$/;

function parseNazeFileBlocks(text){
  if(!text) return [];
  const blocks = [];
  const fenceRe = /```[ \t]*([\w.-]*)\n([\s\S]*?)```/g;
  let m;
  while((m = fenceRe.exec(text))){
    const body = m[2];
    const firstNL = body.indexOf('\n');
    const firstLine = firstNL===-1 ? body : body.slice(0, firstNL);
    const tagMatch = firstLine.match(NAZE_FILE_TAG_LINE_RE);
    if(!tagMatch) continue;
    const path = sanitizeCodePath(tagMatch[1] || tagMatch[2]);
    if(!path) continue;
    const content = firstNL===-1 ? '' : body.slice(firstNL+1);
    blocks.push({ path, content: content.replace(/\n$/,'') });
  }
  return blocks;
}

/* Detect, from plain chat text, whether the user is asking for a coding
   deliverable — used so the system prompt only asks the model to use the
   NAZE_FILE convention when it's actually relevant. */
const CODE_INTENT_RE = /\b(buatkan|bikinkan|bikin|buat)\b.{0,25}\b(web|website|halaman|landing page|landing|portfolio|kalkulator|game|permainan|aplikasi web|to.?do|todo list|form|toko online|dashboard)\b|\b(perbaiki|betulkan|fix)\b.{0,20}\b(project|kode|code|bug|error|tombol|button|halaman|script)\b|\bubah\b.{0,20}\b(warna|tampilan|layout|style|css|tombol)\b|\btambahkan\b.{0,20}\b(dark mode|fitur|fungsi|halaman|animasi)\b.{0,20}\b(project|code|kode|web|website)?\b/i;
function looksLikeCodeRequest(text){
  if(!text) return false;
  return CODE_INTENT_RE.test(text);
}

/* Fallback filenames/extensions for PLAIN fenced code blocks that carry no
   `NAZE_FILE:` tag (e.g. a quick "how do I reverse a string in Python?"
   answer) — used so *every* code block gets the "Open in Naze Code" option,
   not only the ones the model happened to tag. A few common languages get a
   conventional filename so a single HTML+CSS+JS answer still previews
   correctly as one mini project; everything else falls back to a generic
   "snippet.<ext>" name. */
const CODE_LANG_TO_FILENAME = { html:'index.html', htm:'index.html', css:'style.css', scss:'style.css', js:'script.js', javascript:'script.js' };
const CODE_LANG_TO_EXT = {
  html:'html', htm:'html', xml:'xml', css:'css', scss:'scss',
  js:'js', javascript:'js', jsx:'jsx', ts:'ts', typescript:'ts', tsx:'tsx',
  json:'json', py:'py', python:'py', java:'java', c:'c', cpp:'cpp', 'c++':'cpp',
  cs:'cs', csharp:'cs', php:'php', rb:'rb', ruby:'rb', go:'go', golang:'go',
  rust:'rs', rs:'rs', sql:'sql', sh:'sh', bash:'sh', shell:'sh', zsh:'sh',
  yaml:'yml', yml:'yml', md:'md', markdown:'md', swift:'swift',
  kotlin:'kt', kt:'kt', dart:'dart', vue:'vue', svelte:'svelte'
};
function parseGenericCodeBlocks(text){
  if(!text) return [];
  const fenceRe = /```[ \t]*([\w.+-]*)\n([\s\S]*?)```/g;
  const blocks = [];
  const usedNames = new Set();
  const extCounts = {};
  let m;
  while((m = fenceRe.exec(text))){
    const lang = (m[1]||'').toLowerCase().trim();
    const content = m[2].replace(/\n$/,'');
    if(!content.trim()) continue;
    // NAZE_FILE-tagged blocks are handled (and consumed) by
    // parseNazeFileBlocks separately — skip here to avoid duplicating them
    // under a second, guessed filename.
    const firstLine = content.split('\n',1)[0];
    if(NAZE_FILE_TAG_LINE_RE.test(firstLine)) continue;
    let name = CODE_LANG_TO_FILENAME[lang];
    if(!name || usedNames.has(name)){
      const ext = CODE_LANG_TO_EXT[lang] || (/^[a-z0-9]{1,10}$/.test(lang) ? lang : 'txt');
      extCounts[ext] = (extCounts[ext]||0) + 1;
      name = extCounts[ext]===1 ? `snippet.${ext}` : `snippet-${extCounts[ext]}.${ext}`;
      while(usedNames.has(name)){ extCounts[ext]++; name = `snippet-${extCounts[ext]}.${ext}`; }
    }
    usedNames.add(name);
    blocks.push({ path:name, content });
  }
  return blocks;
}

/* ---------- Dependency graph (for multi-file context) ----------
   Cheap, regex-based static scan — good enough to find "which other files
   does this file reference" without a real parser/bundler. Used to decide
   which extra files ride along with the active file in the AI context, so
   Naze can see e.g. the CSS/JS an HTML file actually pulls in without the
   whole project being sent every turn. */
function extractLocalRefsFromFile(project, path){
  const content = project.files[path];
  if(content==null) return [];
  const ext = fileExtOf(path);
  const refs = new Set();
  const add = (ref)=>{
    const hit = resolveAssetPath(project, path, ref);
    if(hit && hit.path!==path) refs.add(hit.path);
  };
  if(ext==='html' || ext==='htm' || ext==='vue' || ext==='svelte'){
    // Quotes are optional in valid HTML (`src=script.js`), so match both.
    const attrRe = /(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;
    let m; while((m = attrRe.exec(content))) add(m[1]||m[2]||m[3]);
  } else if(ext==='css' || ext==='scss'){
    const importRe = /@import\s+(?:url\()?["']([^"')]+)["']\)?/gi;
    const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let m;
    while((m = importRe.exec(content))) add(m[1]);
    while((m = urlRe.exec(content))) add(m[1]);
  } else if(ext==='js' || ext==='jsx' || ext==='ts' || ext==='tsx'){
    const importRe = /\bimport\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/g;
    let m; while((m = importRe.exec(content))) add(m[1] || m[2]);
  }
  return Array.from(refs);
}
/* Simple relative-path resolver — THE single centralized resolver used for
   every project-relative reference in the app (AI context dependency graph,
   preview asset inlining in code-runner.js, and reference rewriting on
   rename/move below). Supports "./x", "x", "/x" (root-relative) and "../x",
   normalizes them all to one canonical project path, and reports whether
   the target is a text file or a binary asset so callers can decide how to
   embed it (inline text vs. data URI). Returns null for anything external
   (http(s)/data:/mailto:/anchors/etc.) or that doesn't resolve to a known
   project path. */
function resolveAssetPath(project, fromPath, ref){
  if(!ref) return null;
  ref = ref.trim();
  if(/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) return null; // any URL scheme (http:, data:, mailto:, blob:, ...) except a Windows drive letter typo
  if(ref.startsWith('//') || ref.startsWith('#')) return null;
  const clean = ref.split(/[?#]/)[0];
  if(!clean) return null;
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  let candidate = clean.startsWith('/') ? clean.slice(1) : ((dir?dir+'/':'') + clean);
  const parts = candidate.split('/');
  const stack = [];
  parts.forEach(seg=>{
    if(seg==='' || seg==='.') return;
    if(seg==='..') stack.pop(); else stack.push(seg);
  });
  const resolved = stack.join('/');
  if(project.files[resolved]!=null) return { path: resolved, kind:'text' };
  if(project.assets && project.assets[resolved]!=null) return { path: resolved, kind:'asset' };
  // Bare JS import with no extension ("./utils") — try common extensions.
  for(const ext of ['js','ts','jsx','tsx']){
    if(project.files[resolved+'.'+ext]!=null) return { path: resolved+'.'+ext, kind:'text' };
  }
  return null;
}
/* Files that reference `path` (reverse edges) — e.g. so opening style.css
   still pulls in the index.html that links it, giving the model enough
   context to know the file is actually wired up. Works for asset paths too
   (used when rewriting references after a rename/move). */
function findReferencingFiles(project, path){
  return Object.keys(project.files).filter(p=>{
    if(p===path) return false;
    return extractLocalRefsFromFile(project, p).includes(path);
  });
}

/* ---------- Reference rewriting on rename/move ("Project integrity") ----------
   Best-effort: only conventional static references (quoted src=/href=/
   url()/import/require literals — the same shapes extractLocalRefsFromFile
   already understands) are rewritten; paths built dynamically in JS can't
   be, since nothing here executes the code. Must be called with the
   project in its PRE-rename state (old path still present) — the caller
   renames the actual file/asset key afterwards. */
function collectRefMatches(path, content){
  const ext = fileExtOf(path);
  const matches = []; // {start, end, value} — start/end bound just the literal value, not the surrounding quotes/attr
  if(ext==='html'||ext==='htm'||ext==='vue'||ext==='svelte'){
    const re = /(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;
    let m; while((m=re.exec(content))){
      const val = m[1]!=null?m[1]:(m[2]!=null?m[2]:m[3]);
      const start = m.index + m[0].lastIndexOf(val);
      matches.push({ start, end: start+val.length, value: val });
    }
  } else if(ext==='css'||ext==='scss'){
    const importRe = /@import\s+(?:url\()?["']([^"')]+)["']\)?/gi;
    const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let m;
    while((m=importRe.exec(content))){ const start=m.index+m[0].lastIndexOf(m[1]); matches.push({start, end:start+m[1].length, value:m[1]}); }
    while((m=urlRe.exec(content))){ const start=m.index+m[0].lastIndexOf(m[1]); matches.push({start, end:start+m[1].length, value:m[1]}); }
  } else if(ext==='js'||ext==='jsx'||ext==='ts'||ext==='tsx'){
    const re = /\bimport\s+(?:[^'"]+?\s+from\s+)?["']([^'"]+)["']|\brequire\(\s*["']([^'"]+)["']\s*\)/g;
    let m; while((m=re.exec(content))){
      const val = m[1]||m[2];
      const start = m.index + m[0].lastIndexOf(val);
      matches.push({ start, end: start+val.length, value: val });
    }
  }
  return matches;
}
/* Shortest relative path from `fromPath`'s directory to `targetPath`,
   e.g. computeRelativeRef('pages/about.html','assets/img/logo.png')
   -> '../assets/img/logo.png'. Used to rewrite a reference so it still
   resolves correctly after the thing it pointed at moved. */
function computeRelativeRef(fromPath, targetPath){
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')).split('/') : [];
  const toParts = targetPath.split('/');
  const toFile = toParts.pop();
  let i=0;
  while(i<fromDir.length && i<toParts.length && fromDir[i]===toParts[i]) i++;
  const ups = fromDir.length - i;
  const rel = [];
  for(let k=0;k<ups;k++) rel.push('..');
  rel.push(...toParts.slice(i), toFile);
  return rel.join('/');
}
/* Rewrites, across every OTHER text file in the project, any literal
   reference that currently resolves to `oldPath` so it points at `newPath`
   instead. Returns how many files were touched. Call BEFORE mutating
   project.files/assets for the rename itself. */
function rewriteReferencesAfterMove(project, oldPath, newPath){
  let filesTouched = 0;
  Object.keys(project.files).forEach(p=>{
    if(p===oldPath) return; // the moved file's own internal relative refs are out of scope (see note above)
    const content = project.files[p];
    if(!content) return;
    const matches = collectRefMatches(p, content).filter(m=>{
      const hit = resolveAssetPath(project, p, m.value);
      return hit && hit.path===oldPath;
    });
    if(!matches.length) return;
    matches.sort((a,b)=>a.start-b.start);
    let out = '', cursor = 0;
    matches.forEach(m=>{
      out += content.slice(cursor, m.start) + computeRelativeRef(p, newPath);
      cursor = m.end;
    });
    out += content.slice(cursor);
    project.files[p] = out;
    filesTouched++;
  });
  return filesTouched;
}

/* Bounded-size project context injected into the outgoing API message when
   Naze Code is open — mirrors the char-budget approach already used for ZIP
   project context ([PROJECT_CONTEXT]) in attachments.js. Instead of only the
   active file, this now walks one hop of the dependency graph (files the
   active file imports/links + files that import/link the active file) so
   the model can see how the code actually connects — while staying well
   under a fixed character budget so tokens/latency stay bounded. */
const NAZE_CODE_CONTEXT_TOTAL_CHAR_CAP = 14000; // total budget across ALL included file bodies
const NAZE_CODE_CONTEXT_FILE_CHAR_CAP = 6000;   // per-file cap within that budget
function buildCodeContextBlock(project, activePath){
  const files = Object.keys(project.files).sort();
  const assetPaths = Object.keys(project.assets||{}).sort();
  const lines = [];
  lines.push('[NAZE_CODE_CONTEXT]');
  lines.push(`Project: ${project.name}`);
  lines.push('File tree:');
  files.forEach(p=> lines.push('- ' + p));
  assetPaths.forEach(p=> lines.push('- ' + p + ' (asset, ' + (project.assets[p].mime||mimeForExt(fileExtOf(p))) + ', ' + fmtSize(project.assets[p].size||0) + ')'));
  if(activePath) lines.push(`Active file: ${activePath}`);

  // Select which files' full contents ride along: the active file, files it
  // references (1 hop), and files that reference it (1 hop) — deduped, in
  // that priority order, until the char budget runs out.
  const included = [];
  if(activePath && project.files[activePath]!=null) included.push(activePath);
  if(activePath){
    extractLocalRefsFromFile(project, activePath).forEach(p=>{ if(!included.includes(p)) included.push(p); });
    findReferencingFiles(project, activePath).forEach(p=>{ if(!included.includes(p)) included.push(p); });
  }
  if(!included.length && files.length) included.push(files[0]); // no active file yet — still give something

  let budgetLeft = NAZE_CODE_CONTEXT_TOTAL_CHAR_CAP;
  included.forEach(p=>{
    if(budgetLeft <= 0) return;
    const content = project.files[p];
    if(content==null) return;
    const perFileCap = Math.min(NAZE_CODE_CONTEXT_FILE_CHAR_CAP, budgetLeft);
    const capped = content.length > perFileCap ? content.slice(0, perFileCap) + '\n...(dipotong)' : content;
    lines.push(`--- isi ${p} ---`);
    lines.push(capped);
    budgetLeft -= capped.length;
  });
  const skipped = files.filter(p=>!included.includes(p));
  if(skipped.length) lines.push(`(${skipped.length} file lain di project tidak disertakan penuh untuk hemat token — minta secara spesifik jika perlu isinya.)`);

  if(project.consoleLog && project.consoleLog.length){
    const recentErrors = project.consoleLog.filter(e=>e.level==='error').slice(-5);
    if(recentErrors.length){
      lines.push('Console errors terakhir:');
      recentErrors.forEach(e=> lines.push(`[ERROR] ${e.text}`));
    }
  }
  if(project.pendingPatch && project.pendingPatch.files && project.pendingPatch.files.length){
    lines.push(`(Ada ${project.pendingPatch.files.length} perubahan dari Naze yang masih menunggu Accept/Reject dari user — jangan tumpuk perubahan baru pada file yang sama sebelum itu diputuskan, kecuali diminta.)`);
  }
  if(assetPaths.length) lines.push('(Asset di atas biner — hanya metadata nama/tipe/ukuran yang dikirim, bukan isinya. Jika perlu benar-benar melihat isi gambar/asset tertentu, minta user melampirkannya lewat chat sebagai attachment.)');
  lines.push('[/NAZE_CODE_CONTEXT]');
  lines.push('Instruksi: Jika perlu membuat/mengubah file, tulis HANYA file yang baru/berubah, masing-masing dalam blok kode dengan baris PERTAMA berupa komentar penanda: `/* NAZE_FILE: path/relatif */` untuk css/js/json, atau `<!-- NAZE_FILE: path/relatif -->` untuk html/xml/markdown. Jangan menulis ulang seluruh project jika hanya sebagian yang berubah. Perubahan akan ditampilkan ke user sebagai Diff untuk di-Accept/Reject dulu, bukan langsung diterapkan — jadi tetap kirim file lengkap (bukan potongan/patch manual) untuk tiap file yang berubah. Beri penjelasan singkat di luar blok kode, jangan menaruh penjelasan di dalam blok file.');
  return lines.join('\n');
}

const NAZE_CODE_SYS_HINT = ' Jika permintaan pengguna berkaitan dengan membuat/memperbaiki/mengubah project coding (halaman web, landing page, kalkulator, aplikasi kecil, dsb.), tulis setiap file yang perlu dibuat/diubah sebagai blok kode terpisah, dengan baris PERTAMA di dalam blok berupa komentar penanda nama file: `/* NAZE_FILE: nama/path/file.ext */` (untuk css/js/json) atau `<!-- NAZE_FILE: nama/path/file.ext -->` (untuk html/xml/markdown/vue/svelte). Ini dipakai aplikasi untuk otomatis menyiapkan Diff perubahan di Naze Code, jadi jangan lupa tag-nya, dan selalu kirim isi file secara utuh (bukan potongan diff manual). Jika sebuah project sudah terbuka (lihat [NAZE_CODE_CONTEXT] bila ada), cukup kirim file yang berubah saja, bukan seluruh project.';

/* ---------- Line-level diff (for the Accept/Reject review panel) ----------
   Small LCS-based line diff — adequate for source-file-sized inputs. Not
   used for huge files (callers should cap what they pass in). */
function diffLines(beforeText, afterText){
  const a = (beforeText==null ? [] : String(beforeText).split('\n'));
  const b = (afterText==null ? [] : String(afterText).split('\n'));
  const n=a.length, m=b.length;
  // Guard against pathological cost on very large files.
  if(n*m > 4000000){
    return [{type:'del', text:`(${n} baris lama)`}, {type:'add', text:`(${m} baris baru — file diganti seluruhnya, terlalu besar untuk diff baris-per-baris)`}];
  }
  const dp = new Array(n+1);
  for(let i=0;i<=n;i++) dp[i] = new Int32Array(m+1);
  for(let i=n-1;i>=0;i--){
    for(let j=m-1;j>=0;j--){
      dp[i][j] = a[i]===b[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
    }
  }
  const ops = [];
  let i=0, j=0;
  while(i<n && j<m){
    if(a[i]===b[j]){ ops.push({type:'eq', text:a[i]}); i++; j++; }
    else if(dp[i+1][j] >= dp[i][j+1]){ ops.push({type:'del', text:a[i]}); i++; }
    else { ops.push({type:'add', text:b[j]}); j++; }
  }
  while(i<n){ ops.push({type:'del', text:a[i]}); i++; }
  while(j<m){ ops.push({type:'add', text:b[j]}); j++; }
  return ops;
}

/* ---------- AI patch staging (diff-before-apply) ----------
   Root cause fixed here: AI edits used to write straight into
   project.files with no confirmation, so a bad/unwanted change silently
   clobbered working code. Now every AI file-block batch becomes a
   `pendingPatch` the user reviews (per-file Accept/Reject) before anything
   in `files` actually changes — see code-workspace.js for the panel. */
function buildPendingPatchFromBlocks(project, blocks){
  const seen = new Set();
  const files = [];
  blocks.forEach(b=>{
    if(!b.path || seen.has(b.path)) return;
    if(b.content.length > NAZE_CODE_MAX_FILE_BYTES) return; // refuse absurdly large single-file patches
    seen.add(b.path);
    const before = project.files[b.path] != null ? project.files[b.path] : null;
    files.push({ path: b.path, before, after: b.content, isNew: before===null, isDelete:false });
  });
  if(!files.length) return null;
  return { id: uid(), ts: Date.now(), source:'ai', files };
}

/* Writes a set of {path, content|null} pairs straight into project.files
   (null = delete) and records an inverse snapshot on patchHistory so it can
   be undone. Used both by "Accept" in the diff panel and internally. */
function applyPatchFiles(project, entries, label){
  const prevSnapshot = {};
  entries.forEach(({path, content})=>{
    prevSnapshot[path] = project.files[path] != null ? project.files[path] : null;
    if(content===null) delete project.files[path];
    else project.files[path] = content;
  });
  project.patchHistory = project.patchHistory || [];
  project.patchHistory.push({ id: uid(), ts: Date.now(), label: label||'Perubahan', files: prevSnapshot });
  while(project.patchHistory.length > NAZE_CODE_MAX_HISTORY) project.patchHistory.shift();
  touchProject(project);
}

function undoLastPatch(project){
  if(!project.patchHistory || !project.patchHistory.length) return null;
  const last = project.patchHistory.pop();
  Object.entries(last.files).forEach(([path, prevContent])=>{
    if(prevContent===null) delete project.files[path];
    else project.files[path] = prevContent;
  });
  touchProject(project);
  return last;
}

/* Called once per finished AI message: either stages a pending patch on the
   open project (for the diff/Accept-Reject panel), or — if no project is
   open — stashes the blocks on the message so the chat bubble can offer an
   "Open in Naze Code" button instead of dumping raw code. */
async function handleNazeFileBlocksInMessage(aiMsg){
  const tagged = parseNazeFileBlocks(aiMsg.text);
  if(tagged.length && activeCodeProject){
    const patch = buildPendingPatchFromBlocks(activeCodeProject, tagged);
    if(patch){
      activeCodeProject.pendingPatch = patch;
      touchProject(activeCodeProject);
      await persistCodeProjects();
      aiMsg.nazeCodePending = true;
      aiMsg.nazeCodePatchFiles = patch.files.map(f=>f.path);
      aiMsg.nazeCodeProjectId = activeCodeProject.id;
      aiMsg.nazeCodePatchId = patch.id;
      if(codeWorkspaceOpen && typeof onPendingPatchReady === 'function'){
        onPendingPatchReady(patch);
      }
    }
    return;
  }
  // Nothing to patch (either no tags, or no project open to patch). Prefer
  // the model's own NAZE_FILE-tagged blocks (it chose the paths); otherwise
  // fall back to ANY plain fenced code block in the reply, so every message
  // that contains code — not just ones matching the narrow "coding request"
  // trigger — gets the "Open in Naze Code" button.
  const blocks = tagged.length ? tagged : parseGenericCodeBlocks(aiMsg.text);
  if(blocks.length) aiMsg.nazeCodeBlocks = blocks;
}

/* ---------- ZIP import (into an editable Naze Code project) ----------
   Deliberately separate from processZipAttachment() in attachments.js,
   which extracts *excerpts* for AI context only. This path keeps full file
   contents (bounded per-file/per-project) so files are actually editable,
   but reuses the same safety constants/guards: zip-slip prevention via
   sanitizeCodePath (drops any '..' segment), ZIP_IGNORE_DIR_NAMES,
   ZIP_SECRET_PATTERNS (.env/keys/tokens are never loaded), and a project
   byte cap so a huge archive can't be imported wholesale.

   Text files (CODE_EDITABLE_EXT) are decoded as UTF-8 into `files`; binary
   assets (CODE_ASSET_EXT — images/fonts/audio/etc) are kept as raw bytes
   and stored base64 in `assets` instead of being run through strFromU8,
   which would silently corrupt them. Any other extension is skipped rather
   than dropped-with-no-trace, and the skip count is reported back so the
   caller can tell the user something was left out. */
async function importZipBufferAsProject(buf, suggestedName){
  if(typeof fflate === 'undefined') throw new Error('Pustaka ZIP belum termuat');
  const stats = { includedBytes:0, includedFiles:0, skipped:0 };
  const filter = (entry)=>{
    const name = entry.name;
    if(name.endsWith('/')) return false;
    const clean = sanitizeCodePath(name);
    if(!clean) return false;
    const parts = clean.split('/');
    const base = parts[parts.length-1];
    if(parts.some(p=>ZIP_IGNORE_DIR_NAMES.has(p.toLowerCase()))) return false;
    if(ZIP_SECRET_PATTERNS.some(rx=>rx.test(base))) return false;
    if(ZIP_IGNORE_FILE_PATTERNS.some(rx=>rx.test(clean))) return false;
    const ext = fileExtOf(clean);
    const isText = CODE_EDITABLE_EXT.has(ext);
    const isAsset = CODE_ASSET_EXT.has(ext);
    if(!isText && !isAsset){ stats.skipped++; return false; }
    const cap = isAsset ? NAZE_CODE_MAX_ASSET_BYTES : NAZE_CODE_MAX_FILE_BYTES;
    if(entry.originalSize > cap){ stats.skipped++; return false; }
    if(stats.includedFiles >= 800) return false;
    if(stats.includedBytes + entry.originalSize > NAZE_CODE_MAX_PROJECT_BYTES) return false;
    stats.includedBytes += entry.originalSize; stats.includedFiles++;
    return true;
  };
  let unzipped;
  try{ unzipped = fflate.unzipSync(new Uint8Array(buf), { filter }); }
  catch(e){ throw new Error('File ZIP rusak atau tidak valid'); }

  // GitHub-style exports wrap everything in one "<repo>-<branch>/" folder — unwrap it.
  const rawPaths = Object.keys(unzipped);
  let rootPrefix = null;
  if(rawPaths.length){
    const firstSeg = rawPaths[0].split('/')[0];
    if(firstSeg && rawPaths.every(p=>p.split('/')[0]===firstSeg)) rootPrefix = firstSeg;
  }
  const files = {};
  const assets = {};
  rawPaths.forEach(path=>{
    const clean = sanitizeCodePath(rootPrefix ? path.slice(rootPrefix.length+1) : path);
    if(!clean) return;
    const ext = fileExtOf(clean);
    const bytes = unzipped[path];
    if(CODE_ASSET_EXT.has(ext)){
      try{ assets[clean] = { mime: mimeForExt(ext), b64: u8ToB64(bytes), size: bytes.length }; }
      catch(e){ /* skip undecodable */ }
    } else {
      try{ files[clean] = fflate.strFromU8(bytes); }catch(e){ /* skip undecodable */ }
    }
  });
  const name = suggestedName || rootPrefix || 'Imported project';
  const project = newCodeProject(name, files, [], assets);
  project.importStats = { includedFiles: stats.includedFiles, skippedFiles: stats.skipped };
  return project;
}

/* ---------- ZIP export ----------
   Includes both text files and binary assets (decoded back from base64),
   so an exported project actually opens correctly elsewhere instead of
   silently missing every image/font it used. */
function exportProjectToZipBlob(project){
  const data = {};
  Object.entries(project.files).forEach(([path, content])=>{
    data[path] = fflate.strToU8(content);
  });
  Object.entries(project.assets||{}).forEach(([path, asset])=>{
    try{ data[path] = b64ToU8(asset.b64); }catch(e){ /* skip corrupted asset rather than fail the whole export */ }
  });
  const zipped = fflate.zipSync(data, { level: 6 });
  return new Blob([zipped], { type:'application/zip' });
}
function downloadProjectZip(project){
  let blob;
  try{ blob = exportProjectToZipBlob(project); }
  catch(e){ showToastError('Gagal membuat file ZIP: ' + (e.message||'error tidak diketahui')); return Promise.resolve(); }
  const filename = (project.name||'project').replace(/[^\w.-]+/g,'-') + '.zip';

  // Root cause of "tombol download tidak bisa": this used to be *only* the
  // <a download> blob-URL trick below with zero feedback either way. That
  // trick is silently ignored by several mobile browsers/PWA "installed
  // app" contexts (notably iOS Safari standalone mode never triggers a
  // save-to-Files dialog for it) — so on those, clicking Download did
  // genuinely nothing, and looked identical to a broken button.
  //
  // Fix: try the Web Share API first (when it can share this exact file) —
  // it opens the native "Save to Files / Drive / share" sheet and works in
  // far more mobile contexts, including installed PWAs. Fall back to the
  // classic anchor download for desktop browsers. Either path now always
  // gives the user a visible result (share sheet, download, or an explicit
  // error toast) instead of silence.
  const file = (typeof File !== 'undefined') ? new File([blob], filename, { type:'application/zip' }) : null;
  if(file && navigator.canShare && navigator.canShare({ files:[file] })){
    return navigator.share({ files:[file], title: filename }).catch(err=>{
      if(err && err.name==='AbortError') return; // user closed the share sheet — not a failure
      fallbackAnchorDownload(blob, filename);
    });
  }
  fallbackAnchorDownload(blob, filename);
  return Promise.resolve();
}
function fallbackAnchorDownload(blob, filename){
  try{
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    showToastError(`Mengunduh ${filename}...`);
  }catch(e){
    showToastError('Gagal mengunduh — coba buka Naze Code lewat browser biasa (bukan mode aplikasi terpasang).');
  }
}
