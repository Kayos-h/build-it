/** Product selection is separate from connector dimensions. Each SKU points
 * to a catalog GLB; the scene calibrates that asset to the catalog envelope. */
export type ProductKind = 'case' | 'motherboard' | 'cpu' | 'cooler' | 'ram' | 'gpu' | 'psu' | 'ssd' | 'fan';
export type CpuSocket = 'AM4' | 'AM5' | 'LGA1700';
export type MemoryType = 'DDR4' | 'DDR5';
export type ProductFormFactor = 'ATX' | 'mATX' | 'ITX';

interface ProductBase<K extends ProductKind> {
  id: string;
  kind: K;
  name: string;
  /** Catalog GLB path, resolved through the authenticated model file API. */
  modelPath: string;
  /** Optional procedural correction applied to this GLB after automatic envelope fitting. */
  modelTransform?: import('../core/types.js').ModelTransform;
  detail: string;
  /** Component power allowance; PSU rating is capacity, never a load. */
  powerWatts: number;
  /** Metadata fields actually supplied by an administrator; defaults are not verified specs. */
  specsProvided?: readonly string[];
}

export interface CaseProduct extends ProductBase<'case'> {}
export interface MotherboardProduct extends ProductBase<'motherboard'> {
  socket: CpuSocket;
  memoryType: MemoryType;
  formFactor: ProductFormFactor;
  boardMountLayout?: import('../core/types.js').BoardMountLayout;
  componentPlacements?: Record<string, import('../core/types.js').BoardMountLayout>;
}
export interface CpuProduct extends ProductBase<'cpu'> {
  socket: CpuSocket;
  vendor: 'AMD' | 'Intel';
  cores: number;
  threads: number;
  /** Relative model coefficient, not a benchmark result. Ryzen 5 5600 = 100. */
  gamingScore: number;
}
export interface CoolerProduct extends ProductBase<'cooler'> {
}
export interface RamProduct extends ProductBase<'ram'> {
  memoryType: MemoryType;
  capacityGb: 16 | 32 | 64;
  modules: 2;
  speedMtps: number;
}
export interface GpuProduct extends ProductBase<'gpu'> {
  vramGb: number;
  /** Relative native-raster model coefficient; RTX 3060 = 100. */
  rasterScore: number;
  recommendedPsuWatts: number;
}
export interface PsuProduct extends ProductBase<'psu'> { capacityWatts: number; efficiency: string }
export interface SsdProduct extends ProductBase<'ssd'> { capacityGb: number; interface: 'PCIe 4.0 NVMe' }
export interface FanProduct extends ProductBase<'fan'> { count: number; sizeMm: 120 }

export interface ProductByKind {
  case: CaseProduct;
  motherboard: MotherboardProduct;
  cpu: CpuProduct;
  cooler: CoolerProduct;
  ram: RamProduct;
  gpu: GpuProduct;
  psu: PsuProduct;
  ssd: SsdProduct;
  fan: FanProduct;
}
export type Product = ProductByKind[ProductKind];
export type HardwareConfiguration = { [K in ProductKind]: string };
export const PRODUCT_KINDS: readonly ProductKind[] = ['case', 'motherboard', 'cpu', 'cooler', 'ram', 'gpu', 'psu', 'ssd', 'fan'];
  
export const CASE_OPTIONS: readonly CaseProduct[] = [
  { id: 'corsair-4000d', kind: 'case', modelPath: 'case/corsair-4000d.glb', name: 'Corsair 4000D Airflow', detail: 'ATX tower · ATX / mATX / Mini-ITX', powerWatts: 0 },
  { id: 'aero-pc-case', kind: 'case', modelPath: 'case/aero_pc_case.glb', name: 'Aero PC Case', detail: 'Compact tower · mATX / Mini-ITX', powerWatts: 0 },
  { id: 'lian-li-o11', kind: 'case', modelPath: 'case/lian-li-o11.glb', modelTransform: { rotation: [0, -Math.PI / 2, 0] }, name: 'Lian Li O11', detail: 'Mini-ITX tower · ATX power supply', powerWatts: 0 },
];

