import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial,
  PerspectiveCamera, Ray, Vector2, Vector3,
} from 'three';
import { AssemblyError, type Assembly } from '../src/core/Assembly';
import { SlotNode } from '../src/core/SlotNode';
import type { ComponentDefinition, ComponentInstance, PartKind, ValidationResult } from '../src/core/types';
import { hitTestSlot } from '../src/interaction/SlotHitTest';
import { SlotSnappingController } from '../src/interaction/SlotSnappingController';

function slot(id = 'motherboard:pcie1', x = 0): SlotNode {
  return new SlotNode({
    id, label: id === 'motherboard:pcie1' ? 'PCIe x16' : 'Alternative mount',
    accepts: ['gpu'], position: [x, 0, 0],
    bounds: { min: [-0.1, -0.05, -0.01], max: [0.1, 0.05, 0.01] },
    snapVector: [0, 0, 1], snapRadius: 0.04,
  }, 'motherboard');
}

function cameraAt(position = new Vector3(0, 0, 1), target = new Vector3()): PerspectiveCamera {
  const camera = new PerspectiveCamera(40, 1, 0.001, 10);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

test('slot hit follows its complete rotated parent transform', () => {
  const parent = new Group();
  parent.position.set(1, 2, -1);
  parent.rotation.set(0.25, Math.PI / 2, 0.12);
  const mount = slot();
  parent.add(mount);
  parent.updateMatrixWorld(true);
  const center = new Vector3().applyMatrix4(mount.matrixWorld);
  const origin = new Vector3(0, 0, 1).applyMatrix4(mount.matrixWorld);
  const camera = cameraAt(origin, center);
  const ray = new Ray(origin, center.clone().sub(origin).normalize());
  const hit = hitTestSlot(ray, camera, new Vector2(), { width: 1000, height: 1000 }, {
    object: mount, localBounds: mount.localBounds, snapVector: mount.snapVector, snapRadius: mount.snapRadius,
  });
  assert.ok(hit?.direct);
  const expected = new Vector3(0, 0, 0.01).applyMatrix4(mount.matrixWorld);
  assert.ok(hit.point.distanceTo(expected) < 1e-8, 'hit must lie on the rotated box face');
});

test('snap fallback rejects distant rays using both physical and screen proximity', () => {
  const mount = slot();
  const camera = cameraAt();
  const target = { object: mount, localBounds: mount.localBounds, snapVector: mount.snapVector, snapRadius: 0.02 };
  const viewport = { width: 1000, height: 1000 };
  // Deliberately near screen coordinates must not override the physical radius.
  assert.equal(hitTestSlot(new Ray(new Vector3(0.5, 0, 1), new Vector3(0, 0, -1)), camera, new Vector2(), viewport, target), null);
  // A physically near ray must still satisfy the independent pixel gate.
  assert.equal(hitTestSlot(new Ray(new Vector3(0.105, 0, 1), new Vector3(0, 0, -1)), camera, new Vector2(0.9, 0), viewport, target), null);
});

test('bounded snap fallback accepts a ray just outside a thin rotated connector', () => {
  const mount = slot();
  mount.rotation.y = Math.PI / 2;
  mount.updateMatrixWorld(true);
  const bounds = new Box3(new Vector3(-0.02, -0.03, -0.01), new Vector3(0.02, 0.03, 0.01));
  const origin = new Vector3(0, 0, 1).applyMatrix4(mount.matrixWorld);
  const camera = cameraAt(origin);
  const rayOrigin = new Vector3(0.025, 0, 1).applyMatrix4(mount.matrixWorld);
  const rayDirection = new Vector3(0, 0, -1).transformDirection(mount.matrixWorld);
  const projected = new Vector3(0.025, 0, 0).applyMatrix4(mount.matrixWorld).project(camera);
  const hit = hitTestSlot(new Ray(rayOrigin, rayDirection), camera, new Vector2(projected.x, projected.y), { width: 1000, height: 1000 }, {
    object: mount, localBounds: bounds, snapVector: mount.snapVector, snapRadius: 0.02,
  });
  assert.ok(hit);
  assert.equal(hit.direct, false);
});

/** Minimal DOM event surface: these tests exercise the real controller handlers. */
class CanvasStub extends EventTarget {
  style = { cursor: '' };
  tabIndex = -1;
  tagName = 'CANVAS';
  isContentEditable = false;
  focused = false;
  focus(): void { this.focused = true; }
  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 800, width: 800, height: 800, toJSON: () => ({}) };
  }
}

