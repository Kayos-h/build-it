import {
  ArrowHelper, Box3, BoxGeometry, Camera, Color, EdgesGeometry, Group,
  LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial,
  Object3D, Raycaster, Vector2, Vector3,
} from 'three';
import type { Assembly } from '../core/Assembly';
import type { SlotNode } from '../core/SlotNode';
import type { ComponentInstance, PartKind, ValidationResult } from '../core/types';
import { compareSlotHits, hitTestSlot } from './SlotHitTest';

export interface PlacementState {
  kind: PartKind;
  mode: 'drag' | 'place';
  slotId: string | null;
  label: string | null;
  valid: boolean;
  reason?: string;
}

export interface SlotSnappingOptions {
  canvas: HTMLCanvasElement;
  camera: Camera;
  assembly: Assembly;
  /** Scene or a dedicated overlay group. Only previews are positioned here. */
  previewRoot: Object3D;
  setControlsEnabled: (enabled: boolean) => void;
  onReport?: (message: string, level?: 'info' | 'success' | 'error') => void;
  onFocus?: (instance: ComponentInstance) => void;
  onInstalled?: (instance: ComponentInstance) => void;
  onPlacementChange?: (state: PlacementState | null) => void;
  snapRadiusPx?: number;
}

interface ActivePlacement {
  kind: PartKind;
  mode: 'drag' | 'place';
  pointerId: number | null;
  slot: SlotNode | null;
  validation: ValidationResult | null;
}

interface ClickStart {
  pointerId: number;
  x: number;
  y: number;
  moved: boolean;
}

const VALID_COLOR = new Color(0x54e6bc);
const BLOCKED_COLOR = new Color(0xff5e72);
const CLICK_SLOP = 6;

/**
 * Owns pointer/keyboard interaction, never component transforms. A release
 * commits through Assembly.install(), which reserves the slot and parents the
 * mounted component to its connector. Ghosts are the only world-space objects.
 */
export class SlotSnappingController {
  private readonly options: SlotSnappingOptions;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly preview = new Group();
  private readonly ghostBounds = new Box3();
  private readonly inverse = new Matrix4();
  private readonly matrix = new Matrix4();
  private ghost: Mesh<BoxGeometry, MeshBasicMaterial> | null = null;
  private edges: LineSegments<EdgesGeometry, LineBasicMaterial> | null = null;
  private arrow: ArrowHelper | null = null;
  private active: ActivePlacement | null = null;
  private clickStart: ClickStart | null = null;
  private disposed = false;
  private interactionGeneration = 0;
  private notificationKey = '';
  private readonly oldCursor: string;
  private readonly oldTabIndex: number;
  private readonly unsubscribe: () => void;

  constructor(options: SlotSnappingOptions) {
    this.options = options;
    this.oldCursor = options.canvas.style.cursor;
    this.oldTabIndex = options.canvas.tabIndex;
    if (options.canvas.tabIndex < 0) options.canvas.tabIndex = 0;
    this.preview.name = 'placement-preview';
    this.preview.visible = false;
    this.preview.matrixAutoUpdate = false;
    this.preview.userData.pickable = false;
    options.previewRoot.add(this.preview);

    options.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('blur', this.onWindowBlur);
    this.unsubscribe = options.assembly.subscribe(this.onAssemblyChange);
  }

  get isPlacing(): boolean { return this.active !== null; }
  get activeKind(): PartKind | null { return this.active?.kind ?? null; }

  get state(): PlacementState | null {
    if (!this.active) return null;
    return {
      kind: this.active.kind,
      mode: this.active.mode,
      slotId: this.active.slot?.slotId ?? null,
      label: this.active.slot?.label ?? null,
      valid: this.active.validation?.valid ?? false,
      reason: this.active.validation?.reason,
    };
  }

  /** Call on pointerdown or after a pointermove drag threshold, even off-canvas. */
  beginDrag(kind: PartKind, event: PointerEvent): boolean {
    // Pointermove has button === -1 when no button changes state. The buttons
    // bitmask identifies the held primary button after a library drag threshold.
    const primaryPressed = event.type === 'pointerdown' ? event.button === 0 : (event.buttons & 1) !== 0;
    if (!primaryPressed || !event.isPrimary) return false;
    if (!this.start(kind, 'drag', event.pointerId)) return false;
    event.preventDefault();
    this.options.canvas.style.cursor = 'grabbing';
    this.updatePointer(event.clientX, event.clientY);
    return true;
  }

