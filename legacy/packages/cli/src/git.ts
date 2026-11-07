import { execFileSync } from 'node:child_process';

export interface GitContext {
  branch?: string;
  commit?: string;
  root?: string;
}

function git(workspacePath: string, args: string[]): string | undefined {
  try {
    const output = execFileSync('git', ['-C', workspacePath, ...args], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

export function readGitContext(workspacePath: string): GitContext {
  const branch = git(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = git(workspacePath, ['rev-parse', 'HEAD']);
  const root = git(workspacePath, ['rev-parse', '--show-toplevel']);

  return {
    ...(branch && branch !== 'HEAD' ? { branch } : {}),
    ...(commit ? { commit } : {}),
    ...(root ? { root } : {}),
  };
}
