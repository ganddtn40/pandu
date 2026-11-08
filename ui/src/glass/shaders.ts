export const WALLPAPER_VERT = /* glsl */ `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const WALLPAPER_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
uniform vec2 uResolution;
uniform float uTheme;      // 0 light, 1 dark, 2 frost
uniform float uPattern;    // checker lab override
uniform float uWallpaper;  // 0 procedural, 1 none, 2 image
uniform vec3 uAccent;
uniform sampler2D uImage;
uniform float uImageAspect;
out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p = p * 2.03 + 11.7;
    amplitude *= 0.5;
  }
  return value;
}

float blob(vec2 p, vec2 center, float radius, float softness) {
  return smoothstep(radius, radius - softness, length(p - center));
}

vec3 themeBackground(float theme) {
  if (theme < 0.5) return vec3(0.890, 0.875, 0.839);
  if (theme < 1.5) return vec3(0.027, 0.035, 0.047);
  return vec3(0.859, 0.902, 0.941);
}

vec2 coverUv(vec2 uv, float viewAspect, float imageAspect) {
  vec2 scale = vec2(1.0);
  if (viewAspect > imageAspect) {
    scale.y = imageAspect / max(viewAspect, 0.0001);
  } else {
    scale.x = viewAspect / max(imageAspect, 0.0001);
  }
  return (uv - 0.5) * scale + 0.5;
}

// Theme values are 0 light, 1 dark, 2 frost. Light and frost are light
// surfaces; only dark uses the smoked, near-black treatment.
float isLightTheme(float theme) {
  return abs(theme - 1.0) > 0.5 ? 1.0 : 0.0;
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 p = vec2(uv.x * aspect, uv.y);

  // Warp the field so the light pools have organic, non-circular edges.
  vec2 q = p + 0.10 * vec2(fbm(p * 1.7 + 3.1), fbm(p * 1.7 + 8.4));
  q += 0.035 * vec2(fbm(p * 3.4 + 1.2), fbm(p * 3.4 + 5.9));

  vec3 color;
  float grain;
  float lightMode = isLightTheme(uTheme);

  if (uWallpaper > 1.5) {
    // A user wallpaper. It is scrimmed toward the theme so UI text keeps its
    // contrast no matter how busy the photograph is.
    vec2 imageUv = coverUv(uv, aspect, uImageAspect);
    color = texture(uImage, imageUv).rgb;
    if (lightMode > 0.5) {
      color = mix(color, vec3(0.945, 0.960, 0.980), 0.24);
    } else {
      color = mix(color, vec3(0.020, 0.026, 0.036), 0.44);
    }
    grain = 0.004;
  } else if (uWallpaper > 0.5) {
    // No wallpaper: a flat graphite or paper field with one soft accent glow.
    color = themeBackground(uTheme);
    color = mix(color, uAccent, 0.04);
    float vignette = smoothstep(0.30, 1.10, length(uv - vec2(0.5)));
    color *= 1.0 - vignette * (lightMode > 0.5 ? 0.06 : 0.18);
    grain = 0.002;
  } else if (uPattern > 0.5) {
    // High-contrast checker plus warm/cool diagonal bands. This is the
    // refraction test: any edge bend or channel split becomes obvious.
    vec2 cells = vec2(uv.x * aspect, uv.y) * 8.0;
    float checker = mod(floor(cells.x) + floor(cells.y), 2.0);
    color = mix(vec3(0.045, 0.050, 0.062), vec3(0.945, 0.950, 0.960), checker);
    float band = step(0.62, fract((uv.x * aspect + uv.y) * 5.0));
    color = mix(color, vec3(0.86, 0.28, 0.18), band * 0.28);
    float cool = step(0.70, fract((uv.x * aspect - uv.y) * 7.0));
    color = mix(color, vec3(0.18, 0.46, 0.92), cool * 0.22);
    grain = 0.004;
  } else if (uTheme > 1.5) {
    // Frost: cool, airy light with a blue-green cast.
    color = vec3(0.906, 0.933, 0.957);
    color = mix(color, vec3(0.760, 0.858, 0.972), blob(q, vec2(0.20 * aspect, 0.18), 0.74, 0.64));
    color = mix(color, vec3(0.690, 0.820, 0.930), blob(q, vec2(0.84 * aspect, 0.20), 0.68, 0.60));
    color = mix(color, vec3(0.800, 0.910, 0.890), blob(q, vec2(0.78 * aspect, 0.84), 0.72, 0.62));
    color = mix(color, vec3(0.760, 0.800, 0.940), blob(q, vec2(0.20 * aspect, 0.88), 0.66, 0.58));
    color = mix(color, vec3(0.960, 0.976, 1.000), blob(q, vec2(0.52 * aspect, 0.46), 0.52, 0.48));
    color = mix(color, uAccent, blob(q, vec2(0.28 * aspect, 0.22), 0.44, 0.50) * 0.04);
    float wash = smoothstep(0.0, 1.0, uv.x * 0.7 + (1.0 - uv.y) * 0.3);
    color += wash * vec3(0.010, 0.014, 0.018);
    color -= smoothstep(0.35, 1.0, length(uv - vec2(0.5))) * 0.020;
    grain = 0.008;
  } else if (uTheme < 0.5) {
    color = vec3(0.906, 0.922, 0.945);
    color = mix(color, vec3(0.760, 0.842, 0.955), blob(q, vec2(0.22 * aspect, 0.20), 0.72, 0.62));
    color = mix(color, vec3(0.972, 0.900, 0.796), blob(q, vec2(0.86 * aspect, 0.10), 0.66, 0.58));
    color = mix(color, vec3(0.790, 0.900, 0.842), blob(q, vec2(0.78 * aspect, 0.82), 0.74, 0.64));
    color = mix(color, vec3(0.842, 0.822, 0.930), blob(q, vec2(0.20 * aspect, 0.90), 0.64, 0.58));
    color = mix(color, vec3(1.000, 0.968, 0.916), blob(q, vec2(0.52 * aspect, 0.46), 0.52, 0.48));
    color = mix(color, uAccent, blob(q, vec2(0.28 * aspect, 0.24), 0.44, 0.50) * 0.05);
    float wash = smoothstep(0.0, 1.0, uv.x * 0.7 + (1.0 - uv.y) * 0.3);
    color += wash * vec3(0.018, 0.012, 0.006);
    color -= smoothstep(0.35, 1.0, length(uv - vec2(0.5))) * 0.018;
    grain = 0.012;
  } else {
    // Smoky graphite panel: a near-black base with broad neutral blue-gray
    // pools. The accent appears only as a faint glow so the chrome reads as
    // graphite rather than warm brown.
    color = vec3(0.098, 0.104, 0.116);
    color = mix(color, vec3(0.238, 0.256, 0.288), blob(q, vec2(0.20 * aspect, 0.18), 0.78, 0.68));
    color = mix(color, vec3(0.300, 0.318, 0.352), blob(q, vec2(0.84 * aspect, 0.22), 0.70, 0.62));
    color = mix(color, vec3(0.340, 0.356, 0.392), blob(q, vec2(0.78 * aspect, 0.84), 0.74, 0.66));
    color = mix(color, vec3(0.180, 0.204, 0.248), blob(q, vec2(0.22 * aspect, 0.86), 0.68, 0.60));
    color = mix(color, vec3(0.315, 0.330, 0.362), blob(q, vec2(0.56 * aspect, 0.50), 0.56, 0.52));
    color = mix(color, uAccent, blob(q, vec2(0.30 * aspect, 0.22), 0.50, 0.55) * 0.035);
    float wash = smoothstep(0.0, 1.0, uv.x * 0.65 + (1.0 - uv.y) * 0.35);
    color += wash * vec3(0.018, 0.020, 0.024);
    color -= smoothstep(0.30, 1.05, length(uv - vec2(0.5))) * 0.028;
    grain = 0.010;
  }

  // Very soft film grain; it keeps large gradients from banding.
  float g = hash21(gl_FragCoord.xy + uTheme * 17.0) - 0.5;
  color += g * grain;

  if (uPattern < 0.5 && uWallpaper < 1.5) {
    // Calm the palette a touch so text stays comfortable on top of the glass.
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, 0.88);
  }

  outColor = vec4(color, 1.0);
}
`;

