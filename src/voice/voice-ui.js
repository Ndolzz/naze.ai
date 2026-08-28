/* ---------- Naze Voice: UI ----------
 * Wires the mic button, the Voice panel, and the "Voice" settings page to
 * NazeVoiceController. Self-contained: binds its own DOM events (does not
 * touch js/events.js), and only reaches into the rest of the app through
 * things that already exist globally (`$`, `stGet`/`stSet`, `escapeHtml`,
 * `SETTINGS_TITLES`) — same pattern the rest of the app already uses.
 */
(function (global) {
  'use strict';

  const DEFAULT_VOICE_PREFS = {
    enabled: true,
    lang: 'id-ID',
    voiceURI: '',
    rate: 1,
    pitch: 1,
    volume: 1,
    continuous: false
  };
  let voicePrefs = Object.assign({}, DEFAULT_VOICE_PREFS);

  function $(sel) { return document.querySelector(sel); }

  async function loadPrefs() {
    try {
      const saved = (typeof global.stGet === 'function') ? await global.stGet('voicePrefs') : null;
      voicePrefs = Object.assign({}, DEFAULT_VOICE_PREFS, saved || {});
    } catch (e) { /* keep defaults */ }
  }
  async function savePrefsVoice() {
    if (typeof global.stSet === 'function') await global.stSet('voicePrefs', voicePrefs);
  }

  function applyPrefsToController() {
    const ctrl = global.NazeVoiceController;
    if (!ctrl) return;
    ctrl.setPrefs({
      lang: voicePrefs.lang, voiceURI: voicePrefs.voiceURI,
      rate: voicePrefs.rate, pitch: voicePrefs.pitch, volume: voicePrefs.volume
    });
    ctrl.setContinuous(voicePrefs.continuous);
  }

  /* ---------- Mic support / visibility ---------- */
  function micButtonAvailable() {
    const ctrl = global.NazeVoiceController;
    return !!(ctrl && ctrl.supported() && voicePrefs.enabled);
  }

  function refreshMicVisibility() {
    const btn = $('#voice-btn');
    if (!btn) return;
    const supported = global.NazeVoiceController && global.NazeVoiceController.supported();
    if (!supported) {
      btn.style.display = 'none'; // graceful degradation: no mic in this browser
      return;
    }
    btn.style.display = voicePrefs.enabled ? 'flex' : 'none';
  }

  /* ---------- Status text / visuals ---------- */
  const STATUS_LABEL = {
    idle: 'Siap', listening: 'Mendengarkan…', processing: 'Memproses…',
    speaking: 'Naze berbicara…', error: 'Terjadi kesalahan', unsupported: 'Tidak didukung di browser ini'
  };
  const ERROR_LABEL = {
    'not-allowed': 'Izin mikrofon ditolak. Aktifkan akses mikrofon di pengaturan browser untuk pakai Voice Mode.',
    'audio-capture': 'Mikrofon tidak ditemukan/tidak bisa diakses.',
    'network': 'Koneksi bermasalah saat mengenali suara.',
    'service-not-allowed': 'Layanan pengenalan suara tidak diizinkan browser ini.',
    'language-not-supported': 'Bahasa yang dipilih tidak didukung browser ini.',
    'send-failed': 'Gagal mengirim pesan suara ke Naze.',
    'chat-pipeline-unavailable': 'Chat belum siap, coba lagi sebentar.'
  };

  function setMicButtonState(state) {
    const btn = $('#voice-btn');
    if (btn) {
      btn.classList.remove('vc-listening', 'vc-processing', 'vc-speaking', 'vc-error');
      if (state === 'listening') btn.classList.add('vc-listening');
      else if (state === 'processing') btn.classList.add('vc-processing');
      else if (state === 'speaking') btn.classList.add('vc-speaking');
      else if (state === 'error') btn.classList.add('vc-error');
      btn.setAttribute('aria-pressed', String(state === 'listening'));
    }
  }

  function renderPanelState(state, extra) {
    const statusEl = $('#voice-status');
    const micEl = $('#voice-panel-mic');
    if (statusEl) {
      let label = STATUS_LABEL[state] || state;
      if (state === 'error' && extra && ERROR_LABEL[extra.error]) label = ERROR_LABEL[extra.error];
      statusEl.textContent = label;
    }
    if (micEl) {
      micEl.classList.remove('vc-listening', 'vc-processing', 'vc-speaking', 'vc-error');
      if (['listening', 'processing', 'speaking', 'error'].includes(state)) micEl.classList.add('vc-' + state);
    }
    if (state === 'listening' && extra) {
      const tEl = $('#voice-transcript');
      if (tEl) tEl.textContent = extra.final || extra.interim || '';
    }
    if (state === 'processing') {
      const rEl = $('#voice-response');
      if (rEl) rEl.textContent = '';
    }
    if (state === 'speaking') {
      const rEl = $('#voice-response');
      // `messages` is a `let` global from js/state.js — bare identifier,
      // not a window property (see note in voice-controller.js).
      const list = (typeof messages !== 'undefined') ? messages : null;
      const last = Array.isArray(list) && list.length ? list[list.length - 1] : null;
      if (rEl && last && last.role === 'ai') {
        rEl.textContent = last.text; // textContent, so no manual escaping needed
      }
    }
  }

  /* ---------- Panel open/close ---------- */
  function openPanel() {
    const overlay = $('#voice-panel-overlay');
    if (overlay) overlay.classList.add('show');
    const tEl = $('#voice-transcript'); if (tEl) tEl.textContent = '';
    const rEl = $('#voice-response'); if (rEl) rEl.textContent = '';
  }
  function closePanel() {
    const overlay = $('#voice-panel-overlay');
    if (overlay) overlay.classList.remove('show');
    if (global.NazeVoiceController) global.NazeVoiceController.stopAll();
  }

  /* ---------- Continuous mode toggle (kept in sync in 2 places) ---------- */
  function setToggleUI(el, on) {
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-pressed', String(!!on));
  }
  function syncContinuousToggles() {
    setToggleUI($('#voice-continuous-toggle'), voicePrefs.continuous);
    setToggleUI($('#voice-continuous-toggle-settings'), voicePrefs.continuous);
  }
  async function setContinuous(on) {
    voicePrefs.continuous = !!on;
    if (global.NazeVoiceController) global.NazeVoiceController.setContinuous(voicePrefs.continuous);
    syncContinuousToggles();
    await savePrefsVoice();
  }

  /* ---------- Voice picker (populated once voices load) ---------- */
  function populateVoiceSelect() {
    const sel = $('#voice-select');
    if (!sel || !global.NazeSpeechSynthesis) return;
    const voices = global.NazeSpeechSynthesis.getVoices();
    if (!voices.length) return; // will be retried; getVoices() is async in most browsers
    const current = voicePrefs.voiceURI;
    sel.innerHTML = '<option value="">Otomatis (terbaik untuk bahasa terpilih)</option>' +
      voices.map(v => `<option value="${v.voiceURI}">${v.name} (${v.lang})</option>`).join('');
    sel.value = current && voices.some(v => v.voiceURI === current) ? current : '';
  }

  /* ---------- Settings page bindings ---------- */
  function bindSettingsControls() {
    const enableToggle = $('#voice-enable-toggle');
    if (enableToggle) {
      setToggleUI(enableToggle, voicePrefs.enabled);
      enableToggle.addEventListener('click', async () => {
        voicePrefs.enabled = !voicePrefs.enabled;
        setToggleUI(enableToggle, voicePrefs.enabled);
        refreshMicVisibility();
        await savePrefsVoice();
      });
    }

    const langSeg = $('#voice-lang-seg');
    if (langSeg) {
      langSeg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === voicePrefs.lang));
      langSeg.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', async () => {
          voicePrefs.lang = b.dataset.v;
          langSeg.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
          applyPrefsToController();
          populateVoiceSelect();
          await savePrefsVoice();
        });
      });
    }

    const voiceSelect = $('#voice-select');
    if (voiceSelect) {
      voiceSelect.addEventListener('change', async () => {
        voicePrefs.voiceURI = voiceSelect.value;
        applyPrefsToController();
        await savePrefsVoice();
      });
    }

    bindRange('#voice-rate-range', 'rate');
    bindRange('#voice-pitch-range', 'pitch');
    bindRange('#voice-volume-range', 'volume');

    const contToggleSettings = $('#voice-continuous-toggle-settings');
    if (contToggleSettings) contToggleSettings.addEventListener('click', () => setContinuous(!voicePrefs.continuous));
  }

  function bindRange(sel, key) {
    const el = $(sel);
    if (!el) return;
    el.value = voicePrefs[key];
    el.addEventListener('input', () => {
      voicePrefs[key] = parseFloat(el.value);
      applyPrefsToController();
    });
    el.addEventListener('change', savePrefsVoice);
  }

  /* ---------- Mic + panel bindings ---------- */
  function bindMicAndPanel() {
    const micBtn = $('#voice-btn');
    if (micBtn) {
      micBtn.addEventListener('click', () => {
        if (!micButtonAvailable()) return;
        openPanel();
        global.NazeVoiceController.startListening();
      });
    }

    const panelMic = $('#voice-panel-mic');
    if (panelMic) {
      panelMic.addEventListener('click', () => {
        const ctrl = global.NazeVoiceController;
        if (!ctrl) return;
        const s = ctrl.getState();
        if (s === 'idle' || s === 'error') ctrl.startListening();
        else ctrl.stopAll();
      });
    }

    const stopBtn = $('#voice-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', () => { if (global.NazeVoiceController) global.NazeVoiceController.stopAll(); });

    const closeBtn = $('#voice-panel-close');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    const overlay = $('#voice-panel-overlay');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target.id === 'voice-panel-overlay') closePanel(); });

    const contToggle = $('#voice-continuous-toggle');
    if (contToggle) contToggle.addEventListener('click', () => setContinuous(!voicePrefs.continuous));
  }

  async function init() {
    await loadPrefs();

    // "Voice" entry in the settings title map — settings.js already
    // handles navigation/rendering generically via [data-nav]/[data-view].
    // SETTINGS_TITLES is a `const` global (js/settings.js): bare
    // identifier, not a window property — same reasoning as
    // messages/isStreaming above.
    if (typeof SETTINGS_TITLES !== 'undefined') SETTINGS_TITLES.voice = 'Voice Mode';

    if (!global.NazeVoiceController || !global.NazeVoiceController.supported()) {
      // Browser has no SpeechRecognition: hide the mic entirely, but the
      // rest of Naze (and TTS, if available) keeps working normally.
      refreshMicVisibility();
      bindSettingsControls();
      return;
    }

    applyPrefsToController();
    refreshMicVisibility();
    syncContinuousToggles();
    bindMicAndPanel();
    bindSettingsControls();
    populateVoiceSelect();
    // Voice list often arrives asynchronously after page load.
    setTimeout(populateVoiceSelect, 500);
    setTimeout(populateVoiceSelect, 1500);

    global.NazeVoiceController.onStateChange((state, extra) => {
      setMicButtonState(state);
      renderPanelState(state, extra);
    });
  }

  global.NazeVoiceUI = { init };
})(typeof window !== 'undefined' ? window : globalThis);
