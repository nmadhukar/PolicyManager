import { StructureDetectorService } from './structure-detector.service';

describe('StructureDetectorService', () => {
  const svc = new StructureDetectorService();

  describe('normalizeIdentifier', () => {
    it('returns null for null/empty/whitespace', () => {
      expect(svc.normalizeIdentifier(null)).toBeNull();
      expect(svc.normalizeIdentifier(undefined)).toBeNull();
      expect(svc.normalizeIdentifier('')).toBeNull();
      expect(svc.normalizeIdentifier('   ')).toBeNull();
    });

    it('lowercases and collapses whitespace', () => {
      expect(svc.normalizeIdentifier('SOP-0045')).toBe('sop-0045');
      expect(svc.normalizeIdentifier('  Policy   705 ')).toBe('policy 705');
    });

    it('folds a bare Roman numeral to arabic', () => {
      expect(svc.normalizeIdentifier('IV')).toBe('4');
      expect(svc.normalizeIdentifier('vii')).toBe('7');
      expect(svc.normalizeIdentifier('XII')).toBe('12');
    });

    it('folds a trailing Roman numeral after a keyword', () => {
      expect(svc.normalizeIdentifier('Article IV')).toBe('article 4');
      expect(svc.normalizeIdentifier('Section IX')).toBe('section 9');
    });

    it('leaves dotted-decimal and alphanumeric identifiers intact (lowercased)', () => {
      expect(svc.normalizeIdentifier('8.3')).toBe('8.3');
      expect(svc.normalizeIdentifier('826A')).toBe('826a');
      expect(svc.normalizeIdentifier('HR-102')).toBe('hr-102');
    });

    it('normalizes CFR citations', () => {
      expect(svc.normalizeIdentifier('42 CFR Part 2')).toBe('42 cfr part 2');
    });
  });

  describe('matchHeadingLine — generic, document-type-neutral shapes', () => {
    const cases: Array<[string, { sectionType: string; sectionIdentifier: string | null; normalizedSectionIdentifier: string | null; sectionTitle: string | null }]> = [
      // Policy manuals — numeric AND alphanumeric, NO hardcoded numbers.
      ['Policy 705 Seclusion and Restraint', { sectionType: 'policy', sectionIdentifier: 'Policy 705', normalizedSectionIdentifier: 'policy 705', sectionTitle: 'Seclusion and Restraint' }],
      ['Policy 826A Medication Reconciliation', { sectionType: 'policy', sectionIdentifier: 'Policy 826A', normalizedSectionIdentifier: 'policy 826a', sectionTitle: 'Medication Reconciliation' }],
      ['Policy 1506', { sectionType: 'policy', sectionIdentifier: 'Policy 1506', normalizedSectionIdentifier: 'policy 1506', sectionTitle: null }],
      // Procedure.
      ['Procedure HR-102: Onboarding', { sectionType: 'procedure', sectionIdentifier: 'Procedure HR-102', normalizedSectionIdentifier: 'procedure hr-102', sectionTitle: 'Onboarding' }],
      // Contract clause.
      ['Clause 8.3 Limitation of Liability', { sectionType: 'clause', sectionIdentifier: '8.3', normalizedSectionIdentifier: '8.3', sectionTitle: 'Limitation of Liability' }],
      // Article (Roman).
      ['Article IV Governance', { sectionType: 'article', sectionIdentifier: 'IV', normalizedSectionIdentifier: '4', sectionTitle: 'Governance' }],
      // Chapter.
      ['Chapter 7 Safety', { sectionType: 'chapter', sectionIdentifier: '7', normalizedSectionIdentifier: '7', sectionTitle: 'Safety' }],
      // Section 504 (regulatory-style).
      ['Section 504 Rehabilitation', { sectionType: 'section', sectionIdentifier: '504', normalizedSectionIdentifier: '504', sectionTitle: 'Rehabilitation' }],
      // Regulatory citation.
      ['42 CFR Part 2 Confidentiality', { sectionType: 'regulation', sectionIdentifier: '42 CFR Part 2', normalizedSectionIdentifier: '42 cfr part 2', sectionTitle: 'Confidentiality' }],
      // Appendix.
      ['Appendix B Forms', { sectionType: 'appendix', sectionIdentifier: 'B', normalizedSectionIdentifier: 'b', sectionTitle: 'Forms' }],
      // Dotted outline heading.
      ['3.2.1 Access Reviews', { sectionType: 'section', sectionIdentifier: '3.2.1', normalizedSectionIdentifier: '3.2.1', sectionTitle: 'Access Reviews' }],
      // ALL-CAPS handbook heading (no identifier).
      ['GENERAL PROVISIONS', { sectionType: 'heading', sectionIdentifier: null, normalizedSectionIdentifier: null, sectionTitle: 'GENERAL PROVISIONS' }],
    ];

    it.each(cases)('detects %s', (line, expected) => {
      const m = svc.matchHeadingLine(line);
      expect(m).not.toBeNull();
      expect(m!.sectionType).toBe(expected.sectionType);
      expect(m!.normalizedSectionIdentifier).toBe(expected.normalizedSectionIdentifier);
      if (expected.sectionTitle !== null) {
        expect(m!.sectionTitle).toBe(expected.sectionTitle);
      }
    });

    it('detects SOP-0045 as an sop and keeps the full self-labeled id', () => {
      const m = svc.matchHeadingLine('SOP-0045 Specimen Handling');
      expect(m).not.toBeNull();
      expect(m!.sectionType).toBe('sop');
      expect(m!.sectionIdentifier).toBe('SOP-0045');
      expect(m!.normalizedSectionIdentifier).toBe('sop-0045');
      expect(m!.sectionTitle).toBe('Specimen Handling');
    });

    it('does NOT treat ordinary prose as a heading', () => {
      expect(svc.matchHeadingLine('This section applies to all employees of the organization.')).toBeNull();
      expect(svc.matchHeadingLine('The policy was approved in 2024 by the board.')).toBeNull();
      expect(svc.matchHeadingLine('see section 8 for details')).toBeNull(); // lowercase, mid-sentence shape
      expect(svc.matchHeadingLine('3 apples were purchased')).toBeNull(); // numbered list value, lowercase title
    });

    it('is not hardcoded to any specific policy number (same rule, different numbers)', () => {
      for (const n of ['705', '610', '826A', '1506']) {
        const m = svc.matchHeadingLine(`Policy ${n} Title Here`);
        expect(m).not.toBeNull();
        expect(m!.sectionType).toBe('policy');
        expect(m!.normalizedSectionIdentifier).toBe(`policy ${n.toLowerCase()}`);
      }
    });
  });

  describe('detectHeadings', () => {
    it('finds headings with correct offsets in document order', () => {
      const text = ['Chapter 7 Safety', 'Body of chapter.', '7.1 Purpose', 'Purpose body.'].join('\n');
      const headings = svc.detectHeadings(text);
      expect(headings.map((h) => h.rawLine)).toEqual(['Chapter 7 Safety', '7.1 Purpose']);
      expect(headings[0].offset).toBe(0);
      expect(text.slice(headings[1].offset)).toMatch(/^7\.1 Purpose/);
    });

    it('treats a long line that merely starts like a heading as body (not a heading)', () => {
      const longLine =
        'Section 8 of this agreement, together with all of its subclauses and the accompanying schedules, ' +
        'shall govern the parties in perpetuity and may not be amended except in writing signed by both.';
      expect(svc.detectHeadings(longLine).length).toBe(0);
    });

    it('returns [] for unstructured prose', () => {
      const text = 'Just some free-flowing notes.\n\nNo headings here at all, only sentences and paragraphs.';
      expect(svc.detectHeadings(text)).toEqual([]);
    });

    it('detects a tab-separated cover-page block ("Policy #<tab>705" + "Title<tab>…")', () => {
      // Real-world policy-manual cover layout: the number and title are on separate
      // label/value lines. The identifier is matched inline; the title is adopted
      // from the nearby "Title" line via bounded look-ahead.
      const text = [
        'Administrative Policies',
        'Policy # \t705',
        'Section \tClient Records',
        'Title \tRelease of Information',
        'Date \t01/03/2020',
        'The purpose of this policy is to govern release of client information.',
      ].join('\n');
      const headings = svc.detectHeadings(text);
      const h = headings.find((x) => x.normalizedSectionIdentifier === 'policy 705');
      expect(h).toBeDefined();
      expect(h!.sectionIdentifier).toBe('Policy 705');
      expect(h!.sectionTitle).toBe('Release of Information');
    });
  });

  describe('segment — never merges sections, builds heading breadcrumbs', () => {
    it('returns a single unstructured segment when no headings exist', () => {
      const text = 'Free-form document with no detectable structure whatsoever.';
      const segs = svc.segment(text);
      expect(segs).toHaveLength(1);
      expect(segs[0].heading).toBeNull();
      expect(segs[0].headingPath).toEqual([]);
      expect(segs[0].text).toBe(text);
    });

    it('cuts exactly at heading offsets (no segment spans two headings)', () => {
      const text = [
        'Policy 705 Seclusion',
        'Restraint may only be used as a last resort.',
        'Policy 610 Grievances',
        'Grievances must be filed within thirty days.',
      ].join('\n');
      const segs = svc.segment(text);
      // Two heading segments (no preamble — text starts with a heading).
      expect(segs).toHaveLength(2);
      expect(segs[0].heading!.sectionIdentifier).toBe('Policy 705');
      expect(segs[1].heading!.sectionIdentifier).toBe('Policy 610');
      // Segment 0 contains ONLY 705's content — never 610's heading or body.
      expect(segs[0].text).toContain('last resort');
      expect(segs[0].text).not.toContain('Policy 610');
      expect(segs[0].text).not.toContain('thirty days');
    });

    it('captures a leading preamble before the first heading', () => {
      const text = ['Table of contents and front matter.', 'Chapter 1 Introduction', 'Intro body.'].join('\n');
      const segs = svc.segment(text);
      expect(segs[0].heading).toBeNull();
      expect(segs[0].text).toContain('front matter');
      expect(segs[1].heading!.sectionType).toBe('chapter');
    });

    it('builds a root→leaf breadcrumb from nesting levels', () => {
      const text = [
        'Chapter 7 Safety', // level 0
        'chapter body',
        'Section 7.1 Controls', // section, dotted depth 1
        'controls body',
        'Section 7.1.2 Access', // deeper
        'access body',
      ].join('\n');
      const segs = svc.segment(text).filter((s) => s.heading);
      expect(segs[0].headingPath).toEqual(['7']);
      expect(segs[1].headingPath).toEqual(['7', '7.1']);
      expect(segs[2].headingPath).toEqual(['7', '7.1', '7.1.2']);
    });

    it('pops sibling levels so two same-level sections do not nest under each other', () => {
      const text = ['Article I Definitions', 'a', 'Article II Term', 'b'].join('\n');
      const segs = svc.segment(text).filter((s) => s.heading);
      expect(segs[0].headingPath).toEqual(['I']);
      // Article II is a sibling of Article I, not a child.
      expect(segs[1].headingPath).toEqual(['II']);
    });

    it('does NOT nest a dotted clause under an unrelated sibling policy/SOP (context-aware)', () => {
      // A flat manual: three unrelated top-level units. A Clause 8.3 must NOT nest
      // under SOP-0045 just because it has a dotted number — they are siblings.
      const text = [
        'Policy 705 Seclusion', 'a',
        'SOP-0045 Handling', 'b',
        'Clause 8.3 Liability', 'c',
      ].join('\n');
      const segs = svc.segment(text).filter((s) => s.heading);
      expect(segs[0].headingPath).toEqual(['Policy 705']);
      expect(segs[1].headingPath).toEqual(['SOP-0045']);
      expect(segs[2].headingPath).toEqual(['8.3']); // sibling, NOT ['SOP-0045','8.3']
    });

    it('nests a non-container heading under a container (chapter) and dotted extensions deeper', () => {
      const text = [
        'Chapter 7 Safety', 'intro',
        'Section 7.1 Controls', 'x',
        '7.1.2 Access', 'y',
      ].join('\n');
      const segs = svc.segment(text).filter((s) => s.heading);
      expect(segs[0].headingPath).toEqual(['7']);
      expect(segs[1].headingPath).toEqual(['7', '7.1']); // section under chapter
      expect(segs[2].headingPath).toEqual(['7', '7.1', '7.1.2']); // dotted extension
    });
  });
});