export const MOTHERBOARD_OPTIONS: readonly MotherboardProduct[] = [
  { id: 'asus-prime-h510m-k', kind: 'motherboard', modelPath: 'motherboard/asus_prime_h510m-k.glb', name: 'ASUS Prime H510M-K', detail: 'AM4 · DDR4 · mATX', socket: 'AM4', memoryType: 'DDR4', formFactor: 'mATX', powerWatts: 35 },
  { id: 'asus-b650', kind: 'motherboard', modelPath: 'motherboard/asus-b650.glb', name: 'ASUS B650', detail: 'AM5 · DDR5 · ATX', socket: 'AM5', memoryType: 'DDR5', formFactor: 'ATX', powerWatts: 40 },
];
export const CPU_OPTIONS: readonly CpuProduct[] = [
  { id: 'am4_cpu', kind: 'cpu', modelPath: 'cpu/am4_cpu.glb', name: 'AM4 CPU', detail: 'AM4 · 6 cores / 12 threads', socket: 'AM4', vendor: 'AMD', cores: 6, threads: 12, gamingScore: 100, powerWatts: 76 },
  { id: 'cpu', kind: 'cpu', modelPath: 'cpu/cpu.glb', name: 'CPU', detail: 'AM4 · 8 cores / 16 threads', socket: 'AM4', vendor: 'AMD', cores: 8, threads: 16, gamingScore: 145, powerWatts: 105 },
];

export const COOLER_OPTIONS: readonly CoolerProduct[] = [
  { id: 'cooler', kind: 'cooler', modelPath: 'cooler/cooler.glb', name: 'Cooler', detail: 'AMD stock air cooler · AM4 / AM5', powerWatts: 2 },
  { id: 'cooler_2', kind: 'cooler', modelPath: 'cooler/cooler_2.glb', name: 'Cooler 2', detail: 'Intel stock air cooler · LGA1700', powerWatts: 2 },
];

export const RAM_OPTIONS: readonly RamProduct[] = [
  { id: 'vengeance-ddr4', kind: 'ram', modelPath: 'ram/vengeance-ddr4.glb', name: 'Vengeance DDR4', detail: '2 × 8 GB · DDR4-3200', memoryType: 'DDR4', capacityGb: 16, modules: 2, speedMtps: 3200, powerWatts: 6 },
  { id: 'vengeance-ddr5', kind: 'ram', modelPath: 'ram/vengeance-ddr5.glb', name: 'Vengeance DDR5', detail: '2 × 16 GB · DDR5-4800', memoryType: 'DDR5', capacityGb: 32, modules: 2, speedMtps: 4800, powerWatts: 8 },
];

export const GPU_OPTIONS: readonly GpuProduct[] = [
  { id: 'nvidia_geforce_rtx_5070', kind: 'gpu', modelPath: 'gpu/nvidia_geforce_rtx_5070.glb', name: 'NVIDIA GeForce RTX 5070', detail: '8 GB GDDR6 · 132 W board allowance', vramGb: 8, rasterScore: 80, powerWatts: 132, recommendedPsuWatts: 450 },
  { id: 'rtx-4070', kind: 'gpu', modelPath: 'gpu/rtx-4070.glb', name: 'RTX 4070', detail: '12 GB GDDR6 · 170 W board allowance', vramGb: 12, rasterScore: 100, powerWatts: 170, recommendedPsuWatts: 550 },
  { id: 'rx_480', kind: 'gpu', modelPath: 'gpu/rx_480.glb', name: 'RX 480', detail: '8 GB GDDR6 · 115 W board allowance', vramGb: 8, rasterScore: 110, powerWatts: 115, recommendedPsuWatts: 550 },
];