export const COPY_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTexture;
out vec4 outColor;

void main() {
  outColor = texture(uTexture, vUv);
}
`;

export const BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uScale;
out vec4 outColor;

void main() {
  vec2 step = uTexel * uDirection * uScale;
  vec3 color = texture(uTexture, vUv).rgb * 0.2270270270;
  color += texture(uTexture, vUv + step * 1.3846153846).rgb * 0.3162162162;
  color += texture(uTexture, vUv - step * 1.3846153846).rgb * 0.3162162162;
  color += texture(uTexture, vUv + step * 3.2307692308).rgb * 0.0702702703;
  color += texture(uTexture, vUv - step * 3.2307692308).rgb * 0.0702702703;
  outColor = vec4(color, 1.0);
}
`;

export const GLASS_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec4 aStyle;
layout(location = 3) in vec4 aClipRect;
layout(location = 4) in vec2 aClip;

uniform vec2 uResolution;

out vec2 vUv;
out vec2 vSize;
out vec2 vScreenPos;
flat out vec4 vStyle;
flat out vec4 vClipRect;
flat out vec2 vClip;

void main() {
  vec2 pos = aRect.xy + aCorner * aRect.zw;
  vec2 clip = vec2(
    pos.x / uResolution.x * 2.0 - 1.0,
    1.0 - pos.y / uResolution.y * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = aCorner;
  vSize = aRect.zw;
  vScreenPos = pos;
  vStyle = aStyle;
  vClipRect = aClipRect;
  vClip = aClip;
}
`;

export const GLASS_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
in vec2 vSize;
in vec2 vScreenPos;
flat in vec4 vStyle;
flat in vec4 vClipRect;
flat in vec2 vClip;

uniform sampler2D uBlur;
uniform vec2 uResolution;
uniform float uTheme;
uniform vec2 uPointer;
uniform vec3 uAccent;
uniform float uIntensity;
uniform float uRefraction;
uniform float uBorders;
uniform float uMotion;
out vec4 outColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 boostSaturation(vec3 color, float amount) {
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(luma), color, amount);
}

void main() {
  float radius = clamp(vStyle.x, 0.0, min(vSize.x, vSize.y) * 0.5);
  vec2 halfSize = max(vSize * 0.5 - 1.0, vec2(0.5));
  vec2 p = (vUv - 0.5) * vSize;
  float d = sdRoundBox(p, halfSize, radius);
  float aa = max(fwidth(d), 0.0001);
  float mask = 1.0 - smoothstep(-aa, aa, d);
  if (mask <= 0.001) discard;

  if (vClip.y > 0.5) {
    vec2 clipHalf = max(vClipRect.zw * 0.5, vec2(0.5));
    float clipRadius = clamp(vClip.x, 0.0, min(clipHalf.x, clipHalf.y));
    vec2 cp = vScreenPos - (vClipRect.xy + vClipRect.zw * 0.5);
    if (sdRoundBox(cp, clipHalf, clipRadius) > -0.5) discard;
  }

  vec2 grad = vec2(
    sdRoundBox(p + vec2(0.75, 0.0), halfSize, radius) - sdRoundBox(p - vec2(0.75, 0.0), halfSize, radius),
    sdRoundBox(p + vec2(0.0, 0.75), halfSize, radius) - sdRoundBox(p - vec2(0.0, 0.75), halfSize, radius)
  );
  vec2 normal = grad / max(length(grad), 0.0001);

  float edge = smoothstep(-30.0, 0.0, d);
  vec2 uv = vec2(
    vScreenPos.x / max(uResolution.x, 1.0),
    1.0 - vScreenPos.y / max(uResolution.y, 1.0)
  );
  vec2 offset = normal * edge * (12.0 * uRefraction / uResolution);

  vec3 refracted = vec3(
    texture(uBlur, uv + offset * 1.05).r,
    texture(uBlur, uv + offset).g,
    texture(uBlur, uv + offset * 0.95).b
  );
  refracted = boostSaturation(refracted, 1.14);

  // Light glass is milky; dark glass is a smoked, near-black panel so bright
  // wallpaper pools still read through the refraction without washing out text.
  // The accent tints the panel just enough to feel intentional.
  float lightMode = abs(uTheme - 1.0) > 0.5 ? 1.0 : 0.0;
  vec3 tintColor = lightMode > 0.5
    ? mix(vec3(1.0), uAccent, 0.06)
    : mix(vec3(0.045, 0.055, 0.070), uAccent, 0.10);
  float tintAmount = clamp(vStyle.y * (0.45 + uIntensity), 0.0, 0.94);
  vec3 color = mix(refracted, tintColor, tintAmount);

  // A gentle inner falloff keeps the surface from looking like flat plastic.
  float inner = smoothstep(-52.0, 0.0, d);
  color *= 1.0 - inner * (lightMode > 0.5 ? 0.055 : 0.16);

  // Specular rim, anchored to the top-left and nudged by the pointer. The
  // border toggle fades the rim without changing the shape's geometry.
  float rimScale = mix(0.20, 1.0, uBorders);
  vec2 lightDir = normalize(vec2(-0.55, -0.85) + uPointer * 0.18 * uMotion);
  float rim = smoothstep(3.2, 0.0, abs(d));
  float spec = pow(max(dot(normal, lightDir), 0.0), 2.2) * rim;
  color += spec * (lightMode > 0.5 ? 0.60 : 0.42) * rimScale;
  color += rim * max(-normal.y, 0.0) * (lightMode > 0.5 ? 0.16 : 0.10) * rimScale;

  float alpha = clamp(vStyle.z * (0.62 + uIntensity * 0.68) + rim * 0.10 * rimScale, 0.0, 1.0) * mask;
  outColor = vec4(clamp(color, 0.0, 1.0), alpha);
}
`;
