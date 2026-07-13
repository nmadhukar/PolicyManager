import { buildLineDiff, MAX_DIFF_LINES } from './document-compare.util';

describe('buildLineDiff', () => {
  it('marks unchanged, removed, changed, and added lines in order', () => {
    const { hunks, truncated } = buildLineDiff(
      ['Policy title', 'Staff must sign annually.', 'Old restraint rule.'].join('\n'),
      [
        'Policy title',
        'Staff must sign quarterly.',
        'New restraint rule.',
        'Added evidence note.',
      ].join('\n'),
    );

    expect(truncated).toBe(false);
    expect(hunks).toEqual([
      { type: 'unchanged', oldLine: 1, newLine: 1, oldText: 'Policy title', newText: 'Policy title' },
      {
        type: 'changed',
        oldLine: 2,
        newLine: 2,
        oldText: 'Staff must sign annually.',
        newText: 'Staff must sign quarterly.',
      },
      {
        type: 'changed',
        oldLine: 3,
        newLine: 3,
        oldText: 'Old restraint rule.',
        newText: 'New restraint rule.',
      },
      { type: 'added', oldLine: null, newLine: 4, oldText: null, newText: 'Added evidence note.' },
    ]);
  });

  it('returns an empty, non-truncated result when both versions are empty', () => {
    expect(buildLineDiff('', '')).toEqual({ hunks: [], truncated: false });
  });

  it('caps very large inputs and flags truncation instead of allocating an O(N*M) matrix', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 500 }, (_, i) => `line ${i}`).join('\n');
    const other = Array.from({ length: MAX_DIFF_LINES + 500 }, (_, i) => `LINE ${i}`).join('\n');
    const { hunks, truncated } = buildLineDiff(big, other);
    expect(truncated).toBe(true);
    // Only the first MAX_DIFF_LINES per side are diffed, so no hunk references a line
    // number beyond the cap.
    for (const h of hunks) {
      if (h.oldLine != null) expect(h.oldLine).toBeLessThanOrEqual(MAX_DIFF_LINES);
      if (h.newLine != null) expect(h.newLine).toBeLessThanOrEqual(MAX_DIFF_LINES);
    }
  });
});
