import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { ProductKind } from '../../src/config/products.js';
import { gltfDocument } from '../../src/graphics/modelFormat.js';
import { baseOrientation, measuredBounds } from '../../src/graphics/ModelCalibration.js';
import { DEFAULT_MODEL_TRANSFORM, type StoredModelBounds, type StoredModelTransform } from './calibration.js';

export interface ModelInspectionResult { transform: StoredModelTransform; bounds: StoredModelBounds | null; warning?: string }
/** Geometry-only inspection avoids texture/network/worker dependencies on the server.
 * Compressed glTF accessors retain min/max; the browser measures decoded vertices. */
export async function inspectModelFile(filePath: string, kind: ProductKind): Promise<ModelInspectionResult> {
  const data = await readFile(filePath);
  return inspectModelData(data, filePath, kind);
}
export function inspectModelData(data: Buffer, filename: string, kind: ProductKind): ModelInspectionResult {
  const extension = extname(filename).toLowerCase();
  const transform: StoredModelTransform = { ...DEFAULT_MODEL_TRANSFORM, normalization: 'slot-v1' };
  let box: Box3;
  if (extension === '.obj') {
    const source = new OBJLoader().parse(data.toString('utf8'));
    source.quaternion.copy(baseOrientation(kind));
    box = measuredBounds(source);
    source.traverse(object => {
      const mesh = object as import('three').Mesh;
      mesh.geometry?.dispose();
      if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => material.dispose());
    });
  } else {
    const document = gltfDocument(extension === '.gltf' ? data.toString('utf8') : new Uint8Array(data).buffer);
    if (!Array.isArray(document.meshes) || !document.meshes.some((mesh: any) => mesh.primitives?.length)) throw new Error('Model has no mesh geometry.');
    box = new Box3();
    const visited = new Set<number>();
    let incomplete = false;
    const visit = (index: number, parent: Matrix4, depth = 0) => {
      if (visited.has(index) || depth > 128) throw new Error('Invalid or excessively deep model hierarchy.');
      const node = document.nodes?.[index];
      if (!node) throw new Error('Invalid model node.');
      visited.add(index);
      const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
        new Vector3(...(node.translation ?? [0, 0, 0]) as [number, number, number]),
        new Quaternion(...(node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number]),
        new Vector3(...(node.scale ?? [1, 1, 1]) as [number, number, number]),
      );
      const world = parent.clone().multiply(local);
      for (const primitive of document.meshes?.[node.mesh]?.primitives ?? []) {
        const accessor = document.accessors?.[primitive.attributes?.POSITION];
        if (!accessor?.min || !accessor?.max) { incomplete = true; continue; }
        box.union(new Box3(new Vector3().fromArray(accessor.min), new Vector3().fromArray(accessor.max)).applyMatrix4(world));
      }
      for (const child of node.children ?? []) visit(child, world, depth + 1);
      visited.delete(index);
    };
    const scene = document.scenes?.[document.scene ?? 0];
    if (!scene?.nodes?.length) throw new Error('Model has no active scene.');
    const base = new Matrix4().makeRotationFromQuaternion(baseOrientation(kind));
    for (const index of scene.nodes) visit(index, base);
    if (box.isEmpty() || incomplete) return { transform, bounds: null, warning: 'Source bounds will be measured from decoded vertices in the preview.' };
  }
  const values = [...box.min.toArray(), ...box.max.toArray()];
  if (!values.every(Number.isFinite)) throw new Error('Model coordinates must be finite.');
  return { transform, bounds: {
    min: box.min.toArray() as [number, number, number], max: box.max.toArray() as [number, number, number],
    size: box.getSize(new Vector3()).toArray() as [number, number, number],
    center: box.getCenter(new Vector3()).toArray() as [number, number, number],
  } };
}
