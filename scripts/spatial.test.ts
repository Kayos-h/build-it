import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Group, Matrix4, Object3D, Vector3 } from 'three';
import { Assembly } from '../src/core/Assembly';
import { CollisionWorld } from '../src/core/CollisionWorld';
import { SlotNode } from '../src/core/SlotNode';
import { BOARD_PROFILES, CPU_IHS_HEIGHT, THERMAL_INTERFACE_GAP } from '../src/config/hardware';
import type { AssetContext, AssetProvider, ComponentInstance, FormFactor, PartKind } from '../src/core/types';

const immediate: AssetProvider = async () => new Group();
const distance = (actual: Vector3, expected: Vector3, epsilon = 1e-8) => assert.ok(actual.distanceTo(expected) < epsilon, `${actual.toArray()} vs ${expected.toArray()}`);
async function board(assembly: Assembly): Promise<void> { await assembly.install('case'); await assembly.install('motherboard'); }

function deferredProvider() {
  const requests: Array<{ kind: PartKind; context: AssetContext; resolve: (model: Object3D) => void; reject: (error: Error) => void }> = [];
  const provider: AssetProvider = (kind, context) => new Promise((resolve, reject) => requests.push({ kind, context, resolve, reject }));
  return { requests, provider };
}

for (const formFactor of ['ATX', 'mATX', 'ITX'] as FormFactor[]) {
  test(`${formFactor}: complete build uses mount parents and clears the enclosure`, async () => {
    const assembly = new Assembly(immediate, { formFactor });
    await board(assembly);
    for (const kind of ['cpu', 'cooler', 'ram', 'ram', 'gpu', 'psu', 'ssd'] as PartKind[]) await assembly.install(kind);
    for (const slot of ['case:fan-rear', 'case:fan-front-1', 'case:fan-front-2', 'case:fan-front-3']) await assembly.install('fan', slot);
    assert.equal(assembly.instances.size, 13);
    assert.equal(assembly.pending.size, 0);
    for (const instance of assembly.instances.values()) {
      if (instance.kind === 'case') { assert.equal(instance.node.parent, assembly.root); continue; }
      assert.ok(instance.node.parent instanceof SlotNode);
      assert.equal(instance.node.parent, assembly.slots.get(instance.slotId!));
      assert.equal(instance.node.parent.parent, assembly.instances.get(instance.parentId!)!.node);
      assert.deepEqual(instance.node.position.toArray(), [0, 0, 0]);
      assert.deepEqual(instance.node.quaternion.toArray(), [0, 0, 0, 1]);
      assert.deepEqual(instance.node.scale.toArray(), [1, 1, 1]);
      assert.ok(assembly.validate(instance.kind, instance.slotId!, { ignoreInstanceId: instance.id }).valid, instance.id);
    }
    const ram = assembly.findByKind('ram').map(instance => instance.slotId);
    assert.deepEqual(ram, formFactor === 'ITX' ? ['motherboard:dimm1', 'motherboard:dimm2'] : ['motherboard:dimm2', 'motherboard:dimm4']);
    assert.equal(assembly.slots.get('case:motherboard')!.screwPoints.length, BOARD_PROFILES[formFactor].standoffs.length);
  });
}

test('case transformation propagates through board, CPU and cooler without recomputing positions', async () => {
  const assembly = new Assembly(immediate);
  await board(assembly);
  const cpu = await assembly.install('cpu');
  const cooler = await assembly.install('cooler');
  const chassis = assembly.instances.get('case')!.node;
  chassis.position.set(2.5, .8, -3);
  chassis.rotation.set(.3, .8, -.15);
  chassis.updateWorldMatrix(true, true);
  const profile = BOARD_PROFILES.ATX;
  const expectedCpu = new Vector3(...profile.position).add(new Vector3(...profile.socket)).applyMatrix4(chassis.matrixWorld);
  distance(cpu.node.getWorldPosition(new Vector3()), expectedCpu);
  const expectedCooler = cpu.node.localToWorld(new Vector3(0, 0, CPU_IHS_HEIGHT + THERMAL_INTERFACE_GAP));
  distance(cooler.node.getWorldPosition(new Vector3()), expectedCooler);
  assert.ok(assembly.validate('gpu').valid, 'GPU bracket must use the transformed case frame');
});

