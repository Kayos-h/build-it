import type { HardwareConfiguration, Product, ProductKind } from './products.js';

export interface DraftCamera { position: [number, number, number]; target: [number, number, number] }
export interface DraftState {
  version: 1;
  configuration: HardwareConfiguration;
  products: Partial<Record<ProductKind, Product>>;
  software: string[];
  rgb: string;
  camera: DraftCamera | null;
}
export interface SavedDraft {
  id: string;
  name: string;
  state: DraftState;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export type DraftSummary = Omit<SavedDraft, 'state'>;
export interface DraftResponse { draft: SavedDraft; unavailableModelIds: string[] }
