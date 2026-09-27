import {
  AmbientLight, ArrowHelper, AxesHelper, Box3, BoxGeometry, Color, DirectionalLight, DoubleSide,
  EdgesGeometry, GridHelper, Group, HemisphereLight, LineBasicMaterial, LineSegments,
  Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene,
  Vector3, WebGLRenderer,
} from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { ModelFileLoader } from '../graphics/ModelFileLoader';
import { applyModelCalibration, createCalibratedAsset, modelAdjustment } from '../graphics/ModelCalibration';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { TransformControlsEventMap } from 'three/addons/controls/TransformControls.js';
import { getSession } from '../api';
import { getDefinition, getSlotDefinitions } from '../config/hardware';
import type { BoardMountId, BoardMountLayout, FormFactor, PartKind, Vec3 } from '../core/types';
import type { AccessibleModel, ModelTransformRecord } from '../api';

interface EditorOptions {
  canvas: HTMLCanvasElement;
  model: AccessibleModel;
  sourceUrl?: string;
  onChange?: (transform: ModelTransformRecord) => void;
  boardMountLayout?: BoardMountLayout;
  componentPlacements?: Record<string, BoardMountLayout>;
  onComponentPlacementChange?: (kind: string, layout: BoardMountLayout) => void;
  onStatus?: (message: string) => void;
}

export type TransformTransferMode = 'position' | 'rotation' | 'scale' | 'all';
export type VisualMatchMode = 'scale' | 'all';

interface ModelMetrics {
  size: Vector3;
  bottomCenter: Vector3;
}

const toVec3 = (value: unknown, fallback: Vec3): [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  const next = value.map(item => Number(item));
  return next.every(Number.isFinite) ? next as [number, number, number] : [...fallback];
};

export function normalizeEditorTransform(value: unknown): ModelTransformRecord {
  const source = value && typeof value === 'object' ? value as Partial<ModelTransformRecord> : {};
  const scale = toVec3(source.scale, [1, 1, 1]).map(value => Math.max(0.001, value)) as [number, number, number];
  return {
    ...(source.normalization === 'slot-v1' ? { normalization: 'slot-v1' as const } : {}),
    position: toVec3(source.position, [0, 0, 0]),
    rotation: toVec3(source.rotation, [0, 0, 0]),
    scale,
  };
}

export class ModelCalibrationEditor {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(45, 1, 0.01, 20);
  private readonly renderer: WebGLRenderer;
  private readonly orbit: OrbitControls;
  private readonly transformControls: TransformControls;
  private readonly draco = new DRACOLoader().setDecoderPath('/draco/');
  private readonly loader = new ModelFileLoader(this.draco);
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;
  private modelRoot: Group | null = null;
  private transform: ModelTransformRecord;
  private boardMountLayout: BoardMountLayout;
  private componentPlacements: Record<string, BoardMountLayout>;
  private activeComponentPreview: { product: AccessibleModel; mountId: BoardMountId; root: Group } | null = null;
  private componentPreviewRevision = 0;

