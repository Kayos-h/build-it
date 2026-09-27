/** Validate a self-contained glTF/GLB before any loader can request dependencies. */
export function gltfDocument(data: ArrayBuffer | string): Record<string, any> {
  let json: string;
  if (typeof data === 'string') json = data;
  else {
    const view = new DataView(data);
    if (data.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength) throw new Error('Invalid GLB 2.0 file.');
    const length = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a || length > data.byteLength - 20) throw new Error('GLB JSON chunk is invalid.');
    json = new TextDecoder().decode(new Uint8Array(data, 20, length));
  }
  const document = JSON.parse(json);
  if (!document || typeof document !== 'object' || document.asset?.version !== '2.0') throw new Error('Use a glTF 2.0 or GLB 2.0 model.');
  for (const entry of [...(document.buffers ?? []), ...(document.images ?? [])]) {
    if (entry.uri !== undefined && (typeof entry.uri !== 'string' || !/^data:/i.test(entry.uri))) {
      throw new Error('This model references external files. Export a GLB or a glTF with embedded buffers and textures.');
    }
  }
  return document;
}
