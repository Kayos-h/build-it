import {
  Box3, BoxGeometry, BufferGeometry, Euler, Group, InstancedMesh, Material,
  Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Texture, TorusGeometry,
  Vector3, type ColorRepresentation, type WebGLRenderer,
} from 'three';
import { ModelFileLoader } from './ModelFileLoader';
import { createCalibratedAsset } from './ModelCalibration';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getSession } from '../api';
import type { AssetContext, AssetProvider, PartKind } from '../core/types';
import { MaterialLibrary } from './Materials';


/** Deduplicates pending GLTF requests, shares immutable geometry, and owns clone lifetimes. */
export class AssetRepository {
  readonly materials: MaterialLibrary;
  readonly provide: AssetProvider = (kind, context) => this.load(kind, context);
  private readonly draco = new DRACOLoader().setDecoderPath('/draco/');
  private readonly loader = new ModelFileLoader(this.draco);
  private readonly sources = new Map<string, Promise<Group>>();
  private readonly sharedGeometries = new Set<BufferGeometry>();
  private readonly sourceMaterials = new Set<Material>();
  private readonly active = new Set<Group>();
  private disposed = false;

  constructor(renderer?: WebGLRenderer) { this.materials = new MaterialLibrary(renderer); }

  async load(kind: PartKind, context: AssetContext): Promise<Group> {
    this.assertActive(context.signal);
    let root: Group;
    if (kind === 'radiator') root = this.createRadiator();
    else {
      const modelPath = context.modelPath;
      if (!modelPath) throw new Error(`No 3D model is configured for ${kind}.`);
      const source = await this.source(kind, modelPath);
      this.assertActive(context.signal);
      // Every Object3D transform and material is independent; source geometry/maps stay shared.
      const instance = source.clone(true);
      this.materials.apply(instance, kind);
      root = this.calibrate(instance, kind, context);
      if (kind === 'case') this.addCaseGlass(root);
      this.addRgbArray(root, kind);
    }
    root.name = `visual:${context.instanceId}`;
    root.userData.partKind = kind;
    root.userData.modelPath = context.modelPath;
    root.updateMatrixWorld(true);
    const actual = new Box3().setFromObject(root);
    root.userData.physicalBounds ??= { min: actual.min.toArray(), max: actual.max.toArray() };
    root.userData.calibration = kind === 'motherboard'
      ? `${context.formFactor} selected board asset fitted to the board envelope; connector slots use the configured form-factor layout.`
      : kind === 'radiator' ? 'Dimensioned 240 mm reference radiator; no source GLB was supplied.'
      : 'Selected GLB fitted to the component envelope and corrected by its optional procedural transform.';
    this.active.add(root);
    return root;
  }

  setRgbColor(color: ColorRepresentation) { this.materials.setRgbColor(color); }
  setGlassOpen(open: boolean) { this.materials.setGlassOpen(open); }

  /** Called by Assembly on removal, reset, and a stale asynchronous completion. */
  release(model: Object3D) {
    if (!this.active.delete(model as Group)) return;
    this.materials.release(model);
    const ownedGeometry = new Set<BufferGeometry>();
    model.traverse(object => {
      if (object instanceof Mesh && !this.sharedGeometries.has(object.geometry)) ownedGeometry.add(object.geometry);
    });
    ownedGeometry.forEach(geometry => geometry.dispose());
    model.removeFromParent();
  }

  private assertActive(signal: AbortSignal) {
    if (this.disposed || signal.aborted) throw new DOMException('Model request cancelled', 'AbortError');
  }

  private source(kind: PartKind, modelPath: string) {
    const cacheKey = `${kind}:${modelPath}`;
    const existing = this.sources.get(cacheKey);
    if (existing) return existing;
    this.refreshAuthHeader();
    const promise = this.loader.loadAsync(this.modelUrl(modelPath)).then(gltf => {
      let source = gltf.scene;
      if (kind === 'ssd') source = this.batchStaticMeshes(source);
      source.traverse(object => {
        if (!(object instanceof Mesh)) return;
        this.sharedGeometries.add(object.geometry);
        (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => this.sourceMaterials.add(material));
      });
      return source;
    }).catch(error => { this.sources.delete(cacheKey); throw error; });
    this.sources.set(cacheKey, promise);
    return promise;
  }

  private modelUrl(modelPath: string): string {
    if (modelPath.startsWith('/')) return modelPath;
    throw new Error('Model asset URL must come from the authenticated model catalog.');
  }

  private refreshAuthHeader(): void {
    const token = getSession()?.token;
    this.loader.setRequestHeader(token ? { Authorization: `Bearer ${token}` } : {});
  }

  private calibrate(source: Group, kind: PartKind, context: AssetContext): Group {
    return createCalibratedAsset(source, kind, context.definition, context.modelTransform);
  }

