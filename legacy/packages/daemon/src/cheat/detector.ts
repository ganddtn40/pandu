import {
  computeTrustScore,
  createId,
  type CheatAnalysis,
  type CheatCategory,
  type CheatEvidence,
  type CheatFinding,
  type CheatSeverity,
  type FileChangeType,
} from '@cockpit/core';

import type { LiveEventBus } from '../live/bus.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/store.js';

export interface CheatDetectorOptions {
  store: Store;
  bus: LiveEventBus;
  logger: Logger;
}

interface ParsedLine {
  kind: 'add' | 'remove';
  text: string;
  line: number;
}

interface FindingInput {
  category: CheatCategory;
  severity: CheatSeverity;
  title: string;
  detail: string;
  detector: string;
  confidence: number;
  evidence: CheatEvidence[];
  suggestion?: string;
  stepId?: string;
}

const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,
  /(?:^|\/)(?:__tests__|tests?|specs?)\//i,
  /_test\.(?:py|go|rs)$/i,
  /(?:Test|Tests)\.(?:java|kt|cs)$/i,
  /\.feature$/i,
];

const SKIP_PATTERNS: readonly RegExp[] = [
  /\b(?:it|test|describe|suite|context)\.(?:skip|todo)\s*\(/i,
  /\bx(?:it|describe|test)\s*\(/i,
  /@pytest\.mark\.(?:skip|xfail)\b/i,
  /\bpytest\.skip\s*\(/i,
  /\bunittest\.skip\b/i,
  /#\[ignore\]/i,
  /\bt\.Skip\s*\(/i,
  /\bSkip\s*\(/i,
];

const SUPPRESSION_PATTERNS: readonly RegExp[] = [
  /@ts-ignore\b/i,
  /@ts-expect-error\b/i,
  /eslint-disable(?:-next-line|-line)?\b/i,
  /#\s*noqa\b/i,
  /#\s*type:\s*ignore\b/i,
  /pytest\.mark\.filterwarnings\b/i,
  /@SuppressWarnings\b/i,
  /\[SuppressMessage\b/i,
  /\/\/\s*nolint\b/i,
  /--no-verify\b/i,
];

const EMPTY_CATCH_PATTERNS: readonly RegExp[] = [
  /catch\s*(?:\([^)]*\))?\s*\{\s*\}\s*;?\s*$/i,
  /except\s*(?:\([^)]*\))?\s*:\s*pass\s*$/i,
  /catch\s*\{\s*\/\/\s*(?:ignore|noop|nothing)\s*\}\s*$/i,
];

const HARDCODE_PATTERNS: readonly RegExp[] = [
  /process\.env\.NODE_ENV\s*===?\s*['"]test['"]/i,
  /import\.meta\.env\.MODE\s*===?\s*['"]test['"]/i,
  /Deno\.env\.get\(\s*['"]DENO_ENV['"]\s*\)\s*===?\s*['"]test['"]/i,
  /(?:CI|TEST|JEST_WORKER_ID|PYTEST_CURRENT_TEST).*===?\s*['"](?:true|1|test)['"]/i,
];

const MOCK_PATTERNS: readonly RegExp[] = [
  /\b(?:vi|jest)\.mock\s*\(/i,
  /\bunittest\.mock\b/i,
  /\bmock\.patch\s*\(/i,
];

const MOCK_PATH_PATTERN = /(?:^|\/)(?:__mocks__|mocks?)\/|\.mock\.[cm]?[jt]sx?$/i;

const STUB_PATTERNS: readonly RegExp[] = [
  /throw\s+new\s+Error\s*\(\s*['"](?:Not implemented|TODO|Unimplemented)/i,
  /\bTODO:\s*implement\b/i,
  /\bNotImplementedError\b/,
  /\bpanic\s*\(\s*['"]not implemented/i,
];

const DONE_PATTERN = /\b(?:done|complete|completed|implemented|finished|ready)\b/i;

const ASSERTION_PATTERN = /\b(?:expect|assert|should|verify|require)\b/i;

const CATEGORY_SEVERITY: Readonly<Record<CheatCategory, CheatSeverity>> = {
  deleted_test: 'critical',
  skipped_test: 'high',
  weakened_test: 'high',
  empty_catch: 'medium',
  hardcoded_expectation: 'medium',
  mock_replacement: 'medium',
  suppression: 'low',
  stub_presented_as_done: 'high',
};

function isTestPath(filePath: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

function parseDiffLines(diff: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        oldLine = Number(match[1] ?? 0);
        newLine = Number(match[2] ?? 0);
      }
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;

    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), line: newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      lines.push({ kind: 'remove', text: raw.slice(1), line: oldLine });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return lines;
}

function excerptFor(line: ParsedLine): string {
  return line.text.trim().slice(0, 500);
}

function evidenceFor(filePath: string, line: ParsedLine, explanation: string): CheatEvidence {
  return {
    filePath,
    startLine: line.line,
    endLine: line.line,
    excerpt: excerptFor(line),
    explanation,
  };
}

function finding(sessionId: string, input: FindingInput): CheatFinding {
  return {
    id: createId(),
    sessionId,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    category: input.category,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    detector: input.detector,
    confidence: input.confidence,
    evidence: input.evidence,
    ...(input.suggestion ? { suggestion: input.suggestion } : {}),
    createdAt: new Date().toISOString(),
  };
}

export class CheatDetector {
  readonly #store: Store;
  readonly #bus: LiveEventBus;
  readonly #logger: Logger;
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(options: CheatDetectorOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#logger = options.logger;
  }

  schedule(sessionId: string): void {
    const existing = this.#timers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.#timers.delete(sessionId);
      try {
        this.analyzeSession(sessionId);
      } catch (error) {
        this.#logger.warn('Cockpit could not analyze agent output for trust', error);
      }
    }, 250);
    timer.unref();
    this.#timers.set(sessionId, timer);
  }

  analyzeSession(sessionId: string): CheatAnalysis | undefined {
    const session = this.#store.getSession(sessionId);
    if (!session) return undefined;

    const findings: CheatFinding[] = [];
    const files = new Set<string>();
    let lastStepId: string | undefined;

    for (const snapshot of this.#store.listSnapshots(sessionId)) {
      if (snapshot.stepId) lastStepId = snapshot.stepId;
      const step = snapshot.stepId ? this.#store.getStep(snapshot.stepId) : undefined;
      const responseText = step?.response?.text ?? '';

      for (const change of this.#store.listSnapshotFileChanges(snapshot.id)) {
        files.add(change.path);
        findings.push(
          ...this.#detectChange(
            sessionId,
            change.path,
            change.changeType,
            change.diff ?? '',
            responseText,
            snapshot.stepId,
          ),
        );
      }
    }

    const score = computeTrustScore(findings);
    const analysis = this.#store.replaceCheatAnalysis({
      sessionId,
      ...(lastStepId ? { stepId: lastStepId } : {}),
      trustScore: score.score,
      grade: score.grade,
      findings,
      filesExamined: files.size,
    });

    this.#bus.emit('analysis.updated', {
      sessionId,
      payload: {
        kind: 'trust',
        trustScore: analysis.trustScore,
        grade: analysis.grade,
        findingCount: analysis.findings.length,
        filesExamined: analysis.filesExamined,
      },
    });

    return analysis;
  }

  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #detectChange(
    sessionId: string,
    filePath: string,
    changeType: FileChangeType,
    diff: string,
    responseText: string,
    stepId?: string,
  ): CheatFinding[] {
    const testFile = isTestPath(filePath);
    const findings: CheatFinding[] = [];
    const step = stepId ? { stepId } : {};

    if (changeType === 'deleted' && testFile) {
      findings.push(
        finding(sessionId, {
          ...step,
          category: 'deleted_test',
          severity: CATEGORY_SEVERITY.deleted_test,
          title: `Test file deleted: ${filePath}`,
          detail:
            'A test file was removed in this step. Deleting tests hides failures instead of fixing them.',
          detector: 'deleted-test',
          confidence: 1,
          evidence: [
            {
              filePath,
              excerpt: 'File deleted.',
              explanation: 'The snapshot reports this test file as deleted.',
            },
          ],
          suggestion: 'Restore the test file or explain why the coverage is no longer required.',
        }),
      );
    }

    if (!diff) return findings;
    const lines = parseDiffLines(diff);
    const added = lines.filter((line) => line.kind === 'add');
    const removed = lines.filter((line) => line.kind === 'remove');

    const skipped = added.find((line) => SKIP_PATTERNS.some((pattern) => pattern.test(line.text)));
    if (skipped) {
      findings.push(
        finding(sessionId, {
          ...step,
          category: 'skipped_test',
          severity: CATEGORY_SEVERITY.skipped_test,
          title: 'Test was skipped',
          detail:
            'A test was disabled in this step. Skipped tests keep the suite green without proving behavior.',
          detector: 'skipped-test',
          confidence: 0.95,
          evidence: [evidenceFor(filePath, skipped, 'The added line disables or skips a test.')],
          suggestion: 'Fix the test or record an explicit, reviewed exception.',
        }),
      );
    }

    const suppression = added.find((line) =>
      SUPPRESSION_PATTERNS.some((pattern) => pattern.test(line.text)),
    );
    if (suppression) {
      findings.push(
        finding(sessionId, {
          ...step,
          category: 'suppression',
          severity: CATEGORY_SEVERITY.suppression,
          title: 'Compiler or linter suppression added',
          detail: 'A suppression comment was added. Suppressions can hide real defects from CI.',
          detector: 'suppression',
          confidence: 0.9,
          evidence: [evidenceFor(filePath, suppression, 'The added line suppresses a diagnostic.')],
          suggestion: 'Fix the underlying warning, or document why the suppression is safe.',
        }),
      );
    }

    const emptyCatch = added.find((line) =>
      EMPTY_CATCH_PATTERNS.some((pattern) => pattern.test(line.text)),
    );
    if (emptyCatch) {
      findings.push(
        finding(sessionId, {
          ...step,
          category: 'empty_catch',
          severity: CATEGORY_SEVERITY.empty_catch,
          title: 'Empty catch block added',
          detail: 'An error is swallowed without logging or recovery.',
          detector: 'empty-catch',
          confidence: 0.85,
          evidence: [evidenceFor(filePath, emptyCatch, 'The added line swallows an error.')],
          suggestion: 'Log, rethrow, or handle the error explicitly.',
        }),
      );
    }

    const hardcoded = added.find((line) =>
      HARDCODE_PATTERNS.some((pattern) => pattern.test(line.text)),
    );
    if (hardcoded) {
      findings.push(
        finding(sessionId, {
          ...step,
          category: 'hardcoded_expectation',
          severity: CATEGORY_SEVERITY.hardcoded_expectation,
          title: 'Test-only branch added',
          detail:
            'Production code now checks for a test environment, which can fake a passing result.',
          detector: 'hardcoded-expectation',
          confidence: 0.8,
          evidence: [
            evidenceFor(filePath, hardcoded, 'The added line special-cases a test environment.'),
          ],
          suggestion: 'Remove the test-only branch and make the real behavior testable.',
        }),
      );
    }

    const mock = added.find((line) => MOCK_PATTERNS.some((pattern) => pattern.test(line.text)));
    if (mock || (changeType === 'added' && MOCK_PATH_PATTERN.test(filePath))) {
      const line = mock ?? { kind: 'add' as const, text: 'New mock module.', line: 1 };
      findings.push(
        finding(sessionId, {
          ...step,
          category: 'mock_replacement',
          severity: CATEGORY_SEVERITY.mock_replacement,
          title: 'Mock replacement introduced',
          detail:
            'A mock was added or expanded. Mocks are useful, but replacing real behavior can hide integration failures.',
          detector: 'mock-replacement',
          confidence: mock ? 0.65 : 0.55,
          evidence: [evidenceFor(filePath, line, 'The added change introduces or extends a mock.')],
          suggestion: 'Keep at least one integration path that exercises the real dependency.',
        }),
      );
    }

    if (testFile) {
      const removedAssertions = removed.filter((line) => ASSERTION_PATTERN.test(line.text));
      const addedAssertions = added.filter((line) => ASSERTION_PATTERN.test(line.text));
      if (removedAssertions.length > addedAssertions.length && removedAssertions.length > 0) {
        const first = removedAssertions[0];
        if (first) {
          findings.push(
            finding(sessionId, {
              ...step,
              category: 'weakened_test',
              severity: CATEGORY_SEVERITY.weakened_test,
              title: 'Test assertions removed',
              detail: `${removedAssertions.length} assertion line(s) were removed while ${addedAssertions.length} were added.`,
              detector: 'weakened-test',
              confidence: 0.75,
              evidence: [
                evidenceFor(filePath, first, 'An assertion was removed from a test file.'),
              ],
              suggestion: 'Replace removed assertions with equivalent coverage.',
            }),
          );
        }
      }
    }

    if (!testFile && DONE_PATTERN.test(responseText)) {
      const stub = added.find((line) => STUB_PATTERNS.some((pattern) => pattern.test(line.text)));
      if (stub) {
        findings.push(
          finding(sessionId, {
            ...step,
            category: 'stub_presented_as_done',
            severity: CATEGORY_SEVERITY.stub_presented_as_done,
            title: 'Stub presented as completed work',
            detail:
              'A stub was added in a source file while the agent reported the work as done or complete.',
            detector: 'stub-presented-as-done',
            confidence: 0.85,
            evidence: [evidenceFor(filePath, stub, 'The added line is an unimplemented stub.')],
            suggestion: 'Finish the implementation or mark the work as in progress.',
          }),
        );
      }
    }

    return findings;
  }
}
