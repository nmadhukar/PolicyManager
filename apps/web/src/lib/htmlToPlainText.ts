/**
 * Flattens an app-authored HTML version to plain text for a `.txt` download.
 * Uses the browser's parser (no dependency); block-level elements become line
 * breaks so paragraphs, headings, and list items land on separate lines.
 */
export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BR', 'TR', 'BLOCKQUOTE', 'PRE']);
  const lines: string[] = [];
  let current = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    if (tag === 'BR') {
      lines.push(current);
      current = '';
      return;
    }
    const isBlock = BLOCK.has(tag);
    if (isBlock && current.trim()) {
      lines.push(current);
      current = '';
    }
    node.childNodes.forEach(walk);
    if (isBlock) {
      lines.push(current);
      current = '';
    }
  };
  doc.body.childNodes.forEach(walk);
  if (current.trim()) lines.push(current);
  // Collapse runs of blank lines, trim trailing whitespace per line.
  return lines
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
