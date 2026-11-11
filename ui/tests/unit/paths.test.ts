import { describe, expect, it } from 'vitest';
import {
  displayFolderPath,
  fileName,
  isAbsoluteFolderPath,
  parentFolderPath,
} from '../../src/lib/paths';

describe('isAbsoluteFolderPath', () => {
  it('accepts Windows, UNC, and POSIX absolute paths', () => {
    expect(isAbsoluteFolderPath('C:\\Users\\ana\\AppData\\Roaming\\Pandu')).toBe(true);
    expect(isAbsoluteFolderPath('D:/Pandu/data')).toBe(true);
    expect(isAbsoluteFolderPath('\\\\server\\share\\Pandu')).toBe(true);
    expect(isAbsoluteFolderPath('/var/lib/pandu')).toBe(true);
  });

  it('rejects relative test and shell paths', () => {
    expect(isAbsoluteFolderPath('ui\\.tmp\\e2e-update-4326')).toBe(false);
    expect(isAbsoluteFolderPath('.pandu')).toBe(false);
    expect(isAbsoluteFolderPath('')).toBe(false);
  });
});

describe('displayFolderPath', () => {
  it('shows a real folder and hides a test path', () => {
    expect(displayFolderPath('C:\\Users\\ana\\AppData\\Roaming\\Pandu')).toBe(
      'C:\\Users\\ana\\AppData\\Roaming\\Pandu',
    );
    expect(displayFolderPath('ui\\.tmp\\e2e-update-4326')).toBe('—');
    expect(displayFolderPath(null)).toBe('—');
  });
});

describe('parentFolderPath', () => {
  it('turns a database file path into its folder', () => {
    expect(parentFolderPath('C:\\Users\\ana\\AppData\\Roaming\\Pandu\\pandu.db')).toBe(
      'C:\\Users\\ana\\AppData\\Roaming\\Pandu',
    );
    expect(parentFolderPath('/var/lib/pandu/pandu.db')).toBe('/var/lib/pandu');
    expect(parentFolderPath('C:\\pandu.db')).toBe('C:\\');
  });

  it('never returns a relative path', () => {
    expect(parentFolderPath('ui\\.tmp\\pandu.db')).toBe('—');
  });
});

describe('fileName', () => {
  it('shows only the backup file, never its folder', () => {
    expect(fileName('C:\\ProgramData\\Pandu\\migrate\\pandu.db.bak-2026-v4')).toBe(
      'pandu.db.bak-2026-v4',
    );
    expect(fileName('/var/lib/pandu/pandu.db.bak-2026-v4')).toBe('pandu.db.bak-2026-v4');
    expect(fileName('pandu.db')).toBe('pandu.db');
    expect(fileName(null)).toBe('—');
  });
});
