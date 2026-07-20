import { sanitizePlainText, sanitizeTipTapHtml } from './html-sanitizer';

describe('sanitizeTipTapHtml (FINDING-013)', () => {
  it('strips <script> tags entirely (content and all)', () => {
    const out = sanitizeTipTapHtml('<p>Hello</p><script>alert(document.cookie)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(document.cookie)');
    expect(out).toContain('<p>Hello</p>');
  });

  it('strips inline event-handler attributes (e.g. onerror on a disallowed <img>)', () => {
    const out = sanitizeTipTapHtml('<p>Note</p><img src=x onerror="fetch(\'//evil\')">');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<img');
  });

  it('strips an <iframe> pointed at an internal/SSRF-prone address', () => {
    const out = sanitizeTipTapHtml('<iframe src="http://169.254.169.254/latest/meta-data/"></iframe>');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('169.254.169.254');
  });

  it('strips <link>/<style> tags that could exfiltrate via CSS or load external resources', () => {
    const out = sanitizeTipTapHtml('<link rel="stylesheet" href="http://evil/x.css"><style>body{}</style>');
    expect(out).not.toContain('<link');
    expect(out).not.toContain('<style');
  });

  it('preserves every tag StarterKit actually produces, unchanged (content-wise)', () => {
    const input =
      '<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em> and <s>struck</s> text.</p>' +
      '<blockquote><p>Quoted</p></blockquote>' +
      '<pre><code>const x = 1;</code></pre>' +
      '<ul><li>One</li><li>Two</li></ul>' +
      '<ol><li>First</li></ol>' +
      '<hr><p>Line one<br>Line two</p>';
    // sanitize-html normalizes void elements to self-closing (<hr />, <br />)
    // — semantically identical for both TipTap's re-parse and Gotenberg's
    // Chromium render, so the assertion is content-based, not byte-for-byte.
    const out = sanitizeTipTapHtml(input);
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<s>struck</s>');
    expect(out).toContain('<blockquote><p>Quoted</p></blockquote>');
    expect(out).toContain('<pre><code>const x = 1;</code></pre>');
    expect(out).toContain('<ul><li>One</li><li>Two</li></ul>');
    expect(out).toContain('<ol><li>First</li></ol>');
    expect(out).toMatch(/<hr\s*\/?>/);
    expect(out).toMatch(/Line one<br\s*\/?>Line two/);
  });

  it('drops disallowed attributes but keeps the (allowed) tag itself', () => {
    const out = sanitizeTipTapHtml('<p onclick="doEvil()" style="background:url(javascript:alert(1))">Text</p>');
    expect(out).toBe('<p>Text</p>');
  });
});

describe('sanitizePlainText (FINDING-014)', () => {
  it('strips <script> tags entirely (content and all)', () => {
    const out = sanitizePlainText('Hello<script>alert(document.cookie)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(document.cookie)');
    expect(out).toContain('Hello');
  });

  it('strips an <img onerror=...> event-handler payload entirely', () => {
    const out = sanitizePlainText('Note<img src=x onerror="fetch(\'//evil\')">');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<img');
    expect(out).toContain('Note');
  });

  it('strips EVERY tag, unlike sanitizeTipTapHtml which allows a formatting subset', () => {
    const out = sanitizePlainText('<p>Some <strong>bold</strong> text</p>');
    expect(out).not.toContain('<p>');
    expect(out).not.toContain('<strong>');
    expect(out).toBe('Some bold text');
  });

  it('leaves plain prose (including stray angle-bracket-free text) unchanged', () => {
    expect(sanitizePlainText('Please review section 3.2 before Friday.')).toBe(
      'Please review section 3.2 before Friday.',
    );
  });
});