export const PSU_OPTIONS: readonly PsuProduct[] = [
  { id: 'aerocool_kcas_500w_atx', kind: 'psu', modelPath: 'psu/aerocool_kcas_500w_atx.glb', name: 'Aerocool Kxas 500w ATX', detail: '550 W · 80 PLUS Bronze', capacityWatts: 550, efficiency: '80 PLUS Bronze', powerWatts: 0 },
  { id: 'psu', kind: 'psu', modelPath: 'psu/psu.glb', name: 'PSU', detail: '650 W · 80 PLUS Bronze', capacityWatts: 650, efficiency: '80 PLUS Bronze', powerWatts: 0 },
  { id: 'psu1', kind: 'psu', modelPath: 'psu/psu1.glb', name: 'PSU 1', detail: '750 W · 80 PLUS Gold', capacityWatts: 750, efficiency: '80 PLUS Gold', powerWatts: 0 },
];

export const SSD_OPTIONS: readonly SsdProduct[] = [
  { id: '990-pro', kind: 'ssd', modelPath: 'ssd/990-pro.glb', name: '990 PRO', detail: '1 TB · M.2 2280 · PCIe 4.0 NVMe', capacityGb: 1000, interface: 'PCIe 4.0 NVMe', powerWatts: 5 },
  { id: 'm2ssd', kind: 'ssd', modelPath: 'ssd/m2ssd.glb', name: 'M2 SSD', detail: '2 TB · M.2 2280 · PCIe 4.0 NVMe', capacityGb: 2000, interface: 'PCIe 4.0 NVMe', powerWatts: 6 },
];

export const FAN_OPTIONS: readonly FanProduct[] = [
  { id: 'fan', kind: 'fan', modelPath: 'fan/fan.glb', name: 'FAN', detail: '4 individual 120 mm PWM fans', count: 4, sizeMm: 120, powerWatts: 8 },
  { id: 'fan2', kind: 'fan', modelPath: 'fan/fan2.glb', name: 'FAN 2', detail: '4 individual 120 mm PWM fans', count: 4, sizeMm: 120, powerWatts: 9 },
];

export type ProductOptionsByKind = { readonly [K in ProductKind]: readonly ProductByKind[K][] };

export const PRODUCT_OPTIONS: ProductOptionsByKind = {
  case: CASE_OPTIONS, motherboard: MOTHERBOARD_OPTIONS, cpu: CPU_OPTIONS, cooler: COOLER_OPTIONS,
  ram: RAM_OPTIONS, gpu: GPU_OPTIONS, psu: PSU_OPTIONS, ssd: SSD_OPTIONS, fan: FAN_OPTIONS,
};

export const DEFAULT_CONFIGURATION: Readonly<HardwareConfiguration> = Object.freeze({
  case: '', motherboard: '', cpu: '', cooler: '', ram: '', gpu: '', psu: '', ssd: '', fan: '',
});

/** An explicit demo fixture, never used to fill unselected dropdowns. */
export const EXAMPLE_CONFIGURATION: Readonly<HardwareConfiguration> = Object.freeze({
  case: 'corsair-4000d', motherboard: 'asus-b650', cpu: 'cpu',
  cooler: 'cooler', ram: 'vengeance-ddr5', gpu: 'rtx-4070',
  psu: 'psu1', ssd: '990-pro', fan: 'fan',
});
export const COMPLETE_CONFIGURATION = EXAMPLE_CONFIGURATION;

/** Empty IDs represent None; only unknown catalog IDs are invalid. */
export function getOptionalProductFromOptions<K extends ProductKind>(
  options: ProductOptionsByKind,
  configuration: HardwareConfiguration,
  kind: K,
): ProductByKind[K] | undefined {
  return options[kind].find(option => option.id === configuration[kind]);
}

export function getOptionalProduct<K extends ProductKind>(configuration: HardwareConfiguration, kind: K): ProductByKind[K] | undefined {
  return getOptionalProductFromOptions(PRODUCT_OPTIONS, configuration, kind);
}

