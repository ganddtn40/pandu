import type { LogLevel } from './config.js';

export type { LogLevel } from './config.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  level: LogLevel;
  error(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  debug(message: string, details?: unknown): void;
}

export type LogSink = Pick<Console, 'error' | 'warn' | 'log'>;

function formatTime(date: Date): string {
  return date.toISOString().slice(11, 19);
}

function formatDetails(details: unknown): string {
  if (details === undefined) return '';
  if (details instanceof Error) {
    return ` ${details.name}: ${details.message}`;
  }
  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return ' [unserializable details]';
  }
}

export function createLogger(level: LogLevel, sink: LogSink = console): Logger {
  const enabled = (candidate: LogLevel): boolean =>
    LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[candidate] && level !== 'silent';

  const write = (candidate: LogLevel, message: string, details?: unknown): void => {
    if (!enabled(candidate)) return;
    const line = `${formatTime(new Date())} ${candidate.toUpperCase().padEnd(5)} ${message}${formatDetails(details)}`;
    if (candidate === 'error') {
      sink.error(line);
    } else if (candidate === 'warn') {
      sink.warn(line);
    } else {
      sink.log(line);
    }
  };

  return {
    level,
    error: (message, details) => write('error', message, details),
    warn: (message, details) => write('warn', message, details),
    info: (message, details) => write('info', message, details),
    debug: (message, details) => write('debug', message, details),
  };
}
