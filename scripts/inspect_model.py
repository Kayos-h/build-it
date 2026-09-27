import bpy, math, os, sys
from mathutils import Vector

out = os.path.abspath(sys.argv[sys.argv.index('--') + 1])
scene = bpy.context.scene
for obj in list(scene.objects):
    if obj.type in {'CAMERA', 'LIGHT'}:
        bpy.data.objects.remove(obj, do_unlink=True)

renderables = [obj for obj in scene.objects if obj.type not in {'CAMERA', 'LIGHT', 'EMPTY'} and hasattr(obj, 'bound_box')]
# Asset files sometimes include an enormous, flat studio floor. Keep it from
# making the model microscopic in diagnostic previews.
ordered = sorted(renderables, key=lambda obj: max(obj.dimensions), reverse=True)
if len(ordered) > 1 and min(ordered[0].dimensions) < 1e-3 and max(ordered[0].dimensions) > max(ordered[1].dimensions) * 5:
    ordered[0].hide_render = True
    renderables.remove(ordered[0])
corners = [obj.matrix_world @ Vector(corner) for obj in renderables for corner in obj.bound_box]
low = Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners)))
high = Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners)))
center, size = (low + high) / 2, high - low
print(f'MODEL_BOUNDS:{size.x:.4f},{size.y:.4f},{size.z:.4f}')

root = bpy.data.objects.new('PreviewRoot', None)
scene.collection.objects.link(root)
for obj in list(scene.objects):
    if obj != root and obj.parent is None:
        obj.parent = root
root.location = -center

world = bpy.data.worlds.new('PreviewWorld') if not scene.world else scene.world
scene.world = world
world.color = (0.025, 0.025, 0.025)
camera_data = bpy.data.cameras.new('PreviewCamera')
camera = bpy.data.objects.new('PreviewCamera', camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
distance = max(size) * 1.8
camera.location = Vector((distance, -distance, distance * .72))
camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.lens = 55

for location, energy, color in [((4,-4,6),1400,(1,.92,.85)),((-4,-2,3),1000,(.35,.6,1)),((0,5,4),900,(1,.2,.55))]:
    data = bpy.data.lights.new('Light', 'AREA'); data.energy = energy; data.color = color; data.shape = 'DISK'; data.size = max(size)
    light = bpy.data.objects.new('Light', data); scene.collection.objects.link(light); light.location = Vector(location).normalized() * distance
    light.rotation_euler = (-light.location).to_track_quat('-Z', 'Y').to_euler()

scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = scene.render.resolution_y = 500
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
