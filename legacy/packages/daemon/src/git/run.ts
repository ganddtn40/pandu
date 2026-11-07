import { execFile } from 'node:child_process';

export interface GitRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  maxBuffer?: number;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${args.join(' ')} failed with exit code ${String(exitCode)}.`);
    this.name = 'GitCommandError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Run Git without a shell. Arguments are always passed as an array so paths and
 * branch names can never be interpreted by a command interpreter.
 */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const rawCode = (error as NodeJS.ErrnoException).code;
          const exitCode = typeof rawCode === 'number' ? rawCode : 1;
          const result: GitResult = {
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : error.message,
            exitCode,
          };
          if (options.allowFailure) {
            resolve(result);
            return;
          }
          reject(new GitCommandError(args, exitCode, result.stderr));
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: 0,
        });
      },
    );
  });
}
