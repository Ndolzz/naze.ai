/* ---------- State ---------- */
let chats = [];            // [{id,title,updatedAt,thinking}]
let currentChatId = null;
let messages = [];         // current chat messages: {role, text, atts:[{name,size,kind,mime,dataUrl|text}], id}
let pendingAtts = [];       // attachments staged in composer
let isStreaming = false;
let streamAbort = null;
let thinkingOn = false;
let browseMode = 'auto'; // 'auto' | 'always' | 'never' — Naze Auto Browse
let imageGenMode = false; // when true, next send goes to the image-gen endpoint instead of chat

/* ---------- Settings v2 state ---------- */
const NAZE_VERSION = '1.5.0';
const DEFAULT_PREFS = {
  theme:'dark', accent:'blue', browseMode:'auto',
  animations:true, enterToSend:true, autoScroll:true,
  markdown:true, codeHighlight:true, density:'comfortable',
  defaultMode:'fast', memoryOn:true
};
let animationsOn = true;
let enterToSendOn = true;
let autoScrollOn = true;
let markdownOn = true;
let codeHighlightOn = true;
let density = 'comfortable';
let defaultMode = 'fast';
let memoryOn = true;

const LIMITS = { image: 10*1024*1024, document: 20*1024*1024, code: 5*1024*1024 };
const IMAGE_EXT = ['jpg','jpeg','png','webp','gif'];
const TEXT_READABLE_EXT = ['txt','csv','json','md','html','css','js','jsx','ts','tsx','py','php','java','c','cpp','cs','xml','sql','sh'];
const DOC_UNREADABLE_EXT = ['pdf','doc','docx','xls','xlsx','ppt','pptx'];
const LANG_MAP = {js:'javascript',jsx:'jsx',ts:'typescript',tsx:'tsx',py:'python',php:'php',java:'java',c:'c',cpp:'cpp',cs:'csharp',json:'json',sql:'sql',sh:'bash',html:'html',css:'css',xml:'xml',md:'markdown',txt:'text',csv:'csv'};

/* ---------- ZIP project analysis ---------- */
// Upload cap is on the *compressed* .zip file itself, same idea as the other
// LIMITS entries above. The uncompressed-content caps below are separate
// safety nets applied during extraction, not at the file-picker stage.
LIMITS.zip = 30*1024*1024; // 30MB

// Safety caps applied while extracting/reading a ZIP client-side, so a huge
// or hostile archive (zip bomb, a monorepo with node_modules left in, etc.)
// can never freeze the tab or blow up the prompt sent to the AI.
const ZIP_MAX_TOTAL_UNCOMPRESSED = 120*1024*1024; // stop *including* more entries past this much uncompressed content
const ZIP_MAX_FILES = 4000;                        // stop including more entries past this count
const ZIP_MAX_FILE_TEXT_SIZE = 300*1024;           // per-file: never read content above this size
const ZIP_PER_FILE_CHAR_CAP = 4000;                // per-file: how much of one file's content can enter the prompt
const ZIP_CONTEXT_CHAR_BUDGET = 45000;             // total: hard cap on all embedded file content combined

// Folders/files never scanned or sent to the AI, regardless of what's inside
// the archive. fflate's filter callback lets us skip *decompressing* these
// entirely (not just discard them after the fact), so a bloated
// node_modules folder costs almost nothing to skip.
const ZIP_IGNORE_DIR_NAMES = new Set([
  'node_modules','.git','.svn','.hg','.next','.nuxt','dist','build','out',
  'target','vendor','coverage','__pycache__','.cache','.venv','venv','env',
  '.idea','.vscode','.gradle','.parcel-cache','.turbo','.output','bin','obj',
  '.pytest_cache','.mypy_cache','.tox','tmp','temp'
]);
// Dotfiles that ARE useful for project analysis, allowed through even though
// dotfiles/dotfolders are skipped by default below.
const ZIP_DOTFILE_ALLOW = new Set([
  '.gitignore','.env.example','.env.sample','.eslintrc','.eslintrc.json',
  '.eslintrc.js','.babelrc','.editorconfig','.dockerignore'
]);
// Never read or forward these to the AI, even if nothing else caught them —
// credentials, private keys, tokens, secrets in any common form.
const ZIP_SECRET_PATTERNS = [
  /^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /\.pfx$/i, /\.p12$/i,
  /^id_rsa/i, /^id_dsa/i, /^id_ed25519/i, /\.keystore$/i, /\.jks$/i,
  /secrets?\.(json|ya?ml|txt)$/i, /credentials/i, /^\.npmrc$/i, /^\.netrc$/i
];
// Binary / build / generated / vendored content — never useful as "source
// code", often huge, so it's never read as text (still counted in totals).
const ZIP_IGNORE_FILE_PATTERNS = [
  /\.(png|jpe?g|gif|bmp|webp|ico|svg|ttf|otf|woff2?|eot)$/i,
  /\.(mp4|mov|avi|mkv|mp3|wav|ogg|flac)$/i,
  /\.(zip|rar|7z|gz|tar|bz2|xz)$/i,
  /\.(exe|dll|so|dylib|class|jar|war|pyc|o|obj|a|lib)$/i,
  /\.(pdf|psd|ai|sketch)$/i,
  /\.min\.(js|css)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|Cargo\.lock)$/i,
  /\.DS_Store$/, /Thumbs\.db$/i, /\.log$/i, /\.map$/i
];
// Extensions read as source/config text for whole-project analysis —
// deliberately broader than TEXT_READABLE_EXT above (single-file uploads),
// since a project scan wants to recognize far more languages.
const ZIP_TEXT_EXT = new Set([...TEXT_READABLE_EXT,
  'go','rs','rb','kt','kts','swift','dart','vue','svelte','yml','yaml',
  'toml','ini','cfg','conf','gradle','groovy','scala','lua','r','pl','ps1',
  'bat','graphql','proto','rst'
]);
const ZIP_LANG_BY_EXT = {
  js:'JavaScript', jsx:'JavaScript (React)', ts:'TypeScript', tsx:'TypeScript (React)',
  py:'Python', php:'PHP', java:'Java', kt:'Kotlin', kts:'Kotlin', go:'Go',
  rs:'Rust', rb:'Ruby', swift:'Swift', dart:'Dart', c:'C', cpp:'C++', cs:'C#',
  vue:'Vue', svelte:'Svelte', html:'HTML', css:'CSS', scss:'SCSS', sql:'SQL',
  sh:'Shell', ps1:'PowerShell', scala:'Scala', lua:'Lua', groovy:'Groovy'
};
// Config/manifest files worth calling out by name under "important files".
const ZIP_CONFIG_FILES = [
  'package.json','tsconfig.json','requirements.txt','pyproject.toml','Pipfile',
  'go.mod','Cargo.toml','pom.xml','build.gradle','build.gradle.kts',
  'composer.json','Gemfile','next.config.js','nuxt.config.js','vite.config.js',
  'vite.config.ts','webpack.config.js','tailwind.config.js','docker-compose.yml',
  'Dockerfile','manifest.json','vercel.json','.env.example','appsettings.json'
];
// Checked in priority order — the first one found is reported as the entry point.
const ZIP_ENTRY_CANDIDATES = [
  'src/index.ts','src/index.js','src/main.ts','src/main.js','index.ts','index.js',
  'server.js','app.js','app.ts','main.py','manage.py','app.py','main.go',
  'src/main.rs','main.rs','Main.java','Program.cs','index.php','public/index.php',
  'index.html','public/index.html'
];

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

