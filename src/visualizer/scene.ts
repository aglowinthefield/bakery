import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { GraphEdge, VisualState } from "./graph.js";
import type { Point } from "./layout.js";
import type { Look } from "./look.js";
import {
  arrowFragment,
  arrowVertex,
  edgeFragment,
  gridFragment,
  nodeFragment,
  quadVertex,
} from "./shaders.js";

export type SceneNode = {
  id: string;
  title: string;
  /** The line under the title. */
  activity: string;
  state: VisualState;
  priority: number;
};

/** The glow setting: how strong bloom and halos are. */
export type Glow = "off" | "soft" | "normal" | "full";
export const glowLevels: Record<Glow, number> = {
  off: 0,
  soft: 0.35,
  normal: 0.6,
  full: 1,
};

const stateKeys = [
  "fill",
  "glow",
  "pulse",
  "breathe",
  "orbit",
  "spark",
  "ring",
  "arc",
  "dash",
  "flick",
] as const;

/**
 * Drawing parameters per state; the look only chooses colors. `breathe` is how
 * deep the core pulses at `pulse` rad/s, `spark` shows an orbiting spark at `orbit`
 * rad/s (negative runs the other way), `ring` makes the ring breathe too, `arc` sweeps an arc, `dash`
 * dashes the ring, `flick` flickers.
 */
// prettier-ignore
const STATES: Record<VisualState, Record<(typeof stateKeys)[number], number>> = {
  working:      { fill: 0.4, glow: 0.8, pulse: 3.2, breathe: 1, orbit: 2.2, spark: 1, ring: 0, arc: 0, dash: 0, flick: 0 },
  quiet:        { fill: 0.25, glow: 0.35, pulse: 0.8, breathe: 0.6, orbit: 0.35, spark: 1, ring: 0, arc: 0, dash: 0, flick: 0 },
  agent_review: { fill: 0.32, glow: 0.7, pulse: 2.4, breathe: 1, orbit: -1.6, spark: 1, ring: 0, arc: 0, dash: 0, flick: 0 },
  waiting:      { fill: 0.08, glow: 0.3, pulse: 1, breathe: 0.4, orbit: 0, spark: 0, ring: 0, arc: 1, dash: 0, flick: 0 },
  needs_review: { fill: 0.25, glow: 0.7, pulse: 1.8, breathe: 0.8, orbit: 0, spark: 0, ring: 0, arc: 0, dash: 0, flick: 0 },
  failed:       { fill: 0.4, glow: 0.6, pulse: 1, breathe: 0.3, orbit: 0, spark: 0, ring: 0, arc: 0, dash: 0, flick: 1 },
  interrupted:  { fill: 0.15, glow: 0.2, pulse: 1, breathe: 0, orbit: 0, spark: 0, ring: 0, arc: 0, dash: 1, flick: 0 },
  done:         { fill: 0.55, glow: 0.2, pulse: 0, breathe: 0, orbit: 0, spark: 0, ring: 0, arc: 0, dash: 0, flick: 0 },
  ready:        { fill: 0.1, glow: 0.2, pulse: 1.4, breathe: 1, orbit: 0, spark: 0, ring: 1, arc: 0, dash: 0, flick: 0 },
  blocked:      { fill: 0, glow: 0, pulse: 1, breathe: 0, orbit: 0, spark: 0, ring: 0, arc: 0, dash: 1, flick: 0 },
  triage:       { fill: 0, glow: 0, pulse: 1, breathe: 0, orbit: 0, spark: 0, ring: 0, arc: 0, dash: 0, flick: 0 },
};

/** The parameters that ease between states rather than switching. */
const easedKeys = [
  "fill",
  "glow",
  "pulse",
  "breathe",
  "orbit",
  "spark",
] as const;
type Eased = Record<(typeof easedKeys)[number], number>;

