import { describe, expect, it } from 'vitest';

import {
  computeTrustScore,
  computeUnderstandingDebt,
  scoreUnderstandingFile,
  type CheatFinding,
  type UnderstandingFileInput,
} from '../src/index.js';
import { createId } from '../src/ids.js';

function finding(overrides: Partial<CheatFinding>): CheatFinding {
  return {
    id: createId(),
    sessionId: createId(),
    category: 'skipped_test',
    severity: 'high',
    title: 'Test skipped',
    detail: 'A test was skipped instead of fixed.',
    detector: 'test-cheat',
    confidence: 1,
    evidence: [
      {
        filePath: 'src/feature.test.ts',
        startLine: 12,
        excerpt: 'it.skip("handles overflow", () => {})',
      },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const file = (overrides: Partial<UnderstandingFileInput>): UnderstandingFileInput => ({
  path: 'src/feature.ts',
  aiLines: 100,
  reviewedLines: 0,
  status: 'unseen',
  ...overrides,
});

describe('computeTrustScore', () => {
  it('starts at a perfect score when there are no findings', () => {
    const result = computeTrustScore([]);
    expect(result.score).toBe(100);
    expect(result.grade).toBe('A');
    expect(result.deductions).toEqual([]);
  });

  it('deducts by severity and confidence', () => {
    const result = computeTrustScore([
      finding({ severity: 'critical', confidence: 1 }),
      finding({ category: 'empty_catch', severity: 'low', confidence: 0.5 }),
    ]);

    expect(result.score).toBe(70);
    expect(result.grade).toBe('C');
    expect(result.findingCount).toBe(2);
    expect(result.filesAffected).toBe(1);
  });

  it('groups deductions by category and sorts them by weight', () => {
    const result = computeTrustScore([
      finding({ category: 'deleted_test', severity: 'critical' }),
      finding({ category: 'deleted_test', severity: 'critical' }),
      finding({ category: 'empty_catch', severity: 'low' }),
    ]);

    expect(result.deductions[0]?.category).toBe('deleted_test');
    expect(result.deductions[0]?.findingCount).toBe(2);
    expect(result.deductions[0]?.points).toBe(56);
  });

  it('supports multiple evidence locations without inflating the deduction', () => {
    const multi = finding({
      evidence: [
        { filePath: 'src/a.ts', excerpt: 'a' },
        { filePath: 'src/b.ts', excerpt: 'b' },
      ],
    });
    const result = computeTrustScore([multi]);
    expect(result.score).toBe(83);
    expect(result.evidenceCount).toBe(2);
    expect(result.filesAffected).toBe(2);
  });
});

describe('understanding debt', () => {
  it('weights debt by AI-written line count', () => {
    const smallReviewed = file({
      path: 'src/small.ts',
      aiLines: 10,
      reviewedLines: 10,
      status: 'acknowledged',
    });
    const largeUnreviewed = file({ path: 'src/large.ts', aiLines: 90, status: 'unseen' });

    const result = computeUnderstandingDebt([smallReviewed, largeUnreviewed]);
    expect(result.reviewedPercent).toBe(10);
    expect(result.debtPercent).toBe(90);
    expect(result.unseenFiles).toBe(1);
    expect(result.neverReviewedHotspots[0]?.path).toBe('src/large.ts');
  });

  it('only counts acknowledged files as fully reviewed', () => {
    const opened = file({ status: 'opened', reviewedLines: 40 });
    const acknowledged = file({
      path: 'src/ack.ts',
      aiLines: 60,
      reviewedLines: 0,
      status: 'acknowledged',
    });

    expect(scoreUnderstandingFile(opened)).toBe(40);
    expect(scoreUnderstandingFile(acknowledged)).toBe(100);

    const result = computeUnderstandingDebt([opened, acknowledged]);
    expect(result.reviewedAiLines).toBe(100);
    expect(result.debtPercent).toBe(37.5);
    expect(result.hotspots[0]?.path).toBe('src/feature.ts');
    expect(result.acknowledgedFiles).toBe(1);
  });

  it('reports a clean slate when no AI lines are tracked', () => {
    const result = computeUnderstandingDebt([]);
    expect(result.reviewedPercent).toBe(100);
    expect(result.debtPercent).toBe(0);
    expect(result.fileCount).toBe(0);
  });

  it('clamps inconsistent reviewed counts to the file size', () => {
    const impossible = file({ status: 'opened', aiLines: 10, reviewedLines: 500 });
    expect(scoreUnderstandingFile(impossible)).toBe(100);
    const result = computeUnderstandingDebt([impossible]);
    expect(result.hotspots).toEqual([]);
  });
});
