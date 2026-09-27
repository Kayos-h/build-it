import { getOptionalProductFromOptions, type HardwareConfiguration, type Product, type ProductOptionsByKind } from './products.js';

export interface SoftwareProfile {
  id: string; name: string; workload: string;
  ram: [number, number]; vram: [number, number]; cores?: [number, number];
  source: string; caveat: string;
}
/** Capacity checks for Windows PC configurations, reviewed 2026-09-26.
 * These are requirements, not measured FPS or render-time predictions. */
export const SOFTWARE_PROFILES: readonly SoftwareProfile[] = [
  { id: 'valorant', name: 'Valorant', workload: 'Published memory requirements', ram: [4, 4], vram: [1, 1], source: 'https://playvalorant.com/en-us/specs/', caveat: 'CPU/GPU model, SSE4.2 or AVX, DirectX, Windows and Vanguard requirements need separate verification.' },
  { id: 'fortnite', name: 'Fortnite', workload: 'Recommended PC memory capacity', ram: [8, 16], vram: [0, 2], source: 'https://www.epicgames.com/help/c-34254770/c-38015632/a16548002?lang=en-US', caveat: 'GPU/CPU speed, DirectX, Windows and NVMe requirements need separate verification. Memory alone cannot establish graphics quality or frame rate.' },
  { id: 'blender', name: 'Blender', workload: 'Recommended desktop capacity', ram: [8, 32], vram: [2, 8], cores: [4, 8], source: 'https://www.blender.org/download/requirements/', caveat: 'SSE4.2, supported GPU generation, OpenGL/Vulkan and Cycles rendering backend must also be supported.' },
  { id: 'premiere', name: 'Premiere Pro', workload: 'Recommended capacity for 4K editing', ram: [8, 32], vram: [4, 8], source: 'https://helpx.adobe.com/premiere/desktop/get-started/technical-requirements/adobe-premiere-pro-technical-requirements.html', caveat: 'Premiere 26.x: also verify AVX2, supported CPU/GPU generation, Windows 11, drivers and free SSD space. Codec and effects affect performance.' },
];
export interface SoftwareCheck {
  profile: SoftwareProfile;
  status: 'unknown' | 'below' | 'minimum' | 'target';
  label: string;
  details: string[];
}
function known(product: Product | undefined, key: string, value: number | undefined): number | null {
  return product?.specsProvided?.includes(key) && value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}
export function checkSoftware(options: ProductOptionsByKind, configuration: HardwareConfiguration, ids: readonly string[]): SoftwareCheck[] {
  const cpu = getOptionalProductFromOptions(options, configuration, 'cpu');
  const gpu = getOptionalProductFromOptions(options, configuration, 'gpu');
  const ram = getOptionalProductFromOptions(options, configuration, 'ram');
  return SOFTWARE_PROFILES.filter(profile => ids.includes(profile.id)).map(profile => {
    const capacities = [
      { label: 'RAM', unit: 'GB', value: known(ram, 'capacityGb', ram?.capacityGb), limits: profile.ram },
      { label: 'VRAM', unit: 'GB', value: known(gpu, 'vramGb', gpu?.vramGb), limits: profile.vram },
      ...(profile.cores ? [{ label: 'CPU cores', unit: '', value: known(cpu, 'cores', cpu?.cores), limits: profile.cores }] : []),
    ];
    const below = capacities.some(item => item.value !== null && item.value < item.limits[0]);
    const unknown = !cpu || capacities.some(item => item.value === null);
    const target = capacities.every(item => item.value !== null && item.value >= item.limits[1]);
    const status = below ? 'below' : unknown ? 'unknown' : target ? 'target' : 'minimum';
    return {
      profile, status,
      label: { below: 'Below minimum capacity', unknown: 'Hardware specs incomplete', target: 'Capacity target met', minimum: 'Minimum capacity met' }[status],
      details: capacities.map(item => item.value === null
        ? `${item.label}: select hardware with a recorded specification (target ${item.limits[1]} ${item.unit}).`
        : `${item.label}: ${item.value} ${item.unit} / target ${item.limits[1]} ${item.unit}`),
    };
  });
}
export function hardwareWarnings(options: ProductOptionsByKind, configuration: HardwareConfiguration): string[] {
  const board = getOptionalProductFromOptions(options, configuration, 'motherboard');
  const cpu = getOptionalProductFromOptions(options, configuration, 'cpu');
  const ram = getOptionalProductFromOptions(options, configuration, 'ram');
  const warnings: string[] = [];
  if (cpu && board && cpu.socket !== board.socket) warnings.push(`CPU socket ${cpu.socket} differs from motherboard ${board.socket}. Verify catalog specifications.`);
  if (ram && board && ram.memoryType !== board.memoryType) warnings.push(`${ram.memoryType} RAM differs from motherboard ${board.memoryType}. Verify catalog specifications.`);
  if (!configuration.case && Object.values(configuration).some(Boolean)) warnings.push('Select a case to mount the selected components.');
  if (!configuration.motherboard && ['cpu', 'gpu', 'ram', 'ssd', 'cooler'].some(kind => Boolean(configuration[kind as keyof HardwareConfiguration]))) warnings.push('Select a motherboard to mount CPU, GPU, RAM and storage.');
  return warnings;
}