  constructor(private readonly options: EditorOptions) {
    this.transform = normalizeEditorTransform(options.model.transform);
    this.boardMountLayout = { ...(options.boardMountLayout ?? {}) };
    this.componentPlacements = { ...(options.componentPlacements ?? {}) };
    this.renderer = new WebGLRenderer({ canvas: options.canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(new Color('#0b1216'));
    this.camera.position.set(0.62, 0.42, 0.74);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.target.set(0, 0.18, 0);

    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.setMode('translate');
    this.transformControls.addEventListener('dragging-changed', event => {
      this.orbit.enabled = !Boolean((event as TransformControlsEventMap['dragging-changed']).value);
    });
    this.transformControls.addEventListener('objectChange', () => {
      if (this.activeComponentPreview) this.syncComponentPlacementFromObject();
      else this.syncTransformFromObject();
    });
    this.scene.add(this.transformControls.getHelper());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.canvas);

    this.buildReferenceScene();
    this.resize();
    this.animate();
  }

  async load(): Promise<void> {
    this.options.onStatus?.('Loading model...');
    this.refreshAuthHeader();
    const gltf = await this.loader.loadAsync(this.sourceUrlFor(this.options.model), this.options.model.modelPath);
    this.prepareScene(gltf.scene);
    const root = this.createCalibratedModel(gltf.scene, this.transform);
    this.modelRoot = root;
    this.scene.add(root);
    this.transformControls.attach(modelAdjustment(root));
    this.focusModel();
    this.options.onChange?.(this.getTransform());
    this.options.onStatus?.('Ready');
  }

  setMode(mode: 'translate' | 'rotate' | 'scale'): void {
    if (this.activeComponentPreview) this.transformControls.attach(this.activeComponentPreview.root);
    else if (this.modelRoot) this.transformControls.attach(modelAdjustment(this.modelRoot));
    this.transformControls.setMode(mode);
  }

  async setComponentPreview(product: AccessibleModel | null, mountId?: BoardMountId): Promise<void> {
    const revision = ++this.componentPreviewRevision;
    this.activeComponentPreview = null;
    this.disposeObject(this.componentPreviewRoot);
    this.componentPreviewRoot = null;
    if (!this.modelRoot) return;
    this.transformControls.attach(modelAdjustment(this.modelRoot));
    if (!product || !mountId) {
      return;
    }
    const formFactor: FormFactor = this.options.model.metadata?.formFactor === 'mATX' || this.options.model.metadata?.formFactor === 'ITX' ? this.options.model.metadata.formFactor : 'ATX';
    const kind = product.kind as PartKind;
    const saved = this.componentPlacements[kind]?.[mountId];
    const defaultSlot = getSlotDefinitions('motherboard', formFactor, this.boardMountLayout).find(slot => slot.id === mountId);
    const position = saved?.position ?? defaultSlot?.position ?? [0, 0, 0];
    const rotation = saved?.rotation ?? defaultSlot?.rotation ?? [0, 0, 0];
    this.options.onStatus?.(`Loading ${product.name} on motherboard…`);
    try {
      this.refreshAuthHeader();
      const gltf = await this.loader.loadAsync(this.sourceUrlFor(product), product.modelPath);
      if (revision !== this.componentPreviewRevision || !this.modelRoot) { this.disposeObject(gltf.scene); return; }
      this.prepareScene(gltf.scene);
      const component = createCalibratedAsset(gltf.scene, kind, getDefinition(kind, formFactor), normalizeEditorTransform(product.transform));
      component.traverse(object => {
        if (!(object instanceof Mesh)) return;
        object.material = new MeshBasicMaterial({ color: 0x91e8c5, transparent: true, opacity: 0.78, depthWrite: false, side: DoubleSide });
        object.renderOrder = 5;
      });
      const placement = new Group();
      placement.name = `placement-preview:${product.id}:${mountId}`;
      placement.position.set(...position);
      placement.rotation.set(...rotation);
      placement.add(component);
      this.modelRoot.add(placement);
      this.componentPreviewRoot = placement;
      this.activeComponentPreview = { product, mountId, root: placement };
      this.transformControls.setMode('translate');
      this.transformControls.attach(placement);
      this.componentPlacements[kind] = { ...(this.componentPlacements[kind] ?? {}), [mountId]: { position: [...position], rotation: [...rotation] } };
      this.options.onComponentPlacementChange?.(kind, this.componentPlacements[kind]);
      this.options.onStatus?.(`${product.name} preview loaded. Placement applies to all ${kind.toUpperCase()} models on this motherboard.`);
    } catch (error) {
      if (revision === this.componentPreviewRevision) this.options.onStatus?.(`Could not load ${product.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private componentPreviewRoot: Group | null = null;

  getActiveComponentPlacement(): { componentKind: string; placement: BoardMountLayout } | undefined {
    const active = this.activeComponentPreview;
    if (!active) return undefined;
    return { componentKind: active.product.kind, placement: this.componentPlacements[active.product.kind] ?? {} };
  }

  getComponentPlacements(): Record<string, BoardMountLayout> {
    return structuredClone(this.componentPlacements);
  }

  setActiveComponentPosition(position: Vec3): void {
    const active = this.activeComponentPreview;
    if (!active) return;
    active.root.position.set(...position);
    active.root.updateMatrixWorld(true);
    this.syncComponentPlacementFromObject();
  }

  private syncComponentPlacementFromObject(): void {
    const active = this.activeComponentPreview;
    if (!active) return;
    const placement = { position: active.root.position.toArray() as [number, number, number], rotation: [active.root.rotation.x, active.root.rotation.y, active.root.rotation.z] as [number, number, number] };
    const kind = active.product.kind;
    this.componentPlacements[kind] = { ...(this.componentPlacements[kind] ?? {}), [active.mountId]: placement };
    this.options.onComponentPlacementChange?.(kind, this.componentPlacements[kind]);
  }

  getTransform(): ModelTransformRecord {
    return normalizeEditorTransform(this.transform);
  }

  setTransform(transform: ModelTransformRecord): void {
    this.transform = normalizeEditorTransform(transform);
    this.applyTransformToObject();
    this.options.onChange?.(this.getTransform());
  }

  transferFromModel(source: AccessibleModel, mode: TransformTransferMode): ModelTransformRecord {
    const sourceTransform = normalizeEditorTransform(source.transform);
    const current = this.getTransform();
    this.setTransform({
      normalization: current.normalization,
      position: mode === 'position' || mode === 'all' ? [...sourceTransform.position] : [...current.position],
      rotation: mode === 'rotation' || mode === 'all' ? [...sourceTransform.rotation] : [...current.rotation],
      scale: mode === 'scale' || mode === 'all' ? [...sourceTransform.scale] : [...current.scale],
    });
    return this.getTransform();
  }

  async matchFromModel(source: AccessibleModel, mode: VisualMatchMode): Promise<ModelTransformRecord> {
    if (!this.modelRoot) throw new Error('Load the target model before matching transforms.');
    const sourceTransform = normalizeEditorTransform(source.transform);
    const sourceMetrics = await this.externalMetrics(source, sourceTransform);
    const current = this.getTransform();
    const next = normalizeEditorTransform({
      normalization: current.normalization,
      position: [...current.position],
      rotation: mode === 'all' ? [...sourceTransform.rotation] : [...current.rotation],
      scale: [...current.scale],
    });

    if (mode === 'scale' || mode === 'all') {
      const targetAtUnitScale = this.currentMetrics({
        position: [0, 0, 0],
        rotation: next.rotation,
        scale: [1, 1, 1],
      });
      next.scale = this.scaleToMatch(sourceMetrics.size, targetAtUnitScale.size, this.options.model.kind === 'gpu');
    }

    if (mode === 'all') {
      const targetAtOrigin = this.currentMetrics({
        position: [0, 0, 0],
        rotation: next.rotation,
        scale: next.scale,
      });
      next.position = sourceMetrics.bottomCenter.clone().sub(targetAtOrigin.bottomCenter).toArray() as [number, number, number];
    }

    this.setTransform(next);
    return this.getTransform();
  }

  resetView(): void {
    this.focusModel();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.transformControls.detach();
    this.transformControls.dispose();
    this.orbit.dispose();
    this.disposeObject(this.modelRoot);
    this.scene.traverse(object => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => material.dispose());
      }
    });
    this.draco.dispose();
    this.renderer.dispose();
  }

  private buildReferenceScene(): void {
    this.scene.background = new Color('#0b1216');
    this.scene.add(new HemisphereLight(0xddeee8, 0x0b1216, 1.7));
    this.scene.add(new AmbientLight(0x9fb5b3, 0.5));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(0.4, 0.8, 0.55);
    this.scene.add(key);

    const grid = new GridHelper(1.2, 24, 0x426060, 0x1e3030);
    grid.position.y = 0;
    this.scene.add(grid);
    this.scene.add(new AxesHelper(0.22));
    const front = new ArrowHelper(new Vector3(0, 0, 1), new Vector3(0, 0.01, 0), 0.32, 0xd6a84f, 0.055, 0.028);
    front.name = 'front-facing-reference';
    this.scene.add(front);
    this.scene.add(this.createGhostEnvelope());
  }

  private createGhostEnvelope(): Group {
    const kind = this.options.model.kind as PartKind;
    const metadata = this.options.model.metadata ?? {};
    const formFactor = metadata.formFactor === 'mATX' || metadata.formFactor === 'ITX' ? metadata.formFactor : 'ATX';
    const definition = getDefinition(kind, formFactor as FormFactor);
    const min = new Vector3(...definition.bounds.min);
    const max = new Vector3(...definition.bounds.max);
    const size = max.clone().sub(min);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const group = new Group();
    group.name = 'benchmark-ghost';

    const material = new MeshBasicMaterial({ color: 0x6ad1c9, transparent: true, opacity: 0.1, depthWrite: false });
    const shell = new Mesh(new BoxGeometry(size.x, size.y, size.z), material);
    shell.position.copy(center);
    group.add(shell);

    const edges = new LineSegments(
      new EdgesGeometry(shell.geometry),
      new LineBasicMaterial({ color: 0x6ad1c9, transparent: true, opacity: 0.62 }),
    );
    edges.position.copy(center);
    group.add(edges);
    return group;
  }

  autoAlign(): void {
    this.setTransform({ normalization: 'slot-v1', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    this.focusModel();
  }

  private applyTransformToObject(): void {
    if (!this.modelRoot) return;
    applyModelCalibration(this.modelRoot, this.options.model.kind as PartKind, this.definitionFor(this.options.model), this.transform);
  }

  private syncTransformFromObject(): void {
    if (!this.modelRoot) return;
    const adjustment = modelAdjustment(this.modelRoot);
    this.transform = {
      normalization: this.transform.normalization,
      position: adjustment.position.toArray() as [number, number, number],
      rotation: [adjustment.rotation.x, adjustment.rotation.y, adjustment.rotation.z],
      scale: adjustment.scale.toArray() as [number, number, number],
    };
    this.applyTransformToObject();
    this.options.onChange?.(this.getTransform());
  }

  private scaleToMatch(sourceSize: Vector3, targetSize: Vector3, preserveAspectRatio = false): [number, number, number] {
    // A GPU's X axis is its card length after the editor's base orientation.
    // Match that physical dimension with a uniform multiplier so another card's
    // height or cooler thickness cannot stretch the target mesh out of shape.
    if (preserveAspectRatio && targetSize.x > 1e-8 && sourceSize.x > 1e-8) {
      const factor = sourceSize.x / targetSize.x;
      if (Number.isFinite(factor) && factor > 0) return [factor, factor, factor];
    }
    const scale = new Vector3(
      targetSize.x > 1e-8 ? sourceSize.x / targetSize.x : this.transform.scale[0],
      targetSize.y > 1e-8 ? sourceSize.y / targetSize.y : this.transform.scale[1],
      targetSize.z > 1e-8 ? sourceSize.z / targetSize.z : this.transform.scale[2],
    );
    if (!scale.toArray().every(value => Number.isFinite(value) && value > 0)) return [...this.transform.scale];
    return scale.toArray() as [number, number, number];
  }

  private async externalMetrics(model: AccessibleModel, transform: ModelTransformRecord): Promise<ModelMetrics> {
    this.refreshAuthHeader();
    const gltf = await this.loader.loadAsync(this.sourceUrlFor(model), model.modelPath);
    this.prepareScene(gltf.scene);
    const root = this.createCalibratedModel(gltf.scene, transform, model);
    const metrics = this.metricsFromObject(root);
    this.disposeObject(root);
    return metrics;
  }

  private sourceUrlFor(model: AccessibleModel): string {
    if (this.options.sourceUrl && model.id === this.options.model.id) return this.options.sourceUrl;
    if (model.id && model.id !== 'draft-upload') return `/api/models/${encodeURIComponent(model.id)}/file`;
    throw new Error('Model preview URL is unavailable for this draft.');
  }

  private refreshAuthHeader(): void {
    const token = getSession()?.token;
    this.loader.setRequestHeader(token ? { Authorization: `Bearer ${token}` } : {});
  }

  private currentMetrics(transform: ModelTransformRecord): ModelMetrics {
    if (!this.modelRoot) throw new Error('Load the target model before reading bounds.');
    try {
      applyModelCalibration(this.modelRoot, this.options.model.kind as PartKind, this.definitionFor(this.options.model), { ...transform, normalization: this.transform.normalization });
      return this.metricsFromObject(this.modelRoot);
    } finally { this.applyTransformToObject(); }
  }

  private metricsFromObject(object: Object3D): ModelMetrics {
    const box = new Box3().setFromObject(object, true);
    if (box.isEmpty()) throw new Error('Model bounds are empty.');
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const bottomCenter = new Vector3(center.x, box.min.y, center.z);
    return { size, bottomCenter };
  }

  private prepareScene(source: Object3D): void {
    source.traverse(object => {
      if (!(object instanceof Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
      if (object.material instanceof MeshStandardMaterial) object.material.roughness = Math.max(object.material.roughness, 0.42);
    });
  }

  private definitionFor(model: AccessibleModel) {
    const metadata = model.metadata ?? {};
    const formFactor = metadata.formFactor === 'mATX' || metadata.formFactor === 'ITX' ? metadata.formFactor : 'ATX';
    return getDefinition(model.kind as PartKind, formFactor);
  }

  private createCalibratedModel(source: Object3D, transform: ModelTransformRecord, model = this.options.model): Group {
    return createCalibratedAsset(source, model.kind as PartKind, this.definitionFor(model), transform);
  }

  private focusModel(): void {
    const box = new Box3();
    if (this.modelRoot) box.expandByObject(this.modelRoot);
    box.expandByObject(this.scene.getObjectByName('benchmark-ghost') ?? new Object3D());
    const center = box.isEmpty() ? new Vector3(0, 0.18, 0) : box.getCenter(new Vector3());
    const size = box.isEmpty() ? new Vector3(0.5, 0.5, 0.5) : box.getSize(new Vector3());
    const distance = Math.max(size.x, size.y, size.z, 0.2) * 1.9;
    this.orbit.target.copy(center);
    this.camera.position.copy(center).add(new Vector3(distance, distance * 0.72, distance));
    this.camera.near = Math.max(0.001, distance / 100);
    this.camera.far = Math.max(10, distance * 20);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  private resize(): void {
    const canvas = this.options.canvas;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.frame = requestAnimationFrame(this.animate);
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  };

  private disposeObject(object: Object3D | null): void {
    if (!object) return;
    object.removeFromParent();
    object.traverse(child => {
      if (!(child instanceof Mesh)) return;
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    });
  }
}
