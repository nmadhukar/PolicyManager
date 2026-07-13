/**
 * Sanitizes arbitrary (often Word-pasted) document text so pdf-lib's StandardFont
 * WinAnsi encoder can draw it WITHOUT throwing.
 *
 * pdf-lib's standard fonts encode to WinAnsi; `drawText` throws on any code point
 * the encoder can't represent (CJK, emoji, and — depending on version — common
 * "smart" punctuation). Controlled-document text routinely contains smart quotes,
 * em/en dashes, and ellipses pasted from Word, so an un-sanitized compare PDF or
 * evidence binder would 500 on ordinary content. We map the common typographic
 * characters to ASCII and replace anything outside the safe WinAnsi range with '?'
 * so PDF generation can never crash on user text.
 */

/** Explicit ASCII fallbacks for common non-ASCII typography. */
const REPLACEMENTS: Record<string, string> = {
  '‘': "'", // ‘ left single quote
  '’': "'", // ’ right single quote / apostrophe
  '‚': "'", // ‚
  '‛': "'", // ‛
  '“': '"', // “ left double quote
  '”': '"', // ” right double quote
  '„': '"', // „
  '‟': '"', // ‟
  '–': '-', // – en dash
  '—': '-', // — em dash
  '―': '-', // ― horizontal bar
  '−': '-', // − minus sign
  '…': '...', // … ellipsis
  '•': '*', // • bullet
  ' ': ' ', // non-breaking space
  ' ': ' ', // figure space
  ' ': ' ', // thin space
  ' ': ' ', // hair space
  ' ': ' ', // narrow no-break space
  '€': 'EUR', // € (WinAnsi has it, but keep output portable)
  '™': '(TM)', // ™
  '®': '(R)', // ®
  '©': '(C)', // ©
};

/**
 * Returns a WinAnsi-drawable version of `input`: known typography mapped to ASCII,
 * tabs/newlines flattened to spaces (drawText renders a single line), control chars
 * dropped, and any remaining non-Latin-1 code point replaced with '?'.
 */
export function pdfSafeText(input: string | null | undefined): string {
  if (!input) return '';
  let out = '';
  for (const ch of input) {
    const mapped = REPLACEMENTS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += ' '; // flatten tab/newline — a drawn line has no line breaks
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // C0 / C1 control range — not printable in WinAnsi.
      continue;
    } else if (code <= 0x7e || (code >= 0xa0 && code <= 0xff)) {
      out += ch; // ASCII printable or Latin-1 supplement — safe for WinAnsi
    } else {
      out += '?'; // anything else (CJK, emoji, rare symbols)
    }
  }
  return out;
}
