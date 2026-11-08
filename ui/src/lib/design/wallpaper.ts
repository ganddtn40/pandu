export const WALLPAPER_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const WALLPAPER_MAX_DATA_URL_BYTES = 2.5 * 1024 * 1024;
export const WALLPAPER_MAX_EDGE = 1920;

export interface WallpaperSize {
  width: number;
  height: number;
}

/** Keep a wallpaper under the storage budget while preserving its aspect ratio. */
export function fitWallpaper(
  width: number,
  height: number,
  maxEdge = WALLPAPER_MAX_EDGE,
): WallpaperSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read that image.'));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('That file is not a readable image.'));
    image.onload = () => resolve(image);
    image.src = url;
  });
}

/**
 * Validate, downscale, and compress a user wallpaper. The result is a data URL
 * so it can live in the per-device store without a file server. Wallpaper
 * images are never part of an exported theme.
 */
export async function readWallpaperFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file (PNG, JPEG, WebP, or AVIF).');
  }
  if (file.size > WALLPAPER_MAX_FILE_BYTES) {
    throw new Error('That image is larger than 8 MB. Choose a smaller file.');
  }

  const source = await readAsDataUrl(file);
  const image = await loadImage(source);
  const fitted = fitWallpaper(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = fitted.width;
  canvas.height = fitted.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the wallpaper.');
  context.drawImage(image, 0, 0, fitted.width, fitted.height);

  const result = canvas.toDataURL('image/jpeg', 0.86);
  if (result.length > WALLPAPER_MAX_DATA_URL_BYTES) {
    throw new Error('That image is still too large after resizing. Choose a simpler image.');
  }
  return result;
}
