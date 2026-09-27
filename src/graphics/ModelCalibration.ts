import { Box3, Euler, Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { BoundsDefinition, ComponentDefinition, ModelTransform, PartKind, Vec3 } from '../core/types.js';

const EPSILON = 1e-9;
const rotations: Partial<Record<PartKind, Vec3>> = {
  motherboard: [Math.PI / 2, 0, 0], cpu: [Math.PI / 2, 0, 0], cooler: [Math.PI / 2, 0, 0],
  gpu: [Math.PI / 2, 0, 0], ssd: [Math.PI / 2, 0, 0], fan: [Math.PI / 2, 0, 0],
  case: [0, Math.PI / 2, 0], psu: [0, Math.PI / 2, 0],
};
export function baseOrientation(kind: PartKind): Quaternion {
  return kind === 'ram' ? new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(
    new Vector3(0, 1, 0), new Vector3(1, 0, 0), new Vector3(0, 0, -1),
  )) : new Quaternion().setFromEuler(new Euler(...(rotations[kind] ?? [0, 0, 0])));
}
export function measuredBounds(object: Object3D): Box3 {
  object.updateWorldMatrix(true, true);
  const box = new Box3().setFromObject(object, true);
  const size = box.getSize(new Vector3());
  if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite) || size.toArray().filter(v => v > EPSILON).length < 2) {
    throw new Error('Model must contain finite, measurable mesh geometry.');
  }
  return box;
}
/** Compare all 24 proper axis rotations. Handedness is preserved; an AABB cannot
 * identify semantic front/back, so equally good fits prefer the category orientation. */
function automaticOrientation(raw: Box3, targetSize: Vector3, kind: PartKind): Quaternion {
  const preferred = baseOrientation(kind);
  let best = preferred, bestScore = Infinity;
  for (const a of [0, 1, 2]) for (const b of [0, 1, 2]) for (const c of [0, 1, 2]) {
    if (new Set([a, b, c]).size !== 3) continue;
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) for (const sc of [-1, 1]) {
      const x = new Vector3().setComponent(a, sa), y = new Vector3().setComponent(b, sb), z = new Vector3().setComponent(c, sc);
      if (x.clone().cross(y).dot(z) < 0) continue;
      const matrix = new Matrix4().makeBasis(x, y, z);
      const rotation = new Quaternion().setFromRotationMatrix(matrix);
      const size = raw.clone().applyMatrix4(matrix).getSize(new Vector3());
      const logs = size.toArray().map((v, i) => Math.log(Math.max(v, EPSILON) / targetSize.getComponent(i)));
      const mean = logs.reduce((a, b) => a + b, 0) / 3;
      const score = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) + rotation.angleTo(preferred) * 1e-6;
      if (score < bestScore) { bestScore = score; best = rotation; }
    }
  }
  return best;
}
function anchorOffset(kind: PartKind, actual: Box3, bounds: BoundsDefinition): Vector3 {
  const min = new Vector3(...bounds.min), max = new Vector3(...bounds.max), center = actual.getCenter(new Vector3());
  switch (kind) {
    case 'case': return new Vector3(-center.x, -actual.min.y, -center.z);
    case 'gpu': return new Vector3(min.x - actual.min.x, max.y - actual.max.y, min.z - actual.min.z);
    case 'psu': case 'motherboard': return min.sub(actual.min);
    case 'ssd': return new Vector3(-actual.min.x, -center.y, -actual.min.z);
    default: return new Vector3(-center.x, -center.y, -actual.min.z);
  }
}
interface CalibrationNodes { adjustment: Group; base: Group; source: Object3D; raw: Box3 }
const nodes = new WeakMap<Group, CalibrationNodes>();
export function modelAdjustment(root: Group): Group {
  const record = nodes.get(root);
  if (!record) throw new Error('Unknown calibrated model.');
  return record.adjustment;
}
export function createCalibratedAsset(source: Object3D, kind: PartKind, definition: ComponentDefinition, transform: ModelTransform = {}): Group {
  const root = new Group(), adjustment = new Group(), base = new Group();
  root.name = 'calibrated-model'; adjustment.name = 'model-transform'; base.name = 'asset-calibration';
  base.add(source); adjustment.add(base); root.add(adjustment);
  const raw = measuredBounds(source);
  nodes.set(root, { source, adjustment, base, raw });
  applyModelCalibration(root, kind, definition, transform);
  return root;
}
export function applyModelCalibration(root: Group, kind: PartKind, definition: ComponentDefinition, transform: ModelTransform): void {
  const { adjustment, base, raw } = nodes.get(root)!;
  root.position.set(0, 0, 0);
  adjustment.position.set(0, 0, 0); adjustment.rotation.set(0, 0, 0); adjustment.scale.setScalar(1);
  base.position.set(0, 0, 0); base.scale.setScalar(1);
  const target = new Box3(new Vector3(...definition.bounds.min), new Vector3(...definition.bounds.max)).getSize(new Vector3());
  const standard = transform.normalization === 'slot-v1';
  base.quaternion.copy(standard ? automaticOrientation(raw, target, kind) : baseOrientation(kind));
  if (standard && transform.rotation) adjustment.rotation.set(...transform.rotation);
  const actual = measuredBounds(root), size = actual.getSize(new Vector3());
  const ratios = target.toArray().map((v, i) => size.getComponent(i) > EPSILON ? v / size.getComponent(i) : Infinity);
  const factor = kind === 'cpu' && !standard ? Math.min(ratios[0], ratios[1]) : Math.min(...ratios);
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('Cannot normalize this model.');
  base.scale.setScalar(factor);
  if (standard) {
    // Center the geometry at its rotation pivot before anchoring the whole result.
    // The center measured in the base's frame must scale with the vertices.
    const baseCenter = raw.getCenter(new Vector3()).applyQuaternion(base.quaternion).multiplyScalar(factor);
    base.position.copy(baseCenter).negate();
  } else {
    base.position.copy(anchorOffset(kind, measuredBounds(root), definition.bounds));
    if (transform.rotation) adjustment.rotation.set(...transform.rotation);
  }
  const scale = typeof transform.scale === 'number' ? [transform.scale, transform.scale, transform.scale] as const : transform.scale ?? [1, 1, 1];
  if (!scale.every(v => Number.isFinite(v) && v > 0)) throw new Error('Scale must be finite and positive.');
  adjustment.scale.set(...scale);
  if (standard) root.position.copy(anchorOffset(kind, measuredBounds(root), definition.bounds));
  if (transform.position) adjustment.position.set(...transform.position);
  const bounds = measuredBounds(root);
  root.userData.autoFitScale = factor;
  root.userData.physicalBounds = { min: bounds.min.toArray(), max: bounds.max.toArray() };
  root.userData.modelTransform = transform;
}
