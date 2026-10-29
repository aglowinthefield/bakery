// Shaders for the graph. Motion comes from `uTime`; with reduced motion the
// scene holds it at zero and turns orbit, flicker, flow and bursts off.

export const quadVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * A circle drawn on a quad: core, ring and glow, plus the per-state motion.
 * `uBreathe` is how deep the core pulses at phase `uBeat`; it pulses (and the ring when `uRingBreathe` is set), `uSpark` is
 * the orbiting spark's strength, `uPhase` its angle and `uOrbit` its speed (the sign
 * picks the direction its trail points), `uArc` sweeps a bright
 * arc, `uDash` dashes the ring, `uFlick` flickers, and `uFlash` (0..1, or -1 for
 * none) is the shockwave after a status change. `uGlowK` is the glow setting.
 */
export const nodeFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uLight, uAlpha, uFill, uGlow, uGlowK, uTime, uSeed, uBeat, uBreathe,
  uRingBreathe, uSpark, uPhase, uOrbit, uArc, uDash, uFlick, uFlash;
const float TAU = 6.28318530718;
void main() {
  vec2 p = (vUv - 0.5) * 4.0;
  float d = length(p);
  float ang = atan(p.y, p.x);
  float br = 1.0 - uBreathe * 0.5 * (0.5 - 0.5 * sin(uBeat + uSeed * TAU));
  float flick = 1.0 - uFlick * 0.7 *
    step(0.93, fract(sin(floor(uTime * 14.0 + uSeed * 10.0) * 91.7) * 43758.5));
  float glow = exp(-max(d - 1.0, 0.0) * 2.6) * uGlow * uGlowK * 0.9 * br * flick;
  float core = smoothstep(1.0, 0.9, d) * uFill * (0.45 + 0.55 * (1.0 - d)) * br * flick;
  float ring = smoothstep(0.065, 0.04, abs(d - 1.0));
  float ringI = 0.75 * mix(1.0, br, uRingBreathe);
  if (uDash > 0.5) ring *= step(0.5, fract(ang / TAU * 14.0 + uTime * 0.15));
  if (uArc > 0.5) {
    float a = mod(ang - uTime * 2.2 + uSeed * TAU, TAU) / TAU;
    ringI = 0.2 + 1.6 * pow(1.0 - a, 3.0);
  }
  ring *= ringI * flick;
  float spark = 0.0;
  if (uSpark > 0.01) {
    float oa = uPhase + uSeed * TAU;
    vec2 op = vec2(cos(oa), sin(oa)) * 1.42;
    float da = mod((oa - ang) * (uOrbit < 0.0 ? -1.0 : 1.0), TAU);
    spark = uSpark * (exp(-length(p - op) * 9.0) * (0.9 + 0.8 * uGlowK)
      + exp(-pow((d - 1.42) * 9.0, 2.0)) * exp(-da * 2.2) * 0.5 * uGlowK * step(da, 2.4));
  }
  float shock = 0.0;
  if (uFlash >= 0.0 && uFlash < 1.0)
    shock = exp(-abs(d - (1.0 + uFlash * 0.9)) * 12.0) * pow(1.0 - uFlash, 2.0) * 1.6;
  float v = (core + glow + ring + spark + shock) * smoothstep(2.0, 1.55, d);
  if (uLight > 0.5) {
    float a = clamp(v, 0.0, 1.0) * uAlpha;
    gl_FragColor = vec4(uColor * a, a);
    return;
  }
  gl_FragColor = vec4((uColor * v + vec3(1.0) * core * 0.12 * uGlowK) * uAlpha, 1.0);
}`;

/**
 * A ribbon along a curve. `vUv.x` runs 0..1 along it and `vUv.y` -1..1 across.
 * Dashes and particles move along by `uShift` world units, `uFlow` sends particles
 * toward the target, and
 * `uBurst` (0..1, or -1 for none) is the pulse after the source finishes.
 */
export const edgeFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uLight, uLen, uAlpha, uDashed, uShift, uFlow, uBurst;
void main() {
  float x = vUv.x * uLen;
  float prof = smoothstep(1.0, 0.15, abs(vUv.y));
  float base = 0.55;
  float pulse = 0.0;
  if (uDashed > 0.5) base = step(fract((x - uShift) / 15.0), 0.55) * 0.7;
  if (uFlow > 0.5) {
    float s = fract((uShift - x) / 130.0);
    pulse = exp(-s * 7.0) * 1.6;
    base = 0.3;
  }
  if (uBurst >= 0.0 && uBurst < 1.0)
    pulse += exp(-pow((vUv.x - uBurst * 1.25 + 0.1) * 9.0, 2.0)) * 3.0 * (1.0 - uBurst * 0.5);
  float ends = smoothstep(0.0, 0.04, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
  float I = (base + pulse) * prof * ends * uAlpha;
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
