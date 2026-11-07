import type { CheatFinding, CheatSeverity, TrustGrade } from './cheat.js';
import { clamp } from './common.js';
import type { UnderstandingStatus } from './understanding.js';

export const CHEAT_SEVERITY_POINTS: Readonly<Record<CheatSeverity, number>> = {
  low: 4,
  medium: 9,
  high: 17,
  critical: 28,
};

export interface TrustDeduction {
  category: CheatFinding['category'];
  points: number;
  findingCount: number;
}

export interface TrustScoreResult {
  score: number;
  grade: TrustGrade;
  deductions: TrustDeduction[];
  findingCount: number;
  evidenceCount: number;
  filesAffected: number;
}

function gradeForScore(score: number): TrustGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Score agent output from deterministic cheat findings. Confidence scales each
 * finding's deduction so a weak signal can never tank the session on its own.
 */
export function computeTrustScore(findings: readonly CheatFinding[]): TrustScoreResult {
  const grouped = new Map<CheatFinding['category'], TrustDeduction>();
  const files = new Set<string>();
  let evidenceCount = 0;
  let rawDeduction = 0;

  for (const finding of findings) {
    const points = CHEAT_SEVERITY_POINTS[finding.severity] * clamp(finding.confidence, 0, 1);
    rawDeduction += points;
    const existing = grouped.get(finding.category);
    grouped.set(finding.category, {
      category: finding.category,
      points: (existing?.points ?? 0) + points,
      findingCount: (existing?.findingCount ?? 0) + 1,
    });
    evidenceCount += finding.evidence.length;
    for (const evidence of finding.evidence) {
      files.add(evidence.filePath);
    }
  }

  const score = Math.round(clamp(100 - rawDeduction, 0, 100));
  const deductions = [...grouped.values()]
    .map((entry) => ({ ...entry, points: Math.round(entry.points * 10) / 10 }))
    .sort((a, b) => b.points - a.points);

  return {
    score,
    grade: gradeForScore(score),
    deductions,
    findingCount: findings.length,
    evidenceCount,
    filesAffected: files.size,
  };
}

export interface UnderstandingFileInput {
  path: string;
  aiLines: number;
  reviewedLines: number;
  status: UnderstandingStatus;
}

export interface UnderstandingHotspot {
  path: string;
  status: UnderstandingStatus;
  aiLines: number;
  unreviewedLines: number;
  fileScore: number;
}

export interface UnderstandingDebtResult {
  reviewedPercent: number;
  debtPercent: number;
  totalAiLines: number;
  reviewedAiLines: number;
  fileCount: number;
  unseenFiles: number;
  acknowledgedFiles: number;
  neverReviewedHotspots: UnderstandingHotspot[];
  hotspots: UnderstandingHotspot[];
}

function reviewedLinesFor(file: UnderstandingFileInput): number {
  const bounded = clamp(Math.trunc(file.reviewedLines), 0, Math.max(0, file.aiLines));
  if (file.status === 'acknowledged') {
    return Math.max(0, file.aiLines);
  }
  if (file.status === 'unseen') {
    return 0;
  }
  return bounded;
}

export function scoreUnderstandingFile(file: UnderstandingFileInput): number {
  if (file.aiLines <= 0) {
    return 100;
  }
  return Math.round((reviewedLinesFor(file) / file.aiLines) * 100);
}

/**
 * Understanding debt is the share of AI-written lines the user has not
 * reviewed. Files are weighted by AI line count, not counted equally, because a
 * 600-line generated service deserves more scrutiny than a 3-line import.
 */
export function computeUnderstandingDebt(
  files: readonly UnderstandingFileInput[],
): UnderstandingDebtResult {
  let totalAiLines = 0;
  let reviewedAiLines = 0;
  let unseenFiles = 0;
  let acknowledgedFiles = 0;
  const hotspots: UnderstandingHotspot[] = [];

  for (const file of files) {
    const aiLines = Math.max(0, file.aiLines);
    const reviewed = reviewedLinesFor(file);
    totalAiLines += aiLines;
    reviewedAiLines += reviewed;

    if (file.status === 'unseen') unseenFiles += 1;
    if (file.status === 'acknowledged') acknowledgedFiles += 1;

    const unreviewedLines = Math.max(0, aiLines - reviewed);
    hotspots.push({
      path: file.path,
      status: file.status,
      aiLines,
      unreviewedLines,
      fileScore: scoreUnderstandingFile(file),
    });
  }

  const reviewedPercent =
    totalAiLines === 0 ? 100 : Math.round((reviewedAiLines / totalAiLines) * 1000) / 10;
  const debtPercent = Math.round((100 - reviewedPercent) * 10) / 10;
  const sortedHotspots = hotspots
    .filter((file) => file.unreviewedLines > 0)
    .sort((a, b) => b.unreviewedLines - a.unreviewedLines || a.path.localeCompare(b.path));

  return {
    reviewedPercent,
    debtPercent,
    totalAiLines,
    reviewedAiLines,
    fileCount: files.length,
    unseenFiles,
    acknowledgedFiles,
    neverReviewedHotspots: sortedHotspots.filter((file) => file.status === 'unseen'),
    hotspots: sortedHotspots,
  };
}