test('removing an owner removes descendants and preserves independent case-mounted hardware', async () => {
  const assembly = new Assembly(immediate);
  await board(assembly);
  for (const kind of ['cpu', 'cooler', 'ram', 'gpu', 'psu'] as PartKind[]) await assembly.install(kind);
  assembly.remove('cpu');
  assert.equal(assembly.instances.has('cpu'), false);
  assert.equal(assembly.instances.has('cooler'), false);
  assert.equal(assembly.slots.has('cpu:cooler'), false);
  assert.ok(assembly.instances.has('motherboard'));
  assembly.remove('motherboard');
  assert.deepEqual([...assembly.instances.keys()].sort(), ['case', 'psu']);
  assert.equal(assembly.slots.get('case:motherboard')!.occupantId, null);
  assert.equal([...assembly.slots.keys()].some(id => id.startsWith('motherboard:')), false);
  assembly.remove('case');
  assert.equal(assembly.root.children.length, 0);
  assert.equal(assembly.collisionWorld.obstacles.size, 0);
});

test('pending installation does not satisfy prerequisites or contribute watts', async () => {
  const { provider, requests } = deferredProvider();
  const assembly = new Assembly(provider);
  const pendingCase = assembly.install('case');
  assert.equal(assembly.instances.size, 0);
  await assert.rejects(assembly.install('motherboard'), /Install the pc case first/i);
  requests[0].resolve(new Group()); await pendingCase;
  const pendingBoard = assembly.install('motherboard');
  assert.equal(assembly.watts, 0);
  await assert.rejects(assembly.install('cpu'), /Install the motherboard first/i);
  requests[1].reject(new Error('Network unavailable'));
  await assert.rejects(pendingBoard, /Network unavailable/);
  assert.equal(assembly.instances.has('motherboard'), false);
  assert.equal(assembly.pending.size, 0);
  const retry = assembly.install('motherboard');
  requests[2].resolve(new Group()); await retry;
  assert.ok(assembly.instances.has('motherboard'));
});

test('duplicate installation requests share one promise and create one component', async () => {
  const { provider, requests } = deferredProvider();
  const assembly = new Assembly(provider);
  const first = assembly.install('case');
  const second = assembly.install('case');
  assert.equal(first, second);
  assert.equal(requests.length, 1);
  requests[0].resolve(new Group());
  assert.equal(await first, await second);
  assert.equal(assembly.instances.size, 1);
  assert.equal(assembly.root.children.length, 1);
});

test('reset invalidates pending callbacks even when the same component is reinstalled', async () => {
  const { provider, requests } = deferredProvider();
  const assembly = new Assembly(provider);
  const stale = assembly.install('case');
  const rejected = assert.rejects(stale, /cancelled/i);
  assembly.reset(); await rejected;
  const current = assembly.install('case');
  const oldModel = new Group();
  requests[0].resolve(oldModel);
  requests[1].resolve(new Group());
  await current;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(oldModel.parent, null);
  assert.equal(assembly.instances.size, 1);
  assert.equal(assembly.root.children.length, 1);
  assembly.reset();
  assert.equal(assembly.root.children.length, 0);
});

test('reset and late completion release each model exactly once', async () => {
  const { provider, requests } = deferredProvider();
  const released: Object3D[] = [];
  const assembly = new Assembly(provider, { release: model => released.push(model) });
  const old = assembly.install('case');
  const cancelled = assert.rejects(old, /cancelled/i);
  assembly.reset(); await cancelled;
  const current = assembly.install('case');
  const oldModel = new Group(), currentModel = new Group();
  requests[0].resolve(oldModel);
  requests[1].resolve(currentModel);
  await current;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, [oldModel]);
  assembly.reset(); assembly.reset();
  assert.deepEqual(released, [oldModel, currentModel]);
});

