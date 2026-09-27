import type { ProductKind } from '../config/products';

export interface CatalogItem { kind: ProductKind; label: string; icon: string }

const icon = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

export const catalog: CatalogItem[] = [
  { kind: 'case', label: 'PC Case', icon: icon('<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 17h14M9 20h1M9 5h6M9 8h6"/>') },
  { kind: 'motherboard', label: 'Motherboard', icon: icon('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="6" width="7" height="7" rx="1"/><path d="M17 6v10M8 17h6M3 9h2M3 15h2"/>') },
  { kind: 'cpu', label: 'Processor', icon: icon('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"/>') },
  { kind: 'cooler', label: 'CPU Cooler', icon: icon('<rect x="4" y="3" width="16" height="18" rx="3"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1"/><path d="m12 6 2 4m4 2-4 2m-2 4-2-4m-4-2 4-2"/>') },
  { kind: 'ram', label: 'Memory', icon: icon('<rect x="3" y="6" width="18" height="11" rx="1"/><path d="M6 9v5m4-5v5m4-5v5m4-5v5M5 17v3m4-3v3m6-3v3m4-3v3"/>') },
  { kind: 'gpu', label: 'Graphics Card', icon: icon('<path d="M2 4v16M2 7h18v12H2m5 0v2h7v-2"/><circle cx="8" cy="13" r="3"/><circle cx="16" cy="13" r="3"/>') },
  { kind: 'psu', label: 'Power Supply', icon: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="11" cy="12" r="5"/><path d="m9 9 4 6m-4 0 4-6M18 9v6"/>') },
  { kind: 'ssd', label: 'Storage', icon: icon('<rect x="2" y="8" width="20" height="8" rx="1"/><path d="M5 10v4m4-4v4m4-4v4M19 8v8"/>') },
  { kind: 'fan', label: 'Case Fans', icon: icon('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="2"/><path d="M12 10c-8-8-8 6-2 3m4-1c8-8-6-8-3-2m1 4c8 8 8-6 2-3"/>') },
];