/** Dependents that pull particles down a satisfied edge. */
const activeStates = new Set<VisualState>([
  "working",
  "agent_review",
  "quiet",
  "ready",
]);

const FLASH_SECONDS = 1.1;
const BURST_SECONDS = 1.3;
const BLOOM = { strength: 0.5, radius: 0.3, threshold: 0.35 };

const RADIUS = 22;
const SEGMENTS = 36;
const EDGE_WIDTH = 2.2;
const LABEL_WIDTH = 190;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const COMPACT_ZOOM = 0.55;

const radiusOf = (priority: number) =>
  RADIUS * (1 + 0.1 * Math.max(0, priority));

/** How far to ease toward a target in `dt` seconds at rate `k`. */
const ease = (dt: number, k: number) => 1 - Math.exp(-dt * k);

/**
 * Where shader colors live. Light themes draw straight to the screen with CSS
 * colors as display values, so blending matches the page. Dark themes add light
 * in linear space, bloom it, and encode to sRGB at the end, so bright cores do not
 * clip to white.
 */
const space = (light: boolean) =>
  light ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;

const setCss = (color: THREE.Color, css: string, light: boolean) =>
  color.setStyle(css, space(light));

/**
 * Dark themes add light onto the background. Light themes composite normally with
 * premultiplied alpha, since added light vanishes on white.
 */
function setBlend(material: THREE.ShaderMaterial, light: boolean) {
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDst = light ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor;
  material.blendDstAlpha = material.blendDst;
  material.needsUpdate = true;
}

const hash01 = (text: string) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

type NodeObject = {
  data: SceneNode;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  label: HTMLDivElement;
  title: HTMLDivElement;
  activity: HTMLDivElement;
  /** Where the circle is drawn now; it slides toward `target`. */
  pos: Point | null;
  /** Where the layout puts it. */
  target: Point | null;
  /** Grows from 0 to 1 when the node first appears. */
  scale: number;
  color: THREE.Color;
  /** The CSS color last written to the activity line, to skip redundant writes. */
  labelColor: string;
  eased: Eased;
  /** Scene clock time of the last status change, or -1. */
  flashAt: number;
  /** The orbiting spark's angle and the pulse's phase, advanced by their eased speeds each frame. */
  phase: number;
  beat: number;
};

type EdgeObject = {
  key: string;
  from: string;
  to: string;
  ribbon: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  arrow: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  color: THREE.Color;
  /** Scene clock time the source finished, or -1. */
  burstAt: number;
  /** How far dashes and particles have moved along, in world units. */
  shift: number;
};

function ribbonGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 6), 3),
  );
  const uv = new Float32Array((SEGMENTS + 1) * 4);
  const index: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    uv.set([i / SEGMENTS, -1, i / SEGMENTS, 1], i * 4);
    if (i < SEGMENTS)
      index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

