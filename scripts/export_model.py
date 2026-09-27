import bpy, os, sys

args = sys.argv[sys.argv.index('--') + 1:]
out = os.path.abspath(args[0])
os.makedirs(os.path.dirname(out), exist_ok=True)

source = os.path.basename(bpy.data.filepath).lower()
keep = set(bpy.data.objects)
if source == 'motherbord.blend':
    keep = {obj for obj in bpy.data.objects if obj.name == 'Motherboard'}
elif source == 'ssd.blend':
    keep = {obj for obj in bpy.data.objects if any(c.name == 'ssd2' for c in obj.users_collection) and obj.matrix_world.translation.y >= .2}

world_matrices = {obj: obj.matrix_world.copy() for obj in keep}
for obj in list(bpy.data.objects):
    if obj not in keep or obj.type in {'CAMERA', 'LIGHT'}:
        bpy.data.objects.remove(obj, do_unlink=True)
for obj, matrix in world_matrices.items():
    if obj.name in bpy.data.objects:
        obj.matrix_world = matrix

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format='GLB',
    export_apply=True,
    export_image_format='AUTO',
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_cameras=False,
    export_lights=False,
    export_yup=True,
)
print(f'EXPORTED:{out}')