  /** Click or keyboard flow: display a compatible ghost, then click or Enter. */
  beginPlacement(kind: PartKind): boolean {
    if (!this.start(kind, 'place', null)) return false;
    const slots = this.options.assembly.getAvailableSlots(kind);
    const slot = slots.find(candidate => this.options.assembly.validate(kind, candidate.slotId).valid)
      ?? slots[0] ?? this.matchingSlots(kind)[0];
    this.setCandidate(slot ?? null);
    this.options.canvas.focus({ preventScroll: true });
    const label = this.options.assembly.getDefinition(kind).label;
    this.report(`Place ${label}: click the highlighted mount or press Enter. Arrow keys change mounts; Escape cancels.`);
    return true;
  }

  /** Select an explicit mounting point from an accessible UI control. */
  selectSlot(slotId: string): boolean {
    if (!this.active || this.active.mode !== 'place') return false;
    const slot = this.options.assembly.slots.get(slotId);
    if (!slot?.acceptsKind(this.active.kind)) return false;
    this.setCandidate(slot);
    return true;
  }

  /** Equivalent to Enter; revalidates at the moment of commit. */
  async confirmPlacement(): Promise<void> {
    if (!this.disposed && this.active?.mode === 'place') await this.commit();
  }

  cancel(reason?: string): void {
    // Reset/focus can invalidate a pending completion after its preview was
    // already cleared. Invalidate even when no placement is currently active.
    this.interactionGeneration++;
    const wasActive = this.active !== null;
    this.active = null;
    this.clickStart = null;
    this.preview.visible = false;
    this.options.canvas.style.cursor = this.oldCursor;
    if (wasActive) this.options.setControlsEnabled(true);
    this.notifyPlacement();
    if (wasActive && reason) this.report(reason);
  }

  /** Keep the overlay attached if the assembly or preview root is transformed. */
  update(): void {
    if (this.active?.slot) this.updatePreviewTransform(this.active.slot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.unsubscribe();
    const { canvas } = this.options;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('blur', this.onWindowBlur);
    canvas.tabIndex = this.oldTabIndex;
    this.disposePreviewGeometry();
    this.preview.removeFromParent();
  }

  private start(kind: PartKind, mode: 'drag' | 'place', pointerId: number | null): boolean {
    if (this.disposed) return false;
    this.cancel();
    if (kind === 'case') {
      this.report('Install the chassis to establish the root mounting frame.');
      return false;
    }
    if (!this.matchingSlots(kind).length) {
      const required = kind === 'motherboard' || kind === 'psu' || kind === 'fan' || kind === 'radiator'
        ? 'case' : kind === 'cooler' ? 'CPU' : 'motherboard';
      this.report(`Install the ${required} before placing this component.`, 'error');
      return false;
    }
    this.active = { kind, mode, pointerId, slot: null, validation: null };
    this.createPreview(kind);
    this.options.setControlsEnabled(false);
    this.options.canvas.style.cursor = 'crosshair';
    this.notifyPlacement();
    return true;
  }

  private matchingSlots(kind: PartKind): SlotNode[] {
    return [...this.options.assembly.slots.values()].filter(slot => slot.acceptsKind(kind));
  }

  private createPreview(kind: PartKind): void {
    this.disposePreviewGeometry();
    const bounds = this.options.assembly.getDefinition(kind).bounds;
    this.ghostBounds.set(new Vector3(...bounds.min), new Vector3(...bounds.max));
    const size = this.ghostBounds.getSize(new Vector3()).max(new Vector3(0.0005, 0.0005, 0.0005));
    const center = this.ghostBounds.getCenter(new Vector3());
    const geometry = new BoxGeometry(size.x, size.y, size.z);
    this.ghost = new Mesh(geometry, new MeshBasicMaterial({
      color: VALID_COLOR, transparent: true, opacity: 0.13,
      depthWrite: false, depthTest: false, toneMapped: false,
    }));
    this.ghost.position.copy(center);
    this.ghost.renderOrder = 100;
    this.edges = new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({
      color: VALID_COLOR, transparent: true, opacity: 0.95, depthTest: false,
      depthWrite: false, toneMapped: false,
    }));
    this.edges.position.copy(center);
    this.edges.renderOrder = 101;
    this.arrow = new ArrowHelper(new Vector3(0, 0, -1), new Vector3(), 0.04, VALID_COLOR, 0.012, 0.008);
    this.arrow.traverse(object => {
      object.renderOrder = 102;
      const material = (object as Mesh).material;
      if (material && !Array.isArray(material)) {
        material.depthTest = false;
        material.depthWrite = false;
        material.toneMapped = false;
      }
    });
    this.preview.add(this.ghost, this.edges, this.arrow);
  }

  private disposePreviewGeometry(): void {
    this.ghost?.geometry.dispose();
    this.ghost?.material.dispose();
    this.edges?.geometry.dispose();
    this.edges?.material.dispose();
    if (this.arrow) {
      // ArrowHelper geometry is shared by Three.js instances; dispose materials only.
      this.arrow.traverse(object => {
        const material = (object as Mesh).material;
        if (Array.isArray(material)) material.forEach(value => value.dispose());
        else material?.dispose();
      });
    }
    this.preview.clear();
    this.ghost = null;
    this.edges = null;
    this.arrow = null;
  }

