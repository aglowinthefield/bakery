// Shaders for the static render. They take no time uniform, so nothing moves
// until a later change adds animation.

export const quadVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** A circle drawn on a quad: soft core, ring and glow. Dashed ring for blocked and interrupted, a bright arc for waiting. */
export const nodeFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uLight, uAlpha, uFill, uGlow, uArc, uDash, uSeed;
const float TAU = 6.28318530718;
void main() {
  vec2 p = (vUv - 0.5) * 4.0;
  float d = length(p);
  float ang = atan(p.y, p.x);
  float glow = exp(-max(d - 1.0, 0.0) * 2.6) * uGlow * 0.55;
  float core = smoothstep(1.0, 0.9, d) * uFill * (0.45 + 0.55 * (1.0 - d));
  float ring = smoothstep(0.065, 0.04, abs(d - 1.0));
  float ringI = 0.75;
  if (uDash > 0.5) ring *= step(0.5, fract(ang / TAU * 14.0));
  if (uArc > 0.5) {
    float a = mod(ang + uSeed * TAU, TAU) / TAU;
    ringI = 0.2 + 1.6 * pow(1.0 - a, 3.0);
  }
  float v = (core + glow + ring * ringI) * smoothstep(2.0, 1.55, d);
  if (uLight > 0.5) {
    float a = clamp(v, 0.0, 1.0) * uAlpha;
    gl_FragColor = vec4(uColor * a, a);
    return;
  }
  gl_FragColor = vec4((uColor * v + vec3(1.0) * core * 0.07) * uAlpha, 1.0);
}`;

/** A ribbon along a curve. \`vUv.x\` runs 0..1 along it and \`vUv.y\` -1..1 across. */
export const edgeFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uLight, uLen, uAlpha, uDashed;
void main() {
  float x = vUv.x * uLen;
  float prof = smoothstep(1.0, 0.15, abs(vUv.y));
  float base = 0.55;
  if (uDashed > 0.5) base = step(fract(x / 15.0), 0.55) * 0.7;
  float ends = smoothstep(0.0, 0.04, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
  float I = base * prof * ends * uAlpha;
  if (uLight > 0.5) {
    float a = clamp(I, 0.0, 1.0);
    gl_FragColor = vec4(uColor * a, a);
    return;
  }
  gl_FragColor = vec4(uColor * I, 1.0);
}`;

/** A dotted backdrop in world space. */
export const gridFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uBg, uGrid;
uniform vec2 uCenter, uSize;
uniform float uLight;
void main() {
  vec2 w = uCenter + (vUv - 0.5) * uSize;
  float dotD = length(fract(w / 44.0) - 0.5) * 44.0;
  float dots = smoothstep(1.5, 0.6, dotD);
  vec3 col = uLight > 0.5 ? mix(uBg, uGrid, dots * 0.5) : uBg + uGrid * dots * 0.35;
  gl_FragColor = vec4(col, 1.0);
}`;

/** The arrowhead triangle: a flat color, premultiplied for light themes and added for dark ones. */
export const arrowFragment = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uLight, uAlpha;
void main() {
  if (uLight > 0.5) gl_FragColor = vec4(uColor * uAlpha, uAlpha);
  else gl_FragColor = vec4(uColor * uAlpha, 1.0);
}`;

export const arrowVertex = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
