import { buildLineDiff } from './document-compare.util';

describe('buildLineDiff', () => {
  it('marks unchanged, removed, changed, and added lines in order', () => {
    const hunks = buildLineDiff(
      ['Policy title', 'Staff must sign annually.', 'Old restraint rule.'].join('\n'),
      [
        'Policy title',
        'Staff must sign quarterly.',
        'New restraint rule.',
        'Added evidence note.',
      ].join('\n'),
    );

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

  it('returns a text-unavailable marker when both versions are empty', () => {
    expect(buildLineDiff('', '')).toEqual([]);
  });
});
