export type Vec3 = [number, number, number];

export interface StoredModelTransform {
  normalization?: 'slot-v1';
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface StoredModelBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

export const DEFAULT_MODEL_TRANSFORM: StoredModelTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

const finiteVec3 = (value: unknown, fallback: Vec3): Vec3 => {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  const next = value.map(item => Number(item));
  return next.every(Number.isFinite) ? next as Vec3 : [...fallback];
};

export function normalizeModelTransform(value: unknown): StoredModelTransform {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const scale = typeof source.scale === 'number'
    ? [source.scale, source.scale, source.scale] as Vec3
    : finiteVec3(source.scale, DEFAULT_MODEL_TRANSFORM.scale);
  return {
    ...(source.normalization === 'slot-v1' ? { normalization: 'slot-v1' as const } : {}),
    position: finiteVec3(source.position, DEFAULT_MODEL_TRANSFORM.position),
    rotation: finiteVec3(source.rotation, DEFAULT_MODEL_TRANSFORM.rotation),
    scale: scale.every(value => value > 0) ? scale : [...DEFAULT_MODEL_TRANSFORM.scale],
  };
}

export function normalizeModelBounds(value: unknown): StoredModelBounds | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const bounds = {
    min: finiteVec3(source.min, [0, 0, 0]),
    max: finiteVec3(source.max, [0, 0, 0]),
    size: finiteVec3(source.size, [0, 0, 0]),
    center: finiteVec3(source.center, [0, 0, 0]),
  };
  return bounds.size.some(value => value > 0) ? bounds : null;
}

export function transformJson(transform: StoredModelTransform = DEFAULT_MODEL_TRANSFORM): string {
  return JSON.stringify(normalizeModelTransform(transform));
}

export function isIdentityTransform(transform: StoredModelTransform): boolean {
  const normalized = normalizeModelTransform(transform);
  return JSON.stringify(normalized) === transformJson();
}