export function getSelectedProduct<K extends ProductKind>(configuration: HardwareConfiguration, kind: K): ProductByKind[K] {
  const product = getOptionalProduct(configuration, kind);
  if (!product) throw new RangeError(`Unknown ${kind} product: ${configuration[kind]}`);
  return product;
}

export interface ConfigurationIssue {
  kind: ProductKind;
  code: 'unknown-product';
  severity: 'error';
  message: string;
}
export interface ConfigurationAdjustment { kind: ProductKind; fromId: string; toId: string; reason: string }
export interface ConfigurationChange { configuration: HardwareConfiguration; adjustments: ConfigurationAdjustment[]; warnings: string[] }
export interface ConfigurationValidation { valid: boolean; complete: boolean; selectedCount: number; issues: ConfigurationIssue[] }

export const COMPATIBILITY_NOTES = [
  'No catalog-level hardware compatibility rules are enforced. Any selected CPU, motherboard, memory, cooler, GPU, PSU, SSD, fan, and case SKU can be combined without automatic replacement or fallback.',
  'The 3D preview uses the selected motherboard form factor only to choose its connector layout; it does not reject any case or component pairing.',
] as const;

function powerEstimate(configuration: HardwareConfiguration, options: ProductOptionsByKind = PRODUCT_OPTIONS): { loadWatts: number; recommendedPsuWatts: number } {
  const loadWatts = Math.round(PRODUCT_KINDS.reduce((sum, kind) => sum + (getOptionalProductFromOptions(options, configuration, kind)?.powerWatts ?? 0), 0));
  const gpu = getOptionalProductFromOptions(options, configuration, 'gpu');
  const target = Math.max(gpu?.recommendedPsuWatts ?? 0, (loadWatts + (gpu?.powerWatts ?? 0) * .10) / .80);
  const recommendedPsuWatts = target === 0 ? 0 : [450, 550, 650, 750, 850, 1000, 1200].find(capacity => capacity >= target) ?? Math.ceil(target / 100) * 100;
  return { loadWatts, recommendedPsuWatts };
}

export function validateConfigurationWithOptions(options: ProductOptionsByKind, configuration: HardwareConfiguration): ConfigurationValidation {
  const issues: ConfigurationIssue[] = [];
  let selectedCount = 0;
  for (const kind of PRODUCT_KINDS) {
    if (getOptionalProductFromOptions(options, configuration, kind)) selectedCount++;
    else if (configuration[kind] !== '') {
      issues.push({ kind, code: 'unknown-product', severity: 'error', message: `Select a valid ${kind} product.` });
    }
  }
  return { valid: issues.length === 0, complete: selectedCount === PRODUCT_KINDS.length, selectedCount, issues };
}

export function validateConfiguration(configuration: HardwareConfiguration): ConfigurationValidation {
  return validateConfigurationWithOptions(PRODUCT_OPTIONS, configuration);
}

/** Selection changes are authoritative. No selected SKU is ever replaced because of another selection. */
export function resolveConfigurationChangeWithOptions(
  options: ProductOptionsByKind,
  current: HardwareConfiguration,
  kind: ProductKind,
  productId: string,
): ConfigurationChange {
  if (productId !== '' && !options[kind].some(product => product.id === productId)) {
    throw new RangeError(`Unknown ${kind} product: ${productId}`);
  }
  return {
    configuration: { ...current, [kind]: productId },
    adjustments: [],
    warnings: [],
  };
}

export function resolveConfigurationChange(current: HardwareConfiguration, kind: ProductKind, productId: string): ConfigurationChange {
  return resolveConfigurationChangeWithOptions(PRODUCT_OPTIONS, current, kind, productId);
}

