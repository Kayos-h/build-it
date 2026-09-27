import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_CONFIGURATION, EXAMPLE_CONFIGURATION, GPU_OPTIONS, MOTHERBOARD_OPTIONS, PRODUCT_KINDS,
  PRODUCT_OPTIONS, resolveConfigurationChange, validateConfiguration, estimatePerformance, getOptionalProduct,
} from '../src/config/products';

const empty = () => ({ ...DEFAULT_CONFIGURATION });
const root = resolve(process.cwd());
const allGlbs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = resolve(dir, entry.name);
  if (entry.isDirectory() && entry.name === 'custom') return [];
  return entry.isDirectory() ? allGlbs(full) : entry.name.endsWith('.glb') ? [full] : [];
});

test('optional local catalog has all 21 GLB assets', {
  skip: existsSync(resolve(root, 'data/models/catalog')) ? false : 'Deployment intentionally excludes local model assets; models are managed in Supabase Storage.',
}, () => {
  const modelRoot = resolve(root, 'data/models/catalog');
  const files = allGlbs(modelRoot).map(file => file.slice(modelRoot.length + 1).replaceAll('\\', '/')).sort();
  assert.equal(files.length, 21);
  for (const kind of PRODUCT_KINDS) {
    for (const product of PRODUCT_OPTIONS[kind]) {
      assert.match(product.modelPath, new RegExp(`^${kind}/[^/]+\\.glb$`));
      assert.equal(existsSync(resolve(modelRoot, product.modelPath)), true, `${product.id} -> ${product.modelPath}`);
    }
  }
  const mapped = PRODUCT_KINDS.flatMap(kind => PRODUCT_OPTIONS[kind].map(product => product.modelPath)).sort();
  assert.deepEqual(mapped, files);
});

test('defaults are nine None selections and have zero selected components', () => {
  assert.deepEqual(empty(), { case: '', motherboard: '', cpu: '', cooler: '', ram: '', gpu: '', psu: '', ssd: '', fan: '' });
  const validation = validateConfiguration(empty());
  assert.equal(validation.valid, true);
  assert.equal(validation.complete, false);
  assert.equal(validation.selectedCount, 0);
  assert.equal(estimatePerformance(empty()).loadWatts, 0);
  assert.deepEqual(estimatePerformance(empty()).fps, []);
});

test('changing one selection never replaces, clears, or rewrites another selected SKU', () => {
  const current = {
    ...empty(), case: 'corsair-4000d', motherboard: 'asus-b650', cpu: 'cpu', cooler: 'cooler',
    ram: 'vengeance-ddr5', gpu: 'rtx-4070', psu: 'psu1', ssd: '990-pro', fan: 'fan',
  };
  for (const kind of PRODUCT_KINDS) {
    const product = PRODUCT_OPTIONS[kind][0];
    const result = resolveConfigurationChange(current, kind, product.id);
    assert.equal(result.configuration[kind], product.id);
    for (const other of PRODUCT_KINDS) if (other !== kind) assert.equal(result.configuration[other], current[other]);
    assert.deepEqual(result.adjustments, []);
    assert.deepEqual(result.warnings, []);
  }
});

test('arbitrarily paired hardware stays catalog-valid with no automatic compatibility fallback', () => {
  const configuration = {
    ...empty(),
    case: 'aero-pc-case', motherboard: 'asus-b650', cpu: 'am4_cpu', cooler: 'cooler_2',
    ram: 'vengeance-ddr4', gpu: 'rx_480', psu: 'aerocool_kcas_500w_atx', ssd: 'm2ssd', fan: 'fan2',
  };
  const validation = validateConfiguration(configuration);
  assert.equal(validation.valid, true);
  assert.equal(validation.complete, true);
  assert.equal(validation.issues.length, 0);
  const changed = resolveConfigurationChange(configuration, 'motherboard', 'asus-prime-h510m-k');
  assert.equal(changed.configuration.cpu, 'am4_cpu');
  assert.equal(changed.configuration.ram, 'vengeance-ddr4');
  assert.equal(changed.configuration.case, 'aero-pc-case');
  assert.deepEqual(changed.adjustments, []);
});

test('undersized PSU selection is retained and never upgraded automatically', () => {
  const configuration = {
    ...EXAMPLE_CONFIGURATION,
    gpu: GPU_OPTIONS.at(-1)!.id,
    psu: 'aerocool_kcas_500w_atx',
  };
  const result = resolveConfigurationChange(EXAMPLE_CONFIGURATION, 'psu', 'aerocool_kcas_500w_atx');
  assert.equal(result.configuration.psu, 'aerocool_kcas_500w_atx');
  assert.deepEqual(result.adjustments, []);
  assert.equal(validateConfiguration(configuration).valid, true);
});

test('motherboard selection changes the 3D board layout metadata only; no other SKU is replaced', () => {
  const result = resolveConfigurationChange(EXAMPLE_CONFIGURATION, 'motherboard', 'asus-prime-h510m-k');
  assert.equal(result.configuration.motherboard, 'asus-prime-h510m-k');
  assert.equal(result.configuration.cpu, EXAMPLE_CONFIGURATION.cpu);
  assert.equal(result.configuration.ram, EXAMPLE_CONFIGURATION.ram);
  assert.equal(result.configuration.case, EXAMPLE_CONFIGURATION.case);
  assert.deepEqual(result.adjustments, []);
  assert.equal(MOTHERBOARD_OPTIONS.find(item => item.id === 'asus-prime-h510m-k')!.formFactor, 'mATX');
});

test('removing one selected category does not delete its other selections', () => {
  const result = resolveConfigurationChange(EXAMPLE_CONFIGURATION, 'cpu', '');
  assert.equal(result.configuration.cpu, '');
  assert.equal(result.configuration.cooler, EXAMPLE_CONFIGURATION.cooler);
  assert.equal(result.configuration.motherboard, EXAMPLE_CONFIGURATION.motherboard);
  assert.deepEqual(result.adjustments, []);
});

test('selected IDs are deterministic and power/FPS models remain based only on selected catalog values', () => {
  const validation = validateConfiguration(EXAMPLE_CONFIGURATION);
  assert.equal(validation.valid, true);
  assert.equal(validation.complete, true);
  const performance = estimatePerformance(EXAMPLE_CONFIGURATION);
  assert.equal(performance.loadWatts, 338);
  assert.equal(performance.recommendedPsuWatts, 550);
  assert.equal(performance.psuHeadroomWatts, 412);
  assert.equal(performance.fps.length, 4);
  assert.equal(getOptionalProduct(EXAMPLE_CONFIGURATION, 'gpu')?.id, 'rtx-4070');
});

test('unknown catalog IDs are the only configuration errors', () => {
  const configuration = { ...empty(), gpu: 'does-not-exist' };
  const validation = validateConfiguration(configuration);
  assert.equal(validation.valid, false);
  assert.equal(validation.selectedCount, 0);
  assert.equal(validation.issues[0].code, 'unknown-product');
  assert.throws(() => resolveConfigurationChange(empty(), 'gpu', 'does-not-exist'), /Unknown gpu product/);
});
