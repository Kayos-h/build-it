import { Box3, Group, Matrix4, Vector3 } from 'three';
import type { PartKind, SlotDefinition } from './types';

/** A mount is a real scene-graph transform, owned by the hardware carrying it. */
export class SlotNode extends Group {
  readonly slotId: string;
  readonly label: string;
  readonly ownerId: string;
  readonly accepts: readonly PartKind[];
  readonly localBounds: Box3;
  readonly snapVector: Vector3;
  readonly snapRadius: number;
  readonly priority: number;
  readonly screwPoints: readonly Vector3[];
  occupantId: string | null = null;

  constructor(definition: SlotDefinition, ownerId: string) {
    super();
    this.slotId = definition.id;
    this.name = `slot:${definition.id}`;
    this.label = definition.label;
    this.ownerId = ownerId;
    this.accepts = [...definition.accepts];
    this.localBounds = new Box3(new Vector3(...definition.bounds.min), new Vector3(...definition.bounds.max));
    this.snapVector = new Vector3(...definition.snapVector).normalize();
    this.snapRadius = definition.snapRadius;
    this.priority = definition.priority ?? 0;
    this.screwPoints = (definition.screwPoints ?? []).map(point => new Vector3(...point));
    this.position.set(...definition.position);
    if (definition.rotation) this.rotation.set(...definition.rotation);
    this.userData.slotId = this.slotId;
    this.userData.isSlot = true;
    this.updateMatrix();
  }

  acceptsKind(kind: PartKind): boolean { return this.accepts.includes(kind); }

  getSnapMatrix(target = new Matrix4()): Matrix4 {
    this.updateWorldMatrix(true, false);
    return target.copy(this.matrixWorld);
  }

  getWorldBounds(target = new Box3()): Box3 {
    return target.copy(this.localBounds).applyMatrix4(this.getSnapMatrix());
  }

  getWorldSnapVector(target = new Vector3()): Vector3 {
    return target.copy(this.snapVector).transformDirection(this.getSnapMatrix());
  }

  /** An approach preview can move in world space; the committed mount never does. */
  getApproachMatrix(distance: number, target = new Matrix4()): Matrix4 {
    return this.getSnapMatrix(target).multiply(new Matrix4().makeTranslation(
      this.snapVector.x * distance, this.snapVector.y * distance, this.snapVector.z * distance,
    ));
  }
}
