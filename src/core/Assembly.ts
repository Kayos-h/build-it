import { Group, Matrix4, Object3D, Vector3 } from 'three';
import { BOARD_PROFILES, CASE_INTERIOR, GPU_BRACKET_LOCAL, MOUNT_TOLERANCE, getDefinition, getObstacleDefinitions, getSlotDefinitions } from '../config/hardware';
import { CollisionWorld, toBox3 } from './CollisionWorld';
import { SlotNode } from './SlotNode';
import { modelTransformKey } from './types';
import type { AssemblyEvent, AssetProvider, BoardMountLayout, ComponentDefinition, ComponentInstance, FormFactor, ModelTransform, PartKind, PendingInstallation, ValidationResult } from './types';

const requiredParent: Partial<Record<PartKind, PartKind>> = {
  motherboard: 'case', cpu: 'motherboard', cooler: 'cpu', ram: 'motherboard',
  gpu: 'motherboard', psu: 'case', ssd: 'motherboard', fan: 'case', radiator: 'case',
};
const multiple = new Set<PartKind>(['ram', 'fan', 'ssd']);

export class AssemblyError extends Error {
  constructor(message: string, readonly code: ValidationResult['code']) { super(message); this.name = 'AssemblyError'; }
}

/** Transactional hardware graph. A component exists only after its model is loaded,
 * its parent is still installed, and every mounting/clearance check has passed. */
export class Assembly {
  readonly root = new Group();
  readonly instances = new Map<string, ComponentInstance>();
  readonly slots = new Map<string, SlotNode>();
  readonly pending = new Map<string, PendingInstallation>();
  readonly collisionWorld = new CollisionWorld();
  private readonly listeners = new Set<(event: AssemblyEvent) => void>();
  private readonly releaseModel?: (model: Object3D) => void;
  private generation = 0;
  private profile: FormFactor;

  constructor(private readonly provider: AssetProvider, options: { formFactor?: FormFactor; release?: (model: Object3D) => void } = {}) {
    this.profile = options.formFactor ?? 'ATX';
    this.releaseModel = options.release;
    this.root.name = 'PC assembly';
  }

  get formFactor(): FormFactor { return this.profile; }
  get watts(): number { return [...this.instances.values()].reduce((sum, instance) => sum + instance.definition.watts, 0); }
  getDefinition(kind: PartKind): ComponentDefinition { return getDefinition(kind, this.profile); }

