/* =========================================================================
   Naze Code — asset management test suite
   Run with: node tests/asset-management.test.js

   Loads js/code-state.js in a sandboxed VM context (so the real app files
   are exercised as-is, unmodified) with a few browser globals stubbed
   (btoa/atob, which Node has natively; a fake `fflate` backed by
   fflate-node-shim.js so ZIP import/export can run offline). Everything
   that depends on DOM (code-runner.js's DOMParser-based preview builder)
   is NOT covered here — that half needs a real browser/jsdom; see the
   manual checklist at the bottom of this file for what to verify there.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const fflate = require('./fflate-node-shim.js');

let pass = 0, fail = 0;
function test(name, fn){
  try{ fn(); pass++; console.log('  ok  -', name); }
  catch(e){ fail++; console.log('FAIL  -', name, '\n       ', e.message); }
}
function section(title){ console.log('\n' + title); }

function loadSandbox(){
  const code = fs.readFileSync(path.join(__dirname, '../js/code-state.js'), 'utf8');
  const sandbox = {
    uid: (()=>{ let i=0; return ()=>'id'+(i++); })(),
    showToastError: ()=>{},
    fmtSize: (b)=> b+'B',
    ZIP_IGNORE_DIR_NAMES: new Set(['node_modules','.git','__MACOSX']),
    ZIP_SECRET_PATTERNS: [/^\.env/i, /\.pem$/i],
    ZIP_IGNORE_FILE_PATTERNS: [/\.DS_Store$/i],
    fflate, btoa, atob, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

// A tiny valid PNG (1x1 transparent pixel) and a plausible-looking WOFF2/MP3
// header — content doesn't need to be a real decodable file for these
// tests, only byte-exact round-trip through base64/ZIP matters.
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000155273f6a0000000049454e44ae426082','hex');
const FONT_BYTES = Buffer.from('774f4632000100000000009000030000474445460000000000000000...deadbeef'.slice(0,40),'hex');
const AUDIO_BYTES = Buffer.from([0x49,0x44,0x33,0x03,0,0,0,0,0,0, 1,2,3,4,5,6,7,8]);
const VIDEO_BYTES = Buffer.from([0,0,0,0x18,0x66,0x74,0x79,0x70,0x6d,0x70,0x34,0x32, 9,9,9,9]);

function buildTestZip(entries){
  const data = {};
  Object.entries(entries).forEach(([name, content])=>{
    data[name] = Buffer.isBuffer(content) ? content : fflate.strToU8(content);
  });
  return Buffer.from(fflate.zipSync(data));
}

async function main(){
  const sb = loadSandbox();

  section('1) Import ZIP: HTML + CSS + JS + gambar (PNG)');
  {
    const zip = buildTestZip({
      'index.html': '<html><head><link rel="stylesheet" href="style.css"></head><body><img src="logo.png"><script src="app.js"></script></body></html>',
      'style.css': 'body{background:url(logo.png)}',
      'app.js': 'console.log("hi")',
      'logo.png': PNG_BYTES,
    });
    const project = await sb.importZipBufferAsProject(zip.buffer.slice(zip.byteOffset, zip.byteOffset+zip.byteLength), 'demo');
    test('html/css/js masuk sebagai files (text)', ()=>{
      assert.ok(project.files['index.html'].includes('<img'));
      assert.ok(project.files['style.css'].includes('background'));
      assert.ok(project.files['app.js'].includes('console.log'));
    });
    test('png masuk sebagai assets (bukan files, tidak korup)', ()=>{
      assert.ok(project.files['logo.png']==null, 'PNG tidak boleh ikut ke files (akan korup jika didekode sebagai UTF-8)');
      assert.ok(project.assets['logo.png'], 'PNG harus ada di assets');
      const back = sb.b64ToU8(project.assets['logo.png'].b64);
      assert.strictEqual(Buffer.from(back).toString('hex'), PNG_BYTES.toString('hex'), 'byte asset harus identik setelah base64 encode/decode');
    });
    test('mime PNG terdeteksi benar', ()=> assert.strictEqual(project.assets['logo.png'].mime, 'image/png'));
  }

  section('2) Nested assets (folder bertingkat)');
  {
    const zip = buildTestZip({
      'index.html': '<img src="assets/img/deep/icon.png">',
      'assets/img/deep/icon.png': PNG_BYTES,
    });
    const project = await sb.importZipBufferAsProject(zip.buffer.slice(zip.byteOffset, zip.byteOffset+zip.byteLength), 'nested');
    test('path nested dipertahankan', ()=> assert.ok(project.assets['assets/img/deep/icon.png']));
    test('resolver menemukan nested asset dari index.html', ()=>{
      const hit = sb.resolveAssetPath(project, 'index.html', 'assets/img/deep/icon.png');
      assert.strictEqual(hit && hit.kind, 'asset');
      assert.strictEqual(hit && hit.path, 'assets/img/deep/icon.png');
    });
  }

  section('3) SVG (harus jadi text file, bukan asset biner)');
  {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>';
    const zip = buildTestZip({ 'index.html': '<img src="icon.svg">', 'icon.svg': svg });
    const project = await sb.importZipBufferAsProject(zip.buffer.slice(zip.byteOffset, zip.byteOffset+zip.byteLength), 'svgtest');
    test('svg masuk sebagai files (text), bukan assets', ()=>{
      assert.strictEqual(project.files['icon.svg'], svg);
      assert.ok(project.assets['icon.svg']==null);
    });
  }

  section('4) Font (WOFF2)');
  {
    const zip = buildTestZip({
      'index.html': '<link rel="stylesheet" href="fonts.css">',
      'fonts.css': "@font-face{font-family:'X';src:url('assets/font.woff2') format('woff2');}",
      'assets/font.woff2': FONT_BYTES,
    });
    const project = await sb.importZipBufferAsProject(zip.buffer.slice(zip.byteOffset, zip.byteOffset+zip.byteLength), 'fonttest');
    test('font masuk sebagai asset dengan mime benar', ()=>{
      assert.ok(project.assets['assets/font.woff2']);
      assert.strictEqual(project.assets['assets/font.woff2'].mime, 'font/woff2');
    });
    test('@font-face url() ter-resolve ke asset', ()=>{
      const hit = sb.resolveAssetPath(project, 'fonts.css', 'assets/font.woff2');
      assert.strictEqual(hit.kind, 'asset');
    });
  }

  section('5) Audio (MP3) & Video (MP4)');
  {
    const zip = buildTestZip({
      'index.html': '<audio src="clip.mp3"></audio><video src="clip.mp4"></video>',
      'clip.mp3': AUDIO_BYTES,
      'clip.mp4': VIDEO_BYTES,
    });
    const project = await sb.importZipBufferAsProject(zip.buffer.slice(zip.byteOffset, zip.byteOffset+zip.byteLength), 'media');
    test('audio & video masuk sebagai assets, byte identik', ()=>{
      assert.ok(project.assets['clip.mp3']);
      assert.ok(project.assets['clip.mp4']);
      assert.strictEqual(Buffer.from(sb.b64ToU8(project.assets['clip.mp3'].b64)).toString('hex'), AUDIO_BYTES.toString('hex'));
      assert.strictEqual(Buffer.from(sb.b64ToU8(project.assets['clip.mp4'].b64)).toString('hex'), VIDEO_BYTES.toString('hex'));
    });
    test('mime audio/video benar', ()=>{
      assert.strictEqual(project.assets['clip.mp3'].mime, 'audio/mpeg');
      assert.strictEqual(project.assets['clip.mp4'].mime, 'video/mp4');
    });
  }

  section('6) Asset dengan spasi di nama file');
  {
    const zip = buildTestZip({
      'index.html': '<img src="my photos/vacation pic.png">',
      'my photos/vacation pic.png': PNG_BYTES,
    });
    const project = await sb.importZipBufferAsProject(zip.buffer.slice(zip.byteOffset, zip.byteOffset+zip.byteLength), 'spacetest');
    test('nama dengan spasi dipertahankan persis', ()=> assert.ok(project.assets['my photos/vacation pic.png']));
    test('resolver menangani path dengan spasi', ()=>{
      const hit = sb.resolveAssetPath(project, 'index.html', 'my photos/vacation pic.png');
      assert.strictEqual(hit && hit.kind, 'asset');
    });
  }

  section('7) Asset dengan nama Unicode');
  {
    const name = 'gambar/логотип фото.png';
    const zip = buildTestZip({ 'index.html': `<img src="${name}">`, [name]: PNG_BYTES });
    const project = await sb.importZipBufferAsProject(zip.buffer.slice(zip.byteOffset, zip.byteOffset+zip.byteLength), 'unicodetest');
    test('nama unicode dipertahankan persis', ()=> assert.ok(project.assets[name]));
  }

  section('8) Rename folder yang berisi asset -> referensi ikut ter-update');
  {
    const project = sb.newCodeProject('RenameTest', {
      'index.html': '<link rel="stylesheet" href="css/style.css"><img src="assets/logo.png">',
      'css/style.css': 'body{background:url(../assets/logo.png)}',
    }, [], { 'assets/logo.png': { mime:'image/png', b64: sb.u8ToB64(new Uint8Array(PNG_BYTES)), size: PNG_BYTES.length } });

    // Simulate what renameCodeFolder() in code-workspace.js does: build the
    // move map for everything under "assets/", rewrite references against
    // pre-move state, THEN move the keys.
    const oldPrefix = 'assets/';
    const moves = Object.keys(project.assets).filter(p=>p.startsWith(oldPrefix))
      .map(p=>({ path:p, newPath: 'static/'+p.slice(oldPrefix.length) }));
    moves.forEach(mv=> sb.rewriteReferencesAfterMove(project, mv.path, mv.newPath));
    moves.forEach(mv=>{ project.assets[mv.newPath] = project.assets[mv.path]; delete project.assets[mv.path]; });

    test('asset key berpindah ke folder baru', ()=>{
      assert.ok(project.assets['static/logo.png']);
      assert.ok(project.assets['assets/logo.png']==null);
    });
    test('referensi di index.html ikut ter-update', ()=> assert.ok(project.files['index.html'].includes('static/logo.png')));
    test('referensi url() di css ikut ter-update (masih resolve dengan benar)', ()=>{
      const hit = sb.resolveAssetPath(project, 'css/style.css', project.files['css/style.css'].match(/url\(([^)]+)\)/)[1]);
      assert.strictEqual(hit && hit.kind, 'asset');
      assert.strictEqual(hit && hit.path, 'static/logo.png');
    });
  }

  section('9) Export ZIP lalu import kembali (round-trip)');
  {
    const original = sb.newCodeProject('RoundTrip', {
      'index.html': '<img src="a b/icon.png">',
      'style.css': 'body{}',
    }, [], { 'a b/icon.png': { mime:'image/png', b64: sb.u8ToB64(new Uint8Array(PNG_BYTES)), size: PNG_BYTES.length } });

    const zipData = {};
    Object.entries(original.files).forEach(([p,c])=>{ zipData[p] = fflate.strToU8(c); });
    Object.entries(original.assets).forEach(([p,a])=>{ zipData[p] = sb.b64ToU8(a.b64); });
    const zipped = Buffer.from(fflate.zipSync(zipData));

    const reimported = await sb.importZipBufferAsProject(zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset+zipped.byteLength), 'reimported');
    test('semua text file utuh setelah export->import', ()=>{
      assert.strictEqual(reimported.files['index.html'], original.files['index.html']);
      assert.strictEqual(reimported.files['style.css'], original.files['style.css']);
    });
    test('asset dengan spasi tetap utuh & byte-identik setelah export->import', ()=>{
      assert.ok(reimported.assets['a b/icon.png']);
      assert.strictEqual(reimported.assets['a b/icon.png'].b64, original.assets['a b/icon.png'].b64);
    });
  }

  section('10) Keamanan: path traversal & tipe file tidak dikenal ditolak');
  {
    test('sanitizeCodePath membuang segmen ".." tanpa pernah bisa keluar dari root', ()=>{
      // '..' segments are dropped outright (not resolved by popping the
      // previous segment) — simpler and still always safe: the result can
      // never contain a path that climbs above the project root.
      assert.strictEqual(sb.sanitizeCodePath('../../../etc/passwd'), 'etc/passwd');
      assert.strictEqual(sb.sanitizeCodePath('assets/../../secret.png'), 'assets/secret.png');
      assert.ok(!sb.sanitizeCodePath('../../../../x').startsWith('..'));
    });
    const zip = buildTestZip({ 'index.html':'<p>hi</p>', 'malware.exe': Buffer.from([1,2,3]), '.env': 'SECRET=1' });
    const project = await sb.importZipBufferAsProject(zip.buffer.slice(zip.byteOffset, zip.byteOffset+zip.byteLength), 'sectest');
    test('.exe (tipe tidak didukung) tidak diimpor', ()=>{
      assert.ok(project.files['malware.exe']==null);
      assert.ok((project.assets||{})['malware.exe']==null);
    });
    test('.env (secret pattern) tidak diimpor', ()=> assert.ok(project.files['.env']==null));
  }

  section('11) File kosong & asset kecil tetap dipertahankan');
  {
    const project = sb.newCodeProject('EmptyTest', { 'empty.txt': '' }, [], { 'tiny.png': { mime:'image/png', b64:'AA==', size:1 } });
    test('file teks kosong tersimpan (bukan undefined)', ()=> assert.strictEqual(project.files['empty.txt'], ''));
    test('asset 1 byte tersimpan', ()=> assert.strictEqual(project.assets['tiny.png'].size, 1));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if(fail>0) process.exitCode = 1;
}

main().catch(e=>{ console.error(e); process.exitCode = 1; });

/* -------------------------------------------------------------------------
   Manual/browser checklist (needs a real DOM — DOMParser, iframe, Blob,
   File/drag-drop — so it isn't covered by this Node script):

   [ ] Preview: <img src>, CSS background-image, <video>, <audio>,
       @font-face, and favicon all render inside the sandboxed iframe for
       a project imported via the scenarios above.
   [ ] Preview: a project script calling fetch('./data.json') or
       fetch('assets/data.json') resolves via the virtual FS shim and logs
       the parsed content to console (visible in the Console panel).
   [ ] File Explorer: each asset type shows a distinct icon (image/audio/
       video/font/pdf), clicking one shows the right preview widget, and
       double-clicking never opens a binary asset in the CodeMirror editor.
   [ ] Drag & drop: dropping a folder of mixed assets from the OS file
       manager preserves the folder structure and every filename.
   [ ] Rename a folder containing assets from the File Explorer UI (not
       just the unit-level rewriteReferencesAfterMove call above) and
       confirm the preview still renders the moved images correctly.
   [ ] Upload the same filename twice via "+ Asset" — confirm it's
       auto-renamed with " (2)" rather than silently overwritten.
   ------------------------------------------------------------------------- */