  private batchStaticMeshes(source: Group): Group {
    source.updateMatrixWorld(true);
    const batches = new Map<string, { material: Material; geometries: BufferGeometry[] }>();
    const output = new Group(); output.name = 'batched-ssd';
    let inputMeshes = 0;
    source.traverse(object => {
      if (!(object instanceof Mesh)) return;
      inputMeshes += 1;
      if (Array.isArray(object.material) || Object.keys(object.geometry.morphAttributes).length) {
        const retained = object.clone(); retained.matrix.copy(object.matrixWorld); retained.matrixAutoUpdate = false;
        output.add(retained); return;
      }
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
      const signature = Object.keys(geometry.attributes).sort().map(key => `${key}:${geometry.attributes[key].itemSize}:${geometry.attributes[key].normalized}`).join('|');
      const key = `${object.material.uuid}:${Boolean(geometry.index)}:${signature}`;
      const batch: { material: Material; geometries: BufferGeometry[] } = batches.get(key) ?? { material: object.material, geometries: [] };
      batch.geometries.push(geometry); batches.set(key, batch);
    });
    batches.forEach(({ material, geometries }) => {
      const geometry = geometries.length > 1 ? mergeGeometries(geometries, false) : geometries[0];
      if (geometry) {
        const mesh = new Mesh(geometry, material); mesh.name = `ssd:${material.name}`; output.add(mesh);
        if (geometries.length > 1) geometries.forEach(part => part.dispose());
      } else geometries.forEach(part => output.add(new Mesh(part, material)));
    });
    output.userData.batchStatistics = { sourceMeshes: inputMeshes, mergedMeshes: output.children.length };
    return output;
  }

  private box(group: Group, size: [number, number, number], position: [number, number, number], material: MeshStandardMaterial, name: string) {
    const mesh = new Mesh(new BoxGeometry(...size), material);
    mesh.position.set(...position); mesh.name = name; mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh); return mesh;
  }

  private addCaseGlass(root: Group) {
    let frame: Object3D | undefined;
    root.traverse(object => { if (/^Plane[._]?001$/i.test(object.name)) frame = object; });
    if (!frame) return;
    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(frame);
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    // Plane.001 is a hollow side frame with approximately 20 mm rails. This
    // rectangular pane fits its measured opening and stays within the glass OBB.
    const panel = new Mesh(new BoxGeometry(size.x - .04, size.y - .04, .004), this.materials.glassMaterial());
    panel.name = 'tempered-side-glass';
    panel.position.set(center.x, center.y, bounds.max.z - .0005);
    panel.renderOrder = 10;
    this.materials.trackGlass(panel);
    root.add(panel);
  }

  private addRgbArray(root: Group, kind: PartKind) {
    if (kind === 'fan') {
      const ring = new Mesh(new TorusGeometry(.050, .00065, 6, 64), this.materials.emissive(2.3));
      ring.name = 'fan-rgb-ring'; ring.position.z = .0242; root.add(ring);
      return;
    }
    if (kind !== 'gpu' && kind !== 'ram') return;
    const bounds = new Box3().setFromObject(root);
    const size = bounds.getSize(new Vector3());
    const color = this.materials.emissive();
    const frame = this.materials.brushed();
    const array = new Group(); array.name = `${kind}-addressable-rgb`; root.add(array);
    if (kind === 'ram') {
      const x = Math.min(.005, size.x + .0014), z = Math.min(.042, bounds.max.z + .001);
      this.box(array, [x, size.y * .95, .0012], [0, 0, z - .0006], frame, 'brushed-heatspreader-rail');
      for (let i = 0; i < 12; i++) this.box(array, [x * .8, size.y * .068, .0007], [0, -size.y * .44 + i * size.y * .08, z - .0002], color, `rgb-${i}`);
    } else {
      const centerX = (bounds.min.x + bounds.max.x) / 2;
      const z = bounds.max.z - .0015;
      this.box(array, [size.x * .86, .0018, .003], [centerX, bounds.max.y - .0013, z], frame, 'brushed-gpu-edge');
      for (let i = 0; i < 18; i++) this.box(array, [size.x * .041, .0012, .001], [centerX - size.x * .39 + i * size.x * .046, bounds.max.y - .0005, z + .001], color, `rgb-${i}`);
    }
  }

  private createRadiator() {
    const root = new Group(); root.name = '240-mm-reference-radiator';
    const metal = this.materials.standard({ color: 0x414b50, roughness: .4, metalness: .8 });
    const finMaterial = this.materials.standard({ color: 0x1b2428, roughness: .65, metalness: .55 });
    this.box(root, [.274, .008, .027], [0, -.056, .0135], metal, 'lower-rail');
    this.box(root, [.274, .008, .027], [0, .056, .0135], metal, 'upper-rail');
    this.box(root, [.012, .104, .027], [-.131, 0, .0135], metal, 'inlet-tank');
    this.box(root, [.012, .104, .027], [.131, 0, .0135], metal, 'outlet-tank');
    const fins = new InstancedMesh(new BoxGeometry(.001, .104, .023), finMaterial, 100);
    fins.name = 'radiator-fin-stack';
    const matrix = new Matrix4();
    for (let i = 0; i < 100; i++) { matrix.makeTranslation(-.122 + i * .00246, 0, .0135); fins.setMatrixAt(i, matrix); }
    fins.castShadow = fins.receiveShadow = true; root.add(fins);
    const screwMaterial = this.materials.standard({ color: 0xaeb9bb, metalness: .85, roughness: .3 });
    for (const x of [-.1125, -.0075, .0075, .1125]) for (const y of [-.0525, .0525]) {
      const screw = new Mesh(new TorusGeometry(.0022, .00065, 4, 12), screwMaterial);
      screw.position.set(x, y, .026); root.add(screw);
    }
    return root;
  }

  dispose() {
    this.disposed = true;
    [...this.active].forEach(model => this.release(model));
    this.materials.dispose(); this.draco.dispose();
    this.sharedGeometries.forEach(geometry => geometry.dispose());
    const textures = new Set<Texture>();
    this.sourceMaterials.forEach(material => {
      Object.values(material).forEach(value => { if (value instanceof Texture) textures.add(value); });
      material.dispose();
    });
    textures.forEach(texture => texture.dispose());
    this.sharedGeometries.clear(); this.sourceMaterials.clear(); this.sources.clear();
  }
}