function shader(
  vertexShader: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** True when the browser can make a WebGL context. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * The graph drawn with an orthographic camera. World space has x to the right and
 * y downward, matching layout coordinates. With motion it renders every frame
 * while the tab is visible; with reduced motion it renders on demand and every
 * change lands at once.
 */
export class GraphScene {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  private grid: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private nodes = new Map<string, NodeObject>();
  private edges = new Map<string, EdgeObject>();
  private edgeList: GraphEdge[] = [];
  private look: Look | null = null;
  private view = { x: 0, y: 0, zoom: 1 };
  private size = { w: 1, h: 1 };
  private userMoved = false;
  private frame = 0;
  private disposed = false;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private observer: ResizeObserver;
  private cleanups: (() => void)[] = [];
  private tmp = new THREE.Color();
  private stateColors = new Map<VisualState, THREE.Color>();
  private motion = true;
  private glow = glowLevels.normal;
  /** Seconds of animation so far; it stops while the tab is hidden. */
  private clock = 0;
  private lastFrame = 0;

  constructor(
    private host: HTMLElement,
    private labels: HTMLElement,
    private onPick: (id: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      BLOOM.strength,
      BLOOM.radius,
      BLOOM.threshold,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.renderer.domElement.className = "block h-full w-full";
    host.appendChild(this.renderer.domElement);
    this.camera.position.z = 5;
    this.grid = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      shader(quadVertex, gridFragment, {
        uLight: { value: 0 },
        uBg: { value: new THREE.Color() },
        uGrid: { value: new THREE.Color() },
        uCenter: { value: new THREE.Vector2() },
        uSize: { value: new THREE.Vector2(1, 1) },
      }),
    );
    this.grid.frustumCulled = false;
    this.grid.renderOrder = -10;
    this.scene.add(this.grid);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.listen(host, "pointerdown", this.onPointerDown);
    this.listen(host, "pointermove", this.onPointerMove);
    this.listen(host, "pointerup", this.onPointerUp);
    this.listen(host, "pointercancel", this.onPointerCancel);
    this.listen(host, "wheel", this.onWheel, { passive: false });
    this.listen(host, "dblclick", () => this.fit());
    const onVisibility = () => {
      if (!document.hidden) return this.requestRender();
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.lastFrame = 0;
    };
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanups.push(() =>
      document.removeEventListener("visibilitychange", onVisibility),
    );
    this.resize();
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }

  /** False for `prefers-reduced-motion`: no orbit, particles, flicker or slides. */
  setMotion(motion: boolean) {
    this.motion = motion;
    if (!motion) {
      for (const node of this.nodes.values()) node.flashAt = -1;
      for (const edge of this.edges.values()) edge.burstAt = -1;
    }
    this.requestRender();
  }

  /** Sets the glow strength: bloom in dark themes, and the halo around nodes. */
  setGlow(glow: Glow) {
    this.glow = glowLevels[glow];
    this.requestRender();
  }

  /** Applies theme colors and the light or dark blend mode. */
  setLook(look: Look) {
    this.look = look;
    for (const [state, css] of Object.entries(look.colors))
      this.stateColors.set(
        state as VisualState,
        setCss(new THREE.Color(), css, look.light),
      );
    const uniforms = this.grid.material.uniforms;
    setCss(uniforms.uBg.value, look.background, look.light);
    setCss(uniforms.uGrid.value, look.grid, look.light);
    uniforms.uLight.value = look.light ? 1 : 0;
    // A theme change switches color space, so colors jump rather than fade.
    for (const node of this.nodes.values()) {
      node.color.copy(this.stateColors.get(node.data.state) ?? node.color);
      this.styleNode(node);
    }
    for (const edge of this.edges.values()) {
      edge.color.copy(this.edgeColor(edge.from));
      this.styleEdge(edge);
    }
    this.labels.style.setProperty("--viz-bg", look.background);
    this.requestRender();
  }

  /** Adds, updates and removes nodes and edges. Removed ones release their geometry, material and label. */
  setGraph(nodes: SceneNode[], edges: GraphEdge[]) {
    const ids = new Set(nodes.map((node) => node.id));
    for (const [id, node] of this.nodes)
      if (!ids.has(id)) {
        this.disposeNode(node);
        this.nodes.delete(id);
      }
    const finishedNow = new Set<string>();
    for (const data of nodes) {
      let node = this.nodes.get(data.id);
      if (!node) {
        node = this.createNode(data);
        this.nodes.set(data.id, node);
      } else if (node.data.state !== data.state && this.motion) {
        node.flashAt = this.clock;
        if (data.state === "done") finishedNow.add(data.id);
      }
      node.data = data;
      node.title.textContent = data.title;
      node.activity.textContent = data.activity;
      this.styleNode(node);
    }
    this.edgeList = edges;
    const keys = new Set(edges.map((edge) => `${edge.from}>${edge.to}`));
    for (const [key, edge] of this.edges)
      if (!keys.has(key)) {
        this.disposeEdge(edge);
        this.edges.delete(key);
      }
    for (const edge of edges) {
      const key = `${edge.from}>${edge.to}`;
      if (!this.edges.has(key)) this.edges.set(key, this.createEdge(key, edge));
    }
    for (const edge of this.edges.values()) {
      if (finishedNow.has(edge.from)) edge.burstAt = this.clock;
      this.styleEdge(edge);
    }
    this.rebuildEdges();
    this.requestRender();
  }

  /**
   * Places nodes. A moved node slides to its new place; a new one grows in at the
   * dependency it hangs off, or in place. Fits the view unless the user has already
   * panned or zoomed.
   */
  setPositions(positions: Map<string, Point>) {
    for (const [id, node] of this.nodes) {
      node.target = positions.get(id) ?? null;
      if (!node.target) node.pos = null;
      else if (!node.pos) {
        const parent = this.edgeList
          .filter((edge) => edge.to === id)
          .map((edge) => this.nodes.get(edge.from)?.pos)
          .find(Boolean);
        node.pos = { ...(this.motion && parent ? parent : node.target) };
      }
      if (!this.motion) node.pos = node.target && { ...node.target };
    }
    this.rebuildEdges();
    if (!this.userMoved) this.fit();
    else this.requestRender();
  }

  /** Frames every placed node. */
  fit() {
    const placed = [...this.nodes.values()].filter((node) => node.target);
    this.userMoved = false;
    if (!placed.length) return this.requestRender();
    const pad = 80;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const { target: pos } of placed) {
      if (!pos) continue;
      minX = Math.min(minX, pos.x - LABEL_WIDTH / 2);
      maxX = Math.max(maxX, pos.x + LABEL_WIDTH / 2);
      minY = Math.min(minY, pos.y - RADIUS * 1.5);
      maxY = Math.max(maxY, pos.y + RADIUS * 1.5 + 40);
    }
    const zoom = Math.min(
      (this.size.w - pad) / (maxX - minX),
      (this.size.h - pad) / (maxY - minY),
      1.4,
    );
    this.view = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)),
    };
    this.requestRender();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    for (const cleanup of this.cleanups) cleanup();
    for (const node of this.nodes.values()) this.disposeNode(node);
    for (const edge of this.edges.values()) this.disposeEdge(edge);
    this.nodes.clear();
    this.edges.clear();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.bloom.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Test hook: where each placed node's circle lands on screen, in host pixels. */
  screenPositions(): Record<string, { x: number; y: number }> {
    const out: Record<string, { x: number; y: number }> = {};
    for (const [id, node] of this.nodes)
      if (node.pos) out[id] = this.toScreen(node.pos.x, node.pos.y);
    return out;
  }

  // ───────────── objects ─────────────

  private createNode(data: SceneNode): NodeObject {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      shader(quadVertex, nodeFragment, {
        uColor: { value: new THREE.Color() },
        uLight: { value: 0 },
        uAlpha: { value: 1 },
        uFill: { value: 0 },
        uGlow: { value: 0 },
        uGlowK: { value: glowLevels.normal },
        uTime: { value: 0 },
        uSeed: { value: hash01(data.id) },
        uBeat: { value: 0 },
        uBreathe: { value: 0 },
        uRingBreathe: { value: 0 },
        uSpark: { value: 0 },
        uPhase: { value: 0 },
        uOrbit: { value: 0 },
        uArc: { value: 0 },
        uDash: { value: 0 },
        uFlick: { value: 0 },
        uFlash: { value: -1 },
      }),
    );
    mesh.renderOrder = 2;
    mesh.visible = false;
    this.scene.add(mesh);
    const label = document.createElement("div");
    label.dataset.vizLabel = data.id;
    label.className =
      "pointer-events-none absolute top-0 left-0 text-center will-change-transform";
    label.style.width = `${LABEL_WIDTH}px`;
    label.style.display = "none";
    const shadow = "0 1px 6px var(--viz-bg), 0 0 2px var(--viz-bg)";
    const title = document.createElement("div");
    title.className =
      "truncate text-xs font-semibold text-foreground viz-title";
    title.style.textShadow = shadow;
    const activity = document.createElement("div");
    activity.className =
      "mt-px font-mono text-[10.5px] leading-[1.3] whitespace-nowrap";
    activity.style.textShadow = shadow;
    label.append(title, activity);
    this.labels.appendChild(label);
    const style = STATES[data.state];
    return {
      data,
      mesh,
      label,
      title,
      activity,
      pos: null,
      target: null,
      scale: this.motion ? 0 : 1,
      color: (this.stateColors.get(data.state) ?? new THREE.Color()).clone(),
      labelColor: "",
      eased: Object.fromEntries(
        easedKeys.map((key) => [key, style[key]]),
      ) as Eased,
      flashAt: -1,
      phase: 0,
      beat: 0,
    };
  }

  private disposeNode(node: NodeObject) {
    this.scene.remove(node.mesh);
    node.mesh.geometry.dispose();
    node.mesh.material.dispose();
    node.label.remove();
  }

  private createEdge(key: string, edge: GraphEdge): EdgeObject {
    const ribbon = new THREE.Mesh(
      ribbonGeometry(),
      shader(quadVertex, edgeFragment, {
        uColor: { value: new THREE.Color() },
        uLight: { value: 0 },
        uLen: { value: 100 },
        uAlpha: { value: 1 },
        uDashed: { value: 0 },
        uShift: { value: 0 },
        uFlow: { value: 0 },
        uBurst: { value: -1 },
      }),
    );
    const arrowGeometry = new THREE.BufferGeometry();
    arrowGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(9), 3),
    );
    const arrow = new THREE.Mesh(
      arrowGeometry,
      shader(arrowVertex, arrowFragment, {
        uColor: { value: new THREE.Color() },
        uLight: { value: 0 },
        uAlpha: { value: 0.9 },
      }),
    );
    for (const mesh of [ribbon, arrow]) {
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.visible = false;
      this.scene.add(mesh);
    }
    return {
      key,
      from: edge.from,
      to: edge.to,
      ribbon,
      arrow,
      color: this.edgeColor(edge.from).clone(),
      burstAt: -1,
      shift: 0,
    };
  }

  private disposeEdge(edge: EdgeObject) {
    this.scene.remove(edge.ribbon, edge.arrow);
    for (const mesh of [edge.ribbon, edge.arrow]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }

  /** Sets what switches at once on a status or theme change; colors and sizes ease in `animate`. */
  private styleNode(node: NodeObject) {
    const look = this.look;
    if (!look) return;
    const style = STATES[node.data.state];
    const u = node.mesh.material.uniforms;
    u.uLight.value = look.light ? 1 : 0;
    u.uArc.value = style.arc;
    u.uDash.value = style.dash;
    u.uRingBreathe.value = style.ring;
    setBlend(node.mesh.material, look.light);
  }

  /** The color an edge heads toward: its source's, or done's once satisfied. */
  private edgeColor(from: string) {
    const state = this.nodes.get(from)?.data.state ?? "triage";
    return this.stateColors.get(state) ?? this.tmp.setRGB(0.5, 0.5, 0.5);
  }

  private styleEdge(edge: EdgeObject) {
    const look = this.look;
    const source = this.nodes.get(edge.from);
    if (!look || !source) return;
    const satisfied = source.data.state === "done";
    for (const mesh of [edge.ribbon, edge.arrow]) {
      mesh.material.uniforms.uLight.value = look.light ? 1 : 0;
      setBlend(mesh.material, look.light);
    }
    edge.ribbon.material.uniforms.uDashed.value = satisfied ? 0 : 1;
    edge.arrow.material.uniforms.uAlpha.value = satisfied ? 0.7 : 0.9;
  }

  /** Recomputes every edge's curve from the current node positions. */
  private rebuildEdges() {
    for (const edge of this.edges.values()) {
      const a = this.nodes.get(edge.from);
      const b = this.nodes.get(edge.to);
      const visible = !!(a?.pos && b?.pos);
      edge.ribbon.visible = edge.arrow.visible = visible;
      if (!visible || !a?.pos || !b?.pos) continue;
      this.shapeEdge(
        edge,
        [a.pos.x + radiusOf(a.data.priority) * a.scale + 5, a.pos.y],
        [b.pos.x - radiusOf(b.data.priority) * b.scale - 9, b.pos.y],
      );
    }
  }

  private shapeEdge(
    edge: EdgeObject,
    p0: [number, number],
    p1: [number, number],
  ) {
    const k = Math.max(60, Math.abs(p1[0] - p0[0]) * 0.5);
    const c1 = [p0[0] + k, p0[1]];
    const c2 = [p1[0] - k, p1[1]];
    const at = (t: number): [number, number] => {
      const u = 1 - t;
      return [
        u * u * u * p0[0] +
          3 * u * u * t * c1[0] +
          3 * u * t * t * c2[0] +
          t * t * t * p1[0],
        u * u * u * p0[1] +
          3 * u * u * t * c1[1] +
          3 * u * t * t * c2[1] +
          t * t * t * p1[1],
      ];
    };
    const points = Array.from({ length: SEGMENTS + 1 }, (_, i) =>
      at(i / SEGMENTS),
    );
    let length = 0;
    for (let i = 1; i < points.length; i++)
      length += Math.hypot(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1],
      );
    const position = edge.ribbon.geometry.attributes.position;
    points.forEach((point, i) => {
      const before = points[Math.max(0, i - 1)];
      const after = points[Math.min(SEGMENTS, i + 1)];
      const dx = after[0] - before[0];
      const dy = after[1] - before[1];
      const m = Math.hypot(dx, dy) || 1;
      const nx = (-dy / m) * EDGE_WIDTH * 0.5;
      const ny = (dx / m) * EDGE_WIDTH * 0.5;
      position.setXYZ(i * 2, point[0] + nx, point[1] + ny, 0);
      position.setXYZ(i * 2 + 1, point[0] - nx, point[1] - ny, 0);
    });
    position.needsUpdate = true;
    edge.ribbon.material.uniforms.uLen.value = length;
    const tip = points[SEGMENTS];
    const back = points[SEGMENTS - 2];
    const m = Math.hypot(tip[0] - back[0], tip[1] - back[1]) || 1;
    const dx = (tip[0] - back[0]) / m;
    const dy = (tip[1] - back[1]) / m;
    const bx = tip[0] - dx * 11;
    const by = tip[1] - dy * 11;
    const arrow = edge.arrow.geometry.attributes
      .position as THREE.BufferAttribute;
    arrow.set([
      tip[0] + dx * 2,
      tip[1] + dy * 2,
      0,
      bx - dy * 5,
      by + dx * 5,
      0,
      bx + dy * 5,
      by - dx * 5,
      0,
    ]);
    arrow.needsUpdate = true;
  }

  // ───────────── drawing ─────────────

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    this.size = { w: Math.max(1, w), h: Math.max(1, h) };
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(this.size.w, this.size.h);
    if (!this.userMoved) this.fit();
    else this.requestRender();
  }

  private toScreen(x: number, y: number) {
    return {
      x: (x - this.view.x) * this.view.zoom + this.size.w / 2,
      y: (y - this.view.y) * this.view.zoom + this.size.h / 2,
    };
  }

  private toWorld(sx: number, sy: number): Point {
    return {
      x: this.view.x + (sx - this.size.w / 2) / this.view.zoom,
      y: this.view.y + (sy - this.size.h / 2) / this.view.zoom,
    };
  }

  /** Schedules a frame. Nothing is scheduled while the tab is hidden. */
  private requestRender() {
    if (this.disposed || this.frame || document.hidden) return;
    this.frame = requestAnimationFrame((time) => {
      this.frame = 0;
      if (this.disposed) return;
      const dt = this.lastFrame
        ? Math.min(0.1, (time - this.lastFrame) / 1000)
        : 0;
      this.lastFrame = time;
      this.clock += dt;
      this.animate(this.motion ? dt : Infinity);
      this.draw();
      if (this.motion) this.requestRender();
      else this.lastFrame = 0;
    });
  }

  /**
   * Moves every node, color and parameter toward its target. `dt` is the frame
   * time in seconds; Infinity lands everything at once.
   */
  private animate(dt: number) {
    const motion = this.motion;
    const time = motion ? this.clock : 0;
    let moved = false;
    for (const node of this.nodes.values()) {
      const style = STATES[node.data.state];
      const color = this.stateColors.get(node.data.state);
      if (color) node.color.lerp(color, ease(dt, 5));
      for (const key of easedKeys)
        node.eased[key] += (style[key] - node.eased[key]) * ease(dt, 5);
      if (node.pos && node.target) {
        const k = ease(dt, 4);
        const dx = node.target.x - node.pos.x;
        const dy = node.target.y - node.pos.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.01 || node.scale < 1) moved = true;
        node.pos.x += dx * k;
        node.pos.y += dy * k;
        node.scale += (1 - node.scale) * ease(dt, 6);
        if (node.scale > 0.999) node.scale = 1;
      }
      if (node.flashAt >= 0 && this.clock - node.flashAt > FLASH_SECONDS)
        node.flashAt = -1;
      const u = node.mesh.material.uniforms;
      u.uColor.value.copy(node.color);
      u.uTime.value = time;
      u.uGlowK.value = this.glow;
      u.uFill.value = node.eased.fill;
      u.uGlow.value = node.eased.glow;
      if (motion) node.beat += node.eased.pulse * dt;
      u.uBeat.value = node.beat;
      u.uBreathe.value = motion ? node.eased.breathe : 0;
      if (motion) node.phase += node.eased.orbit * dt;
      u.uOrbit.value = node.eased.orbit;
      u.uPhase.value = node.phase;
      u.uSpark.value = motion ? node.eased.spark : 0;
      u.uFlick.value = motion ? style.flick : 0;
      u.uFlash.value =
        node.flashAt >= 0 ? (this.clock - node.flashAt) / FLASH_SECONDS : -1;
      const css = `#${node.color.getHexString(space(!!this.look?.light))}`;
      if (css !== node.labelColor) {
        node.labelColor = css;
        node.activity.style.color = css;
      }
    }
    for (const edge of this.edges.values()) {
      const source = this.nodes.get(edge.from)?.data.state;
      const target = this.nodes.get(edge.to)?.data.state;
      if (!source || !target) continue;
      const satisfied = source === "done";
      edge.color.lerp(this.edgeColor(edge.from), ease(dt, 5));
      if (edge.burstAt >= 0 && this.clock - edge.burstAt > BURST_SECONDS)
        edge.burstAt = -1;
      const u = edge.ribbon.material.uniforms;
      u.uColor.value.copy(edge.color);
      edge.arrow.material.uniforms.uColor.value.copy(edge.color);
      // Dashes crawl, and run faster out of a card that is being worked on.
      const speed = satisfied
        ? 55
        : source === "working" || source === "agent_review"
          ? 70
          : 14;
      if (motion) edge.shift += speed * dt;
      u.uShift.value = edge.shift;
      u.uFlow.value = motion && satisfied && activeStates.has(target) ? 1 : 0;
      u.uBurst.value =
        edge.burstAt >= 0 ? (this.clock - edge.burstAt) / BURST_SECONDS : -1;
    }
    if (moved) this.rebuildEdges();
    this.bloom.strength = (BLOOM.strength * this.glow) / glowLevels.normal;
  }

  private draw() {
    const { w, h } = this.size;
    const { x, y, zoom } = this.view;
    const halfW = w / 2 / zoom;
    const halfH = h / 2 / zoom;
    // y points down, so top is the smaller y.
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = -halfH;
    this.camera.bottom = halfH;
    this.camera.position.x = x;
    this.camera.position.y = y;
    this.camera.updateProjectionMatrix();

    this.grid.position.set(x, y, -5);
    this.grid.scale.set(w / zoom, h / zoom, 1);
    const grid = this.grid.material.uniforms;
    grid.uCenter.value.set(x, y);
    grid.uSize.value.set(w / zoom, h / zoom);

    const compact = zoom < COMPACT_ZOOM;
    for (const node of this.nodes.values()) {
      const placed = !!node.pos;
      node.mesh.visible = placed && !!this.look;
      node.label.style.display = placed ? "" : "none";
      if (!node.pos) continue;
      const r = radiusOf(node.data.priority);
      node.mesh.position.set(node.pos.x, node.pos.y, 0);
      node.mesh.scale.set(r * 4 * node.scale, r * 4 * node.scale, 1);
      const s = this.toScreen(node.pos.x, node.pos.y + r * 1.5 + 5 / zoom);
      node.label.style.transform = `translate(${s.x - LABEL_WIDTH / 2}px, ${s.y}px)`;
      node.title.style.display = compact ? "none" : "";
    }
    if (this.look) {
      this.renderer.setClearColor(
        setCss(this.tmp, this.look.background, this.look.light),
      );
    }
    // Bloom only works by adding light, so light themes skip it.
    this.bloom.enabled = this.glow > 0;
    if (this.look && !this.look.light) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // ───────────── pointer ─────────────

  private nodeAt(sx: number, sy: number): NodeObject | null {
    const w = this.toWorld(sx, sy);
    let best: NodeObject | null = null;
    let bestDistance = Infinity;
    for (const node of this.nodes.values()) {
      if (!node.pos) continue;
      const d = Math.hypot(node.pos.x - w.x, node.pos.y - w.y);
      if (d < radiusOf(node.data.priority) * 1.5 && d < bestDistance) {
        best = node;
        bestDistance = d;
      }
    }
    return best;
  }

  private local(event: MouseEvent) {
    const rect = this.host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.drag = { x: event.clientX, y: event.clientY, moved: false };
    this.host.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        this.view.x -= dx / this.view.zoom;
        this.view.y -= dy / this.view.zoom;
        drag.x = event.clientX;
        drag.y = event.clientY;
        this.userMoved = true;
        this.host.style.cursor = "grabbing";
        this.requestRender();
      }
      return;
    }
    const p = this.local(event);
    this.host.style.cursor = this.nodeAt(p.x, p.y) ? "pointer" : "grab";
  };

  private onPointerUp = (event: PointerEvent) => {
    const drag = this.drag;
    this.drag = null;
    this.host.style.cursor = "grab";
    if (this.host.hasPointerCapture(event.pointerId))
      this.host.releasePointerCapture(event.pointerId);
    if (!drag || drag.moved) return;
    const p = this.local(event);
    const node = this.nodeAt(p.x, p.y);
    if (node) this.onPick(node.data.id);
  };

  private onPointerCancel = () => {
    this.drag = null;
    this.host.style.cursor = "grab";
  };

  /** Zooms about the cursor so the point under it stays put. */
  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const p = this.local(event);
    const before = this.toWorld(p.x, p.y);
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, this.view.zoom * Math.exp(-event.deltaY * 0.0015)),
    );
    this.view.zoom = zoom;
    this.view.x = before.x - (p.x - this.size.w / 2) / zoom;
    this.view.y = before.y - (p.y - this.size.h / 2) / zoom;
    this.userMoved = true;
    this.requestRender();
  };
}
