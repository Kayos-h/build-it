import { Box3, Camera, Matrix4, Object3D, Plane, Ray, Vector2, Vector3 } from 'three';

export interface SlotPickTarget {
  object: Object3D;
  localBounds: Box3;
  snapVector: Vector3;
  /** Maximum connector-local distance outside the picking box, in meters. */
  snapRadius: number;
}

export interface SlotHit {
  point: Vector3;
  distance: number;
  screenDistance: number;
  direct: boolean;
}

/**
 * Test in connector space rather than against an axis-aligned world box. This
 * remains an oriented-box test when the case or a component is rotated.
 * The fallback requires BOTH physical proximity and pixel proximity so a
 * distant click cannot silently install a part into the nearest available slot.
 */
export function hitTestSlot(
  ray: Ray,
  camera: Camera,
  pointer: Vector2,
  viewport: { width: number; height: number },
  target: SlotPickTarget,
  maxPixelRadius = 72,
): SlotHit | null {
  target.object.updateWorldMatrix(true, false);
  const inverse = new Matrix4().copy(target.object.matrixWorld).invert();
  const localRay = ray.clone().applyMatrix4(inverse);
  const center = target.localBounds.getCenter(new Vector3());
  const worldCenter = center.clone().applyMatrix4(target.object.matrixWorld);
  const projected = worldCenter.clone().project(camera);
  if (projected.z < -1 || projected.z > 1) return null;

  const screenDistance = Math.hypot(
    (pointer.x - projected.x) * viewport.width * 0.5,
    (pointer.y - projected.y) * viewport.height * 0.5,
  );
  const localHit = localRay.intersectBox(target.localBounds, new Vector3());
  if (localHit) {
    const point = localHit.applyMatrix4(target.object.matrixWorld);
    return { point, distance: ray.origin.distanceTo(point), screenDistance, direct: true };
  }

  if (screenDistance > maxPixelRadius) return null;
  const normal = target.snapVector.clone().normalize();
  if (normal.lengthSq() === 0) normal.set(0, 0, 1);
  const plane = new Plane().setFromNormalAndCoplanarPoint(normal, center);
  const planeHit = localRay.intersectPlane(plane, new Vector3());
  if (!planeHit || target.localBounds.distanceToPoint(planeHit) > target.snapRadius) return null;
  const point = planeHit.applyMatrix4(target.object.matrixWorld);
  return { point, distance: ray.origin.distanceTo(point), screenDistance, direct: false };
}

/** Exact intersections win; overlapping mounting volumes prefer the nearer face. */
export function compareSlotHits(a: SlotHit, b: SlotHit): number {
  if (a.direct !== b.direct) return a.direct ? -1 : 1;
  if (a.direct && Math.abs(a.distance - b.distance) > 0.002) return a.distance - b.distance;
  return a.screenDistance - b.screenDistance;
}