  private setCandidate(slot: SlotNode | null): void {
    if (!this.active) return;
    this.active.slot = slot;
    this.active.validation = slot ? this.options.assembly.validate(this.active.kind, slot.slotId) : null;
    this.preview.visible = slot !== null;
    if (slot) {
      const color = this.active.validation?.valid ? VALID_COLOR : BLOCKED_COLOR;
      this.ghost?.material.color.copy(color);
      this.edges?.material.color.copy(color);
      if (this.arrow) {
        const approach = slot.snapVector.clone().normalize();
        if (approach.lengthSq() === 0) approach.set(0, 0, 1);
        const half = this.ghostBounds.getSize(new Vector3()).multiplyScalar(0.5);
        const extent = Math.abs(approach.x) * half.x + Math.abs(approach.y) * half.y + Math.abs(approach.z) * half.z;
        this.arrow.position.copy(this.ghostBounds.getCenter(new Vector3())).addScaledVector(approach, extent + 0.045);
        this.arrow.setDirection(approach.negate());
        this.arrow.setColor(color);
      }
      this.updatePreviewTransform(slot);
    }
    this.notifyPlacement();
  }

  private updatePreviewTransform(slot: SlotNode): void {
    this.options.previewRoot.updateWorldMatrix(true, false);
    this.inverse.copy(this.options.previewRoot.matrixWorld).invert();
    this.matrix.copy(slot.getSnapMatrix());
    this.preview.matrix.multiplyMatrices(this.inverse, this.matrix);
    this.preview.matrixWorldNeedsUpdate = true;
    this.preview.updateWorldMatrix(false, true);
  }

  private insideCanvas(x: number, y: number): boolean {
    const rect = this.options.canvas.getBoundingClientRect();
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return false;
    // An overlay button can cover the canvas; dropping on it must not install.
    return document.elementFromPoint(x, y) === this.options.canvas;
  }

  private setRay(x: number, y: number): DOMRect {
    const rect = this.options.canvas.getBoundingClientRect();
    this.pointer.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
    this.options.camera.updateWorldMatrix(true, false);
    this.raycaster.setFromCamera(this.pointer, this.options.camera);
    return rect;
  }

  private updatePointer(x: number, y: number, allowGhostHit = false): void {
    if (!this.active) return;
    if (!this.insideCanvas(x, y)) {
      // A click-selected mount must survive the trip to its dropdown/confirm
      // controls. A dragged part still loses its target outside the canvas, and
      // pointerup independently rejects drops on any overlay or outside bounds.
      if (this.active.mode === 'drag') this.setCandidate(null);
      return;
    }
    const rect = this.setRay(x, y);
    const current = this.active.slot;
    if (allowGhostHit && current) {
      const localRay = this.raycaster.ray.clone().applyMatrix4(new Matrix4().copy(current.getSnapMatrix()).invert());
      if (localRay.intersectsBox(this.ghostBounds)) { this.setCandidate(current); return; }
    }
    const candidates = this.matchingSlots(this.active.kind).flatMap(slot => {
      const hit = hitTestSlot(this.raycaster.ray, this.options.camera, this.pointer, rect, {
        object: slot, localBounds: slot.localBounds, snapVector: slot.snapVector, snapRadius: slot.snapRadius,
      }, this.options.snapRadiusPx ?? 72);
      return hit ? [{ slot, hit }] : [];
    });
    candidates.sort((a, b) => compareSlotHits(a.hit, b.hit));
    const candidate = candidates[0]?.slot;
    if (!candidate && current) {
      // Keep a selected preview clickable across the whole component silhouette,
      // but let a different connector win immediately when the pointer reaches it.
      const localRay = this.raycaster.ray.clone().applyMatrix4(new Matrix4().copy(current.getSnapMatrix()).invert());
      if (localRay.intersectsBox(this.ghostBounds)) { this.setCandidate(current); return; }
    }
    this.setCandidate(candidate ?? null);
  }

