/* ---------- Naze Voice: Controller (state machine) ----------
 * States: idle -> listening -> processing -> speaking -> idle
 *         (speaking -> listening again only when Continuous Mode is on)
 *
 * Integration contract with the existing app (index.html / js/*.js):
 *   - Reuses the SAME send pipeline the composer uses: it writes the final
 *     transcript into #text-input and calls the existing global
 *     `sendMessage()` — so a voice turn produces the exact same message
 *     object a typed turn would. No new endpoint, no duplicate request.
 *   - Reads the reply to speak from the existing global `messages` array
 *     (the same array chat-engine.js already maintains) after
 *     `sendMessage()` resolves — it does not hook into or modify
 *     chat-engine.js at all.
 *   - Never restarts listening on its own after silence/no-speech/errors —
 *     that would risk an infinite loop. Auto re-listen only happens once,
 *     right after Naze finishes *speaking* a real reply, and only when
 *     Continuous Voice Mode is on.
 */
(function (global) {
  'use strict';

  const STATES = ['idle', 'listening', 'processing', 'speaking', 'error', 'unsupported'];
  const RESTART_DELAY_MS = 700; // let the mic settle after TTS ends, so Naze's own voice isn't picked back up

  let state = 'idle';
  let continuousMode = false;
  let recognizer = null;
  let restartTimer = null;
  let lastSeenAiMsgId = null;
  let prefs = { lang: 'id-ID', voiceURI: '', rate: 1, pitch: 1, volume: 1 };

  const listeners = new Set();
  function setState(next, extra) {
    state = next;
    listeners.forEach(fn => { try { fn(state, extra || {}); } catch (e) {} });
  }
  function onStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function supported() {
    return global.NazeSpeechRecognition && global.NazeSpeechRecognition.isSupported();
  }
  function ttsSupported() {
    return global.NazeSpeechSynthesis && global.NazeSpeechSynthesis.isSupported();
  }

  function setPrefs(p) { prefs = Object.assign({}, prefs, p || {}); }
  function setContinuous(on) {
    continuousMode = !!on;
    if (!continuousMode) clearRestartTimer();
  }
  function isContinuous() { return continuousMode; }
  function getState() { return state; }

  function clearRestartTimer() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  }

  function ensureRecognizer() {
    if (recognizer) return recognizer;
    recognizer = global.NazeSpeechRecognition.createRecognizer({
      onStart: () => setState('listening'),
      onResult: ({ interim, final }) => {
        setState('listening', { interim, final });
        if (final) {
          recognizer.stop();
          handleFinalTranscript(final);
        }
      },
      onNoMatch: () => {
        // Nothing understood — go back to idle rather than looping.
        setState('idle');
      },
      onError: (err) => {
        clearRestartTimer();
        if (err === 'no-speech' || err === 'aborted') {
          setState('idle');
        } else {
          setState('error', { error: err });
        }
      },
      onEnd: () => {
        // If recognition ended without ever producing a final transcript
        // (silence, user stopped it manually), settle back to idle.
        if (state === 'listening') setState('idle');
      }
    });
    return recognizer;
  }

  function startListening() {
    if (!supported()) { setState('unsupported'); return; }
    clearRestartTimer();
    if (global.NazeSpeechSynthesis) global.NazeSpeechSynthesis.stop();
    const r = ensureRecognizer();
    if (!r) { setState('unsupported'); return; }
    r.start({ continuous: false, lang: prefs.lang || 'id-ID' });
  }

  async function handleFinalTranscript(text) {
    text = (text || '').trim();
    if (!text) { setState('idle'); return; }

    setState('processing');

    const input = global.document.getElementById('text-input');
    if (!input || typeof global.sendMessage !== 'function') {
      setState('error', { error: 'chat-pipeline-unavailable' });
      return;
    }
    // NOTE: `isStreaming`/`messages` are `let` globals from js/state.js —
    // shared classic scripts expose those as bare identifiers in the same
    // global lexical scope, NOT as `window.isStreaming`, so they're read
    // directly here rather than through `global.`.
    if (typeof isStreaming !== 'undefined' && isStreaming) {
      // A turn is already running — never fire a second/duplicate request.
      setState('idle');
      return;
    }

    input.value = text;
    if (typeof global.updateSendState === 'function') global.updateSendState();

    try {
      await global.sendMessage(); // exact same pipeline as typing + pressing send
    } catch (e) {
      setState('error', { error: 'send-failed' });
      return;
    }

    speakLatestReply();
  }

  function speakLatestReply() {
    const list = (typeof messages !== 'undefined') ? messages : null;
    const last = Array.isArray(list) && list.length ? list[list.length - 1] : null;
    const isNewAiReply = last && last.role === 'ai' && last.id !== lastSeenAiMsgId;

    if (!isNewAiReply || !last.text) {
      // Nothing new to say (send failed silently, or it was an image-gen
      // turn) — don't get stuck in "processing".
      setState('idle');
      return;
    }
    lastSeenAiMsgId = last.id;

    if (!ttsSupported()) {
      // Voice input still worked; just nothing to read the reply with.
      setState('idle');
      return;
    }

    const spoken = global.NazeSpeechCleaner
      ? global.NazeSpeechCleaner.cleanTextForSpeech(last.text)
      : last.text;

    setState('speaking');
    global.NazeSpeechSynthesis.speak(spoken, {
      lang: prefs.lang, voiceURI: prefs.voiceURI,
      rate: prefs.rate, pitch: prefs.pitch, volume: prefs.volume,
      onEnd: () => {
        if (continuousMode && state === 'speaking') {
          setState('idle');
          restartTimer = setTimeout(() => {
            restartTimer = null;
            if (continuousMode) startListening();
          }, RESTART_DELAY_MS);
        } else {
          setState('idle');
        }
      },
      onError: () => setState('idle')
    });
  }

  function stopAll() {
    clearRestartTimer();
    if (recognizer) recognizer.abort();
    if (global.NazeSpeechSynthesis) global.NazeSpeechSynthesis.stop();
    setState('idle');
  }

  global.NazeVoiceController = {
    STATES, supported, ttsSupported,
    setPrefs, setContinuous, isContinuous, getState,
    startListening, stopAll, onStateChange
  };
})(typeof window !== 'undefined' ? window : globalThis);
