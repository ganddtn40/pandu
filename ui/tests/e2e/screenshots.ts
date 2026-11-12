import { type Locator, type Page } from '@playwright/test';

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Retry a screenshot write when Windows holds the target file open.
 *
 * Defender, the search indexer, and Explorer thumbnails can lock a freshly
 * written PNG for a few milliseconds. That is an environment race, not a test
 * failure, so retry only the file write.
 */
async function retryWrite(write: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await write();
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

export async function saveScreenshot(target: Page | Locator, file: string): Promise<void> {
  await retryWrite(() => target.screenshot({ path: file, animations: 'disabled' }));
}

export async function saveClippedScreenshot(
  page: Page,
  file: string,
  clip: Clip,
): Promise<void> {
  await retryWrite(() => page.screenshot({ path: file, animations: 'disabled', clip }));
}
