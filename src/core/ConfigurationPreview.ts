import { getSlotDefinitions } from '../config/hardware';
import { Assembly } from './Assembly';
import type { BoardMountLayout, ComponentInstance, FormFactor, ModelTransform, PartKind } from './types';
import { modelTransformKey } from './types';

export interface PreviewProduct {
  id: string;
  name: string;
  detail: string;
  /** Browser-ready GLB URL, normally resolved through the authenticated model file API. */
  modelPath: string;
  formFactor?: FormFactor;
  modelTransform?: ModelTransform;
  boardMountLayout?: BoardMountLayout;
  componentPlacements?: Record<string, BoardMountLayout>;
}

export type PreviewSelection = Partial<Record<PartKind, PreviewProduct>>;

interface PreviewMount { kind: PartKind; slotId?: string; parent?: PartKind }

/** Selected products use their catalog-linked GLB and are calibrated into the active board/case connector system.
 * A mount is available only when its parent chain is selected; RAM and fan kits expand to fixed local slots. */
const PREVIEW_MOUNTS: readonly PreviewMount[] = [
  { kind: 'case' },
  { kind: 'motherboard', slotId: 'case:motherboard', parent: 'case' },
  { kind: 'cpu', slotId: 'motherboard:cpu', parent: 'motherboard' },
  { kind: 'cooler', slotId: 'cpu:cooler', parent: 'cpu' },
  { kind: 'ram', slotId: 'motherboard:dimm2', parent: 'motherboard' },
  { kind: 'ram', slotId: 'motherboard:dimm4', parent: 'motherboard' },
  { kind: 'gpu', slotId: 'motherboard:pcie1', parent: 'motherboard' },
  { kind: 'psu', slotId: 'case:psu', parent: 'case' },
  { kind: 'ssd', slotId: 'motherboard:m2-1', parent: 'motherboard' },
  { kind: 'fan', slotId: 'case:fan-rear', parent: 'case' },
  { kind: 'fan', slotId: 'case:fan-front-1', parent: 'case' },
  { kind: 'fan', slotId: 'case:fan-front-2', parent: 'case' },
  { kind: 'fan', slotId: 'case:fan-front-3', parent: 'case' },
  { kind: 'radiator', slotId: 'case:radiator-top', parent: 'case' },
];

