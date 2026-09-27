import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { MaterialLibrary } from '../src/graphics/Materials';

test('case model materials keep their uploaded color instead of becoming white', () => {
  const sourceMaterial = new MeshStandardMaterial({ color: 0x336699, name: 'uploaded case shell' });
  const mesh = new Mesh(new BoxGeometry(), sourceMaterial);
  const model = new Group();
  model.add(mesh);
  const materials = new MaterialLibrary();

  materials.apply(model, 'case');

  assert.equal(mesh.material.color.getHex(), 0x336699);
  assert.equal(mesh.material.metalness, .46);
  assert.equal(mesh.material.roughness, .35);
  assert.equal(sourceMaterial.color.getHex(), 0x336699);

  materials.release(model);
  sourceMaterial.dispose();
  mesh.geometry.dispose();
});