test('removing a parent cancels a pending child without reattaching it', async () => {
  const { provider, requests } = deferredProvider();
  const assembly = new Assembly(provider);
  const casePromise = assembly.install('case'); requests[0].resolve(new Group()); await casePromise;
  const child = assembly.install('motherboard');
  const rejected = assert.rejects(child, /cancelled/i);
  assembly.remove('case'); await rejected;
  assert.equal(requests[1].context.signal.aborted, true);
  const late = new Group(); requests[1].resolve(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(assembly.instances.size, 0);
  assert.equal(assembly.slots.size, 0);
  assert.equal(late.parent, null);
});

test('mount reservations are per DIMM slot and reject incompatible component categories', async () => {
  const assembly = new Assembly(immediate);
  await board(assembly);
  assert.equal(assembly.validate('gpu', 'motherboard:dimm2').code, 'incompatible');
  const ram = await assembly.install('ram', 'motherboard:dimm2');
  assert.equal(assembly.validate('ram', 'motherboard:dimm2').code, 'occupied');
  assert.equal(assembly.validate('ram', 'motherboard:dimm4').valid, true);
  assert.equal(await assembly.install('ram', 'motherboard:dimm2'), ram, 'repeated requests are idempotent');
});

test('GPU requires an independently aligned case expansion bracket', async () => {
  const assembly = new Assembly(immediate);
  await board(assembly);
  assert.equal(assembly.validate('gpu').valid, true);
  const bracket = assembly.slots.get('case:gpu-bracket')!;
  bracket.position.y += .004;
  assert.equal(assembly.validate('gpu').code, 'alignment');
  bracket.position.y -= .004;
  bracket.rotation.y = .1;
  assert.equal(assembly.validate('gpu').code, 'alignment');
});

test('glass, shroud and motherboard heatsinks block physical interpenetration', async () => {
  const assembly = new Assembly(immediate);
  await board(assembly);
  await assembly.install('cpu');
  const coolerSlot = assembly.slots.get('cpu:cooler')!;
  const tall = coolerSlot.getSnapMatrix().multiply(new Matrix4().makeTranslation(0, 0, .15));
  assert.equal(assembly.validateTransform('cooler', coolerSlot, tall).code, 'collision');
  const cpuSlot = assembly.slots.get('motherboard:cpu')!;
  const boardNode = assembly.instances.get('motherboard')!.node;
  const atHeatsink = boardNode.matrixWorld.clone().multiply(new Matrix4().makeTranslation(.02, .25, .015));
  const heatsink = assembly.validateTransform('cpu', cpuSlot, atHeatsink, 'cpu');
  assert.equal(heatsink.code, 'collision');
  assert.ok(heatsink.collisions?.some(label => label.includes('heatsink')));
  const inShroud = assembly.instances.get('case')!.node.matrixWorld.clone().multiply(new Matrix4().makeTranslation(0, .04, 0));
  assert.equal(assembly.validateTransform('cooler', coolerSlot, inShroud).code, 'collision');
});

test('radiator and top fans cannot occupy the same physical volume', async () => {
  const assembly = new Assembly(immediate);
  await assembly.install('case');
  assert.equal(assembly.validate('radiator').valid, true);
  await assembly.install('radiator');
  assert.equal(assembly.validate('fan', 'case:fan-top-1').code, 'collision');
  assembly.remove('radiator');
  assert.equal(assembly.validate('fan', 'case:fan-top-1').valid, true);
  await assembly.install('fan', 'case:fan-top-1');
  assert.equal(assembly.validate('radiator').code, 'collision');
});

test('oriented boxes avoid false positives from overlapping world AABBs', () => {
  const collision = new CollisionWorld();
  const rod = new Box3(new Vector3(-1, -.02, -.02), new Vector3(1, .02, .02));
  const a = new Matrix4().makeRotationZ(Math.PI / 4);
  const b = new Matrix4().makeTranslation(-.08, .08, 0).multiply(a);
  assert.ok(rod.clone().applyMatrix4(a).intersectsBox(rod.clone().applyMatrix4(b)));
  assert.equal(collision.intersects(rod, a, rod, b), false);
  assert.equal(collision.intersects(rod, a, rod, a), true);
});

test('motherboard profile changes require removal and replace the standoff anchor', async () => {
  const assembly = new Assembly(immediate);
  await board(assembly);
  assert.throws(() => assembly.setFormFactor('ITX'), /Remove the motherboard/);
  assembly.remove('motherboard');
  assembly.setFormFactor('ITX');
  assert.equal(assembly.slots.get('case:motherboard')!.screwPoints.length, 4);
  const installedBoard = await assembly.install('motherboard');
  assert.equal(installedBoard.definition.bounds.max[0], .17);
  assert.equal(assembly.getAvailableSlots('ram').length, 2);
});

test('case cutouts remain fixed when motherboard PCIe metadata changes', async () => {
  const originalPcie = BOARD_PROFILES.ATX.pcie;
  const correct = new Assembly(immediate);
  await board(correct);
  const fixedBracket = correct.slots.get('case:gpu-bracket')!.position.clone();
  const cutouts = [...correct.slots.values()].filter(slot => slot.slotId.startsWith('case:expansion-slot-'));
  assert.equal(cutouts.length, 7);
  for (let index = 1; index < cutouts.length; index++) {
    assert.ok(Math.abs(cutouts[index - 1].position.y - cutouts[index].position.y - .02032) < 1e-10);
  }
  try {
    // A bad SKU calibration must not drag the chassis cutouts along with it.
    BOARD_PROFILES.ATX.pcie = [originalPcie[0], originalPcie[1] + .004, originalPcie[2]];
    const mismatched = new Assembly(immediate);
    await board(mismatched);
    distance(mismatched.slots.get('case:gpu-bracket')!.position, fixedBracket);
    assert.equal(mismatched.validate('gpu').code, 'alignment');
    await assert.rejects(mismatched.install('gpu'), /bracket does not align/i);
  } finally {
    BOARD_PROFILES.ATX.pcie = originalPcie;
  }
});
