import * as THREE from "three";
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

/** Static drawing parameters per state. The look only chooses colors. */
const stateStyle: Record<
  VisualState,
  { fill: number; glow: number; arc: number; dash: number }
> = {
  working: { fill: 0.4, glow: 0.8, arc: 0, dash: 0 },
  quiet: { fill: 0.25, glow: 0.35, arc: 0, dash: 0 },
  agent_review: { fill: 0.32, glow: 0.7, arc: 0, dash: 0 },
  waiting: { fill: 0.08, glow: 0.3, arc: 1, dash: 0 },
  needs_review: { fill: 0.25, glow: 0.7, arc: 0, dash: 0 },
  failed: { fill: 0.4, glow: 0.6, arc: 0, dash: 0 },
  interrupted: { fill: 0.15, glow: 0.2, arc: 0, dash: 1 },
  done: { fill: 0.55, glow: 0.2, arc: 0, dash: 0 },
  ready: { fill: 0.1, glow: 0.2, arc: 0, dash: 0 },
  blocked: { fill: 0, glow: 0, arc: 0, dash: 1 },
  triage: { fill: 0, glow: 0, arc: 0, dash: 0 },
};

const RADIUS = 22;
const SEGMENTS = 36;
const EDGE_WIDTH = 2.2;
const LABEL_WIDTH = 190;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const COMPACT_ZOOM = 0.55;

const radiusOf = (priority: number) =>
  RADIUS * (1 + 0.1 * Math.max(0, priority));

/** CSS colors are already display values; keep them as-is so the shaders do not shift them. */
const setCss = (color: THREE.Color, css: string) =>
  color.setStyle(css, THREE.LinearSRGBColorSpace);

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
  pos: Point | null;
};

type EdgeObject = {
  key: string;
  from: string;
  to: string;
  ribbon: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  arrow: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
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
 * y downward, matching layout coordinates. It renders on demand, not every frame.
 */
export class GraphScene {
  private renderer: THREE.WebGLRenderer;
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

  constructor(
    private host: HTMLElement,
    private labels: HTMLElement,
    private onPick: (id: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

  /** Applies theme colors and the light or dark blend mode. */
  setLook(look: Look) {
    this.look = look;
    const uniforms = this.grid.material.uniforms;
    setCss(uniforms.uBg.value, look.background);
    setCss(uniforms.uGrid.value, look.grid);
    uniforms.uLight.value = look.light ? 1 : 0;
    for (const node of this.nodes.values()) this.styleNode(node);
    for (const edge of this.edges.values()) this.styleEdge(edge);
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
    for (const data of nodes) {
      let node = this.nodes.get(data.id);
      if (!node) {
        node = this.createNode(data);
        this.nodes.set(data.id, node);
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
    for (const edge of this.edges.values()) this.styleEdge(edge);
    this.rebuildEdges();
    this.requestRender();
  }

  /** Places nodes. Fits the view unless the user has already panned or zoomed. */
  setPositions(positions: Map<string, Point>) {
    for (const [id, node] of this.nodes) node.pos = positions.get(id) ?? null;
    this.rebuildEdges();
    if (!this.userMoved) this.fit();
    else this.requestRender();
  }

  /** Frames every placed node. */
  fit() {
    const placed = [...this.nodes.values()].filter((node) => node.pos);
    this.userMoved = false;
    if (!placed.length) return this.requestRender();
    const pad = 80;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const { pos } of placed) {
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
        uArc: { value: 0 },
        uDash: { value: 0 },
        uSeed: { value: hash01(data.id) },
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
    return { data, mesh, label, title, activity, pos: null };
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
    return { key, from: edge.from, to: edge.to, ribbon, arrow };
  }

  private disposeEdge(edge: EdgeObject) {
    this.scene.remove(edge.ribbon, edge.arrow);
    for (const mesh of [edge.ribbon, edge.arrow]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }

  private styleNode(node: NodeObject) {
    const look = this.look;
    if (!look) return;
    const style = stateStyle[node.data.state];
    const u = node.mesh.material.uniforms;
    setCss(u.uColor.value, look.colors[node.data.state]);
    u.uLight.value = look.light ? 1 : 0;
    u.uFill.value = style.fill;
    u.uGlow.value = style.glow;
    u.uArc.value = style.arc;
    u.uDash.value = style.dash;
    setBlend(node.mesh.material, look.light);
    node.activity.style.color = look.colors[node.data.state];
  }

  private styleEdge(edge: EdgeObject) {
    const look = this.look;
    const source = this.nodes.get(edge.from);
    if (!look || !source) return;
    const satisfied = source.data.state === "done";
    const color = satisfied ? look.colors.done : look.colors[source.data.state];
    for (const mesh of [edge.ribbon, edge.arrow]) {
      const u = mesh.material.uniforms;
      setCss(u.uColor.value, color);
      u.uLight.value = look.light ? 1 : 0;
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
        [a.pos.x + radiusOf(a.data.priority) + 5, a.pos.y],
        [b.pos.x - radiusOf(b.data.priority) - 9, b.pos.y],
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

  private requestRender() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed) this.draw();
    });
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
      node.mesh.scale.set(r * 4, r * 4, 1);
      const s = this.toScreen(node.pos.x, node.pos.y + r * 1.5 + 5 / zoom);
      node.label.style.transform = `translate(${s.x - LABEL_WIDTH / 2}px, ${s.y}px)`;
      node.title.style.display = compact ? "none" : "";
    }
    if (this.look) {
      this.renderer.setClearColor(setCss(this.tmp, this.look.background));
    }
    this.renderer.render(this.scene, this.camera);
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
