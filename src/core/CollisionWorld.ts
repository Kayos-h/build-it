import { Box3, Matrix4, Vector3 } from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import type { BoundsDefinition, ComponentInstance, PartKind, SpatialObstacle, ValidationResult } from './types';

export function toBox3(bounds: BoundsDefinition): Box3 {
  return new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max));
}

/** Broad-phase AABB followed by an oriented-box SAT narrow phase. */
export class CollisionWorld {
  readonly obstacles = new Map<string, SpatialObstacle>();
  /** Touching mounting surfaces are allowed; visible interpenetration is not. */
  readonly contactTolerance = .0001;

  add(obstacle: SpatialObstacle): void { this.obstacles.set(obstacle.id, obstacle); }
  removeOwner(owner: ComponentInstance['node']): void {
    for (const [id, obstacle] of this.obstacles) if (obstacle.owner === owner) this.obstacles.delete(id);
  }
  clear(): void { this.obstacles.clear(); }

  private orientedBox(bounds: Box3, transform: Matrix4): OBB {
    const inset = bounds.clone();
    // Shrink only to distinguish a shared contact plane from real overlap.
    const half = inset.getSize(new Vector3()).multiplyScalar(.5);
    const amount = Math.min(this.contactTolerance, half.x * .2, half.y * .2, half.z * .2);
    inset.expandByScalar(-amount);
    const oriented = new OBB().fromBox3(inset);
    // Three's OBB.applyMatrix4 adds translation to the center; it does not rotate
    // an off-origin center. Connector-local boxes are intentionally off-center.
    const worldCenter = oriented.center.clone().applyMatrix4(transform);
    oriented.applyMatrix4(transform);
    oriented.center.copy(worldCenter);
    oriented.halfSize.set(Math.abs(oriented.halfSize.x), Math.abs(oriented.halfSize.y), Math.abs(oriented.halfSize.z));
    return oriented;
  }

  intersects(a: Box3, matrixA: Matrix4, b: Box3, matrixB: Matrix4): boolean {
    if (!a.clone().applyMatrix4(matrixA).intersectsBox(b.clone().applyMatrix4(matrixB))) return false;
    return this.orientedBox(a, matrixA).intersectsOBB(this.orientedBox(b, matrixB), 1e-8);
  }

  check(
    kind: PartKind,
    candidateBounds: readonly Box3[],
    transform: Matrix4,
    instances: Iterable<ComponentInstance>,
    ignoredInstanceIds: ReadonlySet<string> = new Set(),
    ignoredObstacleOwners: ReadonlySet<SpatialObstacle['owner']> = new Set(),
  ): ValidationResult {
    const collisions: string[] = [];
    for (const obstacle of this.obstacles.values()) {
      if (obstacle.except?.includes(kind) || ignoredObstacleOwners.has(obstacle.owner)) continue;
      obstacle.owner.updateWorldMatrix(true, false);
      if (candidateBounds.some(candidate => this.intersects(candidate, transform, obstacle.localBounds, obstacle.owner.matrixWorld))) {
        collisions.push(obstacle.label);
      }
    }
    for (const instance of instances) {
      if (instance.kind === 'case' || ignoredInstanceIds.has(instance.id)) continue;
      instance.node.updateWorldMatrix(true, false);
      const installedBounds = instance.definition.collisionBounds ?? [instance.definition.bounds];
      if (candidateBounds.some(candidate => installedBounds.some(existing => this.intersects(candidate, transform, toBox3(existing), instance.node.matrixWorld)))) {
        collisions.push(instance.definition.label);
      }
    }
    return collisions.length
      ? { valid: false, code: 'collision', reason: `Clearance blocked by ${[...new Set(collisions)].join(', ')}.`, collisions }
      : { valid: true };
  }

  /** Test every corner in the case frame, so containment works after case rotation. */
  containedIn(candidate: Box3, candidateTransform: Matrix4, enclosure: Box3, enclosureTransform: Matrix4): boolean {
    const relative = enclosureTransform.clone().invert().multiply(candidateTransform);
    const interior = enclosure.clone().expandByScalar(this.contactTolerance);
    for (const x of [candidate.min.x, candidate.max.x]) {
      for (const y of [candidate.min.y, candidate.max.y]) {
        for (const z of [candidate.min.z, candidate.max.z]) {
          if (!interior.containsPoint(new Vector3(x, y, z).applyMatrix4(relative))) return false;
        }
      }
    }
    return true;
  }
}
