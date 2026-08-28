function applyTheme(t){
  $('#theme-seg').querySelectorAll('button').forEach(b=>b.classList.toggle('sel', b.dataset.v===t));
  let real = t;
  if(t==='system'){ real = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light'; }
  document.body.setAttribute('data-theme', real);
  document.body.dataset.themePref = t;
  const icon = t==='light' ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
                   : t==='system' ? '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'
                   : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  $('#theme-icon').innerHTML = icon;
}
function applyAccent(a){
  document.body.setAttribute('data-accent', a);
  $('#accent-row').querySelectorAll('.accent-dot').forEach(d=>d.classList.toggle('sel', d.dataset.v===a));
}
async function savePrefs(){
  await stSet('prefs', {
    theme: document.body.dataset.themePref || 'dark',
    accent: document.body.getAttribute('data-accent'),
    browseMode, animations:animationsOn, enterToSend:enterToSendOn, autoScroll:autoScrollOn,
    markdown:markdownOn, codeHighlight:codeHighlightOn, density, defaultMode, memoryOn
  });
}
function applyBrowseMode(v){
  browseMode = ['auto','always','never'].includes(v) ? v : 'auto';
  const seg = $('#browse-seg');
  if(seg) seg.querySelectorAll('button').forEach(b=>b.classList.toggle('sel', b.dataset.v===browseMode));
}
function setToggleUI(sel, on){
  const el = $(sel); if(!el) return;
  el.classList.toggle('on', !!on);
  el.setAttribute('aria-pressed', String(!!on));
}
function applyAnimations(v){
  animationsOn = !!v;
  document.body.dataset.anim = animationsOn ? 'on' : 'off';
  setToggleUI('#anim-toggle', animationsOn);
}
function applyEnterToSend(v){
  enterToSendOn = !!v;
  setToggleUI('#enter-toggle', enterToSendOn);
}
function applyAutoScroll(v){
  autoScrollOn = !!v;
  setToggleUI('#autoscroll-toggle', autoScrollOn);
}
function applyMarkdown(v){
  markdownOn = !!v;
  setToggleUI('#markdown-toggle', markdownOn);
  const row = $('#codehl-row'); const btn = $('#codehl-toggle');
  if(row) row.classList.toggle('disabled', !markdownOn);
  if(btn) btn.disabled = !markdownOn;
}
function applyCodeHighlight(v){
  codeHighlightOn = !!v;
  setToggleUI('#codehl-toggle', codeHighlightOn);
}
function applyDensity(v){
  density = v==='compact' ? 'compact' : 'comfortable';
  document.body.dataset.density = density;
  const seg = $('#density-seg');
  if(seg) seg.querySelectorAll('button').forEach(b=>b.classList.toggle('sel', b.dataset.v===density));
}
function applyDefaultMode(v){
  defaultMode = v==='deep' ? 'deep' : 'fast';
  const seg = $('#defaultmode-seg');
  if(seg) seg.querySelectorAll('button').forEach(b=>b.classList.toggle('sel', b.dataset.v===defaultMode));
}
function applyMemoryOn(v){
  memoryOn = !!v;
  setToggleUI('#memory-toggle', memoryOn);
}
function rerenderCurrentThread(){
  if(!currentChatId) return;
  const thread = $('#thread'); if(!thread) return;
  thread.innerHTML='';
  messages.forEach(m=> thread.appendChild(renderMessageEl(m)));
  hlAll();
}

