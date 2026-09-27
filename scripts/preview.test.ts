import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, type Object3D } from 'three';
import { Assembly } from '../src/core/Assembly';
import { ConfigurationPreview, type PreviewProduct, type PreviewSelection } from '../src/core/ConfigurationPreview';
import type { AssetContext, AssetProvider, PartKind } from '../src/core/types';

const product = (id: string, modelPath = `${id}.glb`): PreviewProduct => ({
  id, name: `Product ${id}`, detail: `Details ${id}`, modelPath,
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const fullSelection = (): PreviewSelection => Object.fromEntries(
  ['case', 'motherboard', 'cpu', 'cooler', 'ram', 'gpu', 'psu', 'ssd', 'fan'].map(kind => [kind, product(kind)]),
);

test('default None has no models, mounts, pending requests, or asset loads', async () => {
  let requests = 0;
  const assembly = new Assembly(async () => { requests += 1; return new Group(); });
  const preview = new ConfigurationPreview(assembly);
  await preview.load();
  preview.setProducts({});
  await preview.load();
  assert.equal(requests, 0);
  assert.equal(assembly.instances.size, 0);
  assert.equal(assembly.pending.size, 0);
  assert.equal(assembly.slots.size, 0);
  assert.equal(assembly.root.children.length, 0);
  preview.dispose();
});

test('selected children stay pending in configuration until their entire parent chain is selected', async () => {
  const requested: PartKind[] = [];
  const assembly = new Assembly(async kind => { requested.push(kind); return new Group(); });
  const preview = new ConfigurationPreview(assembly);
  const selection: PreviewSelection = { cpu: product('cpu'), cooler: product('cooler'), ram: product('ram') };
  preview.setProducts(selection);
  await preview.load();
  assert.deepEqual(requested, []);
  selection.motherboard = product('board');
  preview.setProducts(selection);
  await preview.load();
  assert.equal(assembly.instances.size, 0);
  selection.case = product('case');
  preview.setProducts(selection);
  await preview.load();
  assert.deepEqual(requested, ['case', 'motherboard', 'cpu', 'cooler', 'ram', 'ram']);
  assert.equal(assembly.instances.get('cpu')!.parentId, 'motherboard');
  assert.equal(assembly.instances.get('cooler')!.parentId, 'cpu');
  assert.deepEqual(assembly.findByKind('ram').map(instance => instance.slotId), ['motherboard:dimm2', 'motherboard:dimm4']);
  assert.equal(assembly.instances.has('gpu'), false);
  preview.dispose();
});

test('same asset path updates labels, while a changed asset path replaces the installed mesh', async () => {
  const requestedPaths: string[] = [];
  const released: Object3D[] = [];
  const assembly = new Assembly(async (kind, context) => {
    requestedPaths.push(`${kind}:${context.modelPath}`);
    const model = new Group();
    model.userData.requestedPath = context.modelPath;
    return model;
  }, { release: model => released.push(model) });
  const preview = new ConfigurationPreview(assembly);
  preview.setProducts({
    ...fullSelection(),
    case: product('case-old', 'case.glb'),
    ram: product('ram-old', 'ram.glb'),
    gpu: product('gpu-old', 'gpu.glb'),
  });
  await preview.load();

  const originalModels = new Map([...assembly.instances].map(([id, instance]) => [id, instance.model]));
  const firstGpu = assembly.instances.get('gpu')!.model;

  // Changing SKU metadata while keeping the same GLB must not reload geometry.
  preview.setProducts({
    ...fullSelection(),
    case: product('case-current', 'case.glb'),
    ram: product('ram-current', 'ram.glb'),
    gpu: product('gpu-current', 'gpu.glb'),
  });
  await preview.load();
  assert.equal(assembly.instances.get('case')!.model, originalModels.get('case'));
  assert.ok(assembly.findByKind('ram').every(instance => instance.model === originalModels.get(instance.id)));
  assert.equal(assembly.instances.get('gpu')!.model, firstGpu);
  assert.equal(assembly.instances.get('gpu')!.node.userData.productId, 'gpu-current');

  // Changing the selected asset must remove the old instance and mount a new one.
  preview.setProducts({
    ...fullSelection(),
    case: product('case-current', 'case.glb'),
    ram: product('ram-current', 'ram.glb'),
    gpu: product('gpu-new', 'gpu-alt.glb'),
  });
  await preview.load();
  const replacedGpu = assembly.instances.get('gpu')!;
  assert.notEqual(replacedGpu.model, firstGpu);
  assert.equal(replacedGpu.model.userData.requestedPath, 'gpu-alt.glb');
  assert.equal(replacedGpu.model.userData.modelPath, 'gpu-alt.glb');
  assert.ok(released.includes(firstGpu), 'the old GPU model must be released');
  assert.ok(requestedPaths.includes('gpu:gpu.glb'));
  assert.ok(requestedPaths.includes('gpu:gpu-alt.glb'));

  for (const [id, model] of originalModels) {
    if (id !== 'gpu') assert.equal(assembly.instances.get(id)!.model, model);
  }
  preview.dispose();
});

test('concurrent and completed loads retain one canonical 13-part ATX hierarchy', async () => {
  let requests = 0;
  const assembly = new Assembly(async () => { requests += 1; return new Group(); });
  const preview = new ConfigurationPreview(assembly);
  preview.setProducts(fullSelection());
  const first = preview.load();
  assert.equal(preview.load(), first);
  assert.equal(preview.load(), first);
  await first;
  const nodes = [...assembly.instances.values()].map(instance => instance.node);
  await preview.load();
  preview.setProducts({ ...fullSelection(), gpu: product('replacement-label', 'gpu.glb') });
  await preview.load();
  assert.equal(requests, 13);
  assert.equal(assembly.instances.size, 13);
  assert.equal(assembly.formFactor, 'ATX');
  assert.deepEqual(assembly.findByKind('ram').map(instance => instance.slotId), ['motherboard:dimm2', 'motherboard:dimm4']);
  assert.deepEqual(assembly.findByKind('fan').map(instance => instance.slotId), ['case:fan-rear', 'case:fan-front-1', 'case:fan-front-2', 'case:fan-front-3']);
  assert.deepEqual([...assembly.instances.values()].map(instance => instance.node), nodes);
  assert.equal(assembly.pending.size, 0);
  preview.dispose();
});

test('dispose during loading cancels reservations and prevents late installation or further loads', async () => {
  const requests: { context: AssetContext; resolve: (model: Object3D) => void }[] = [];
  const released: Object3D[] = [];
  const assembly = new Assembly((_kind, context) => new Promise(resolve => requests.push({ context, resolve })), {
    release: model => released.push(model),
  });
  const preview = new ConfigurationPreview(assembly);
  preview.setProducts({ case: product('case') });
  let resetEvents = 0;
  assembly.subscribe(event => { if (event.type === 'reset') resetEvents += 1; });
  const loading = preview.load();
  await tick();
  const rejected = assert.rejects(loading, /cancelled|disposed/i);
  preview.dispose();
  preview.dispose();
  await rejected;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].context.signal.aborted, true);
  const lateModel = new Group();
  requests[0].resolve(lateModel);
  await tick();
  assert.equal(assembly.instances.size, 0);
  assert.equal(assembly.pending.size, 0);
  assert.equal(assembly.root.children.length, 0);
  assert.equal(lateModel.parent, null);
  assert.deepEqual(released, [lateModel]);
  assert.equal(resetEvents, 1);
  await assert.rejects(preview.load(), /disposed/i);
  assert.equal(requests.length, 1);
});

