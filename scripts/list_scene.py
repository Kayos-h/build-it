import bpy

bpy.context.view_layer.update()
print('SCENE_OBJECTS')
objects = sorted(bpy.data.objects, key=lambda o: max(o.dimensions) if hasattr(o, 'dimensions') else 0, reverse=True)
for obj in objects:
    if obj.type not in {'CAMERA', 'LIGHT', 'EMPTY'}:
        dimensions = tuple(round(v, 4) for v in obj.dimensions)
        location = tuple(round(v, 4) for v in obj.matrix_world.translation)
        vertices = len(obj.data.vertices) if obj.type == 'MESH' else 0
        collections = ','.join(c.name for c in obj.users_collection)
        print(f'OBJ|{obj.name}|{obj.type}|dim={dimensions}|loc={location}|verts={vertices}|hidden={obj.hide_render}|collections={collections}')