function pointer(type: string, x: number, y: number, overrides: Partial<PointerEvent> = {}): PointerEvent {
  return Object.assign(new Event(type, { cancelable: true }), {
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y,
    ...overrides,
  }) as PointerEvent;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(t: TestContext) {
  const previous = new Map(['window', 'document', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const windowStub = new EventTarget();
  const canvas = new CanvasStub();
  let overlay = false;
  let controller: SlotSnappingController | undefined;
  const mesh = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());

  // Register cleanup before changing globals or constructing the controller so
  // failed setup/assertions cannot leak DOM globals, listeners, or GPU resources.
  t.after(() => {
    try { controller?.dispose(); }
    finally {
      mesh.geometry.dispose();
      mesh.material.dispose();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: windowStub },
    document: { configurable: true, writable: true, value: { elementFromPoint: () => overlay ? {} : canvas } },
    HTMLElement: { configurable: true, writable: true, value: CanvasStub },
  });

  const first = slot();
  const second = slot('motherboard:pcie2', 0.25);
  const ramMount = new SlotNode({
    id: 'motherboard:dimm2', label: 'DIMM 2', accepts: ['ram'], position: [-0.25, 0, 0],
    bounds: { min: [-0.01, -0.05, -0.01], max: [0.01, 0.05, 0.01] }, snapVector: [0, 0, 1], snapRadius: 0.02,
  }, 'motherboard');
  const definition: ComponentDefinition = {
    kind: 'gpu', label: 'Graphics Card', watts: 200, description: '',
    bounds: { min: [-0.1, -0.05, -0.02], max: [0.1, 0.05, 0.02] },
  };
  const node = new Group();
  node.add(mesh);
  node.userData.instanceId = 'cpu';
  node.updateMatrixWorld(true);
  const existing: ComponentInstance = {
    id: 'cpu', kind: 'cpu', slotId: null, parentId: null, node, model: mesh,
    definition: { ...definition, kind: 'cpu', label: 'Processor' }, installedAt: 0,
  };
  const installations: { kind: PartKind; slotId: string | undefined }[] = [];
  const committed: ComponentInstance[] = [];
  const completions: ComponentInstance[] = [];
  const focused: ComponentInstance[] = [];
  const reports: string[] = [];
  let enabled = true;
  let validation: ValidationResult = { valid: true };
  let subscribed = true;
  let installGate: Promise<void> | null = null;
  // Spatial transactions have their own tests. This boundary stub isolates
  // gestures while still using real SlotNode transforms and Assembly signatures.
  const assembly = {
    slots: new Map([[first.slotId, first], [second.slotId, second], [ramMount.slotId, ramMount]]),
    instances: new Map([['cpu', existing]]),
    getAvailableSlots: (kind: PartKind) => [first, second, ramMount].filter(mount => mount.acceptsKind(kind)),
    getDefinition: (kind: PartKind) => ({ ...definition, kind, label: kind === 'ram' ? 'Memory' : definition.label }),
    subscribe: () => () => { subscribed = false; },
    validate: () => validation,
    install: async (kind: PartKind, slotId?: string) => {
      installations.push({ kind, slotId });
      if (installGate) await installGate;
      const instance = { ...existing, node: new Group(), model: new Group(), id: kind, kind, slotId: slotId ?? null, definition };
      committed.push(instance);
      assembly.instances.set(kind, instance);
      return instance;
    },
  } as unknown as Assembly;
  controller = new SlotSnappingController({
    canvas: canvas as unknown as HTMLCanvasElement, camera: cameraAt(), assembly,
    previewRoot: new Group(), setControlsEnabled: value => { enabled = value; },
    onFocus: instance => focused.push(instance), onReport: message => reports.push(message),
    onInstalled: instance => completions.push(instance),
  });
  return {
    canvas, controller, window: windowStub, first, second, installations, committed, completions, focused, reports,
    get controlsEnabled() { return enabled; },
    get subscribed() { return subscribed; },
    setOverlay(value: boolean) { overlay = value; },
    setValidation(value: ValidationResult) { validation = value; },
    setInstallGate(value: Promise<void>) { installGate = value; },
  };
}

test('library drag can begin after pointermove threshold with button -1 and buttons 1', async t => {
  const h = harness(t);
  const event = pointer('pointermove', -10, 400);
  assert.equal(event.button, -1);
  assert.equal(event.buttons, 1);
  assert.equal(h.controller.beginDrag('gpu', event), true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.controlsEnabled, false);
  h.window.dispatchEvent(pointer('pointerup', 400, 400));
  await Promise.resolve();
  assert.deepEqual(h.installations, [{ kind: 'gpu', slotId: h.first.slotId }]);
  assert.equal(h.controlsEnabled, true);
});

test('a hover with no held primary button cannot initiate a drag', t => {
  const h = harness(t);
  assert.equal(h.controller.beginDrag('gpu', pointer('pointermove', 400, 400, { buttons: 0 })), false);
  assert.equal(h.controller.beginDrag('gpu', pointer('pointerdown', 400, 400, { button: 2, buttons: 2 })), false);
  assert.equal(h.controller.isPlacing, false);
  assert.equal(h.controlsEnabled, true);
});

test('releasing outside the canvas cancels instead of installing', t => {
  const h = harness(t);
  h.controller.beginDrag('gpu', pointer('pointerdown', -10, 400));
  h.window.dispatchEvent(pointer('pointermove', 400, 400));
  assert.equal(h.controller.state?.valid, true);
  h.window.dispatchEvent(pointer('pointerup', 900, 400));
  assert.equal(h.installations.length, 0);
  assert.equal(h.controller.isPlacing, false);
  assert.equal(h.controlsEnabled, true);
});

test('releasing on a canvas overlay cancels despite coordinates inside its bounds', t => {
  const h = harness(t);
  h.controller.beginDrag('gpu', pointer('pointerdown', -10, 400));
  h.window.dispatchEvent(pointer('pointermove', 400, 400));
  assert.equal(h.controller.state?.valid, true);
  h.setOverlay(true);
  h.window.dispatchEvent(pointer('pointerup', 400, 400));
  assert.equal(h.installations.length, 0);
  assert.equal(h.controller.isPlacing, false);
  assert.equal(h.controlsEnabled, true);
});

test('pointercancel removes the preview and restores orbit controls', t => {
  const h = harness(t);
  h.controller.beginDrag('gpu', pointer('pointerdown', -10, 400));
  h.window.dispatchEvent(pointer('pointermove', 400, 400));
  assert.equal(h.controller.state?.slotId, h.first.slotId);
  h.window.dispatchEvent(pointer('pointercancel', 400, 400));
  assert.equal(h.installations.length, 0);
  assert.equal(h.controller.state, null);
  assert.equal(h.controlsEnabled, true);
});

test('dropdown selection commits that exact mount, and duplicate confirm cannot install again', async t => {
  const h = harness(t);
  assert.equal(h.controller.beginPlacement('gpu'), true);
  assert.equal(h.canvas.focused, true);
  assert.equal(h.controller.selectSlot('unknown-slot'), false);
  assert.equal(h.controller.selectSlot(h.second.slotId), true);
  assert.equal(h.controller.state?.slotId, h.second.slotId);
  await Promise.all([h.controller.confirmPlacement(), h.controller.confirmPlacement()]);
  assert.deepEqual(h.installations, [{ kind: 'gpu', slotId: h.second.slotId }]);
  assert.equal(h.controller.state, null);
  assert.equal(h.controlsEnabled, true);
});

test('click placement survives pointer movement outside the canvas and onto its confirm overlay', async t => {
  const h = harness(t);
  h.controller.beginPlacement('gpu');
  assert.equal(h.controller.state?.slotId, h.first.slotId);
  h.window.dispatchEvent(pointer('pointermove', 900, 400, { buttons: 0 }));
  assert.equal(h.controller.state?.slotId, h.first.slotId);
  h.setOverlay(true);
  h.window.dispatchEvent(pointer('pointermove', 400, 400, { buttons: 0 }));
  assert.equal(h.controller.state?.slotId, h.first.slotId);
  assert.equal(h.controller.state?.valid, true);
  await h.controller.confirmPlacement();
  assert.deepEqual(h.installations, [{ kind: 'gpu', slotId: h.first.slotId }]);
});

test('dropdown selection survives overlay hover and installs only on explicit confirmation', async t => {
  const h = harness(t);
  h.controller.beginPlacement('gpu');
  h.setOverlay(true);
  assert.equal(h.controller.selectSlot(h.second.slotId), true);
  h.window.dispatchEvent(pointer('pointermove', 410, 420, { buttons: 0 }));
  h.window.dispatchEvent(pointer('pointerup', 410, 420));
  assert.equal(h.controller.state?.slotId, h.second.slotId);
  assert.equal(h.installations.length, 0, 'overlay pointer release itself is not a mount commit');
  await h.controller.confirmPlacement();
  assert.deepEqual(h.installations, [{ kind: 'gpu', slotId: h.second.slotId }]);
});

test('commit revalidates a previously valid preview when the mount becomes blocked', async t => {
  const h = harness(t);
  h.controller.beginPlacement('gpu');
  assert.equal(h.controller.state?.valid, true);
  h.setValidation({ valid: false, code: 'collision', reason: 'Glass panel clearance is blocked.' });
  await h.controller.confirmPlacement();
  assert.equal(h.installations.length, 0);
  assert.equal(h.controller.state?.valid, false);
  assert.equal(h.controller.state?.reason, 'Glass panel clearance is blocked.');
  assert.ok(h.reports.includes('Glass panel clearance is blocked.'));
});

test('a late GPU installation preserves the newer RAM preview and does not steal focus or status', async t => {
  const h = harness(t);
  const gate = deferred();
  t.after(gate.resolve);
  h.setInstallGate(gate.promise);
  h.controller.beginPlacement('gpu');
  const completion = h.controller.confirmPlacement();
  assert.equal(h.installations.length, 1);
  assert.equal(h.controller.beginPlacement('ram'), true);
  const reports = [...h.reports];
  gate.resolve();
  await completion;
  assert.equal(h.committed.length, 1, 'a valid independent component remains installed by the assembly');
  assert.equal(h.committed[0].kind, 'gpu');
  assert.equal(h.completions.length, 0, 'the old transaction must not invoke a focus callback');
  assert.deepEqual(h.reports, reports);
  assert.equal(h.controller.state?.kind, 'ram');
  assert.equal(h.controller.state?.slotId, 'motherboard:dimm2');
  assert.equal(h.controlsEnabled, false);
});

test('an explicit cancel while no preview is active invalidates a pending completion', async t => {
  const h = harness(t);
  const gate = deferred();
  t.after(gate.resolve);
  h.setInstallGate(gate.promise);
  h.controller.beginPlacement('gpu');
  const completion = h.controller.confirmPlacement();
  assert.equal(h.controller.isPlacing, false, 'commit clears its own preview before loading');
  // The root calls cancel before Reset/focus even when the preview is inactive.
  h.controller.cancel();
  const reports = [...h.reports];
  gate.resolve();
  await completion;
  assert.equal(h.committed.length, 1, 'UI cancellation must not undo a valid assembly transaction');
  assert.equal(h.completions.length, 0);
  assert.deepEqual(h.reports, reports);
  assert.equal(h.controller.state, null);
  assert.equal(h.controlsEnabled, true);
});

test('a late failure from an earlier selection cannot overwrite the current preview status', async t => {
  const h = harness(t);
  const gate = deferred();
  t.after(gate.resolve);
  h.setInstallGate(gate.promise);
  h.controller.beginPlacement('gpu');
  const completion = h.controller.confirmPlacement();
  h.controller.beginPlacement('ram');
  const reports = [...h.reports];
  gate.reject(new Error('GPU asset failed to load.'));
  await completion;
  assert.equal(h.committed.length, 0);
  assert.equal(h.completions.length, 0);
  assert.deepEqual(h.reports, reports);
  assert.equal(h.controller.state?.kind, 'ram');
});

for (const [label, cause] of [
  ['Assembly cancellation', new AssemblyError('Installation cancelled.', 'cancelled')],
  ['AbortError', Object.assign(new Error('Model request cancelled.'), { name: 'AbortError' })],
] as const) {
  test(`${label} is silent even when the current transaction has no newer interaction`, async t => {
    const h = harness(t);
    const gate = deferred();
    t.after(gate.resolve);
    h.setInstallGate(gate.promise);
    h.controller.beginPlacement('gpu');
    const completion = h.controller.confirmPlacement();
    const reports = [...h.reports];
    gate.reject(cause);
    await completion;
    assert.equal(h.committed.length, 0);
    assert.equal(h.completions.length, 0);
    assert.deepEqual(h.reports, reports);
  });
}

test('an unexpected failure still reports an error for the current transaction', async t => {
  const h = harness(t);
  const gate = deferred();
  t.after(gate.resolve);
  h.setInstallGate(gate.promise);
  h.controller.beginPlacement('gpu');
  const completion = h.controller.confirmPlacement();
  gate.reject(new Error('GPU asset failed to load.'));
  await completion;
  assert.equal(h.committed.length, 0);
  assert.equal(h.completions.length, 0);
  assert.equal(h.reports.at(-1), 'GPU asset failed to load.');
});

test('an orbit drag returning to its starting pixel does not focus a component', t => {
  const h = harness(t);
  h.canvas.dispatchEvent(pointer('pointerdown', 400, 400));
  h.window.dispatchEvent(pointer('pointermove', 450, 400));
  h.window.dispatchEvent(pointer('pointerup', 400, 400));
  assert.equal(h.focused.length, 0);
  h.canvas.dispatchEvent(pointer('pointerdown', 400, 400));
  h.window.dispatchEvent(pointer('pointerup', 400, 400));
  assert.deepEqual(h.focused.map(instance => instance.id), ['cpu']);
});

test('Escape cancels click placement and disposal detaches event listeners', t => {
  const h = harness(t);
  h.controller.beginPlacement('gpu');
  h.window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  assert.equal(h.controller.state, null);
  assert.equal(h.controlsEnabled, true);
  h.controller.beginPlacement('gpu');
  h.controller.dispose();
  assert.equal(h.canvas.tabIndex, -1);
  assert.equal(h.canvas.style.cursor, '');
  assert.equal(h.controlsEnabled, true);
  assert.equal(h.subscribed, false);
  assert.equal(h.controller.beginPlacement('gpu'), false);
  h.canvas.dispatchEvent(pointer('pointerdown', 400, 400));
  h.window.dispatchEvent(pointer('pointerup', 400, 400));
  assert.equal(h.focused.length, 0);
  assert.equal(h.installations.length, 0);
});