test('a failed model load is retryable without reloading completed parents', async () => {
  const attempts = new Map<PartKind, number>();
  const assembly = new Assembly(async kind => {
    const attempt = (attempts.get(kind) ?? 0) + 1;
    attempts.set(kind, attempt);
    if (kind === 'gpu' && attempt === 1) throw new Error('Temporary GPU decoding failure');
    return new Group();
  });
  const preview = new ConfigurationPreview(assembly);
  preview.setProducts(fullSelection());
  await assert.rejects(preview.load(), /Temporary GPU decoding failure/);
  assert.equal(assembly.instances.size, 6);
  const cpuModel = assembly.instances.get('cpu')!.model;
  preview.setProducts({ ...fullSelection(), gpu: product('retry-current') });
  await preview.load();
  assert.equal(assembly.instances.size, 13);
  assert.equal(assembly.pending.size, 0);
  assert.equal(attempts.get('gpu'), 2);
  assert.equal(attempts.get('case'), 1);
  assert.equal(attempts.get('cpu'), 1);
  assert.equal(attempts.get('ram'), 2);
  assert.equal(assembly.instances.get('cpu')!.model, cpuModel);
  assert.equal(assembly.instances.get('gpu')!.node.userData.productId, 'retry-current');
  preview.dispose();
});

test('selection snapshots are independent of caller mutation and None removes their models', async () => {
  const assembly = new Assembly(async () => new Group());
  const preview = new ConfigurationPreview(assembly);
  const selected = product('initial');
  preview.setProducts({ case: product('case'), motherboard: product('board'), gpu: selected });
  selected.name = 'Mutated without setProducts';
  await preview.load();
  const gpu = assembly.instances.get('gpu')!;
  assert.equal(gpu.node.userData.productName, 'Product initial');
  preview.setProducts({});
  await preview.load();
  assert.equal(assembly.instances.size, 0);
  assert.equal(assembly.root.children.length, 0);
  assert.equal(gpu.node.parent, null);
  preview.dispose();
});

test('reset can reload the same preview and selected motherboard form factor drives the active connector layout', async () => {
  const assembly = new Assembly(async (_kind, context) => { const model = new Group(); model.userData.modelPath = context.modelPath; return model; }, { formFactor: 'ITX' });
  const preview = new ConfigurationPreview(assembly);
  preview.setProducts({
    case: product('case', 'case.glb'),
    motherboard: { ...product('itx-board', 'itx-board.glb'), formFactor: 'ITX' },
  });
  await preview.load();
  assert.equal(assembly.formFactor, 'ITX');
  assert.equal(assembly.instances.get('motherboard')!.node.userData.productId, 'itx-board');
  assert.equal(assembly.instances.get('motherboard')!.model.userData.modelPath, 'itx-board.glb');
  assembly.reset();
  await preview.load();
  assert.equal(assembly.instances.size, 2);
  assert.equal(assembly.formFactor, 'ITX');
  preview.dispose();
});

