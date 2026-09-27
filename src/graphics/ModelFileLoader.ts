import type { Group } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { gltfDocument } from './modelFormat.js';

export class ModelFileLoader {
  private readonly gltf: GLTFLoader;
  private headers: Record<string, string> = {};
  constructor(draco: DRACOLoader) { this.gltf = new GLTFLoader().setDRACOLoader(draco); }
  setRequestHeader(headers: Record<string, string>): void { this.headers = headers; }
  async loadAsync(url: string, filename = url): Promise<{ scene: Group }> {
    let response = await fetch(url, { headers: url.startsWith('blob:') ? {} : this.headers });
    if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
    if (url.startsWith('/api/') && response.headers.get('content-type')?.includes('application/json')) {
      const asset = await response.json() as { url: string };
      // Signed storage URLs carry their own authorization. Never forward the app JWT.
      response = await fetch(asset.url);
      if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
    }
    const format = /\.obj(?:$|[?#])/i.test(filename) || /[?&]format=obj(?:&|$)/i.test(url) ? 'obj'
      : /\.gltf(?:$|[?#])/i.test(filename) || /[?&]format=gltf(?:&|$)/i.test(url) ? 'gltf' : 'glb';
    if (format === 'obj') return { scene: new OBJLoader().parse(await response.text()) };
    const data = format === 'gltf' ? await response.text() : await response.arrayBuffer();
    gltfDocument(data);
    return this.gltf.parseAsync(data, '');
  }
}
