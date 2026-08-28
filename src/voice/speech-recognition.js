/* ---------- Naze Voice: Speech Recognition (Speech-to-Text) ----------
 * Thin wrapper around the browser-native SpeechRecognition /
 * webkitSpeechRecognition API. No paid service, no API key — if the
 * browser doesn't support it, `isSupported()` says so and the rest of the
 * app keeps working as a text-only chat.
 */
(function (global) {
  'use strict';

  const SR = global.SpeechRecognition || global.webkitSpeechRecognition || null;

  function isSupported() {
    return !!SR;
  }

  /**
   * @param {Object} handlers
   *   onStart(), onEnd(), onError(err), onNoMatch(),
   *   onResult({interim, final}) — called on every recognition "result"
   *     event; `final` is only set once a chunk of speech is finalized.
   */
  function createRecognizer(handlers) {
    handlers = handlers || {};
    if (!SR) return null;

    const recognition = new SR();
    recognition.continuous = false;   // controlled per-call via start(opts)
    recognition.interimResults = true;
    recognition.lang = 'id-ID';
    recognition.maxAlternatives = 1;

    let active = false;

    recognition.onstart = () => {
      active = true;
      if (handlers.onStart) handlers.onStart();
    };

    recognition.onend = () => {
      active = false;
      if (handlers.onEnd) handlers.onEnd();
    };

    recognition.onerror = (e) => {
      active = false;
      if (handlers.onError) handlers.onError(e && e.error ? e.error : 'unknown');
    };

    recognition.onnomatch = () => {
      if (handlers.onNoMatch) handlers.onNoMatch();
    };

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0] ? res[0].transcript : '';
        if (res.isFinal) final += text;
        else interim += text;
      }
      // Whitespace cleanup; empty finals are ignored by the caller.
      interim = interim.replace(/\s+/g, ' ').trim();
      final = final.replace(/\s+/g, ' ').trim();
      if (interim || final) {
        if (handlers.onResult) handlers.onResult({ interim, final });
      }
    };

    return {
      /** @param {{continuous?:boolean, lang?:string}} opts */
      start(opts) {
        if (active) return; // never start twice — avoids duplicate sessions
        opts = opts || {};
        recognition.continuous = !!opts.continuous;
        recognition.lang = opts.lang || 'id-ID';
        try { recognition.start(); } catch (e) { /* already starting — ignore */ }
      },
      stop() {
        if (!active) return;
        try { recognition.stop(); } catch (e) {}
      },
      abort() {
        active = false;
        try { recognition.abort(); } catch (e) {}
      },
      isActive() { return active; }
    };
  }

  global.NazeSpeechRecognition = { isSupported, createRecognizer };
})(typeof window !== 'undefined' ? window : globalThis);
