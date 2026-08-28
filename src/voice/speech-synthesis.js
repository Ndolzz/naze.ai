/* ---------- Naze Voice: Speech Synthesis (Text-to-Speech) ----------
 * Thin wrapper around window.speechSynthesis. No paid TTS service, no API
 * key. Voice list loads async in most browsers (`voiceschanged`), so
 * getVoices()/pickVoice() both tolerate an empty list on first call.
 */
(function (global) {
  'use strict';

  const synth = global.speechSynthesis || null;

  function isSupported() {
    return !!(synth && global.SpeechSynthesisUtterance);
  }

  let cachedVoices = [];
  function refreshVoices() {
    if (!synth) return [];
    cachedVoices = synth.getVoices() || [];
    return cachedVoices;
  }
  if (synth) {
    refreshVoices();
    if ('onvoiceschanged' in synth) {
      synth.addEventListener('voiceschanged', refreshVoices);
    }
  }

  function getVoices() {
    return cachedVoices.length ? cachedVoices : refreshVoices();
  }

  /**
   * Pick the best available voice for a language, preferring (in order):
   * exact "id-ID" -> any "id-*" -> "en-US" -> browser default (undefined).
   * Never assumes a specific voice is installed.
   */
  function pickVoice(lang, preferredVoiceURI) {
    const voices = getVoices();
    if (!voices.length) return null;
    if (preferredVoiceURI) {
      const exact = voices.find(v => v.voiceURI === preferredVoiceURI);
      if (exact) return exact;
    }
    const wantLang = (lang || 'id-ID').toLowerCase();
    const byExact = voices.find(v => v.lang && v.lang.toLowerCase() === wantLang);
    if (byExact) return byExact;
    const shortWant = wantLang.split('-')[0];
    const byPrefix = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(shortWant));
    if (byPrefix) return byPrefix;
    const byEnUS = voices.find(v => v.lang && v.lang.toLowerCase() === 'en-us');
    if (byEnUS) return byEnUS;
    return null; // let the browser fall back to its own default voice
  }

  let currentUtterance = null;

  /**
   * @param {string} text
   * @param {{lang?:string, voiceURI?:string, rate?:number, pitch?:number,
   *          volume?:number, onEnd?:Function, onError?:Function}} opts
   */
  function speak(text, opts) {
    if (!isSupported() || !text) { if (opts && opts.onEnd) opts.onEnd(); return; }
    opts = opts || {};
    // Never overlap two utterances.
    synth.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(opts.lang, opts.voiceURI);
    if (voice) utter.voice = voice;
    utter.lang = (voice && voice.lang) || opts.lang || 'id-ID';
    utter.rate = clamp(opts.rate, 0.5, 2, 1);
    utter.pitch = clamp(opts.pitch, 0, 2, 1);
    utter.volume = clamp(opts.volume, 0, 1, 1);

    utter.onend = () => { currentUtterance = null; if (opts.onEnd) opts.onEnd(); };
    utter.onerror = (e) => { currentUtterance = null; if (opts.onError) opts.onError(e); };

    currentUtterance = utter;
    synth.speak(utter);
  }

  function clamp(v, min, max, dflt) {
    v = typeof v === 'number' && !isNaN(v) ? v : dflt;
    return Math.max(min, Math.min(max, v));
  }

  function stop() {
    if (!synth) return;
    currentUtterance = null;
    synth.cancel();
  }
  function pause() { if (synth && synth.speaking) synth.pause(); }
  function resume() { if (synth && synth.paused) synth.resume(); }
  function isSpeaking() { return !!(synth && synth.speaking); }

  global.NazeSpeechSynthesis = { isSupported, speak, stop, pause, resume, isSpeaking, getVoices, pickVoice };
})(typeof window !== 'undefined' ? window : globalThis);
