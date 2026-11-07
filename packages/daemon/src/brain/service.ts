import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BRAIN_FORMAT_PATHS,
  BRAIN_FORMATS,
  type BrainFormat,
  type BrainOutputView,
  type BrainProjectStatus,
  type BrainSyncInput,
  type BrainSyncResponse,
  type BrainSyncResult,
} from '@cockpit/core';

import type { Logger } from '../logger.js';
import type { Store } from '../store/store.js';

export class BrainServiceError extends Error {
  readonly status: number;
  readonly code: 'bad_request' | 'not_found' | 'conflict';

  constructor(status: number, code: BrainServiceError['code'], message: string) {
    super(message);
    this.name = 'BrainServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface BrainServiceOptions {
  store: Store;
  logger: Logger;
}

interface BrainSourceFile {
  path: string;
  content: string;
}

interface BrainScript {
  name: string;
  command: string;
}

interface BrainTopFile {
  path: string;
  aiLines: number;
  unreviewedLines: number;
}

interface BrainFacts {
  projectName: string;
  rootPath: string;
  languages: string[];
  packageManager?: string;
  scripts: BrainScript[];
  sessionCount: number;
  stepCount: number;
  totalCostUsd: number;
  agents: string[];
  models: string[];
  topFiles: BrainTopFile[];
  recentPrompts: string[];
  understanding: {
    fileCount: number;
    unreviewedLines: number;
    openedFiles: number;
    acknowledgedFiles: number;
  };
}

const SOURCE_FILES = [
  'README.md',
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Makefile',
  'docker-compose.yml',
  'compose.yml',
] as const;

const SOURCE_DIRECTORIES = ['src', 'apps', 'packages', 'tests', 'test', 'docs'] as const;

const MAX_SOURCE_BYTES = 200_000;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function truncate(value: string, maximum: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readScripts(packageJson: string | undefined): BrainScript[] {
  if (!packageJson) return [];
  try {
    const parsed: unknown = JSON.parse(packageJson);
    if (!isRecord(parsed) || !isRecord(parsed['scripts'])) return [];
    return Object.entries(parsed['scripts'])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, command]) => ({ name, command }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 10);
  } catch {
    return [];
  }
}

function detectLanguages(sources: ReadonlyMap<string, string>): string[] {
  const languages: string[] = [];
  if (sources.has('tsconfig.json')) languages.push('TypeScript');
  if (sources.has('package.json') && !languages.includes('TypeScript'))
    languages.push('JavaScript');
  if (sources.has('pyproject.toml')) languages.push('Python');
  if (sources.has('Cargo.toml')) languages.push('Rust');
  if (sources.has('go.mod')) languages.push('Go');
  return uniqueSorted(languages);
}

function detectPackageManager(rootPath: string): string | undefined {
  const candidates: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ];
  for (const [file, manager] of candidates) {
    if (existsSync(path.join(rootPath, file))) return manager;
  }
  return undefined;
}

function renderIntro(format: BrainFormat): string[] {
  switch (format) {
    case 'agents_md':
      return [
        '# Agent Instructions',
        '',
        'This file is read by Codex, Cursor, and other tools that understand AGENTS.md. It is',
        'generated from the repository and from work recorded by Cockpit.',
      ];
    case 'claude_md':
      return [
        '# Claude Instructions',
        '',
        'This file is read by Claude Code. It is generated from the repository and from work',
        'recorded by Cockpit.',
      ];
    case 'cursorrules':
      return [
        '# Cursor Rules',
        '',
        'Generated from the repository and from work recorded by Cockpit.',
      ];
    case 'gemini_md':
      return [
        '# Gemini Instructions',
        '',
        'This file is read by Gemini CLI. It is generated from the repository and from work',
        'recorded by Cockpit.',
      ];
    case 'copilot_instructions':
      return [
        '# Copilot Instructions',
        '',
        'This file is read by GitHub Copilot. It is generated from the repository and from work',
        'recorded by Cockpit.',
      ];
  }
}

