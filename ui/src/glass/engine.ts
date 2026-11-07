import { clampDpr, hasGlassSize, packGlassInstance, parseRadius, GLASS_INSTANCE_FLOATS, MAX_GLASS_SHAPES } from './geometry';
import {
  BLUR_FRAG,
  COPY_FRAG,
  GLASS_FRAG,
  GLASS_VERT,
  WALLPAPER_FRAG,
  WALLPAPER_VERT,
} from './shaders';

type Theme = 'light' | 'dark';

interface ShapeMeta {
  el: HTMLElement;
  depth: number;
  radius: number;
  clipEl: HTMLElement | null;
  clipRadius: number;
  rect: DOMRect;
  clipRect: DOMRect | null;
}

interface ShapeStyle {
  tint: number;
  opacity: number;
}

const STYLES: Record<Theme, Record<number, ShapeStyle>> = {
  light: {
    1: { tint: 0.14, opacity: 0.74 },
    2: { tint: 0.11, opacity: 0.64 },
    3: { tint: 0.09, opacity: 0.52 },
  },
  dark: {
    1: { tint: 0.16, opacity: 0.66 },
    2: { tint: 0.11, opacity: 0.56 },
    3: { tint: 0.08, opacity: 0.44 },
  },
};

export interface GlassController {
  destroy: () => void;
  refresh: () => void;
}

export function initGlass(canvas: HTMLCanvasElement, forceFallback = false): GlassController {
  const html = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)').matches;

  if (forceFallback || reducedTransparency) {
    return fallback(canvas, forceFallback ? 'preference' : 'reduced-transparency');
  }

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  });

  if (!gl) {
    return fallback(canvas, 'webgl2-unavailable');
  }

  try {
    return createEngine(canvas, gl, reducedMotion);
  } catch (error) {
    console.warn('[cockpit] glass renderer could not start', error);
    return fallback(canvas, 'init-failed');
  }
}

function fallback(canvas: HTMLCanvasElement, reason: string): GlassController {
  canvas.hidden = true;
  const html = document.documentElement;
  html.dataset.glassMode = 'fallback';
  html.dataset.glassReason = reason;
  for (const element of document.querySelectorAll<HTMLElement>('[data-glass]')) {
    delete element.dataset.glassRendered;
  }
  window.__cockpitGlassMode = 'fallback';
  window.__cockpitGlassReady = true;
  console.info(`[cockpit] glass fallback: ${reason}`);
  return {
    destroy: () => undefined,
    refresh: () => undefined,
  };
}