test('None cascades through CPU, motherboard and case while retaining independent selected models', async () => {
  const assembly = new Assembly(async () => new Group());
  const preview = new ConfigurationPreview(assembly);
  const selected = fullSelection();
  preview.setProducts(selected);
  await preview.load();
  const chassis = assembly.instances.get('case')!.model;
  const psu = assembly.instances.get('psu')!.model;
  const fanModels = assembly.findByKind('fan').map(instance => instance.model);
  const gpu = assembly.instances.get('gpu')!.model;
  delete selected.cpu;
  preview.setProducts(selected);
  assert.equal(assembly.instances.has('cpu'), false);
  assert.equal(assembly.instances.has('cooler'), false, 'selected cooler cannot remain without its CPU parent');
  await preview.load();
  assert.equal(assembly.instances.size, 11);
  assert.equal(assembly.instances.get('gpu')!.model, gpu);
  delete selected.motherboard;
  preview.setProducts(selected);
  await preview.load();
  assert.deepEqual([...assembly.instances.values()].map(instance => instance.kind).sort(), ['case', 'fan', 'fan', 'fan', 'fan', 'psu']);
  assert.equal(assembly.instances.get('case')!.model, chassis);
  assert.equal(assembly.instances.get('psu')!.model, psu);
  assert.deepEqual(assembly.findByKind('fan').map(instance => instance.model), fanModels);
  delete selected.case;
  preview.setProducts(selected);
  await preview.load();
  assert.equal(assembly.instances.size, 0);
  assert.equal(assembly.slots.size, 0);
  assert.equal(assembly.pending.size, 0);
  preview.dispose();
});

test('clearing and reselecting a pending case cannot commit its stale model', async () => {
  const requests: { kind: PartKind; context: AssetContext; resolve: (model: Object3D) => void }[] = [];
  const released: Object3D[] = [];
  const assembly = new Assembly((kind, context) => new Promise(resolve => requests.push({ kind, context, resolve })), {
    release: model => released.push(model),
  });
  const preview = new ConfigurationPreview(assembly);
  preview.setProducts({ case: product('old-case') });
  const loading = preview.load();
  await tick();
  preview.setProducts({});
  assert.equal(requests[0].context.signal.aborted, true);
  assert.equal(assembly.pending.size, 0);
  preview.setProducts({ case: product('current-case') });
  assert.equal(preview.load(), loading);
  await tick();
  assert.equal(requests.length, 2);
  const stale = new Group(), current = new Group();
  requests[1].resolve(current);
  await loading;
  requests[0].resolve(stale);
  await tick();
  assert.equal(assembly.instances.size, 1);
  assert.equal(assembly.instances.get('case')!.model, current);
  assert.equal(current.userData.productId, 'current-case');
  assert.equal(stale.parent, null);
  assert.deepEqual(released, [stale]);
  preview.dispose();
});

test('removing a pending motherboard settles latest load while preserving case and PSU', async () => {
  let boardRequest!: { context: AssetContext; resolve: (model: Object3D) => void };
  const assembly = new Assembly(async (kind, context) => kind === 'motherboard'
    ? new Promise(resolve => { boardRequest = { context, resolve }; }) : new Group());
  const preview = new ConfigurationPreview(assembly);
  const independent: PreviewSelection = { case: product('case'), psu: product('psu') };
  preview.setProducts(independent);
  await preview.load();
  const psu = assembly.instances.get('psu')!.model;
  preview.setProducts({ ...independent, motherboard: product('board'), cpu: product('cpu') });
  const loading = preview.load();
  await tick();
  preview.setProducts({ ...independent, cpu: product('cpu') });
  assert.equal(preview.load(), loading);
  await loading;
  assert.equal(boardRequest.context.signal.aborted, true);
  boardRequest.resolve(new Group());
  await tick();
  assert.deepEqual([...assembly.instances.keys()].sort(), ['case', 'psu']);
  assert.equal(assembly.instances.get('psu')!.model, psu);
  assert.equal(assembly.pending.size, 0);
  preview.dispose();
});

test('a selection queued at load completion is reconciled before the shared promise resolves', async () => {
  const assembly = new Assembly(async () => new Group());
  const preview = new ConfigurationPreview(assembly);
  preview.setProducts({ case: product('case') });
  let latestLoad: Promise<void> | undefined;
  assembly.subscribe(event => {
    if (event.type === 'installed' && event.kind === 'case') queueMicrotask(() => {
      preview.setProducts({ case: product('case'), psu: product('psu') });
      latestLoad = preview.load();
    });
  });
  const loading = preview.load();
  await loading;
  await latestLoad;
  assert.deepEqual([...assembly.instances.keys()].sort(), ['case', 'psu']);
  assert.equal(assembly.pending.size, 0);
  preview.dispose();
});
