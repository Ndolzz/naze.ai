/* ---------- Init ---------- */
(async function init(){
  const prefs = Object.assign({}, DEFAULT_PREFS, await stGet('prefs') || {});
  applyTheme(prefs.theme); applyAccent(prefs.accent);
  applyBrowseMode(prefs.browseMode);
  applyAnimations(prefs.animations !== false);
  applyEnterToSend(prefs.enterToSend !== false);
  applyAutoScroll(prefs.autoScroll !== false);
  applyMarkdown(prefs.markdown !== false);
  applyCodeHighlight(prefs.codeHighlight !== false);
  applyDensity(prefs.density);
  applyDefaultMode(prefs.defaultMode);
  applyMemoryOn(prefs.memoryOn !== false);
  thinkingOn = (defaultMode === 'deep');
  updateThinkToggleUI();
  if($('#naze-version-val')) $('#naze-version-val').textContent = 'v' + NAZE_VERSION;
  const idx = await stGet('chats-index') || [];
  chats = idx;
  renderChatList();
  bindEvents();
  await loadCodeProjectsIndex();
  bindCodeWorkspaceEvents();
  autoSizeTextarea();
  registerServiceWorker();
  updateWelcomeGreeting();
  if(chats.length){ /* stay on welcome until user picks/creates */ }
  if(window.NazeVoiceUI){ try{ await NazeVoiceUI.init(); }catch(e){ console.warn('Voice mode init failed', e); } }
})();

