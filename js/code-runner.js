/* =========================================================================
   NAZE CODE — runner (sandboxed preview + console)
   The iframe never gets allow-same-origin, so anything inside it (including
   any code the user/AI wrote) has no access to the parent page, cookies, or
   Naze's own storage — it's a fresh opaque origin every time we assemble it.

   Rewritten to build the preview via DOMParser instead of regex string
   surgery: this is what makes attributes like `defer`, `type="module"`,
   `async`, ids, data-* etc. survive on inlined <script>/<link> tags, and
   lets <img>/<source>/poster/CSS url()/@import all resolve against the
   project's virtual filesystem (including binary assets, inlined as data:
   URIs) instead of only <link rel=stylesheet>/<script src>.
   ========================================================================= */

const NAZE_CONSOLE_BRIDGE = `
<script>(function(){
  function send(level, args){
    try{
      var text = args.map(function(a){
        if(a instanceof Error) return (a.stack || a.message);
        if(typeof a === 'object'){ try{ return JSON.stringify(a); }catch(e){ return String(a); } }
        return String(a);
      }).join(' ');
      parent.postMessage({__nazeConsole:true, level:level, text:text}, '*');
    }catch(e){}
  }
  ['log','info','warn','error'].forEach(function(level){
    var orig = console[level];
    console[level] = function(){ send(level, Array.prototype.slice.call(arguments)); orig && orig.apply(console, arguments); };
  });
  window.addEventListener('error', function(e){
    send('error', [(e.message||'Script error') + ' (' + (e.filename||'') + ':' + (e.lineno||0) + ':' + (e.colno||0) + ')']);
  });
  window.addEventListener('unhandledrejection', function(e){
    send('error', ['Unhandled promise rejection: ' + (e.reason && (e.reason.stack||e.reason.message) || e.reason)]);
  });
})();<\/script>`;

/* NOTE: path resolution itself now lives in ONE place — resolveAssetPath()
   in code-state.js (loaded before this file) — used by both the preview
   engine here and the AI-context dependency graph, so there is exactly one
   definition of "what does this reference point at" in the whole app. */
function assetDataUri(project, path){
  const a = project.assets[path];
  if(!a) return null;
  return `data:${a.mime||'application/octet-stream'};base64,${a.b64}`;
}
/* Same idea but also covers a *text* file used where an asset is expected
   — overwhelmingly this means an inline SVG referenced as <img src="x.svg">
   or a CSS background-image, which is extremely common and otherwise had no
   way to render inside the sandboxed iframe (there's no real file server
   backing it). JSON/TXT text files are deliberately NOT covered here: they
   aren't meant to be rendered as an image/asset — a project fetching them
   via JS is handled separately by the virtual filesystem fetch/XHR shim
   below, so they stay real, readable text there instead of being flattened
   into a data URI. */
function dataUriForResolvedRef(project, hit){
  if(!hit) return null;
  if(hit.kind==='asset') return assetDataUri(project, hit.path);
  if(fileExtOf(hit.path)==='svg'){
    const content = project.files[hit.path] || '';
    try{ return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(content))); }
    catch(e){ return null; }
  }
  return null;
}

/* Resolve CSS `url(...)` and `@import` references inside a stylesheet's
   text, rewriting local ones to data: URIs (assets, or text SVGs — see
   dataUriForResolvedRef) or inlined text (nested @import of another local
   .css, bounded depth to avoid loops). */
function resolveCssRefs(project, cssPath, cssText, depth){
  if(depth > 4 || !cssText) return cssText || '';
  let out = cssText.replace(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?\s*;?/gi, (m, ref)=>{
    const hit = resolveAssetPath(project, cssPath, ref);
    if(!hit || hit.kind!=='text' || fileExtOf(hit.path)!=='css') return m; // only recurse into actual .css @import targets
    return resolveCssRefs(project, hit.path, project.files[hit.path], depth+1);
  });
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref)=>{
    const hit = resolveAssetPath(project, cssPath, ref);
    const uri = dataUriForResolvedRef(project, hit);
    return uri ? `url("${uri}")` : m;
  });
  return out;
}

/* Rewrites every local src/href/poster/srcset attribute found under `doc`
   that resolves to a project asset (or a text SVG — see
   dataUriForResolvedRef) into a data: URI. */
