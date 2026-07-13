import { ConfigService } from '@nestjs/config';
import {
  RenditionService,
  renditionStrategyFor,
  requiresRendition,
} from './rendition.service';

describe('renditionStrategyFor (pure dispatch)', () => {
  it('treats PDFs as passthrough (no rendition needed)', () => {
    expect(renditionStrategyFor('application/pdf', 'a.pdf')).toBe('passthrough');
    expect(renditionStrategyFor('application/octet-stream', 'a.PDF')).toBe('passthrough');
  });

  it('treats images as native (no PDF rendition)', () => {
    expect(renditionStrategyFor('image/png', 'a.png')).toBe('image');
    expect(renditionStrategyFor('application/octet-stream', 'photo.JPG')).toBe('image');
  });

  it('routes HTML through the Chromium pipeline', () => {
    expect(renditionStrategyFor('text/html', 'index.html')).toBe('html');
    expect(renditionStrategyFor('application/octet-stream', 'note.htm')).toBe('html');
  });

  it('routes Office/text formats through the LibreOffice pipeline', () => {
    expect(
      renditionStrategyFor(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'policy.docx',
      ),
    ).toBe('office');
    expect(renditionStrategyFor('application/octet-stream', 'sheet.xlsx')).toBe('office');
    expect(renditionStrategyFor('application/octet-stream', 'deck.pptx')).toBe('office');
    expect(renditionStrategyFor('text/plain', 'readme.txt')).toBe('office');
    expect(renditionStrategyFor('application/octet-stream', 'legacy.doc')).toBe('office');
  });

  it('falls back to none for unknown/unsupported types', () => {
    expect(renditionStrategyFor('application/zip', 'a.zip')).toBe('none');
    expect(renditionStrategyFor('application/octet-stream', 'mystery')).toBe('none');
  });

  it('ignores charset parameters on the mime type', () => {
    expect(renditionStrategyFor('text/html; charset=utf-8', 'x')).toBe('html');
  });
});

describe('requiresRendition', () => {
  it('is true only for office + html sources', () => {
    expect(requiresRendition('application/octet-stream', 'a.docx')).toBe(true);
    expect(requiresRendition('text/html', 'a.html')).toBe(true);
    expect(requiresRendition('application/pdf', 'a.pdf')).toBe(false);
    expect(requiresRendition('image/png', 'a.png')).toBe(false);
    expect(requiresRendition('application/zip', 'a.zip')).toBe(false);
  });
});

const makeS3 = () => ({
  getObjectBuffer: jest.fn().mockResolvedValue(Buffer.from('source-bytes')),
  buildRenditionKey: jest.fn(
    (id: string, n: number) => `renditions/${id}/v${n}/rendition.pdf`,
  ),
  putObject: jest.fn().mockResolvedValue({ versionId: 'r-ver-1' }),
});

const build = (s = makeS3()) => {
  const config = new ConfigService({ GOTENBERG_URL: 'http://goten.local' });
  const svc = new RenditionService(config, s as never);
  return { svc, s3: s };
};

