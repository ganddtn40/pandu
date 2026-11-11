/**
 * Filesystem paths shown in Settings.
 *
 * The daemon resolves its configured home before reporting it, so a real
 * installation always sends an absolute path. This guard keeps a relative
 * test or shell path out of the UI even if a caller sends one.
 */

const DRIVE = /^[a-zA-Z]:[\\/]/;
const UNC = /^\\\\[^\\]+\\[^\\]+/;

export function isAbsoluteFolderPath(value: string): boolean {
  return DRIVE.test(value) || UNC.test(value) || value.startsWith('/');
}

/** A displayable folder path, or an em dash when the value is not real. */
export function displayFolderPath(value: string | null | undefined): string {
  const path = value?.trim() ?? '';
  if (!path || !isAbsoluteFolderPath(path)) return '—';
  return path;
}

/** The folder containing a file path. Used when only `databasePath` is known. */
export function parentFolderPath(value: string | null | undefined): string {
  const path = displayFolderPath(value);
  if (path === '—') return path;
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (index < 0) return path;
  if (index === 0) return '/';
  if (index === 2 && DRIVE.test(path)) return path.slice(0, 3);
  return path.slice(0, index);
}

/** The last segment of a path, for showing a file without its test folder. */
export function fileName(value: string | null | undefined): string {
  const path = value?.trim() ?? '';
  if (!path) return '—';
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index >= 0 ? path.slice(index + 1) : path;
}
