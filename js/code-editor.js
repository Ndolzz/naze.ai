/* =========================================================================
   NAZE CODE — editor wrapper (CodeMirror 5)
   Thin wrapper so the rest of Naze Code never touches CodeMirror directly.
   ========================================================================= */

const CM_MODE_BY_EXT = {
  html:'htmlmixed', htm:'htmlmixed', vue:'htmlmixed', svelte:'htmlmixed',
  css:'css', scss:'css',
  js:'javascript', jsx:'jsx', json:'javascript',
  ts:'javascript', tsx:'jsx',
  xml:'xml', svg:'xml',
  md:'markdown',
  py:'python', php:'php',
  yml:'yaml', yaml:'yaml',
  txt:null
};

let nazeCM = null;               // the CodeMirror instance (single editor, re-bound per open file)
let nazeCMChangeHandler = null;  // current onChange callback (debounced by caller)
let nazeCMDebounceTimer = null;

function initNazeCodeEditor(container){
  if(nazeCM) return nazeCM;
  nazeCM = CodeMirror(container, {
    value: '',
    lineNumbers: true,
    lineWrapping: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    indentUnit: 2, tabSize: 2, indentWithTabs: false,
    theme: (document.documentElement.getAttribute('data-theme')==='light') ? 'default' : 'material-darker',
    extraKeys: {
      'Ctrl-F': 'findPersistent', 'Cmd-F': 'findPersistent',
      'Ctrl-H': 'replace', 'Cmd-Alt-F': 'replace',
      'Ctrl-Z': 'undo', 'Cmd-Z': 'undo',
      'Shift-Ctrl-Z': 'redo', 'Shift-Cmd-Z': 'redo',
      'Tab': (cm)=>{ if(cm.somethingSelected()) cm.indentSelection('add'); else cm.replaceSelection('  ', 'end'); }
    }
  });
  nazeCM.on('change', ()=>{
    if(!nazeCMChangeHandler) return;
    clearTimeout(nazeCMDebounceTimer);
    nazeCMDebounceTimer = setTimeout(()=> nazeCMChangeHandler(nazeCM.getValue()), 350);
  });
  return nazeCM;
}

function nazeCodeEditorSetTheme(isLight){
  if(!nazeCM) return;
  nazeCM.setOption('theme', isLight ? 'default' : 'material-darker');
}

function nazeCodeEditorOpenFile(path, content, onChange){
  if(!nazeCM) return;
  nazeCMChangeHandler = null; // avoid firing a spurious change while we swap content
  const ext = fileExtOf(path);
  const mode = CM_MODE_BY_EXT[ext] || null;
  nazeCM.setOption('mode', mode);
  nazeCM.setValue(content || '');
  nazeCM.clearHistory();
  nazeCMChangeHandler = onChange;
  setTimeout(()=>nazeCM.refresh(), 30); // panel may have been display:none a moment ago
}

function nazeCodeEditorGetValue(){ return nazeCM ? nazeCM.getValue() : ''; }
function nazeCodeEditorFocus(){ if(nazeCM) nazeCM.focus(); }
function nazeCodeEditorFind(){ if(nazeCM) nazeCM.execCommand('findPersistent'); }
function nazeCodeEditorReplace(){ if(nazeCM) nazeCM.execCommand('replace'); }
function nazeCodeEditorUndo(){ if(nazeCM) nazeCM.execCommand('undo'); }
function nazeCodeEditorRedo(){ if(nazeCM) nazeCM.execCommand('redo'); }
function nazeCodeEditorSelectAll(){ if(nazeCM) nazeCM.execCommand('selectAll'); }
async function nazeCodeEditorCopyAll(){
  if(!nazeCM) return;
  try{ await navigator.clipboard.writeText(nazeCM.getValue()); showToastError('Kode disalin ke clipboard.'); }catch(e){}
}