describe('RenditionService.generateForVersion (dispatch + best-effort)', () => {
  const base = {
    documentId: 'doc-1',
    versionNumber: 2,
    sourceS3Key: 'documents/doc-1/v2/policy.docx',
  };

  it('converts an Office file and stores the rendition at the deterministic key', async () => {
    const { svc, s3 } = build();
    const convert = jest
      .spyOn(svc, 'convertOfficeToPdf')
      .mockResolvedValue(Buffer.from('%PDF-1.7 fake'));

    const result = await svc.generateForVersion({
      ...base,
      mimeType: 'application/octet-stream',
      fileName: 'policy.docx',
    });

    expect(convert).toHaveBeenCalledTimes(1);
    expect(s3.buildRenditionKey).toHaveBeenCalledWith('doc-1', 2);
    expect(s3.putObject).toHaveBeenCalledWith(
      'renditions/doc-1/v2/rendition.pdf',
      expect.any(Buffer),
      'application/pdf',
    );
    expect(result).toEqual({
      renditionS3Key: 'renditions/doc-1/v2/rendition.pdf',
      strategy: 'office',
    });
  });

  it('pulls source bytes from S3 when no buffer is supplied (on-demand regen)', async () => {
    const { svc, s3 } = build();
    jest.spyOn(svc, 'convertOfficeToPdf').mockResolvedValue(Buffer.from('pdf'));

    await svc.generateForVersion({
      ...base,
      mimeType: 'application/octet-stream',
      fileName: 'policy.docx',
    });

    expect(s3.getObjectBuffer).toHaveBeenCalledWith('documents/doc-1/v2/policy.docx');
  });

  it('uses the provided buffer without a second S3 fetch when supplied', async () => {
    const { svc, s3 } = build();
    jest.spyOn(svc, 'convertOfficeToPdf').mockResolvedValue(Buffer.from('pdf'));

    await svc.generateForVersion({
      ...base,
      mimeType: 'application/octet-stream',
      fileName: 'policy.docx',
      sourceBuffer: Buffer.from('inline'),
    });

    expect(s3.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('routes HTML sources through the Chromium converter', async () => {
    const { svc } = build();
    const html = jest.spyOn(svc, 'convertHtmlToPdf').mockResolvedValue(Buffer.from('pdf'));
    const office = jest.spyOn(svc, 'convertOfficeToPdf');

    const result = await svc.generateForVersion({
      ...base,
      mimeType: 'text/html',
      fileName: 'note.html',
      sourceBuffer: Buffer.from('<h1>hi</h1>'),
    });

    expect(html).toHaveBeenCalledWith('<h1>hi</h1>');
    expect(office).not.toHaveBeenCalled();
    expect(result.strategy).toBe('html');
  });

  it('does NOT call Gotenberg for a PDF source (passthrough → null)', async () => {
    const { svc, s3 } = build();
    const office = jest.spyOn(svc, 'convertOfficeToPdf');
    const html = jest.spyOn(svc, 'convertHtmlToPdf');

    const result = await svc.generateForVersion({
      ...base,
      mimeType: 'application/pdf',
      fileName: 'already.pdf',
      sourceBuffer: Buffer.from('%PDF'),
    });

    expect(office).not.toHaveBeenCalled();
    expect(html).not.toHaveBeenCalled();
    expect(s3.putObject).not.toHaveBeenCalled();
    expect(result).toEqual({ renditionS3Key: null, strategy: 'passthrough' });
  });

  it('does NOT call Gotenberg for an image source (native → null)', async () => {
    const { svc, s3 } = build();
    const result = await svc.generateForVersion({
      ...base,
      mimeType: 'image/png',
      fileName: 'scan.png',
      sourceBuffer: Buffer.from('PNG'),
    });
    expect(s3.putObject).not.toHaveBeenCalled();
    expect(result).toEqual({ renditionS3Key: null, strategy: 'image' });
  });

  it('is best-effort: a conversion failure yields null and never throws', async () => {
    const { svc, s3 } = build();
    jest.spyOn(svc, 'convertOfficeToPdf').mockRejectedValue(new Error('gotenberg down'));

    const result = await svc.generateForVersion({
      ...base,
      mimeType: 'application/octet-stream',
      fileName: 'policy.docx',
      sourceBuffer: Buffer.from('bytes'),
    });

    expect(result).toEqual({ renditionS3Key: null, strategy: 'office' });
    // Storage was never reached because conversion failed first.
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  it('is best-effort: a storage failure after conversion yields null', async () => {
    const s3 = makeS3();
    s3.putObject.mockRejectedValue(new Error('s3 down'));
    const { svc } = build(s3);
    jest.spyOn(svc, 'convertOfficeToPdf').mockResolvedValue(Buffer.from('pdf'));

    const result = await svc.generateForVersion({
      ...base,
      mimeType: 'application/octet-stream',
      fileName: 'policy.docx',
      sourceBuffer: Buffer.from('bytes'),
    });

    expect(result.renditionS3Key).toBeNull();
  });
});

describe('RenditionService Gotenberg HTTP contract', () => {
  const okPdf = () =>
    ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from(Buffer.from('%PDF-1.7')).buffer,
      text: async () => '',
    }) as unknown as Response;

  afterEach(() => jest.restoreAllMocks());

  it('POSTs the Office file to the LibreOffice route with the extension preserved', async () => {
    const { svc } = build();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okPdf());

    const pdf = await svc.convertOfficeToPdf(Buffer.from('bytes'), 'my policy.docx');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://goten.local/forms/libreoffice/convert');
    expect((init as RequestInit).method).toBe('POST');
    const form = (init as RequestInit).body as FormData;
    const part = form.get('files') as File;
    expect(part).toBeInstanceOf(Blob);
    // Extension preserved so LibreOffice detects the source format.
    expect((part as File).name).toBe('my_policy.docx');
    expect(pdf.toString()).toBe('%PDF-1.7');
  });

  it('POSTs HTML to the Chromium route as index.html', async () => {
    const { svc } = build();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okPdf());

    await svc.convertHtmlToPdf('<h1>hi</h1>');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://goten.local/forms/chromium/convert/html');
    const form = (init as RequestInit).body as FormData;
    expect((form.get('files') as File).name).toBe('index.html');
  });

  it('throws on a non-OK Gotenberg response (so generateForVersion can catch it)', async () => {
    const { svc } = build();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    } as unknown as Response);

    await expect(svc.convertHtmlToPdf('<p>x</p>')).rejects.toThrow(/503/);
  });
});
