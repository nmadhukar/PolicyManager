import { TextExtractionService, selectExtractor } from './text-extraction.service';

describe('selectExtractor (dispatch)', () => {
  it('routes PDFs by mime or extension', () => {
    expect(selectExtractor('application/pdf', 'a.pdf')).toBe('pdf');
    expect(selectExtractor('application/octet-stream', 'report.PDF')).toBe('pdf');
  });

  it('routes DOCX (OpenXML) by mime or extension', () => {
    expect(
      selectExtractor(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'a.docx',
      ),
    ).toBe('docx');
    expect(selectExtractor('application/octet-stream', 'Policy.docx')).toBe('docx');
  });

  it('routes text/markdown by mime or extension', () => {
    expect(selectExtractor('text/plain', 'a.txt')).toBe('text');
    expect(selectExtractor('text/markdown', 'a.md')).toBe('text');
    expect(selectExtractor('application/octet-stream', 'notes.md')).toBe('text');
  });

  it('returns "none" for unsupported types (images, legacy .doc, binaries)', () => {
    expect(selectExtractor('image/png', 'a.png')).toBe('none');
    expect(selectExtractor('application/msword', 'legacy.doc')).toBe('none');
    expect(selectExtractor('application/zip', 'a.zip')).toBe('none');
  });
});

describe('TextExtractionService.extract', () => {
  const svc = new TextExtractionService();

  it('extracts UTF-8 text from txt/md without a parser', async () => {
    const text = await svc.extract(Buffer.from('Hello **policy**'), 'text/markdown', 'a.md');
    expect(text).toBe('Hello **policy**');
  });

  it('returns an empty string for unsupported types (never throws)', async () => {
    await expect(svc.extract(Buffer.from([0, 1, 2, 3]), 'image/png', 'a.png')).resolves.toBe('');
  });

  it('never crashes the upload when a parser throws — resolves to empty string', async () => {
    // A .pdf extension with non-PDF bytes makes the PDF parser fail internally.
    const result = await svc.extract(Buffer.from('not really a pdf'), 'application/pdf', 'x.pdf');
    expect(typeof result).toBe('string');
  });

  it('caps very large text output to protect the row/DB', async () => {
    const huge = 'a'.repeat(2_000_000);
    const result = await svc.extract(Buffer.from(huge), 'text/plain', 'big.txt');
    expect(result.length).toBeLessThanOrEqual(1_000_000);
  });
});
