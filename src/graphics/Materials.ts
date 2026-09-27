import {
  Color, DataTexture, DoubleSide, LinearFilter, LinearMipmapLinearFilter, Material,
  Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, RepeatWrapping,
  RGBAFormat, UnsignedByteType, type ColorRepresentation, type WebGLRenderer,
} from 'three';
import type { PartKind } from '../core/types';

/** Materials are cloned per model instance; shared source GLTF materials stay immutable. */
export class MaterialLibrary {
  private readonly owned = new Set<Material>();
  private readonly rgb = new Set<MeshStandardMaterial>();
  private readonly glass = new Set<Mesh>();
  private readonly color = new Color('#54e8bd');
  private brushedRoughness?: DataTexture;
  private glassOpen = true;

  constructor(private readonly renderer?: WebGLRenderer) {}

  standard(parameters: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}) {
    const material = new MeshStandardMaterial(parameters);
    this.owned.add(material);
    return material;
  }

  emissive(intensity = 3.2) {
    const material = this.standard({ color: 0xbed9d2, roughness: .28, metalness: .18,
      emissive: this.color, emissiveIntensity: intensity, toneMapped: false });
    this.rgb.add(material);
    return material;
  }

  /** Directional micrograin for new aluminum accents; donor GLTF maps are untouched. */
  brushed(parameters: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}) {
    if (!this.brushedRoughness) {
      const width = 128, height = 64;
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        const stripe = ((y + 1) * 2654435761) >>> 0;
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          const fine = ((x * 2246822519 + y * 3266489917) >>> 0) & 15;
          const value = 130 + (stripe & 55) + fine;
          data[offset] = data[offset + 1] = data[offset + 2] = value; data[offset + 3] = 255;
        }
      }
      this.brushedRoughness = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
      this.brushedRoughness.name = 'deterministic-aluminum-micrograin';
      this.brushedRoughness.wrapS = this.brushedRoughness.wrapT = RepeatWrapping;
      this.brushedRoughness.repeat.set(2, 8);
      this.brushedRoughness.magFilter = LinearFilter;
      this.brushedRoughness.minFilter = LinearMipmapLinearFilter;
      this.brushedRoughness.generateMipmaps = true;
      this.brushedRoughness.anisotropy = this.renderer ? Math.min(8, this.renderer.capabilities.getMaxAnisotropy()) : 1;
      this.brushedRoughness.needsUpdate = true;
    }
    return this.standard({ name: 'Brushed aluminum · directional roughness', color: 0x899598,
      metalness: .83, roughness: .54, roughnessMap: this.brushedRoughness, ...parameters });
  }

  glassMaterial() {
    const material = new MeshPhysicalMaterial({
      name: 'Tempered glass · 4 mm', color: 0xc7e4e7,
      transmission: .9, roughness: .05, ior: 1.52,
      thickness: .004, metalness: .02, transparent: true, opacity: 1,
      attenuationColor: new Color(0xb3d6d3), attenuationDistance: .5,
      depthWrite: false, side: DoubleSide,
    });
    this.owned.add(material);
    return material;
  }

  trackGlass(mesh: Mesh) {
    mesh.castShadow = false; mesh.userData.glassPanel = true;
    mesh.visible = !this.glassOpen; this.glass.add(mesh);
  }

  apply(root: Object3D, kind: PartKind) {
    const instanceMaterials = new Map<Material, Material>();
    root.traverse(object => {
      if (!(object instanceof Mesh)) return;
      object.castShadow = object.receiveShadow = true;
      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const prepared = sourceMaterials.map(source => {
        const existing = instanceMaterials.get(source);
        if (existing) return existing;
        const name = source.name.toLowerCase();
        let material: MeshStandardMaterial;
        if (kind === 'case' && name.includes('material.003')) {
          // Blender inspection shows the retained Cylinder.006 is a set of side
          // panel fasteners. The donor GLB contains no usable glass surface.
          material = this.standard({ name: 'Side panel fasteners', color: 0x475054, metalness: .72, roughness: .4 });
        } else {
          // GLTFLoader already supplies physically based materials. Keep their maps,
          // normal maps, UV channels, alpha modes, and vertex colors intact.
          material = source instanceof MeshStandardMaterial ? source.clone() : this.standard();
          if (kind === 'case') {
            if (name.includes('fancolor')) {
              material.color.set(0x1b242a); material.metalness = .22; material.roughness = .42;
            } else if (name.includes('light')) {
              material.color.set(0xdcebe8); material.emissive.copy(this.color); material.emissiveIntensity = 2.8;
              this.rgb.add(material);
            } else {
              material.metalness = .46; material.roughness = .35;
            }
          } else if (kind === 'motherboard') {
            if (/black|green|brown/.test(name)) {
              material.color.set(0x202927); material.metalness = .06; material.roughness = .9;
            } else if (/metal|gold/.test(name)) {
              material.metalness = .82; material.roughness = Math.max(.28, material.roughness);
              if (!name.includes('gold')) material.color.multiplyScalar(.75);
            } else if (name.includes('white')) {
              material.color.set(0xb9c3c5); material.metalness = .6; material.roughness = .36;
            }
          } else if (kind === 'gpu' || kind === 'ram') {
            material.metalness = Math.max(.28, Math.min(material.metalness, .75));
            material.roughness = Math.max(.3, material.roughness);
            if (/plastic|circuit/.test(name)) { material.metalness = .04; material.roughness = .82; }
          } else if (kind === 'cooler' || kind === 'fan') {
            material.roughness = Math.max(.36, material.roughness);
            if (material.color.getHSL({h:0,s:0,l:0}).l < .05) material.color.set(0x252b32);
            if (kind === 'fan') {
              // The donor material makes every blade an HDR emitter. Reserve the
              // bright RGB for a thin dedicated ring so the blades remain readable.
              material.color.set(name.includes('048') ? 0x233038 : 0x758087);
              material.metalness = .3; material.roughness = .52;
            }
          }
          if (material.emissive && Math.max(material.emissive.r, material.emissive.g, material.emissive.b) > 0) {
            material.emissive.copy(this.color);
            material.emissiveIntensity = kind === 'fan' ? .07 : Math.min(3, Math.max(.5, material.emissiveIntensity));
            this.rgb.add(material);
          }
        }
        for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) {
          if (texture && this.renderer) texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        }
        this.owned.add(material);
        instanceMaterials.set(source, material);
        return material;
      });
      object.material = Array.isArray(object.material) ? prepared : prepared[0];
      if (prepared.some(material => material instanceof MeshPhysicalMaterial && material.transmission > 0)) {
        this.trackGlass(object);
      }
    });
  }

  setRgbColor(color: ColorRepresentation) {
    this.color.set(color);
    this.rgb.forEach(material => material.emissive.copy(this.color));
  }

  setGlassOpen(open: boolean) {
    this.glassOpen = open;
    this.glass.forEach(mesh => { mesh.visible = !open; });
  }

  release(root: Object3D) {
    const materials = new Set<Material>();
    root.traverse(object => {
      if (!(object instanceof Mesh)) return;
      this.glass.delete(object);
      (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
    });
    materials.forEach(material => {
      if (!this.owned.delete(material)) return;
      if (material instanceof MeshStandardMaterial) this.rgb.delete(material);
      material.dispose();
    });
  }

  dispose() {
    this.owned.forEach(material => material.dispose());
    this.brushedRoughness?.dispose(); this.brushedRoughness = undefined;
    this.owned.clear(); this.rgb.clear(); this.glass.clear();
  }
}
