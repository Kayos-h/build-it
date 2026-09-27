import type { Box3, Group, Object3D } from 'three';

export type PartKind = 'case' | 'motherboard' | 'cpu' | 'cooler' | 'ram' | 'gpu' | 'psu' | 'ssd' | 'fan' | 'radiator';
export type FormFactor = 'ATX' | 'mATX' | 'ITX';
export type Vec3 = readonly [number, number, number];

export type BoardMountId = 'motherboard:cpu' | 'motherboard:dimm1' | 'motherboard:dimm2' | 'motherboard:dimm3' | 'motherboard:dimm4' | 'motherboard:m2-1' | 'motherboard:pcie1';
export interface BoardMountOverride { position: Vec3; rotation?: Vec3 }
export type BoardMountLayout = Partial<Record<BoardMountId, BoardMountOverride>>;

export interface ModelTransform {
  /** Shared orientation, uniform fitting and anchoring after rotation. */
  normalization?: 'slot-v1';
  /** Extra scalar/vector multiplier applied after automatic envelope fitting. */
  scale?: number | Vec3;
  /** Extra XYZ Euler rotation, in radians, applied after the built-in asset orientation. */
  rotation?: Vec3;
  /** Extra XYZ local offset in metres, applied after automatic mounting alignment. */
  position?: Vec3;
}

/** Stable comparison key for configuration/scene reconciliation. */
export function modelTransformKey(transform?: ModelTransform): string {
  if (!transform) return '';
  return JSON.stringify({
    normalization: transform.normalization ?? null,
    scale: transform.scale ?? null,
    rotation: transform.rotation ?? null,
    position: transform.position ?? null,
  });
}

/** All dimensions are meters. Mounted roots use their connector as local origin. */
export interface BoundsDefinition { min: Vec3; max: Vec3 }

export interface ComponentDefinition {
  kind: PartKind;
  label: string;
  watts: number;
  bounds: BoundsDefinition;
  /** Geometrically separate volumes prevent large empty-space AABBs blocking mounts. */
  collisionBounds?: readonly BoundsDefinition[];
  description: string;
}

export interface SlotDefinition {
  id: string;
  label: string;
  accepts: readonly PartKind[];
  position: Vec3;
  rotation?: Vec3;
  bounds: BoundsDefinition;
  /** In connector-local space: the direction from which a part approaches its seat. */
  snapVector: Vec3;
  snapRadius: number;
  priority?: number;
  screwPoints?: readonly Vec3[];
}

export interface ComponentInstance {
  id: string;
  kind: PartKind;
  slotId: string | null;
  parentId: string | null;
  node: Group;
  model: Object3D;
  /** Browser-ready catalog asset URL. */
  modelPath?: string;
  modelTransform?: ModelTransform;
  boardMountLayout?: BoardMountLayout;
  definition: ComponentDefinition;
  installedAt: number;
}

export interface AssetContext {
  instanceId: string;
  slotId: string | null;
  formFactor: FormFactor;
  definition: ComponentDefinition;
  /** Browser-ready catalog asset URL. */
  modelPath?: string;
  modelTransform?: ModelTransform;
  signal: AbortSignal;
}

/** Provider owns geometry/material resources; the assembly owns returned object transforms. */
export type AssetProvider = (kind: PartKind, context: AssetContext) => Promise<Object3D>;

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  code?: 'prerequisite' | 'occupied' | 'incompatible' | 'collision' | 'alignment' | 'missing-slot' | 'cancelled';
  collisions?: string[];
}

export interface PendingInstallation {
  id: string;
  kind: PartKind;
  slotId: string | null;
  parentId: string | null;
  /** Asset requested by this in-flight installation. */
  modelPath?: string;
  modelTransform?: ModelTransform;
  boardMountLayout?: BoardMountLayout;
  controller: AbortController;
  promise: Promise<ComponentInstance>;
}

export interface AssemblyEvent {
  type: 'loading' | 'installed' | 'removed' | 'reset' | 'error' | 'profile';
  instanceId?: string;
  kind?: PartKind;
  error?: Error;
}

export interface SpatialObstacle {
  id: string;
  label: string;
  owner: Object3D;
  localBounds: Box3;
  /** A PSU belongs inside its bay; the bay still blocks all other component kinds. */
  except?: readonly PartKind[];
}