/** Owns the contents of a dedicated Assembly, but never its asset or render resources. */
export class ConfigurationPreview {
  private products: PreviewSelection = {};
  private operation?: Promise<void>;
  private revision = 0;
  private disposed = false;
  private generation = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly assembly: Assembly) {
    this.unsubscribe = assembly.subscribe(event => {
      if (event.type === 'installed' && event.instanceId) {
        const instance = assembly.instances.get(event.instanceId);
        if (instance) this.label(instance);
      }
    });
  }

  /** Replace the selection snapshot. Omitted kinds represent None: immediately
   * remove/cancel their mounts and descendants, while retaining unrelated geometry. */
  setProducts(selection: PreviewSelection): void {
    if (this.disposed) return;
    const snapshot: PreviewSelection = {};
    for (const [kind, product] of Object.entries(selection) as [PartKind, PreviewProduct | undefined][]) {
      if (product) snapshot[kind] = { id: product.id, name: product.name, detail: product.detail, modelPath: product.modelPath, formFactor: product.formFactor, modelTransform: product.modelTransform, boardMountLayout: product.boardMountLayout, componentPlacements: product.componentPlacements };
    }
    this.products = snapshot;
    this.revision += 1;
    this.pruneUnavailableMounts();
    for (const instance of this.assembly.instances.values()) this.label(instance);
  }

  /** Reconcile the latest snapshot. Concurrent requests share one drain operation,
   * including selection changes that occur while an earlier asset is loading. */
  load(): Promise<void> {
    if (this.disposed) return Promise.reject(this.cancelled());
    if (this.operation) return this.operation;
    if (this.hasDesiredLayout()) return Promise.resolve();
    const epoch = this.generation;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    this.operation = operation;
    const advance = () => {
      const attemptedRevision = this.revision;
      void this.reconcile(epoch).then(completedRevision => {
        if (this.disposed || epoch !== this.generation) { this.operation = undefined; reject(this.cancelled()); return; }
        // Recheck in the same callback that settles the shared promise. A change
        // queued after reconcile() returned must not resolve an outdated load.
        if (completedRevision !== this.revision || !this.hasDesiredLayout()) { advance(); return; }
        this.operation = undefined;
        resolve();
      }, error => {
        if (!this.disposed && attemptedRevision !== this.revision) { advance(); return; }
        this.operation = undefined;
        reject(this.disposed ? this.cancelled() : error);
      });
    };
    // Reserve before provider code or Assembly listeners can request another load.
    queueMicrotask(advance);
    return operation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.unsubscribe();
    // Assembly cancels reservations and safely releases late provider completions.
    // AssetRepository / GraphicsViewport disposal remains the caller's responsibility.
    this.assembly.reset();
  }

  private async reconcile(epoch: number): Promise<number> {
    this.assertCurrent(epoch);
    this.pruneUnavailableMounts();
    const desiredFormFactor: FormFactor = this.products.motherboard?.formFactor ?? 'ATX';
    const boardMountLayout = this.activeBoardMountLayout();
    if (this.assembly.formFactor !== desiredFormFactor) {
      this.assembly.reset();
      this.assembly.setFormFactor(desiredFormFactor);
    }
    const revision = this.revision;
    for (const { kind, slotId } of this.desiredMounts()) {
      this.assertCurrent(epoch);
      if (revision !== this.revision) return revision;
      let instance: ComponentInstance;
      try {
        instance = await this.assembly.install(kind, slotId, this.products[kind]?.modelPath, this.products[kind]?.modelTransform, kind === 'motherboard' ? boardMountLayout : undefined);
      } catch (error) {
        this.assertCurrent(epoch);
        // Removing a pending mount rejects its old transaction. Continue with
        // the latest selection instead of surfacing a stale cancellation error.
        if (revision !== this.revision) return revision;
        throw error;
      }
      this.assertCurrent(epoch);
      if (this.assembly.instances.get(instance.id) === instance) this.label(instance);
    }
    return revision;
  }

  private label(instance: ComponentInstance): void {
    const product = this.products[instance.kind];
    for (const object of [instance.node, instance.model]) {
      if (product) {
        object.userData.productId = product.id;
        object.userData.productName = product.name;
        object.userData.productDetail = product.detail;
        object.userData.modelPath = product.modelPath;
      } else {
        delete object.userData.productId;
        delete object.userData.productName;
        delete object.userData.productDetail;
        delete object.userData.modelPath;
      }
    }
  }

  private desiredMounts(): PreviewMount[] {
    const enabled = new Set<PartKind>();
    const formFactor = this.products.motherboard?.formFactor ?? 'ATX';
    const ramSlots = getSlotDefinitions('motherboard', formFactor, this.activeBoardMountLayout()).filter(slot => slot.accepts.includes('ram'))
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).slice(0, 2);
    const mounts = PREVIEW_MOUNTS.flatMap(mount => mount.kind !== 'ram' ? [mount]
      : mount.slotId === 'motherboard:dimm2' ? ramSlots.map(slot => ({ kind: 'ram' as const, slotId: slot.id, parent: 'motherboard' as const })) : []);
    return mounts.filter(mount => {
      if (!this.products[mount.kind] || mount.parent && !enabled.has(mount.parent)) return false;
      enabled.add(mount.kind);
      return true;
    });
  }

  private mountId(mount: PreviewMount): string {
    return ['ram', 'ssd', 'fan'].includes(mount.kind) ? `${mount.kind}@${mount.slotId}` : mount.kind;
  }

  private pruneUnavailableMounts(): void {
    const desiredMounts = this.desiredMounts();
    const desiredIds = new Set(desiredMounts.map(mount => this.mountId(mount)));
    const desiredPaths = new Map(desiredMounts.map(mount => [this.mountId(mount), { modelPath: this.products[mount.kind]?.modelPath, modelTransform: this.products[mount.kind]?.modelTransform, boardMountLayout: mount.kind === 'motherboard' ? this.activeBoardMountLayout() : undefined }]));
    const candidates = [...this.assembly.instances.values(), ...this.assembly.pending.values()];
    for (const item of candidates) {
      const desired = desiredPaths.get(item.id);
      const stale = !desiredIds.has(item.id)
        || Boolean(desired && (item.modelPath !== desired.modelPath
          || modelTransformKey(item.modelTransform) !== modelTransformKey(desired.modelTransform)
          || JSON.stringify(item.boardMountLayout ?? {}) !== JSON.stringify(desired.boardMountLayout ?? {})));
      if (stale && (this.assembly.instances.has(item.id) || this.assembly.pending.has(item.id))) {
        this.assembly.remove(item.id);
      }
    }
  }

  private hasDesiredLayout(): boolean {
    const desired = this.desiredMounts();
    return this.assembly.formFactor === (this.products.motherboard?.formFactor ?? 'ATX')
      && this.assembly.pending.size === 0
      && this.assembly.instances.size === desired.length
      && desired.every(mount => {
        const instance = this.assembly.instances.get(this.mountId(mount));
        const product = this.products[mount.kind];
        return instance?.kind === mount.kind
          && instance.slotId === (mount.slotId ?? null)
          && instance.modelPath === product?.modelPath
          && modelTransformKey(instance.modelTransform) === modelTransformKey(product?.modelTransform)
          && (mount.kind !== 'motherboard' || JSON.stringify(instance.boardMountLayout ?? {}) === JSON.stringify(this.activeBoardMountLayout()));
      });
  }

  private activeBoardMountLayout(): BoardMountLayout {
    const layout: BoardMountLayout = { ...(this.products.motherboard?.boardMountLayout ?? {}) };
    const motherboard = this.products.motherboard;
    if (!motherboard) return layout;
    for (const kind of ['cpu', 'ram', 'gpu', 'ssd'] as const) {
      const placement = motherboard.componentPlacements?.[kind];
      if (placement) Object.assign(layout, placement);
    }
    return layout;
  }

  private assertCurrent(epoch: number): void {
    if (this.disposed || epoch !== this.generation) throw this.cancelled();
  }

  private cancelled(): DOMException {
    return new DOMException('The configuration preview has been disposed.', 'AbortError');
  }
}
