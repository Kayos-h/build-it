import type { Product, ProductKind } from '../../src/config/products.js';
import {
  DEFAULT_MODEL_TRANSFORM,
  normalizeModelTransform,
  type StoredModelBounds,
  type StoredModelTransform,
} from './calibration.js';

export interface HardwareModelInput {
  id: string;
  kind: ProductKind;
  name: string;
  detail: string;
  modelPath: string;
  powerWatts?: number;
  metadata?: Record<string, unknown>;
  transform?: StoredModelTransform;
  bounds?: StoredModelBounds | null;
}

const numberValue = (metadata: Record<string, unknown>, key: string, fallback: number): number => {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const stringValue = <T extends string>(metadata: Record<string, unknown>, key: string, fallback: T, allowed: readonly T[]): T => {
  const value = metadata[key];
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
};

export function productFromHardwareModel(input: HardwareModelInput): Product {
  const metadata = input.metadata ?? {};
  const powerWatts = input.powerWatts ?? numberValue(metadata, 'powerWatts', 0);
  const modelTransform = normalizeModelTransform(input.transform ?? metadata.modelTransform ?? DEFAULT_MODEL_TRANSFORM);
  const base = {
    id: input.id,
    modelPath: input.modelPath,
    modelTransform,
    name: input.name,
    detail: input.detail,
    powerWatts,
    specsProvided: Object.keys(metadata).filter(key => typeof metadata[key] === 'number' && Number.isFinite(metadata[key]) && Number(metadata[key]) > 0),
  };
  switch (input.kind) {
    case 'case':
      return { ...base, kind: 'case' } as Product;
    case 'motherboard':
      return {
        ...base,
        kind: 'motherboard',
        socket: stringValue(metadata, 'socket', 'AM4', ['AM4', 'AM5', 'LGA1700']),
        memoryType: stringValue(metadata, 'memoryType', 'DDR4', ['DDR4', 'DDR5']),
        formFactor: stringValue(metadata, 'formFactor', 'ATX', ['ATX', 'mATX', 'ITX']),
        boardMountLayout: metadata.boardMountLayout as import('../../src/core/types.js').BoardMountLayout | undefined,
        componentPlacements: metadata.componentPlacements as Record<string, import('../../src/core/types.js').BoardMountLayout> | undefined,
      } as Product;
    case 'cpu':
      return {
        ...base,
        kind: 'cpu',
        socket: stringValue(metadata, 'socket', 'AM4', ['AM4', 'AM5', 'LGA1700']),
        vendor: stringValue(metadata, 'vendor', 'AMD', ['AMD', 'Intel']),
        cores: numberValue(metadata, 'cores', 6),
        threads: numberValue(metadata, 'threads', 12),
        gamingScore: numberValue(metadata, 'gamingScore', 100),
      } as Product;
    case 'cooler':
      return { ...base, kind: 'cooler' } as Product;
    case 'ram':
      return {
        ...base,
        kind: 'ram',
        memoryType: stringValue(metadata, 'memoryType', 'DDR4', ['DDR4', 'DDR5']),
        capacityGb: numberValue(metadata, 'capacityGb', 16) as 16 | 32 | 64,
        modules: 2,
        speedMtps: numberValue(metadata, 'speedMtps', 3200),
      } as Product;
    case 'gpu':
      return {
        ...base,
        kind: 'gpu',
        vramGb: numberValue(metadata, 'vramGb', 8),
        rasterScore: numberValue(metadata, 'rasterScore', 100),
        recommendedPsuWatts: numberValue(metadata, 'recommendedPsuWatts', 550),
      } as Product;
    case 'psu':
      return {
        ...base,
        kind: 'psu',
        capacityWatts: numberValue(metadata, 'capacityWatts', 650),
        efficiency: typeof metadata.efficiency === 'string' ? metadata.efficiency : '80 PLUS Bronze',
      } as Product;
    case 'ssd':
      return {
        ...base,
        kind: 'ssd',
        capacityGb: numberValue(metadata, 'capacityGb', 1000),
        interface: 'PCIe 4.0 NVMe',
      } as Product;
    case 'fan':
      return {
        ...base,
        kind: 'fan',
        count: numberValue(metadata, 'count', 4),
        sizeMm: 120,
      } as Product;
  }
}

export const builtInHardwareModels: readonly HardwareModelInput[] = [];