function renderFacts(format: BrainFormat, facts: BrainFacts): string {
  const lines: string[] = [...renderIntro(format), ''];

  lines.push('## Repository', '');
  lines.push(`- Name: ${facts.projectName}`);
  lines.push(`- Root: \`${facts.rootPath}\``);
  if (facts.languages.length > 0) lines.push(`- Languages: ${facts.languages.join(', ')}`);
  if (facts.packageManager) lines.push(`- Package manager: ${facts.packageManager}`);
  lines.push('');

  if (facts.scripts.length > 0) {
    lines.push('## Commands', '');
    for (const script of facts.scripts) {
      lines.push(`- \`${facts.packageManager ?? 'npm'} run ${script.name}\` — ${script.command}`);
    }
    lines.push('');
  }

  lines.push('## Working agreements', '');
  lines.push(
    '- Read the existing code before changing it; match its structure, naming, and style.',
  );
  lines.push('- Keep diffs focused. Do not rewrite unrelated code or generated files.');
  lines.push('- Run the repository typecheck, lint, and tests before declaring work complete.');
  lines.push('- Never commit secrets. Use environment variables for credentials.');
  lines.push('- Record decisions in the repository, not only in the chat transcript.');
  lines.push('');

  lines.push('## Recent work recorded by Cockpit', '');
  if (facts.sessionCount === 0) {
    lines.push('No sessions have been recorded for this project yet.', '');
  } else {
    lines.push(`- Sessions: ${facts.sessionCount}`);
    lines.push(`- Steps: ${facts.stepCount}`);
    lines.push(`- Recorded cost: ${formatUsd(facts.totalCostUsd)}`);
    if (facts.agents.length > 0) lines.push(`- Agents: ${facts.agents.join(', ')}`);
    if (facts.models.length > 0) lines.push(`- Models: ${facts.models.join(', ')}`);
    lines.push('');

    if (facts.topFiles.length > 0) {
      lines.push('### Files touched by AI', '');
      for (const file of facts.topFiles) {
        const review =
          file.unreviewedLines > 0 ? `, ${file.unreviewedLines} line(s) awaiting review` : '';
        lines.push(`- \`${file.path}\` — ${file.aiLines} AI line(s)${review}`);
      }
      lines.push('');
    }

    if (facts.recentPrompts.length > 0) {
      lines.push('### Recent prompts', '');
      for (const prompt of facts.recentPrompts) {
        lines.push(`- ${prompt}`);
      }
      lines.push('');
    }
  }

  if (facts.understanding.fileCount > 0) {
    lines.push('## Review debt', '');
    lines.push(`- Files with AI-written lines: ${facts.understanding.fileCount}`);
    lines.push(`- Lines awaiting review: ${facts.understanding.unreviewedLines}`);
    lines.push(`- Opened, not acknowledged: ${facts.understanding.openedFiles}`);
    lines.push(`- Acknowledged: ${facts.understanding.acknowledgedFiles}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    'This file is generated by Cockpit. Run `cockpit brain sync` to refresh it, or edit it and',
    'take ownership — Cockpit will report drift instead of silently overwriting your changes.',
    '',
  );

  return lines.join('\n');
}

export class BrainService {
  readonly #store: Store;
  readonly #logger: Logger;

  constructor(options: BrainServiceOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
  }

  async generate(projectId: string, formats?: readonly BrainFormat[]): Promise<BrainProjectStatus> {
    const project = this.#store.getProject(projectId);
    if (!project) {
      throw new BrainServiceError(404, 'not_found', 'The requested project was not found.');
    }

    const sources = await this.#readSources(project.rootPath);
    this.#store.deleteBrainSources(projectId);
    for (const source of sources) {
      this.#store.upsertBrainSource({
        projectId,
        path: source.path,
        content: source.content,
        checksum: sha256(source.content),
      });
    }

    const facts = this.#buildFacts(projectId, project.name, project.rootPath, sources);
    const sourceChecksum = sha256(
      JSON.stringify({
        sources: [...sources]
          .map((source) => ({ path: source.path, checksum: sha256(source.content) }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        facts,
      }),
    );

    const selected = formats && formats.length > 0 ? formats : BRAIN_FORMATS;
    for (const format of selected) {
      const content = renderFacts(format, facts);
      this.#store.upsertBrainOutput({
        projectId,
        format,
        path: BRAIN_FORMAT_PATHS[format],
        content,
        checksum: sha256(content),
        sourceChecksum,
      });
    }

    this.#logger.debug('Generated Project Brain outputs', {
      projectId,
      formats: selected.join(','),
    });
    return this.status(projectId);
  }

  async status(projectId: string): Promise<BrainProjectStatus> {
    const project = this.#store.getProject(projectId);
    if (!project) {
      throw new BrainServiceError(404, 'not_found', 'The requested project was not found.');
    }

    const outputs = this.#store.listBrainOutputs(projectId);
    const views: BrainOutputView[] = [];
    for (const output of outputs) {
      const disk = await this.#readDiskFile(project.rootPath, output.path);
      views.push({
        ...output,
        existsOnDisk: disk !== undefined,
        ...(disk === undefined ? {} : { diskChecksum: sha256(disk) }),
        drifted: disk !== undefined && sha256(disk) !== output.checksum,
      });
    }

    return {
      project,
      sources: this.#store.listBrainSources(projectId).map((source) => ({
        id: source.id,
        path: source.path,
        checksum: source.checksum,
        updatedAt: source.updatedAt,
      })),
      outputs: views,
      drift: this.#store.listBrainDriftEvents(projectId),
    };
  }

  async sync(projectId: string, input: BrainSyncInput): Promise<BrainSyncResponse> {
    const project = this.#store.getProject(projectId);
    if (!project) {
      throw new BrainServiceError(404, 'not_found', 'The requested project was not found.');
    }

    const selected = input.formats && input.formats.length > 0 ? input.formats : BRAIN_FORMATS;
    let outputs = this.#store.listBrainOutputs(projectId);
    const missingFormats = selected.filter(
      (format) => !outputs.some((output) => output.format === format),
    );
    if (missingFormats.length > 0) {
      await this.generate(projectId, missingFormats);
      outputs = this.#store.listBrainOutputs(projectId);
    }

    const results: BrainSyncResult[] = [];
    for (const format of selected) {
      const output = outputs.find((candidate) => candidate.format === format);
      if (!output) {
        results.push({
          format,
          path: BRAIN_FORMAT_PATHS[format],
          action: 'missing',
          message: 'No generated output exists for this format yet.',
        });
        continue;
      }

      const absolutePath = path.join(project.rootPath, output.path);
      const disk = await this.#readDiskFile(project.rootPath, output.path);
      const diskChecksum = disk === undefined ? undefined : sha256(disk);

      if (diskChecksum !== undefined && diskChecksum !== output.checksum && !input.force) {
        this.#store.markBrainOutputDrift(output.id, true);
        this.#recordDrift(projectId, output.id, output.checksum, diskChecksum);
        results.push({
          format,
          path: output.path,
          action: 'drift',
          checksum: diskChecksum,
          message:
            'The file on disk has changed since Cockpit generated it. Use force to overwrite.',
        });
        continue;
      }

      const needsWrite = diskChecksum !== output.checksum;
      if (input.dryRun) {
        results.push({
          format,
          path: output.path,
          action: needsWrite ? 'written' : 'unchanged',
          checksum: output.checksum,
          ...(needsWrite ? { message: 'Dry run: the file would be written.' } : {}),
        });
        continue;
      }

      if (needsWrite) {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, output.content, 'utf8');
      }
      this.#store.markBrainOutputSynced(output.id);
      this.#store.resolveBrainDriftEvents(projectId, output.id);
      results.push({
        format,
        path: output.path,
        action: needsWrite ? 'written' : 'unchanged',
        checksum: output.checksum,
      });
    }

    return { results, status: await this.status(projectId) };
  }

  async #readSources(rootPath: string): Promise<BrainSourceFile[]> {
    const sources: BrainSourceFile[] = [];

    for (const relativePath of SOURCE_FILES) {
      const content = await this.#readDiskFile(rootPath, relativePath, MAX_SOURCE_BYTES);
      if (content !== undefined) {
        sources.push({ path: relativePath, content });
      }
    }

    for (const directory of SOURCE_DIRECTORIES) {
      const absolute = path.join(rootPath, directory);
      try {
        const info = await stat(absolute);
        if (info.isDirectory()) {
          sources.push({ path: `${directory}/`, content: `Directory: ${directory}\n` });
        }
      } catch {
        // Optional directories are simply absent.
      }
    }

    return sources.sort((a, b) => a.path.localeCompare(b.path));
  }

  async #readDiskFile(
    rootPath: string,
    relativePath: string,
    maximum = MAX_SOURCE_BYTES,
  ): Promise<string | undefined> {
    const absolute = path.join(rootPath, relativePath);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) return undefined;
      const content = await readFile(absolute, 'utf8');
      return content.length > maximum ? content.slice(0, maximum) : content;
    } catch {
      return undefined;
    }
  }

  #recordDrift(
    projectId: string,
    outputId: string,
    expectedChecksum: string,
    actualChecksum: string,
  ): void {
    const unresolved = this.#store
      .listBrainDriftEvents(projectId, 200)
      .filter(
        (event) =>
          event.outputId === outputId &&
          event.expectedChecksum === expectedChecksum &&
          event.actualChecksum === actualChecksum &&
          event.resolvedAt === undefined,
      );
    if (unresolved.length > 0) return;

    this.#store.insertBrainDriftEvent({
      projectId,
      outputId,
      expectedChecksum,
      actualChecksum,
    });
  }

  #buildFacts(
    projectId: string,
    projectName: string,
    rootPath: string,
    sources: readonly BrainSourceFile[],
  ): BrainFacts {
    const sourceMap = new Map(sources.map((source) => [source.path, source.content]));
    const packageJson = sourceMap.get('package.json');
    const packageManager = detectPackageManager(rootPath);

    const sessions = this.#store.listSessions({ projectId, limit: 200 }).sessions;
    const provenance = this.#store.listProvenanceEntries({ projectId, limit: 5000 });
    const understanding = this.#store.listUnderstandingFiles({ projectId, limit: 500 });

    const files = new Map<string, BrainTopFile>();
    for (const entry of provenance) {
      const current = files.get(entry.filePath) ?? {
        path: entry.filePath,
        aiLines: 0,
        unreviewedLines: 0,
      };
      current.aiLines += Math.max(1, entry.lineEnd - entry.lineStart + 1);
      files.set(entry.filePath, current);
    }
    for (const file of understanding) {
      const current = files.get(file.path) ?? {
        path: file.path,
        aiLines: file.aiLines,
        unreviewedLines: 0,
      };
      current.aiLines = Math.max(current.aiLines, file.aiLines);
      current.unreviewedLines = Math.max(0, file.aiLines - file.reviewedLines);
      files.set(file.path, current);
    }

    const recentPrompts: string[] = [];
    for (const session of sessions.slice(0, 5)) {
      for (const prompt of this.#store.listRecentPromptTexts(session.id, 3)) {
        const excerpt = truncate(prompt, 200);
        if (excerpt.length > 0 && !recentPrompts.includes(excerpt)) {
          recentPrompts.push(excerpt);
        }
        if (recentPrompts.length >= 8) break;
      }
      if (recentPrompts.length >= 8) break;
    }

    return {
      projectName,
      rootPath: normalizePath(rootPath),
      languages: detectLanguages(sourceMap),
      ...(packageManager ? { packageManager } : {}),
      scripts: readScripts(packageJson),
      sessionCount: sessions.length,
      stepCount: sessions.reduce((total, session) => total + session.totals.stepCount, 0),
      totalCostUsd: sessions.reduce((total, session) => total + session.totals.totalCostUsd, 0),
      agents: uniqueSorted(
        sessions.flatMap((session) => (session.agent?.name ? [session.agent.name] : [])),
      ),
      models: uniqueSorted(
        sessions.flatMap((session) => (session.modelRef?.model ? [session.modelRef.model] : [])),
      ),
      topFiles: [...files.values()]
        .filter((file) => file.aiLines > 0)
        .sort((a, b) => b.aiLines - a.aiLines || a.path.localeCompare(b.path))
        .slice(0, 15),
      recentPrompts,
      understanding: {
        fileCount: understanding.length,
        unreviewedLines: understanding.reduce(
          (total, file) => total + Math.max(0, file.aiLines - file.reviewedLines),
          0,
        ),
        openedFiles: understanding.filter((file) => file.status === 'opened').length,
        acknowledgedFiles: understanding.filter((file) => file.status === 'acknowledged').length,
      },
    };
  }
}
