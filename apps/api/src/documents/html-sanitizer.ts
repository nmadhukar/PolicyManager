import sanitizeHtml from 'sanitize-html';

/**
 * FINDING-013: the TipTap editor (apps/web/src/ui/TipTapEditor.tsx) is
 * configured with ONLY @tiptap/starter-kit — no image, link, table, or raw-HTML
 * extension. Any tag/attribute outside that set can only reach the server via a
 * crafted request that bypasses the editor UI (a compromised/malicious client,
 * or a `document.write` holder calling the API directly), not through normal use.
 *
 * The saved HTML is later sent verbatim to Gotenberg's Chromium HTML-to-PDF
 * route (RenditionService.convertHtmlToPdf), which renders it in a real headless
 * browser — a `<script>` or an `<img>`/`<link>` pointed at an internal address
 * would execute / fetch server-side (XSS against the renderer, or SSRF against
 * the internal network) if not stripped first. This allow-list matches
 * StarterKit's actual node/mark set exactly (see its bundled extensions), so
 * normal editor output is never altered.
 */
const ALLOWED_TAGS = [
  'p',
  'div',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  's',
  'strike',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
];

export function sanitizeTipTapHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {},
    allowedSchemes: [],
    // Strip disallowed tags but keep their text content (matches how a browser
    // would render unknown/stripped elements as inline text, and avoids
    // silently dropping a user's words because of one bad tag).
    disallowedTagsMode: 'discard',
  });
}

/**
 * FINDING-014: for fields that are plain text by design (e.g. an annotation
 * comment — no rich-text editor produces this value), strip ALL markup
 * rather than allow any tag. Keeps the enclosed text (matches
 * {@link sanitizeTipTapHtml}'s discard behavior) so a stray `<`/`>` in normal
 * prose doesn't silently eat the surrounding words.
 */
export function sanitizePlainText(text: string): string {
  return sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: 'discard',
  });
}