export const PERFORMANCE_SCENARIO = '1080p · native rendering · ray tracing off · no upscaling or frame generation';
export const FPS_DESCRIPTION = 'Modeled FPS ranges derived from the selected CPU, GPU, memory and VRAM inputs; these are estimates, not guaranteed results.';
export interface GamePerformanceEstimate {
  game: 'Valorant' | 'Counter-Strike 2' | 'Fortnite' | 'Cyberpunk 2077';
  preset: string;
  low: number;
  high: number;
  average: number;
  bottleneck: 'CPU' | 'GPU' | 'balanced';
}
export interface PerformanceEstimate {
  loadWatts: number;
  recommendedPsuWatts: number;
  psuHeadroomWatts: number;
  psuLoadPercent: number;
  memoryGb: number;
  vramGb: number;
  resolution: '1920×1080';
  fps: GamePerformanceEstimate[];
  notes: string[];
}

const GAME_MODELS: readonly {
  game: GamePerformanceEstimate['game']; preset: string; referenceCpuFps: number;
  sixteenGbFactor: number; requiredVramGb: number; uncertainty: number;
}[] = [
  { game: 'Valorant', preset: 'High', referenceCpuFps: 520, sixteenGbFactor: 1, requiredVramGb: 4, uncertainty: .18 },
  { game: 'Counter-Strike 2', preset: 'High · MSAA 2×', referenceCpuFps: 330, sixteenGbFactor: .96, requiredVramGb: 6, uncertainty: .18 },
  { game: 'Fortnite', preset: 'DX12 High · Nanite / Lumen off', referenceCpuFps: 460, sixteenGbFactor: .94, requiredVramGb: 8, uncertainty: .22 },
  { game: 'Cyberpunk 2077', preset: 'High · RT off', referenceCpuFps: 260, sixteenGbFactor: .94, requiredVramGb: 8, uncertainty: .18 },
];

const REFERENCE_CPU_GAMING_SCORE = 184;

const GPU_BENCHMARK_FPS: Record<GpuProduct['id'], Record<GamePerformanceEstimate['game'], number>> = {
  'radeon-rx-6600': { 'Valorant': 202, 'Counter-Strike 2': 140, 'Fortnite': 100, 'Cyberpunk 2077': 79 },
  'geforce-rtx-3060': { 'Valorant': 260, 'Counter-Strike 2': 137, 'Fortnite': 127, 'Cyberpunk 2077': 68 },
  'geforce-rtx-4060': { 'Valorant': 338, 'Counter-Strike 2': 157, 'Fortnite': 163, 'Cyberpunk 2077': 82 },
  'radeon-rx-7700-xt': { 'Valorant': 344, 'Counter-Strike 2': 195, 'Fortnite': 224, 'Cyberpunk 2077': 115 },
  'geforce-rtx-4070-super': { 'Valorant': 344, 'Counter-Strike 2': 214, 'Fortnite': 303, 'Cyberpunk 2077': 154 },
  'radeon-rx-7800-xt': { 'Valorant': 344, 'Counter-Strike 2': 206, 'Fortnite': 273, 'Cyberpunk 2077': 132 },
  'geforce-rtx-4080-super': { 'Valorant': 344, 'Counter-Strike 2': 225, 'Fortnite': 424, 'Cyberpunk 2077': 201 },
  'radeon-rx-7900-xtx': { 'Valorant': 344, 'Counter-Strike 2': 227, 'Fortnite': 428, 'Cyberpunk 2077': 203 },
};

/** UI labels remain available while no hardware is selected and FPS is hidden. */
export const GAME_PRESETS: readonly Pick<GamePerformanceEstimate, 'game' | 'preset'>[] = GAME_MODELS.map(({ game, preset }) => ({ game, preset }));

