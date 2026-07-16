import { Injectable } from '@nestjs/common';

/**
 * A detected structural boundary in a document's flat extracted text.
 *
 * The detector is deliberately GENERIC and document-type-neutral: it recognizes
 * the *shapes* of headings/identifiers common across policy manuals, SOPs,
 * handbooks, contracts, and regulations — never a specific organization's policy
 * numbers or formatting. A line that matches no pattern is not a heading; a
 * document whose text matches nothing at all yields zero headings and falls back
 * to plain token chunking (see ChunkingService).
 */
export interface DetectedHeading {
  /** Character offset in the source text where this heading's line begins. */
  offset: number;
  /** The raw heading line, trimmed. */
  rawLine: string;
  /**
   * Coarse, type-neutral class of the heading, derived from the matched shape:
   * 'policy' | 'sop' | 'procedure' | 'article' | 'clause' | 'section' |
   * 'chapter' | 'appendix' | 'regulation' | 'heading'. Never an enum — stored as
   * a free string on the chunk.
   */
  sectionType: string;
  /** Raw identifier as printed ("705", "SOP-0045", "8.3", "IV", "42 CFR Part 2"). */
  sectionIdentifier: string | null;
  /** Folded identifier for exact lookup ("sop-0045", "8.3", "4" for "IV"). */
  normalizedSectionIdentifier: string | null;
  /** The human title following the identifier on the same line, if any. */
  sectionTitle: string | null;
  /**
   * Nesting depth (0 = top level). Derived from the heading class and, for dotted
   * numeric identifiers, the number of dotted components — so "8.3.1" nests under
   * "8.3" under "8". Used to build each chunk's root→leaf headingPath breadcrumb.
   */
  level: number;
}

/** A contiguous structural unit: a heading and the body text beneath it. */
export interface StructuralSegment {
  /** The heading that opens this segment, or null for a leading pre-heading preamble. */
  heading: DetectedHeading | null;
  /** Root→leaf breadcrumb of headings enclosing this segment (identifiers/titles). */
  headingPath: string[];
  /** The segment's text (heading line + body), sliced from the source. */
  text: string;
  /** Character offset of the segment start in the source text. */
  start: number;
  /** Character offset of the segment end (exclusive) in the source text. */
  end: number;
}

/**
 * Roman-numeral → arabic, for folding "Article IV" → "4". Covers 1–39, which is
 * far beyond any realistic article/section count; unknown forms return null so we
 * never guess.
 */
const ROMAN_MAP: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
  xxi: 21, xxii: 22, xxiii: 23, xxiv: 24, xxv: 25, xxvi: 26, xxvii: 27, xxviii: 28, xxix: 29, xxx: 30,
};

/**
 * A generic heading pattern. `test` runs against a single trimmed line; on a
 * match it returns the structural fields. Patterns are tried in order of
 * specificity — the FIRST match wins, so a more specific shape (SOP-0045,
 * 42 CFR Part 2) is checked before the generic "Section N" / bare-number forms.
 *
 * CRITICAL: these match SHAPES, never a hardcoded identifier value. "Policy 705"
 * and "Policy 610" match the same rule; no policy number is baked in.
 */
interface HeadingRule {
  readonly name: string;
  readonly sectionType: string;
  readonly regex: RegExp;
  /** Extracts (identifier, title) from the match groups. */
  readonly extract: (m: RegExpMatchArray) => { identifier: string | null; title: string | null };
  /** Computes nesting level from the identifier (dotted depth) or a fixed base. */
  readonly level: (identifier: string | null) => number;
}

/** Dotted-numeric depth: "8" → 0, "8.3" → 1, "8.3.1" → 2 (capped for sanity). */
function dottedLevel(identifier: string | null, base = 0): number {
  if (!identifier) return base;
  const dots = (identifier.match(/\./g) ?? []).length;
  return Math.min(base + dots, 8);
}

/** A short trailing title, cleaned of leading punctuation/dashes. */
function cleanTitle(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.replace(/^[\s:.\-–—]+/, '').trim();
  return t.length > 0 ? t : null;
}

