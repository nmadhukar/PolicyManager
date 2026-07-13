import { pdfSafeText } from './pdf-text.util';

describe('pdfSafeText', () => {
  it('maps smart quotes, dashes, and ellipsis to ASCII', () => {
    expect(pdfSafeText('“Seclusion” — it’s reviewed…')).toBe('"Seclusion" - it\'s reviewed...');
  });

  it('replaces non-WinAnsi code points (CJK, emoji) with ?', () => {
    expect(pdfSafeText('policy 政策 📄')).toBe('policy ?? ?');
  });

  it('flattens tabs/newlines to spaces and drops control chars', () => {
    const input = 'a' + String.fromCharCode(9) + 'b' + String.fromCharCode(10) + 'c d';
    expect(pdfSafeText(input)).toBe('a b c d');
    // A C0 control (bell) is dropped entirely.
    expect(pdfSafeText('x' + String.fromCharCode(7) + 'y')).toBe('xy');
  });

  it('keeps ASCII and Latin-1 printable characters', () => {
    expect(pdfSafeText('Café résumé © 2026')).toBe('Café résumé (C) 2026');
  });

  it('handles null/undefined/empty', () => {
    expect(pdfSafeText(null)).toBe('');
    expect(pdfSafeText(undefined)).toBe('');
    expect(pdfSafeText('')).toBe('');
  });
});
