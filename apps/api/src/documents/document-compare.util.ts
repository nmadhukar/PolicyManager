import type { PolicyDiffHunk } from '@policymanager/shared';

interface TokenLine {
  text: string;
  line: number;
}

/** Normalizes extracted text for a stable paragraph/line redline. */
function tokenize(text: string | null | undefined): TokenLine[] {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line, index) => ({ text: line.trimEnd(), line: index + 1 }))
    .filter((line) => line.text.trim().length > 0);
}

/**
 * Deterministic line-level LCS diff. Adjacent remove+add pairs are collapsed into
 * `changed` hunks so reviewers see edits instead of two unrelated operations.
 */
export function buildLineDiff(oldText: string | null | undefined, newText: string | null | undefined): PolicyDiffHunk[] {
  const oldLines = tokenize(oldText);
  const newLines = tokenize(newText);
  if (oldLines.length === 0 && newLines.length === 0) return [];

  const dp = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i].text === newLines[j].text
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const raw: PolicyDiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (oldLine.text === newLine.text) {
      raw.push({
        type: 'unchanged',
        oldLine: oldLine.line,
        newLine: newLine.line,
        oldText: oldLine.text,
        newText: newLine.text,
      });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({
        type: 'removed',
        oldLine: oldLine.line,
        newLine: null,
        oldText: oldLine.text,
        newText: null,
      });
      i += 1;
    } else {
      raw.push({
        type: 'added',
        oldLine: null,
        newLine: newLine.line,
        oldText: null,
        newText: newLine.text,
      });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    raw.push({
      type: 'removed',
      oldLine: oldLines[i].line,
      newLine: null,
      oldText: oldLines[i].text,
      newText: null,
    });
    i += 1;
  }
  while (j < newLines.length) {
    raw.push({
      type: 'added',
      oldLine: null,
      newLine: newLines[j].line,
      oldText: null,
      newText: newLines[j].text,
    });
    j += 1;
  }
  return collapseChanged(raw);
}

function collapseChanged(raw: PolicyDiffHunk[]): PolicyDiffHunk[] {
  const out: PolicyDiffHunk[] = [];
  let i = 0;
  while (i < raw.length) {
    const cur = raw[i];
    if (cur.type === 'unchanged') {
      out.push(cur);
      i += 1;
      continue;
    }

    const removed: PolicyDiffHunk[] = [];
    const added: PolicyDiffHunk[] = [];
    while (raw[i]?.type === 'removed') {
      removed.push(raw[i]);
      i += 1;
    }
    while (raw[i]?.type === 'added') {
      added.push(raw[i]);
      i += 1;
    }

    const paired = Math.min(removed.length, added.length);
    for (let j = 0; j < paired; j += 1) {
      out.push({
        type: 'changed',
        oldLine: removed[j].oldLine,
        newLine: added[j].newLine,
        oldText: removed[j].oldText,
        newText: added[j].newText,
      });
    }
    for (let j = paired; j < removed.length; j += 1) {
      out.push(removed[j]);
    }
    for (let j = paired; j < added.length; j += 1) {
      out.push(added[j]);
    }
  }
  return out;
}