const HEADING_RULES: readonly HeadingRule[] = [
  // Regulatory citations, e.g. "42 CFR Part 2", "21 CFR 1301.11". Highly specific,
  // checked first so the leading number isn't mistaken for a bare section number.
  {
    name: 'regulation-cfr',
    sectionType: 'regulation',
    regex: /^(\d{1,3}\s+CFR(?:\s+Part)?\s+[\d.]+(?:\([a-z0-9]+\))*)\b[\s:.\-–—]*(.*)$/i,
    extract: (m) => ({ identifier: m[1].replace(/\s+/g, ' ').trim(), title: cleanTitle(m[2]) }),
    level: () => 0,
  },
  // Labeled identifiers with an explicit keyword: Policy 705, Policy 826A,
  // SOP-0045, Procedure HR-102, Form 12-B, Standard 3.2. The keyword sets the
  // type; the identifier is alphanumeric with optional separators. The keyword is
  // CASE-SENSITIVE-capitalized (real headings capitalize it) so lowercase prose
  // like "policy of the company applies" is not misread as a heading. `group2`
  // captures any keyword→id joiner ("-"/" "/":") so a SELF-LABELED id like
  // "SOP-0045" keeps its full form rather than dropping the "SOP-" prefix.
  {
    name: 'labeled-identifier',
    sectionType: 'labeled', // replaced per-keyword below via keywordType()
    regex:
      /^(Policy|Procedure|SOP|Standard|Form|Directive|Instruction|Guideline|Bulletin|Protocol)([#:\s-]*)([A-Za-z]{0,4}-?\d+[A-Za-z0-9.-]*)\b[\s:.\-–—]*(.*)$/,
    extract: (m) => {
      const keyword = m[1];
      const joiner = m[2] ?? '';
      const idPart = m[3].trim();
      // If the keyword is hyphenated directly onto the id (SOP-0045, HR-102 style),
      // the keyword+id together ARE the identifier; keep it whole.
      const hyphenJoined = joiner.includes('-') || /^-/.test(m[2] ?? '');
      const identifier = hyphenJoined
        ? `${keyword}-${idPart}`
        : `${capitalize(keyword)} ${idPart}`.replace(/\s+/g, ' ');
      return { identifier, title: cleanTitle(m[4]) };
    },
    level: () => 0,
  },
  // Chapter N / Chapter Seven — chapters are top-level containers. Case-sensitive
  // "Chapter" (capitalized) so lowercase "chapter body" prose is not a heading.
  {
    name: 'chapter',
    sectionType: 'chapter',
    regex: /^Chapter\s+([0-9]+|[A-Z][a-z]+)\b[\s:.\-–—]*(.*)$/,
    extract: (m) => ({ identifier: m[1].trim(), title: cleanTitle(m[2]) }),
    level: () => 0,
  },
  // Article IV / Article 4 — common in contracts and bylaws. Case-sensitive keyword;
  // numeral is Roman (upper) or arabic.
  {
    name: 'article',
    sectionType: 'article',
    regex: /^Article\s+([IVXLC]+|\d+)\b[\s:.\-–—]*(.*)$/,
    extract: (m) => ({ identifier: m[1].trim(), title: cleanTitle(m[2]) }),
    level: () => 0,
  },
  // Appendix A / Appendix 1 / Annex B / Exhibit C / Schedule 2. Case-sensitive keyword.
  {
    name: 'appendix',
    sectionType: 'appendix',
    regex: /^(?:Appendix|Annex|Exhibit|Schedule)\s+([A-Za-z0-9]+)\b[\s:.\-–—]*(.*)$/,
    extract: (m) => ({ identifier: m[1].trim(), title: cleanTitle(m[2]) }),
    level: () => 0,
  },
  // Explicit "Section 504", "Section 8.3", "§ 8.3". Case-sensitive keyword so
  // mid-sentence "see section 8" prose is not a heading.
  {
    name: 'section',
    sectionType: 'section',
    regex: /^(?:Section|Sec\.|§)\s*([0-9]+(?:\.[0-9]+)*[A-Za-z]?)\b[\s:.\-–—]*(.*)$/,
    extract: (m) => ({ identifier: m[1].trim(), title: cleanTitle(m[2]) }),
    level: (id) => dottedLevel(id),
  },
  // Explicit "Clause 8.3". Case-sensitive keyword.
  {
    name: 'clause',
    sectionType: 'clause',
    regex: /^Clause\s+([0-9]+(?:\.[0-9]+)*[A-Za-z]?)\b[\s:.\-–—]*(.*)$/,
    extract: (m) => ({ identifier: m[1].trim(), title: cleanTitle(m[2]) }),
    level: (id) => dottedLevel(id),
  },
  // Bare dotted-decimal outline heading at line start: "8.3 Title", "705.3 Title",
  // "1.2.4 Title". Requires a following title word so we don't match a stray
  // numeric list value or a decimal in prose. Type 'section' (generic).
  {
    name: 'numbered-outline',
    sectionType: 'section',
    regex: /^(\d+(?:\.\d+)+)\s+(\S.*)$/,
    extract: (m) => ({ identifier: m[1].trim(), title: cleanTitle(m[2]) }),
    level: (id) => dottedLevel(id, 0),
  },
  // A bare integer + Title-Case title, e.g. "705 Seclusion And Restraint",
  // "7 Overview". Conservative: requires the title to start with an uppercase
  // letter, so numbered list items ("3 apples") don't match.
  {
    name: 'numbered-heading',
    sectionType: 'section',
    regex: /^(\d{1,4}[A-Za-z]?)\s+([A-Z][^\n]{0,120})$/,
    extract: (m) => ({ identifier: m[1].trim(), title: cleanTitle(m[2]) }),
    level: () => 0,
  },
  // ALL-CAPS title line (no identifier): "GENERAL PROVISIONS", "PURPOSE". A common
  // heading style in handbooks/manuals with no numbering. Kept last so numbered
  // shapes win. No identifier — pure title heading.
  {
    name: 'allcaps-title',
    sectionType: 'heading',
    regex: /^([A-Z][A-Z0-9 ,'&/()\-]{3,80})$/,
    extract: (m) => ({ identifier: null, title: cleanTitle(m[1]) }),
    level: () => 1,
  },
];

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/** Map a matched labeled keyword to a section type (SOP→sop, Procedure→procedure…). */
function keywordType(identifier: string): string {
  // The keyword is the leading run of letters, whether space-joined ("Policy 705")
  // or hyphen-joined onto the id ("SOP-0045" → "SOP", "Procedure HR-102" → "Procedure").
  const kw = (identifier.match(/^[A-Za-z]+/)?.[0] ?? '').toLowerCase();
  if (kw === 'sop') return 'sop';
  if (kw === 'procedure') return 'procedure';
  if (kw === 'policy') return 'policy';
  if (kw === 'form') return 'form';
  if (kw === 'standard') return 'standard';
  if (kw === 'protocol') return 'protocol';
  if (kw === 'guideline') return 'guideline';
  if (kw === 'directive') return 'directive';
  return 'policy';
}

/**
 * Detects generic structural boundaries in flat extracted text and segments the
 * text into structural units. PURE and DETERMINISTIC — no clock, no randomness,
 * no external state — so it is trivially unit-testable and reproducible.
 *
 * Design constraints (from the multi-document requirements):
 *  - Document-type-NEUTRAL: recognizes heading/identifier SHAPES, never a specific
 *    organization's policy numbers, titles, or formatting.
 *  - Degrades safely: text with no recognizable structure yields ZERO headings,
 *    so the caller falls back to plain token chunking (unstructured support).
 *  - Never merges sections: segment boundaries are exactly the detected heading
 *    offsets, so a segment contains one unit's text and stops at the next heading.
 */
@Injectable()
export class StructureDetectorService {
  /**
   * Fold a raw identifier to a canonical form for exact lookup:
   *  - lowercased and whitespace-collapsed,
   *  - a bare Roman numeral ("IV") → arabic ("4"),
   *  - a "Keyword 705" labeled id → the keyword + number ("policy 705"),
   *  - CFR citations normalized to "42 cfr part 2".
   * Returns null for a null/empty identifier. Never throws.
   */
  normalizeIdentifier(identifier: string | null | undefined): string | null {
    if (!identifier) return null;
    const raw = identifier.trim().toLowerCase().replace(/\s+/g, ' ');
    if (raw.length === 0) return null;

    // Bare Roman numeral (possibly the whole id): fold to arabic.
    const roman = ROMAN_MAP[raw];
    if (roman !== undefined) return String(roman);

    // "article iv" / "section iv" → keep the keyword, fold the numeral.
    const parts = raw.split(' ');
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (ROMAN_MAP[last] !== undefined) {
        return [...parts.slice(0, -1), String(ROMAN_MAP[last])].join(' ');
      }
    }
    return raw;
  }

  /**
   * Test a single trimmed line against the generic heading rules. Returns the
   * detected heading fields (identifier/title/type/level) or null if the line is
   * not a heading. Exposed for unit testing of the rule set.
   */
  matchHeadingLine(line: string): Omit<DetectedHeading, 'offset' | 'rawLine'> | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    for (const rule of HEADING_RULES) {
      const m = trimmed.match(rule.regex);
      if (!m) continue;
      const { identifier, title } = rule.extract(m);
      // A heading must yield SOMETHING to anchor on — an identifier or a title.
      if (!identifier && !title) continue;
      const sectionType =
        rule.name === 'labeled-identifier' && identifier ? keywordType(identifier) : rule.sectionType;
      return {
        sectionType,
        sectionIdentifier: identifier,
        normalizedSectionIdentifier: this.normalizeIdentifier(identifier),
        sectionTitle: title,
        level: rule.level(identifier),
      };
    }
    return null;
  }

  /**
   * Scan `text` line-by-line and return every detected heading with its source
   * offset, in document order. A heading line must be reasonably short (headings
   * are not paragraphs) — long lines are treated as body even if they'd match a
   * pattern, which prevents a sentence beginning "Section 8 applies…" from being
   * misread as a heading.
   */
  detectHeadings(text: string): DetectedHeading[] {
    const headings: DetectedHeading[] = [];
    const MAX_HEADING_LEN = 140;
    let offset = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length <= MAX_HEADING_LEN) {
        const match = this.matchHeadingLine(trimmed);
        if (match) {
          headings.push({ offset, rawLine: trimmed, ...match });
        }
      }
      // +1 for the '\n' consumed by split. Correct for the last line too (the
      // extra +1 is never used because there is no line after it).
      offset += line.length + 1;
    }
    return headings;
  }

  /**
   * Segment `text` into structural units using the detected headings as cut
   * points, and compute each segment's root→leaf heading breadcrumb from the
   * heading `level` stack. A leading run of text before the first heading becomes
   * a headingless preamble segment (so nothing is dropped). Returns a single
   * whole-text segment (heading null, empty path) when no headings are detected —
   * the unstructured fallback signal for the caller.
   */
  segment(text: string): StructuralSegment[] {
    const headings = this.detectHeadings(text);
    if (headings.length === 0) {
      return [{ heading: null, headingPath: [], text, start: 0, end: text.length }];
    }

    const segments: StructuralSegment[] = [];

    // Preamble before the first heading (if any non-whitespace exists there).
    if (headings[0].offset > 0 && text.slice(0, headings[0].offset).trim().length > 0) {
      segments.push({
        heading: null,
        headingPath: [],
        text: text.slice(0, headings[0].offset),
        start: 0,
        end: headings[0].offset,
      });
    }

    // A stack of enclosing headings for building breadcrumbs. `label` prefers the
    // identifier, else the title, so the path reads like ["Chapter 7","705","705.3"].
    // Nesting is CONTEXT-AWARE, not level-absolute: a heading nests under the stack
    // top only if it is a genuine child (a dotted extension like "8.3.1" under "8.3",
    // or any heading under a CONTAINER like a chapter/article/appendix). Two sibling
    // top-level units (Policy 705 then Clause 8.3 in a flat manual) do NOT nest, so a
    // clause never lands under an unrelated policy.
    const stack: DetectedHeading[] = [];

    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const start = h.offset;
      const end = i + 1 < headings.length ? headings[i + 1].offset : text.length;

      // Pop the stack until the top is a valid PARENT of h (or the stack is empty).
      while (stack.length > 0 && !this.isChildOf(h, stack[stack.length - 1])) {
        stack.pop();
      }
      stack.push(h);
      const headingPath = stack.map((s) => s.sectionIdentifier ?? s.sectionTitle ?? s.rawLine);

      segments.push({
        heading: h,
        headingPath,
        text: text.slice(start, end),
        start,
        end,
      });
    }

    return segments;
  }

  /**
   * Is `child` a genuine structural descendant of `parent`? True when either:
   *  - the parent is a CONTAINER (chapter/article/appendix/part) and the child is
   *    not itself a container — containers hold heterogeneous children; or
   *  - the child's dotted identifier extends the parent's ("8.3.1" under "8.3",
   *    "705.3" under "705").
   * Otherwise they are siblings/unrelated top-level units and must not nest.
   */
  private isChildOf(child: DetectedHeading, parent: DetectedHeading): boolean {
    const CONTAINER = new Set(['chapter', 'article', 'appendix', 'part']);
    if (CONTAINER.has(parent.sectionType) && !CONTAINER.has(child.sectionType)) {
      return true;
    }
    const p = parent.sectionIdentifier;
    const c = child.sectionIdentifier;
    if (p && c && /^\d+(?:\.\d+)*$/.test(p) && /^\d+(?:\.\d+)*$/.test(c)) {
      return c.startsWith(`${p}.`);
    }
    return false;
  }
}
