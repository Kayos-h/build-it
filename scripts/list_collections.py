import bpy
from mathutils import Vector

for collection in bpy.data.collections:
    objects = [obj for obj in collection.all_objects if obj.type == 'MESH']
    if not objects:
        continue
    corners = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners)))
    high = Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners)))
    size = high - low
    print(f'COLLECTION|{collection.name}|objects={len(objects)}|bounds=({size.x:.3f},{size.y:.3f},{size.z:.3f})')