  subscribe(listener: (event: AssemblyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AssemblyEvent): void {
    for (const listener of this.listeners) {
      // Rendering/UI observers must never roll back a successful graph transaction.
      try { listener(event); } catch (error) { console.error('Assembly observer failed:', error); }
    }
  }

  private release(model: Object3D): void {
    model.removeFromParent();
    try { this.releaseModel?.(model); } catch (error) { console.error('Asset release failed:', error); }
  }

  findByKind(kind: PartKind): ComponentInstance[] {
    return [...this.instances.values()].filter(instance => instance.kind === kind);
  }

  getAvailableSlots(kind: PartKind): SlotNode[] {
    const reservations = new Set([...this.pending.values()].map(request => request.slotId));
    return [...this.slots.values()]
      .filter(slot => slot.acceptsKind(kind) && !slot.occupantId && !reservations.has(slot.slotId))
      .sort((a, b) => a.priority - b.priority);
  }

  private ancestorsOf(instanceId: string): Set<string> {
    const ancestors = new Set<string>();
    let current: string | null = instanceId;
    while (current) {
      ancestors.add(current);
      current = this.instances.get(current)?.parentId ?? null;
    }
    return ancestors;
  }

  private instanceId(kind: PartKind, slotId: string | null): string {
    return multiple.has(kind) && slotId ? `${kind}@${slotId}` : kind;
  }

  validate(kind: PartKind, slotId?: string, options: { ignoreReservationId?: string; ignoreInstanceId?: string; skipGeometry?: boolean; definition?: ComponentDefinition } = {}): ValidationResult {
    if (kind === 'case') return this.instances.has('case')
      ? { valid: false, code: 'occupied', reason: 'A case is already installed.' }
      : { valid: true };
    const parentKind = requiredParent[kind];
    if (parentKind && !this.findByKind(parentKind).length) {
      return { valid: false, code: 'prerequisite', reason: `Install the ${getDefinition(parentKind, this.profile).label.toLowerCase()} first.` };
    }
    const targetId = slotId ?? this.getAvailableSlots(kind)[0]?.slotId;
    const slot = targetId ? this.slots.get(targetId) : undefined;
    if (!slot) return { valid: false, code: 'missing-slot', reason: `No ${kind} mount is available.` };
    if (!slot.acceptsKind(kind)) return { valid: false, code: 'incompatible', reason: `${slot.label} does not accept a ${kind}.` };
    if (slot.occupantId && slot.occupantId !== options.ignoreInstanceId) {
      return { valid: false, code: 'occupied', reason: `${slot.label} is already occupied.` };
    }
    if ([...this.pending.values()].some(request => request.slotId === targetId && request.id !== options.ignoreReservationId)) {
      return { valid: false, code: 'occupied', reason: `${slot.label} is currently being installed.` };
    }
    if (!this.instances.has(slot.ownerId)) return { valid: false, code: 'prerequisite', reason: 'The mount owner is no longer installed.' };
    if (options.skipGeometry) return { valid: true };
    const worldMatrix = slot.getSnapMatrix();
    return this.validateTransform(kind, slot, worldMatrix, options.ignoreInstanceId, options.definition);
  }

  /** Used both for release validation and by collision-aware preview tools. */
  validateTransform(kind: PartKind, slot: SlotNode, worldMatrix: Matrix4, ignoreInstanceId?: string, definition = this.getDefinition(kind)): ValidationResult {
    const chassis = this.instances.get('case');
    if (!chassis) return { valid: false, code: 'prerequisite', reason: 'Install the PC case first.' };
    chassis.node.updateWorldMatrix(true, false);
    const collisionBounds = (definition.collisionBounds ?? [definition.bounds]).map(toBox3);
    const ignored = this.ancestorsOf(slot.ownerId);
    if (ignoreInstanceId) ignored.add(ignoreInstanceId);
    // Revalidating a motherboard must not collide its PCB with its own VRM
    // fixtures. Ancestor-owned fixtures still participate for CPU/RAM/cooler.
    const ignoredObstacleOwners = new Set<Object3D>();
    if (ignoreInstanceId) {
      const self = this.instances.get(ignoreInstanceId);
      if (self) ignoredObstacleOwners.add(self.node);
    }
    const collision = this.collisionWorld.check(kind, collisionBounds, worldMatrix, this.instances.values(), ignored, ignoredObstacleOwners);
    if (!collision.valid) return collision;
    if (!this.collisionWorld.containedIn(toBox3(definition.bounds), worldMatrix, toBox3(CASE_INTERIOR), chassis.node.matrixWorld)) {
      return { valid: false, code: 'collision', reason: 'The component extends beyond the case clearance envelope.', collisions: ['case interior'] };
    }
    if (kind === 'gpu') {
      const bracket = this.slots.get('case:gpu-bracket');
      if (!bracket) return { valid: false, code: 'alignment', reason: 'The rear expansion-slot bracket is unavailable.' };
      const actual = new Vector3(...GPU_BRACKET_LOCAL).applyMatrix4(worldMatrix);
      const target = new Vector3().setFromMatrixPosition(bracket.getSnapMatrix());
      const actualNormal = new Vector3(-1, 0, 0).transformDirection(worldMatrix);
      const targetNormal = bracket.getWorldSnapVector();
      if (actual.distanceTo(target) > MOUNT_TOLERANCE || actualNormal.angleTo(targetNormal) > Math.PI / 90) {
        return { valid: false, code: 'alignment', reason: 'GPU I/O bracket does not align with the rear expansion slot (1.5 mm / 2° tolerance).' };
      }
    }
    return { valid: true };
  }

  /** The promise itself is shared for repeated clicks on the same pending mount. */
  install(kind: PartKind, requestedSlotId?: string, requestedModelPath?: string, requestedModelTransform?: ModelTransform, requestedBoardMountLayout?: BoardMountLayout): Promise<ComponentInstance> {
    if (!requestedSlotId) {
      const inFlight = [...this.pending.values()].find(request => request.kind === kind);
      if (inFlight) return inFlight.promise;
      if (!multiple.has(kind)) {
        const existing = this.findByKind(kind)[0];
        if (existing) return Promise.resolve(existing);
      }
    }
    const slotId = kind === 'case' ? null : (requestedSlotId ?? this.getAvailableSlots(kind)[0]?.slotId ?? null);
    const id = this.instanceId(kind, slotId);
    const existingRequest = this.pending.get(id);
    if (existingRequest) {
      if (modelTransformKey(existingRequest.modelTransform) === modelTransformKey(requestedModelTransform) && JSON.stringify(existingRequest.boardMountLayout ?? {}) === JSON.stringify(requestedBoardMountLayout ?? {}) && (!requestedModelPath || existingRequest.modelPath === requestedModelPath)) return existingRequest.promise;
      // A newer SKU can request a different asset for the same mount. Cancel the
      // stale reservation; ConfigurationPreview will immediately enqueue the
      // replacement through its next reconciliation pass.
      this.remove(id);
    }
    const existingInstance = this.instances.get(id);
    if (existingInstance && existingInstance.slotId === slotId) {
      if (modelTransformKey(existingInstance.modelTransform) === modelTransformKey(requestedModelTransform) && JSON.stringify(existingInstance.boardMountLayout ?? {}) === JSON.stringify(requestedBoardMountLayout ?? {}) && (!requestedModelPath || existingInstance.modelPath === requestedModelPath)) return Promise.resolve(existingInstance);
      this.remove(id);
    }
    const validation = this.validate(kind, slotId ?? undefined, { skipGeometry: requestedModelTransform?.normalization === 'slot-v1' });
    if (!validation.valid) return Promise.reject(new AssemblyError(validation.reason ?? 'Mount validation failed.', validation.code));
    const slot = slotId ? this.slots.get(slotId)! : null;
    const parentId = slot?.ownerId ?? null;
    const epoch = this.generation;
    const controller = new AbortController();
    const baseDefinition = this.getDefinition(kind);
    let definition = baseDefinition;
    let resolve!: (instance: ComponentInstance) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ComponentInstance>((done, fail) => { resolve = done; reject = fail; });
    const request: PendingInstallation = { id, kind, slotId, parentId, modelPath: requestedModelPath, modelTransform: requestedModelTransform, boardMountLayout: requestedBoardMountLayout, controller, promise };
    // Reserve before notifying observers or entering provider code.
    this.pending.set(id, request);
    const cancel = () => reject(new AssemblyError('Installation cancelled.', 'cancelled'));
    controller.signal.addEventListener('abort', cancel, { once: true });
    this.emit({ type: 'loading', instanceId: id, kind });

    void (async () => {
      let model: Object3D | undefined;
      try {
        if (controller.signal.aborted) throw new AssemblyError('Installation cancelled.', 'cancelled');
        model = await this.provider(kind, { instanceId: id, slotId, formFactor: this.profile, definition, modelPath: requestedModelPath, modelTransform: requestedModelTransform, signal: controller.signal });
        if (controller.signal.aborted || epoch !== this.generation || this.pending.get(id) !== request) {
          throw new AssemblyError('Installation cancelled.', 'cancelled');
        }
        if (slot && (this.slots.get(slot.slotId) !== slot || !this.instances.has(slot.ownerId))) {
          throw new AssemblyError('The mount was removed before the asset finished loading.', 'prerequisite');
        }
        if (requestedModelTransform?.normalization === 'slot-v1' && model.userData.physicalBounds) {
          const bounds = model.userData.physicalBounds;
          definition = { ...baseDefinition, bounds, collisionBounds: kind === 'motherboard' ? baseDefinition.collisionBounds : [bounds] };
        }
        const finalValidation = this.validate(kind, slotId ?? undefined, { ignoreReservationId: id, definition });
        if (!finalValidation.valid) throw new AssemblyError(finalValidation.reason ?? 'Mount validation failed.', finalValidation.code);
        const node = new Group();
        node.name = `${definition.label} [${id}]`;
        node.userData.instanceId = id;
        node.userData.kind = kind;
        node.add(model);
        const instance: ComponentInstance = { id, kind, slotId, parentId, node, model, modelPath: requestedModelPath, modelTransform: requestedModelTransform, boardMountLayout: requestedBoardMountLayout, definition, installedAt: Date.now() };
        // A connector-local identity transform is the only committed placement.
        // No world-space component offset is stored anywhere in this graph.
        (slot ?? this.root).add(node);
        if (slot) slot.occupantId = id;
        this.instances.set(id, instance);
        this.addOwnedNodes(instance, requestedBoardMountLayout);
        this.pending.delete(id);
        controller.signal.removeEventListener('abort', cancel);
        this.root.updateMatrixWorld(true);
        this.emit({ type: 'installed', instanceId: id, kind });
        resolve(instance);
      } catch (cause) {
        if (model) this.release(model);
        if (this.pending.get(id) === request) this.pending.delete(id);
        controller.signal.removeEventListener('abort', cancel);
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (!controller.signal.aborted) this.emit({ type: 'error', instanceId: id, kind, error });
        reject(error);
      }
    })();
    return promise;
  }

  private addOwnedNodes(instance: ComponentInstance, boardMountLayout?: BoardMountLayout): void {
    for (const definition of getSlotDefinitions(instance.kind, this.profile, boardMountLayout)) {
      const slot = new SlotNode(definition, instance.id);
      instance.node.add(slot);
      this.slots.set(slot.slotId, slot);
    }
    for (const obstacle of getObstacleDefinitions(instance.kind, this.profile)) {
      this.collisionWorld.add({
        id: `${instance.id}:${obstacle.id}`, label: obstacle.label,
        owner: instance.node, localBounds: toBox3(obstacle.bounds), except: obstacle.except,
      });
    }
  }

  /** Removing an owner removes its entire subtree and cancels dependent requests. */
  remove(instanceId: string): void {
    const affected = new Set<string>([instanceId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const instance of this.instances.values()) {
        if (instance.parentId && affected.has(instance.parentId) && !affected.has(instance.id)) {
          affected.add(instance.id); changed = true;
        }
      }
      for (const request of this.pending.values()) {
        if (request.parentId && affected.has(request.parentId) && !affected.has(request.id)) {
          affected.add(request.id); changed = true;
        }
      }
    }
    for (const id of affected) {
      const request = this.pending.get(id);
      if (request) { this.pending.delete(id); request.controller.abort(); }
    }
    const removed: ComponentInstance[] = [];
    for (const id of [...affected].reverse()) {
      const instance = this.instances.get(id);
      if (!instance) continue;
      if (instance.slotId) {
        const slot = this.slots.get(instance.slotId);
        if (slot?.occupantId === id) slot.occupantId = null;
      }
      for (const [slotId, slot] of this.slots) if (slot.ownerId === id) this.slots.delete(slotId);
      this.collisionWorld.removeOwner(instance.node);
      instance.node.removeFromParent();
      this.release(instance.model);
      this.instances.delete(id);
      removed.push(instance);
    }
    for (const instance of removed) this.emit({ type: 'removed', instanceId: instance.id, kind: instance.kind });
    if (!removed.length) this.emit({ type: 'removed', instanceId });
  }

  reset(): void {
    this.generation++;
    for (const request of this.pending.values()) request.controller.abort();
    this.pending.clear();
    for (const instance of this.instances.values()) this.release(instance.model);
    this.instances.clear();
    this.slots.clear();
    this.collisionWorld.clear();
    this.root.clear();
    this.emit({ type: 'reset' });
  }

  setFormFactor(formFactor: FormFactor): void {
    if (!(formFactor in BOARD_PROFILES)) throw new Error(`Unknown motherboard form factor: ${formFactor}`);
    if (formFactor === this.profile) return;
    if (this.findByKind('motherboard').length || [...this.pending.values()].some(request => request.kind === 'motherboard')) {
      throw new Error('Remove the motherboard before changing the standoff layout.');
    }
    this.profile = formFactor;
    const chassis = this.instances.get('case');
    if (chassis) {
      for (const slotId of ['case:motherboard', 'case:gpu-bracket']) {
        const previous = this.slots.get(slotId);
        previous?.removeFromParent();
        const definition = getSlotDefinitions('case', formFactor).find(slot => slot.id === slotId)!;
        const replacement = new SlotNode(definition, chassis.id);
        chassis.node.add(replacement);
        this.slots.set(replacement.slotId, replacement);
      }
    }
    this.emit({ type: 'profile' });
  }

  /** A compact inspectable graph for diagnostics and regression tests. */
  snapshot(): { formFactor: FormFactor; watts: number; instances: { id: string; kind: PartKind; parentId: string | null; slotId: string | null }[]; pending: string[] } {
    return {
      formFactor: this.profile, watts: this.watts,
      instances: [...this.instances.values()].map(({ id, kind, parentId, slotId }) => ({ id, kind, parentId, slotId })),
      pending: [...this.pending.keys()],
    };
  }
}
