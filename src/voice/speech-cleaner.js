/* ---------- Naze Voice: Speech Cleaner ----------
 * Turns a raw NAZE AI markdown reply into plain, speakable text.
 * IMPORTANT: this never touches the actual chat message — `messages[].text`
 * stays exactly as the model wrote it (markdown and all). Cleaning only
 * ever runs on a throwaway copy of the text, right before it's handed to
 * SpeechSynthesis.
 */
(function (global) {
  'use strict';

  function cleanTextForSpeech(text) {
    if (!text) return '';
    let t = String(text);

    // Fenced code blocks — code isn't speakable, drop the whole block.
    t = t.replace(/```[\s\S]*?```/g, ' ');
    // Inline code: `foo()` -> foo()
    t = t.replace(/`([^`\n]+)`/g, '$1');

    // Images: ![alt](url) -> alt (or nothing)
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Links: [text](url) -> text
    t = t.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1');

    // Headings: "### Judul" -> "Judul"
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');

    // Bold/italic/strikethrough markers
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
    t = t.replace(/\*([^*\n]+)\*/g, '$1');
    t = t.replace(/___([^_]+)___/g, '$1');
    t = t.replace(/__([^_]+)__/g, '$1');
    t = t.replace(/_([^_\n]+)_/g, '$1');
    t = t.replace(/~~([^~]+)~~/g, '$1');

    // Blockquote markers
    t = t.replace(/^\s{0,3}>\s?/gm, '');

    // Bullet / numbered list markers -> keep the text, drop the marker
    t = t.replace(/^\s*[-*+]\s+/gm, '');
    t = t.replace(/^\s*\d+[.)]\s+/gm, '');

    // Horizontal rules
    t = t.replace(/^\s*([-*_]\s*){3,}\s*$/gm, ' ');

    // Tables: strip pipes and separator rows, keep cell text
    t = t.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ');
    t = t.replace(/\|/g, ', ');

    // Raw URLs — reading out a full URL is useless, say "tautan" instead.
    t = t.replace(/https?:\/\/\S+/g, 'tautan');

    // Citation-style markers, e.g. [1], [12], 【source†L1-L2】
    t = t.replace(/\[\d+\]/g, '');
    t = t.replace(/【[^】]*】/g, '');

    // Any stray HTML tags
    t = t.replace(/<[^>]+>/g, ' ');

    // Leftover markdown/formatting symbols and excess whitespace
    t = t.replace(/[#*_~`]+/g, '');
    t = t.replace(/\n{2,}/g, '. ');
    t = t.replace(/\n/g, ' ');
    t = t.replace(/\s{2,}/g, ' ');

    return t.trim();
  }

  global.NazeSpeechCleaner = { cleanTextForSpeech };
})(typeof window !== 'undefined' ? window : globalThis);