function inlineAssetAttrs(project, entryPath, doc){
  const ATTR_TAGS = [
    ['img','src'], ['source','src'], ['audio','src'], ['video','src'], ['video','poster'],
    ['track','src'], ['embed','src'], ['object','data'], ['link','href'] // link[rel=icon/manifest/etc]
  ];
  ATTR_TAGS.forEach(([tag, attr])=>{
    doc.querySelectorAll(`${tag}[${attr}]`).forEach(el=>{
      if(tag==='link'){
        const rel = (el.getAttribute('rel')||'').toLowerCase();
        if(rel==='stylesheet') return; // handled separately (inlined as <style>)
      }
      const hit = resolveAssetPath(project, entryPath, el.getAttribute(attr));
      const uri = dataUriForResolvedRef(project, hit);
      if(uri) el.setAttribute(attr, uri);
    });
  });
  // srcset="a.png 1x, b.png 2x"
  doc.querySelectorAll('[srcset]').forEach(el=>{
    const rewritten = el.getAttribute('srcset').split(',').map(part=>{
      const bits = part.trim().split(/\s+/);
      const hit = resolveAssetPath(project, entryPath, bits[0]);
      const uri = dataUriForResolvedRef(project, hit);
      if(uri) bits[0] = uri;
      return bits.join(' ');
    }).join(', ');
    el.setAttribute('srcset', rewritten);
  });
  // inline style="background:url(...)" attributes
  doc.querySelectorAll('[style]').forEach(el=>{
    const css = el.getAttribute('style');
    if(css && /url\(/i.test(css)) el.setAttribute('style', resolveCssRefs(project, entryPath, css, 0));
  });
}

/* ---------- Virtual filesystem for JS-side asset access ----------
   Attribute/CSS references (img src, url(), etc.) are resolved at BUILD
   time above by flattening to data: URIs — that works regardless of the
   iframe's origin. But project JS calling `fetch('./data.json')` or
   `new XMLHttpRequest()` needs something to actually answer that request
   at RUN time, and there is no real server behind the sandboxed srcdoc
   iframe to do it. This shim embeds the project's files/assets as data
   inside the iframe's own realm and intercepts fetch()/XHR for any URL
   that resolves to a project path (relative to the entry document, same
   as a real browser resolves them), serving it from that embedded data —
   entirely in-process, so it works even with no allow-same-origin and no
   network. Anything that doesn't resolve (external URLs, API calls) falls
   through to the real fetch/XHR untouched.
   Known limitation: only static, resolvable-at-build-time relative paths
   are covered — a URL built dynamically from unpredictable string
   concatenation at runtime still resolves fine here too (the shim runs at
   request time, not build time), but a path is never intercepted unless it
   matches something under [NAZE_CODE_CONTEXT]'s file tree exactly. */
const TEXT_RESPONSE_MIME = { html:'text/html', htm:'text/html', css:'text/css', js:'application/javascript', mjs:'application/javascript', json:'application/json', xml:'application/xml', svg:'image/svg+xml', md:'text/markdown', txt:'text/plain' };
function buildVirtualFsScript(project, entryPath){
  const files = {}; Object.entries(project.files).forEach(([p,c])=>{ files[p]=c; });
  const assets = {}; Object.entries(project.assets||{}).forEach(([p,a])=>{ assets[p]={mime:a.mime,b64:a.b64}; });
  const mimeMap = TEXT_RESPONSE_MIME;
  const payload = JSON.stringify({ files, assets, mimeMap, entryPath });
  return `\n<script>(function(){\n` +
`  try{\n` +
`    var FS = ${payload};\n` +
`    function extOf(p){ var b=p.split('/').pop()||''; var d=b.lastIndexOf('.'); return d>0?b.slice(d+1).toLowerCase():''; }\n` +
`    function b64ToBytes(b64){ var bin=atob(b64), u8=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i); return u8; }\n` +
`    function resolvePath(base, ref){\n` +
`      var clean = String(ref).split(/[?#]/)[0];\n` +
`      var dir = base.indexOf('/')>=0 ? base.slice(0, base.lastIndexOf('/')) : '';\n` +
`      var cand = clean.charAt(0)==='/' ? clean.slice(1) : (dir?dir+'/':'')+clean;\n` +
`      var parts = cand.split('/'), stack=[];\n` +
`      for(var i=0;i<parts.length;i++){ var s=parts[i]; if(s===''||s==='.') continue; if(s==='..') stack.pop(); else stack.push(s); }\n` +
`      return stack.join('/');\n` +
`    }\n` +
`    function lookup(url){\n` +
`      try{\n` +
`        var u = String(url);\n` +
`        if(/^[a-z][a-z0-9+.-]*:/i.test(u) || u.indexOf('//')===0) return null;\n` +
`        var p = resolvePath(FS.entryPath||'', u);\n` +
`        if(Object.prototype.hasOwnProperty.call(FS.files, p)) return {kind:'text', path:p, content:FS.files[p]};\n` +
`        if(Object.prototype.hasOwnProperty.call(FS.assets, p)) return {kind:'asset', path:p, asset:FS.assets[p]};\n` +
`      }catch(e){}\n` +
`      return null;\n` +
`    }\n` +
`    var _fetch = window.fetch ? window.fetch.bind(window) : null;\n` +
`    window.fetch = function(input, init){\n` +
`      var url = (typeof input==='string') ? input : (input && input.url);\n` +
`      var hit = url!=null ? lookup(url) : null;\n` +
`      if(hit){\n` +
`        var mime = hit.kind==='text' ? (FS.mimeMap[extOf(hit.path)]||'text/plain; charset=utf-8') : (hit.asset.mime||'application/octet-stream');\n` +
`        var body = hit.kind==='text' ? hit.content : b64ToBytes(hit.asset.b64);\n` +
`        return Promise.resolve(new Response(body, {status:200, statusText:'OK', headers:{'Content-Type':mime}}));\n` +
`      }\n` +
`      return _fetch ? _fetch(input, init) : Promise.reject(new TypeError('Failed to fetch'));\n` +
`    };\n` +
`    var OrigXHR = window.XMLHttpRequest;\n` +
`    if(OrigXHR){\n` +
`      var NazeXHR = function(){\n` +
`        var xhr = new OrigXHR();\n` +
`        var _open = xhr.open.bind(xhr), _send = xhr.send.bind(xhr), _hit = null;\n` +
`        xhr.open = function(method, url){ _hit = lookup(url); if(_hit) return; return _open.apply(null, arguments); };\n` +
`        xhr.send = function(){\n` +
`          if(_hit){\n` +
`            var self = xhr;\n` +
`            setTimeout(function(){\n` +
`              var text = _hit.kind==='text' ? _hit.content : '';\n` +
`              try{\n` +
`                Object.defineProperty(self,'status',{value:200,configurable:true});\n` +
`                Object.defineProperty(self,'readyState',{value:4,configurable:true});\n` +
`                Object.defineProperty(self,'responseText',{value:text,configurable:true});\n` +
`                Object.defineProperty(self,'response',{value:text,configurable:true});\n` +
`              }catch(e){}\n` +
`              self.onreadystatechange && self.onreadystatechange();\n` +
`              self.onload && self.onload();\n` +
`            }, 0);\n` +
`            return;\n` +
`          }\n` +
`          return _send.apply(null, arguments);\n` +
`        };\n` +
`        return xhr;\n` +
`      };\n` +
`      window.XMLHttpRequest = NazeXHR;\n` +
`    }\n` +
`  }catch(e){}\n` +
`})();<\\/script>`;
}


/* Build the full preview document (as an HTML string) for `project`,
   wired for a sandboxed srcdoc iframe: local <link rel=stylesheet> inlined
   as <style>, local <script src> inlined as <script> (attributes like
   type=module/defer/async/id preserved), local images/fonts/etc resolved
   to data: URIs, and the console bridge injected at the top of <head>.
   Wrapped in try/catch so a malformed/huge project can never throw an
   unhandled error and leave the preview stuck mid-render. */
function buildPreviewDoc(project){
  try{
    return buildPreviewDocInner(project);
  }catch(e){
    const msg = 'Naze Code preview error: ' + (e && e.message || e);
    return `<!doctype html><html><head><meta charset="utf-8">${NAZE_CONSOLE_BRIDGE}</head><body style="font:13px monospace;color:#c00;padding:16px;white-space:pre-wrap;">${escapeHtml(msg)}<script>console.error(${JSON.stringify(msg)});<\/script></body></html>`;
  }
}
function buildPreviewDocInner(project){
  const htmlFiles = Object.keys(project.files).filter(p=>/\.html?$/i.test(p));
  const entryPath = htmlFiles.find(p=>p==='index.html')
                  || htmlFiles.find(p=>!p.includes('/'))
                  || htmlFiles[0];

  if(!entryPath){
    // No HTML entry point (e.g. a JS/CSS-only snippet) — build a minimal
    // shell so there's still something to run/preview.
    const css = Object.keys(project.files).filter(p=>/\.css$/i.test(p))
      .map(p=>resolveCssRefs(project, p, project.files[p], 0)).join('\n');
    const js = Object.keys(project.files).filter(p=>/\.jsx?$/i.test(p)).map(p=>project.files[p]).join('\n;\n');
    return `<!doctype html><html><head><meta charset="utf-8">${NAZE_CONSOLE_BRIDGE}${buildVirtualFsScript(project, Object.keys(project.files)[0]||'')}<style>${css}</style></head><body><script>${js}<\/script></body></html>`;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(project.files[entryPath], 'text/html');

  // Inline local stylesheets (<link rel=stylesheet href>) as <style>, in
  // document order, resolving nested @import/url() along the way.
  Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]')).forEach(link=>{
    const hit = resolveAssetPath(project, entryPath, link.getAttribute('href'));
    if(!hit || hit.kind!=='text') return;
    const styleEl = doc.createElement('style');
    styleEl.textContent = resolveCssRefs(project, hit.path, project.files[hit.path], 0);
    link.replaceWith(styleEl);
  });

  // Inline local scripts (<script src>) as inline <script>, preserving
  // every other attribute (type=module, defer, async, id, data-*, ...) so
  // module-vs-classic execution semantics stay intact. `defer` is dropped
  // since it has no effect on an already-inline, in-order script.
  Array.from(doc.querySelectorAll('script[src]')).forEach(scriptEl=>{
    const hit = resolveAssetPath(project, entryPath, scriptEl.getAttribute('src'));
    if(!hit || hit.kind!=='text') return;
    const inline = doc.createElement('script');
    Array.from(scriptEl.attributes).forEach(a=>{
      if(a.name==='src' || a.name==='defer') return;
      inline.setAttribute(a.name, a.value);
    });
    inline.textContent = project.files[hit.path];
    scriptEl.replaceWith(inline);
  });

  // Inline <style> blocks may still reference url(...) assets.
  Array.from(doc.querySelectorAll('style')).forEach(styleEl=>{
    if(/url\(/i.test(styleEl.textContent||'')) styleEl.textContent = resolveCssRefs(project, entryPath, styleEl.textContent, 0);
  });

  inlineAssetAttrs(project, entryPath, doc);

  // Console bridge and the virtual-filesystem fetch/XHR shim must both run
  // before any project script — inserted first inside <head> (creating one
  // if the page didn't have one), shim second so console errors from the
  // shim itself (defensive try/catch aside) would still be visible.
  let head = doc.querySelector('head');
  if(!head){ head = doc.createElement('head'); doc.documentElement.insertBefore(head, doc.documentElement.firstChild); }
  head.insertAdjacentHTML('afterbegin', buildVirtualFsScript(project, entryPath));
  head.insertAdjacentHTML('afterbegin', NAZE_CONSOLE_BRIDGE);

  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

let nazePreviewIframe = null;
let nazeConsoleEntries = [];
let nazeConsoleListenerBound = false;

function initNazeCodePreview(iframeEl, onConsoleEntry){
  nazePreviewIframe = iframeEl;
  if(nazeConsoleListenerBound) return;
  nazeConsoleListenerBound = true;
  window.addEventListener('message', (e)=>{
    if(!nazePreviewIframe || e.source !== nazePreviewIframe.contentWindow) return;
    const d = e.data;
    if(!d || !d.__nazeConsole) return;
    const entry = { level:d.level, text:d.text, ts:Date.now() };
    nazeConsoleEntries.push(entry);
    if(nazeConsoleEntries.length>300) nazeConsoleEntries.shift();
    if(activeCodeProject){
      activeCodeProject.consoleLog = activeCodeProject.consoleLog||[];
      activeCodeProject.consoleLog.push(entry);
      if(activeCodeProject.consoleLog.length>50) activeCodeProject.consoleLog.shift();
    }
    onConsoleEntry && onConsoleEntry(entry);
  });
}

// Hard cap on the assembled preview document — a project with many/large
// inlined data-URI assets could otherwise produce a multi-tens-of-MB
// srcdoc string, which is what actually freezes/crashes a mobile WebView.
const NAZE_PREVIEW_MAX_DOC_BYTES = 12*1024*1024;

function runNazeCodeProject(project){
  if(!nazePreviewIframe || !project) return;
  nazeConsoleEntries = [];
  // sandbox intentionally omits allow-same-origin: the preview stays a fully
  // isolated opaque origin regardless of what the project's own code does.
  nazePreviewIframe.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms allow-popups');
  const doc = buildPreviewDoc(project);
  if(doc.length > NAZE_PREVIEW_MAX_DOC_BYTES){
    nazePreviewIframe.srcdoc = `<!doctype html><body style="font:13px monospace;color:#c00;padding:16px;">Preview terlalu besar untuk dijalankan (${fmtSize(doc.length)}) — kurangi ukuran asset di project ini.</body>`;
    return;
  }
  // Wipe the previous document first (about:blank) so a previous run's
  // timers/animations/audio are fully torn down before the new one starts —
  // assigning srcdoc directly on top of a busy page is what tends to make
  // heavier pages stutter the whole tab while both run briefly at once.
  nazePreviewIframe.srcdoc = 'about:blank';
  requestAnimationFrame(()=>{ if(nazePreviewIframe) nazePreviewIframe.srcdoc = doc; });
}

function refreshNazeCodePreview(){ if(activeCodeProject) runNazeCodeProject(activeCodeProject); }

/* Debounced auto-run, called from the editor's onChange. */
let nazeAutoRunTimer = null;
function scheduleNazeAutoRun(){
  if(!autoRunOn) return;
  clearTimeout(nazeAutoRunTimer);
  nazeAutoRunTimer = setTimeout(()=> refreshNazeCodePreview(), 600);
}