export function estimatePerformanceWithOptions(options: ProductOptionsByKind, configuration: HardwareConfiguration): PerformanceEstimate {
  const validation = validateConfigurationWithOptions(options, configuration);
  const cpu = getOptionalProductFromOptions(options, configuration, 'cpu');
  const gpu = getOptionalProductFromOptions(options, configuration, 'gpu');
  const ram = getOptionalProductFromOptions(options, configuration, 'ram');
  const psu = getOptionalProductFromOptions(options, configuration, 'psu');
  const power = powerEstimate(configuration, options);
  // A small, capped transfer-rate effect; simply buying excess capacity does not
  // multiply FPS. CPU scores already incorporate their platform generation.
  const baselineMemorySpeed = ram?.memoryType === 'DDR4' ? 3200 : 5200;
  const memorySpeedFactor = ram ? Math.max(.97, Math.min(1.025, (ram.speedMtps / baselineMemorySpeed) ** .08)) : 1;
  const fps = validation.valid && validation.complete && cpu && gpu && ram ? GAME_MODELS.map((game): GamePerformanceEstimate => {
    const capacityFactor = ram.capacityGb >= 32 ? 1 : game.sixteenGbFactor;
    const vramFactor = Math.min(1, gpu.vramGb / game.requiredVramGb);
    const benchmarkFps = GPU_BENCHMARK_FPS[gpu.id]?.[game.game] ?? gpu.rasterScore;
    const cpuCeiling = game.referenceCpuFps * cpu.gamingScore / REFERENCE_CPU_GAMING_SCORE * memorySpeedFactor * capacityFactor;
    const gpuCeiling = benchmarkFps * vramFactor;
    // A smooth minimum has diminishing returns near the opposite component's
    // ceiling and remains monotonic when either performance coefficient rises.
    const modeled = (cpuCeiling ** -4 + gpuCeiling ** -4) ** (-.25);
    const average = Math.max(1, Math.round(modeled));
    return {
      game: game.game, preset: game.preset, average,
      low: Math.max(1, Math.floor(modeled * (1 - game.uncertainty))),
      high: Math.ceil(modeled * (1 + game.uncertainty)),
      bottleneck: cpuCeiling < gpuCeiling * .85 ? 'CPU' : gpuCeiling < cpuCeiling * .85 ? 'GPU' : 'balanced',
    };
  }) : [];
  return {
    ...power, psuHeadroomWatts: psu ? psu.capacityWatts - power.loadWatts : 0,
    psuLoadPercent: psu ? Math.round(power.loadWatts / psu.capacityWatts * 100) : 0,
    memoryGb: ram?.capacityGb ?? 0, vramGb: gpu?.vramGb ?? 0, resolution: '1920×1080', fps,
    notes: [
      ...(!validation.complete ? [`Select all ${PRODUCT_KINDS.length} hardware categories to enable FPS estimates (${validation.selectedCount} selected). Partial power totals include only selected known products.`] : []),
      ...(!validation.valid ? ['FPS estimates are unavailable until compatibility issues are resolved.', ...validation.issues.map(issue => issue.message)] : []),
      FPS_DESCRIPTION,
      'All presets use 1920×1080 native rendering with ray tracing, upscaling and frame generation disabled. GPU-side anchors are based on public 1080p benchmark tables, then adjusted for the selected CPU, memory and VRAM. FPS bounds express scene variation and model uncertainty; they are not measured 1% lows.',
      'Load is a combined component power allowance, not measured wall draw or typical gaming consumption. PSU sizing adds GPU transient allowance and capacity headroom; a larger PSU does not increase FPS.',
      'SSD capacity affects storage space and its small power allowance, not this FPS model. RAM above 32 GB provides no capacity-based FPS bonus.',
      'CPU scaling, memory behavior and cooling coefficients remain conservative model adjustments, not manufacturer-certified results. Game patches, drivers, thermals, BIOS limits and background tasks can change real performance.',
      ...COMPATIBILITY_NOTES,
    ],
  };
}

export function estimatePerformance(configuration: HardwareConfiguration): PerformanceEstimate {
  return estimatePerformanceWithOptions(PRODUCT_OPTIONS, configuration);
}