  private async commit(): Promise<void> {
    const active = this.active;
    if (!active?.slot) { this.report('Move onto a highlighted mounting slot before releasing.', 'error'); return; }
    const slot = active.slot;
    const validation = this.options.assembly.validate(active.kind, slot.slotId);
    if (!validation.valid) {
      this.setCandidate(slot);
      this.report(validation.reason ?? 'This component cannot be installed at this mount.', 'error');
      if (active.mode === 'drag') this.cancel();
      return;
    }
    const label = this.options.assembly.getDefinition(active.kind).label;
    this.cancel();
    const generation = this.interactionGeneration;
    this.report(`Installing ${label} in ${slot.label}…`);
    try {
      const instance = await this.options.assembly.install(active.kind, slot.slotId);
      // A valid transaction still belongs to the assembly when the user moves
      // on. Only its stale UI callbacks are discarded; never remove the part.
      if (this.disposed || generation !== this.interactionGeneration) return;
      this.options.onInstalled?.(instance);
      if (generation === this.interactionGeneration) this.report(`${label} snapped to ${slot.label}.`, 'success');
    } catch (error) {
      if (this.disposed || generation !== this.interactionGeneration) return;
      const expectedCancellation = error instanceof Error
        && (error.name === 'AbortError' || 'code' in error && error.code === 'cancelled');
      if (!expectedCancellation) this.report(error instanceof Error ? error.message : 'Installation failed.', 'error');
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) return;
    this.clickStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    if (this.active?.mode === 'place') {
      this.updatePointer(event.clientX, event.clientY, true);
      event.preventDefault();
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.clickStart?.pointerId === event.pointerId
      && Math.hypot(event.clientX - this.clickStart.x, event.clientY - this.clickStart.y) > CLICK_SLOP) {
      this.clickStart.moved = true;
    }
    if (!this.active || !event.isPrimary) return;
    if (this.active.mode === 'drag' && this.active.pointerId !== event.pointerId) return;
    this.updatePointer(event.clientX, event.clientY);
    if (this.active.mode === 'drag') event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) return;
    const click = this.clickStart;
    this.clickStart = null;
    if (this.active?.mode === 'drag') {
      if (this.active.pointerId !== event.pointerId) return;
      if (!this.insideCanvas(event.clientX, event.clientY)) { this.cancel(); return; }
      this.updatePointer(event.clientX, event.clientY);
      if (this.active.slot) void this.commit();
      else this.cancel('No mount selected. Drag closer to a compatible slot.');
      return;
    }
    if (!click || click.pointerId !== event.pointerId || click.moved
      || Math.hypot(event.clientX - click.x, event.clientY - click.y) > CLICK_SLOP
      || !this.insideCanvas(event.clientX, event.clientY)) return;
    if (this.active?.mode === 'place') {
      this.updatePointer(event.clientX, event.clientY, true);
      if (this.active.slot) void this.commit();
    } else this.focusAt(event.clientX, event.clientY);
  };

  private focusAt(x: number, y: number): void {
    if (!this.options.onFocus) return;
    this.setRay(x, y);
    const instances = this.options.assembly.instances;
    const roots = [...instances.values()].filter(instance => !instance.parentId).map(instance => instance.node);
    const hits = this.raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      let ancestor: Object3D | null = hit.object;
      let instance: ComponentInstance | undefined;
      let ignored = false;
      while (ancestor) {
        if (!ancestor.visible || ancestor.userData.pickable === false) { ignored = true; break; }
        if (!instance && typeof ancestor.userData.instanceId === 'string') instance = instances.get(ancestor.userData.instanceId);
        ancestor = ancestor.parent;
      }
      if (ignored || !instance) continue;
      const materials = (hit.object as Mesh).material;
      const material = Array.isArray(materials) ? materials[hit.face?.materialIndex ?? 0] : materials;
      if (material) {
        const transmission = 'transmission' in material ? Number(material.transmission) : 0;
        if (transmission >= 0.5 || material.transparent && material.opacity <= 0.25) continue;
      }
      this.options.onFocus(instance);
      return;
    }
  }

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.active?.mode !== 'drag' || this.active.pointerId === event.pointerId) this.cancel();
    this.clickStart = null;
  };

  private readonly onWindowBlur = (): void => { this.cancel(); };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.active) return;
    if (event.key === 'Escape') { event.preventDefault(); this.cancel('Placement cancelled.'); return; }
    if (this.active.mode !== 'place') return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (event.key === 'Enter') { event.preventDefault(); void this.commit(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const slots = this.matchingSlots(this.active.kind);
    const current = slots.findIndex(slot => slot === this.active?.slot);
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    this.setCandidate(slots[(current + delta + slots.length) % slots.length] ?? null);
  };

  private readonly onAssemblyChange = (): void => {
    if (!this.active?.slot) return;
    const slot = this.options.assembly.slots.get(this.active.slot.slotId);
    if (!slot || slot !== this.active.slot) { this.cancel('The selected mounting point is no longer available.'); return; }
    this.setCandidate(slot);
  };

  private notifyPlacement(): void {
    const state = this.state;
    const key = JSON.stringify(state);
    if (key === this.notificationKey) return;
    this.notificationKey = key;
    this.options.onPlacementChange?.(state);
  }

  private report(message: string, level: 'info' | 'success' | 'error' = 'info'): void {
    this.options.onReport?.(message, level);
  }
}