function createEngine(
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
  reducedMotion: boolean,
): GlassController {
  const wallpaperProgram = program(gl, WALLPAPER_VERT, WALLPAPER_FRAG);
  const copyProgram = program(gl, WALLPAPER_VERT, COPY_FRAG);
  const blurProgram = program(gl, WALLPAPER_VERT, BLUR_FRAG);
  const glassProgram = program(gl, GLASS_VERT, GLASS_FRAG);

  const wallpaperUniforms = uniforms(gl, wallpaperProgram, ['uResolution', 'uTheme']);
  const copyUniforms = uniforms(gl, copyProgram, ['uTexture']);
  const blurUniforms = uniforms(gl, blurProgram, ['uTexture', 'uTexel', 'uDirection']);
  const glassUniforms = uniforms(gl, glassProgram, [
    'uBlur',
    'uResolution',
    'uTheme',
    'uPointer',
  ]);

  const emptyVao = gl.createVertexArray();
  const glassVao = gl.createVertexArray();
  const cornerBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();
  if (!emptyVao || !glassVao || !cornerBuffer || !instanceBuffer) {
    throw new Error('could not allocate glass buffers');
  }

  gl.bindVertexArray(glassVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, MAX_GLASS_SHAPES * GLASS_INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
  const stride = GLASS_INSTANCE_FLOATS * 4;
  const attributes: Array<[number, number, number]> = [
    [1, 4, 0],
    [2, 4, 4 * 4],
    [3, 4, 8 * 4],
    [4, 2, 12 * 4],
  ];
  for (const [location, size, offset] of attributes) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  let theme: Theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  let shapes: ShapeMeta[] = [];
  let frame = 0;
  let lastFrame = 0;
  let geometryDirty = true;
  let refreshQueued = true;
  let blurDirty = true;
  let ready = false;
  let destroyed = false;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let cssWidth = 0;
  let cssHeight = 0;
  let pointerX = 0;
  let pointerY = 0;
  let targetX = 0;
  let targetY = 0;
  let pointerSettling = false;

  const textures: WebGLTexture[] = [];
  const framebuffers: WebGLFramebuffer[] = [];
  let blurTexture: WebGLTexture | null = null;

  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  const minFrameMs = isMobile ? 33 : 16;

  const resizeObserver = new ResizeObserver(() => {
    geometryDirty = true;
    requestRender();
  });

  const mutationObserver = new MutationObserver(() => {
    refreshQueued = true;
    requestRender();
  });

  const themeObserver = new MutationObserver(() => {
    const next = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    if (next === theme) return;
    theme = next;
    blurDirty = true;
    requestRender();
  });

  const onPointerMove = (event: PointerEvent): void => {
    if (reducedMotion) return;
    targetX = (event.clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
    targetY = (event.clientY / Math.max(window.innerHeight, 1)) * 2 - 1;
    pointerSettling = true;
    requestRender();
  };

  const onScroll = (): void => {
    geometryDirty = true;
    requestRender();
  };

  const onResize = (): void => {
    geometryDirty = true;
    blurDirty = true;
    requestRender();
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      blurDirty = true;
      requestRender();
    }
  };

  const onThemeEvent = (): void => {
    const next = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    if (next === theme) return;
    theme = next;
    blurDirty = true;
    requestRender();
  };

  function requestRender(): void {
    if (destroyed || frame) return;
    frame = window.requestAnimationFrame(tick);
  }

  function tick(time: number): void {
    frame = 0;
    if (destroyed || document.visibilityState === 'hidden') return;
    if (time - lastFrame < minFrameMs) {
      frame = window.requestAnimationFrame(tick);
      return;
    }
    lastFrame = time;

    if (refreshQueued) {
      refreshQueued = false;
      rebuildShapes();
    }
    if (geometryDirty) {
      geometryDirty = false;
      updateRects();
    }

    render();

    if (pointerSettling) {
      requestRender();
    }
  }

  function rebuildShapes(): void {
    const next: ShapeMeta[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-glass]')) {
      const rect = el.getBoundingClientRect();
      if (!hasGlassSize(rect)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        continue;
      }
      const depth = Math.min(Math.max(Number(el.dataset.glassDepth) || 2, 1), 3);
      const radius = parseRadius(style.borderTopLeftRadius || style.borderRadius, rect.width, rect.height);
      const clipEl = findClip(el);
      let clipRect: DOMRect | null = null;
      let clipRadius = 0;
      if (clipEl) {
        clipRect = clipEl.getBoundingClientRect();
        if (!hasGlassSize(clipRect)) {
          clipRect = null;
        } else {
          const clipStyle = getComputedStyle(clipEl);
          clipRadius = parseRadius(
            clipStyle.borderTopLeftRadius || clipStyle.borderRadius,
            clipRect.width,
            clipRect.height,
          );
        }
      }
      next.push({ el, depth, radius, clipEl, clipRadius, rect, clipRect });
      if (next.length >= MAX_GLASS_SHAPES) break;
    }

    for (const element of document.querySelectorAll<HTMLElement>('[data-glass-rendered]')) {
      delete element.dataset.glassRendered;
    }
    for (const shape of next) {
      shape.el.dataset.glassRendered = 'true';
    }

    shapes = next;
    resizeObserver.disconnect();
    for (const shape of shapes) {
      resizeObserver.observe(shape.el);
      if (shape.clipEl) resizeObserver.observe(shape.clipEl);
    }
    geometryDirty = true;
  }

  function updateRects(): void {
    for (const shape of shapes) {
      shape.rect = shape.el.getBoundingClientRect();
      shape.clipRect = shape.clipEl?.getBoundingClientRect() ?? null;
      if (shape.clipRect && !hasGlassSize(shape.clipRect)) {
        shape.clipRect = null;
      }
    }
  }

  function resizeIfNeeded(): void {
    const nextCssWidth = Math.max(canvas.clientWidth, 1);
    const nextCssHeight = Math.max(canvas.clientHeight, 1);
    const dpr = clampDpr(window.devicePixelRatio || 1);
    const nextWidth = Math.max(Math.floor(nextCssWidth * dpr), 1);
    const nextHeight = Math.max(Math.floor(nextCssHeight * dpr), 1);
    if (nextWidth === canvasWidth && nextHeight === canvasHeight) {
      cssWidth = nextCssWidth;
      cssHeight = nextCssHeight;
      return;
    }

    canvasWidth = nextWidth;
    canvasHeight = nextHeight;
    cssWidth = nextCssWidth;
    cssHeight = nextCssHeight;
    canvas.width = nextWidth;
    canvas.height = nextHeight;

    for (const texture of textures) gl.deleteTexture(texture);
    for (const framebuffer of framebuffers) gl.deleteFramebuffer(framebuffer);
    textures.length = 0;
    framebuffers.length = 0;

    const quarterWidth = Math.max(Math.floor(nextWidth / 4), 1);
    const quarterHeight = Math.max(Math.floor(nextHeight / 4), 1);
    const [wallpaper, fboWallpaper] = target(gl, nextWidth, nextHeight);
    const [a, fboA] = target(gl, quarterWidth, quarterHeight);
    const [b, fboB] = target(gl, quarterWidth, quarterHeight);
    const [c, fboC] = target(gl, quarterWidth, quarterHeight);
    textures.push(wallpaper, a, b, c);
    framebuffers.push(fboWallpaper, fboA, fboB, fboC);
    blurTexture = c;
    blurDirty = true;
    geometryDirty = true;
  }

  function renderWallpaperAndBlur(): void {
    const quarterWidth = Math.max(Math.floor(canvasWidth / 4), 1);
    const quarterHeight = Math.max(Math.floor(canvasHeight / 4), 1);
    if (!blurTexture || textures.length < 4) return;

    // Render the expensive procedural wallpaper once, then reuse the texture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers[0] ?? null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.useProgram(wallpaperProgram);
    gl.uniform2f(wallpaperUniforms.uResolution ?? null, cssWidth, cssHeight);
    gl.uniform1f(wallpaperUniforms.uTheme ?? null, theme === 'dark' ? 1 : 0);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Downsample the wallpaper to a quarter-resolution texture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers[1] ?? null);
    gl.viewport(0, 0, quarterWidth, quarterHeight);
    gl.useProgram(copyProgram);
    gl.uniform1i(copyUniforms.uTexture ?? null, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[0] ?? null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(blurProgram);
    gl.uniform1i(blurUniforms.uTexture ?? null, 0);
    gl.uniform2f(blurUniforms.uTexel ?? null, 1 / quarterWidth, 1 / quarterHeight);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers[2] ?? null);
    gl.viewport(0, 0, quarterWidth, quarterHeight);
    gl.bindTexture(gl.TEXTURE_2D, textures[1] ?? null);
    gl.uniform2f(blurUniforms.uDirection ?? null, 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers[3] ?? null);
    gl.viewport(0, 0, quarterWidth, quarterHeight);
    gl.bindTexture(gl.TEXTURE_2D, textures[2] ?? null);
    gl.uniform2f(blurUniforms.uDirection ?? null, 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  function render(): void {
    resizeIfNeeded();
    if (blurDirty) {
      renderWallpaperAndBlur();
      blurDirty = false;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(copyProgram);
    gl.uniform1i(copyUniforms.uTexture ?? null, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[0] ?? null);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (shapes.length > 0) {
      const data = new Float32Array(shapes.length * GLASS_INSTANCE_FLOATS);
      const styles = STYLES[theme];
      for (let index = 0; index < shapes.length; index += 1) {
        const shape = shapes[index];
        if (!shape) continue;
        const style = styles[shape.depth] ?? styles[2] ?? { tint: 0.08, opacity: 0.55 };
        const packed = packGlassInstance({
          x: shape.rect.left,
          y: shape.rect.top,
          width: shape.rect.width,
          height: shape.rect.height,
          radius: shape.radius,
          tint: style.tint,
          opacity: style.opacity,
          depth: shape.depth,
          clip: shape.clipRect
            ? {
                x: shape.clipRect.left,
                y: shape.clipRect.top,
                width: shape.clipRect.width,
                height: shape.clipRect.height,
                radius: shape.clipRadius,
              }
            : null,
        });
        data.set(packed, index * GLASS_INSTANCE_FLOATS);
      }

      if (!reducedMotion && pointerSettling) {
        pointerX += (targetX - pointerX) * 0.18;
        pointerY += (targetY - pointerY) * 0.18;
        if (Math.abs(targetX - pointerX) < 0.002 && Math.abs(targetY - pointerY) < 0.002) {
          pointerX = targetX;
          pointerY = targetY;
          pointerSettling = false;
        }
      } else {
        pointerSettling = false;
      }

      gl.useProgram(glassProgram);
      gl.uniform1i(glassUniforms.uBlur ?? null, 0);
      gl.uniform2f(glassUniforms.uResolution ?? null, cssWidth, cssHeight);
      gl.uniform1f(glassUniforms.uTheme ?? null, theme === 'dark' ? 1 : 0);
      gl.uniform2f(glassUniforms.uPointer ?? null, pointerX, pointerY);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, blurTexture);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(glassVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, shapes.length);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    if (!ready) {
      ready = true;
      const html = document.documentElement;
      html.dataset.glassMode = 'webgl';
      html.dataset.glassRenderer = 'webgl2';
      window.__cockpitGlassMode = 'webgl';
      window.__cockpitGlassReady = true;
    }
  }

  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  mutationObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('cockpit:theme', onThemeEvent);
  document.addEventListener('visibilitychange', onVisibility);

  requestRender();

  return {
    destroy: () => {
      destroyed = true;
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      themeObserver.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
      window.removeEventListener('cockpit:theme', onThemeEvent);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const texture of textures) gl.deleteTexture(texture);
      for (const framebuffer of framebuffers) gl.deleteFramebuffer(framebuffer);
      gl.deleteBuffer(cornerBuffer);
      gl.deleteBuffer(instanceBuffer);
      gl.deleteVertexArray(emptyVao);
      gl.deleteVertexArray(glassVao);
      gl.deleteProgram(wallpaperProgram);
      gl.deleteProgram(copyProgram);
      gl.deleteProgram(blurProgram);
      gl.deleteProgram(glassProgram);
    },
    refresh: () => {
      refreshQueued = true;
      requestRender();
    },
  };
}

function findClip(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  while (parent) {
    if (parent.hasAttribute('data-glass')) {
      return parent.dataset.glassClip === 'none' ? null : parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

function target(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): [WebGLTexture, WebGLFramebuffer] {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error('could not allocate glass framebuffer');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`glass framebuffer is incomplete (${status})`);
  }
  return [texture, framebuffer];
}

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('could not create shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'unknown shader error';
      gl.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  };

  const vertexShader = compile(gl.VERTEX_SHADER, vertex);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, fragment);
  const result = gl.createProgram();
  if (!result) throw new Error('could not create program');
  gl.attachShader(result, vertexShader);
  gl.attachShader(result, fragmentShader);
  gl.linkProgram(result);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(result) ?? 'unknown link error';
    gl.deleteProgram(result);
    throw new Error(log);
  }
  return result;
}

function uniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: string[],
): Record<string, WebGLUniformLocation | null> {
  const result: Record<string, WebGLUniformLocation | null> = {};
  for (const name of names) {
    result[name] = gl.getUniformLocation(program, name);
  }
  return result;
}
