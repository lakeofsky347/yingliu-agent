"""Deterministic whitebox 3D shot previsualization template for Yingliu Agent.
Reads a validated JSON spec file path passed after `--` and renders whitebox keyframes
and/or PNG frame sequence for spatial/camera previsualization. Never runs arbitrary user code.
"""
import json
import math
import os
import sys
import bpy


def parse_spec():
    argv = sys.argv
    if "--" not in argv:
        raise RuntimeError("Missing spec path after --")
    idx = argv.index("--") + 1
    if idx >= len(argv):
        raise RuntimeError("Spec path argument missing")
    with open(argv[idx], "r", encoding="utf-8") as fh:
        return json.load(fh)


def hex_to_rgba(color_hex, default=(0.82, 0.84, 0.88, 1.0)):
    if not isinstance(color_hex, str) or not color_hex.startswith("#") or len(color_hex) != 7:
        return default
    try:
        r = int(color_hex[1:3], 16) / 255.0
        g = int(color_hex[3:5], 16) / 255.0
        b = int(color_hex[5:7], 16) / 255.0
        return (r, g, b, 1.0)
    except ValueError:
        return default


def make_material(name, rgba):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.72
    mat.diffuse_color = rgba
    return mat


def assign_mat(obj, mat):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)


def add_standin(item):
    pos = item.get("position", [0.0, 0.0, 0.0])
    height = float(item.get("height", 1.72))
    yaw_deg = float(item.get("facingDeg", 0.0))
    rgba = hex_to_rgba(item.get("color"), (0.86, 0.88, 0.92, 1.0))
    mat = make_material("Standin_" + item.get("id", "char"), rgba)
    accent = make_material("Nose_" + item.get("id", "char"), (0.20, 0.52, 0.78, 1.0))

    root = bpy.data.objects.new("Char_" + item.get("id", "char"), None)
    bpy.context.collection.objects.link(root)
    root.location = (float(pos[0]), float(pos[1]), float(pos[2]))
    root.rotation_euler = (0.0, 0.0, math.radians(yaw_deg))

    torso_h = height * 0.62
    bpy.ops.mesh.primitive_cylinder_add(radius=height * 0.14, depth=torso_h, location=(0, 0, torso_h * 0.5))
    torso = bpy.context.active_object
    assign_mat(torso, mat)
    torso.parent = root

    head_r = height * 0.11
    bpy.ops.mesh.primitive_uv_sphere_add(radius=head_r, location=(0, 0, torso_h + head_r * 1.15))
    head = bpy.context.active_object
    assign_mat(head, mat)
    head.parent = root

    # Facing direction marker (+Y forward in local coordinates)
    bpy.ops.mesh.primitive_cone_add(radius1=head_r * 0.35, depth=head_r * 0.8, location=(0, head_r * 1.1, torso_h + head_r * 1.15), rotation=(-math.pi / 2, 0, 0))
    nose = bpy.context.active_object
    assign_mat(nose, accent)
    nose.parent = root


def add_prop(item):
    kind = item.get("kind", "box")
    pos = item.get("position", [0.0, 0.0, 0.0])
    scale = item.get("scale", [1.0, 1.0, 1.0])
    yaw_deg = float(item.get("facingDeg", 0.0))
    rgba = hex_to_rgba(item.get("color"), (0.74, 0.77, 0.82, 1.0))
    mat = make_material("Prop_" + item.get("id", "prop"), rgba)

    if kind == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1.0, location=(float(pos[0]), float(pos[1]), float(pos[2]) + float(scale[2]) * 0.5))
    elif kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(float(pos[0]), float(pos[1]), float(pos[2]) + float(scale[2]) * 0.5))
    elif kind == "plane":
        bpy.ops.mesh.primitive_plane_add(size=1.0, location=(float(pos[0]), float(pos[1]), float(pos[2])))
    else:
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(float(pos[0]), float(pos[1]), float(pos[2]) + float(scale[2]) * 0.5))
    obj = bpy.context.active_object
    obj.scale = (float(scale[0]), float(scale[1]), float(scale[2]))
    obj.rotation_euler = (0.0, 0.0, math.radians(yaw_deg))
    assign_mat(obj, mat)


def setup_lights(preset):
    def add_light(name, ltype, loc, energy, rot=(0.0, 0.0, 0.0), size=3.0):
        data = bpy.data.lights.new(name=name, type=ltype)
        data.energy = energy
        if ltype == "AREA":
            data.size = size
        obj = bpy.data.objects.new(name=name, object_data=data)
        bpy.context.collection.objects.link(obj)
        obj.location = loc
        obj.rotation_euler = rot
        return obj

    if preset == "daylight":
        add_light("Sun", "SUN", (6, -6, 10), 4.0, (math.radians(45), math.radians(15), math.radians(35)))
        add_light("SkyFill", "AREA", (-5, -4, 6), 120.0, (math.radians(55), 0, math.radians(-35)), 6.0)
    else:
        # Three-point studio blocking rig
        add_light("Key", "AREA", (5, -5, 6), 380.0, (math.radians(52), 0, math.radians(42)), 4.0)
        add_light("Fill", "AREA", (-6, -4, 4), 160.0, (math.radians(60), 0, math.radians(-48)), 5.0)
        add_light("Rim", "AREA", (0, 6, 5), 220.0, (math.radians(-50), 0, math.radians(180)), 4.0)


def main():
    spec = parse_spec()
    out_dir = spec["outputDir"]
    os.makedirs(out_dir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    # World background
    world = bpy.data.worlds.new("PrevizWorld")
    scene.world = world
    bg = hex_to_rgba(spec.get("background"), (0.14, 0.16, 0.20, 1.0))
    world.color = bg[:3]

    # Render engine selection (Workbench is fastest & deterministic for whitebox previz)
    desired_engine = spec.get("engine", "BLENDER_WORKBENCH")
    try:
        scene.render.engine = desired_engine
    except Exception:
        scene.render.engine = "BLENDER_WORKBENCH"

    if scene.render.engine == "BLENDER_WORKBENCH":
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "MATERIAL"
        scene.display.shading.show_shadows = True

    # Ground plane
    bpy.ops.mesh.primitive_plane_add(size=40.0, location=(0.0, 0.0, 0.0))
    ground = bpy.context.active_object
    assign_mat(ground, make_material("Ground", (0.28, 0.30, 0.34, 1.0)))

    setup_lights(spec.get("lighting", "three_point"))

    for obj in spec.get("objects", []):
        if obj.get("kind") == "character":
            add_standin(obj)
        else:
            add_prop(obj)

    # Camera + Track-To target
    cam_spec = spec.get("camera", {})
    cam_data = bpy.data.cameras.new("PrevizCamera")
    cam_data.lens = float(cam_spec.get("lensMm", 35.0))
    cam_obj = bpy.data.objects.new("PrevizCamera", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    target_obj = bpy.data.objects.new("CameraTarget", None)
    bpy.context.collection.objects.link(target_obj)

    track = cam_obj.constraints.new(type="TRACK_TO")
    track.target = target_obj
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    start_pos = cam_spec.get("startPos", [0.0, -6.0, 1.8])
    end_pos = cam_spec.get("endPos", start_pos)
    start_tgt = cam_spec.get("startTarget", [0.0, 0.0, 1.2])
    end_tgt = cam_spec.get("endTarget", start_tgt)

    frames = max(1, int(spec.get("frames", 1)))
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.fps = max(1, int(spec.get("fps", 24)))
    scene.render.resolution_x = int(spec.get("width", 960))
    scene.render.resolution_y = int(spec.get("height", 540))
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"

    cam_obj.location = (float(start_pos[0]), float(start_pos[1]), float(start_pos[2]))
    cam_obj.keyframe_insert(data_path="location", frame=1)
    target_obj.location = (float(start_tgt[0]), float(start_tgt[1]), float(start_tgt[2]))
    target_obj.keyframe_insert(data_path="location", frame=1)

    if frames > 1:
        cam_obj.location = (float(end_pos[0]), float(end_pos[1]), float(end_pos[2]))
        cam_obj.keyframe_insert(data_path="location", frame=frames)
        target_obj.location = (float(end_tgt[0]), float(end_tgt[1]), float(end_tgt[2]))
        target_obj.keyframe_insert(data_path="location", frame=frames)

    mode = spec.get("output", "both")
    keyframe_path = os.path.join(out_dir, "keyframe.png")
    manifest = {"keyframe": keyframe_path, "framesDir": None, "frameCount": frames}

    if mode in ("video", "both") and frames > 1:
        frames_dir = os.path.join(out_dir, "frames")
        os.makedirs(frames_dir, exist_ok=True)
        scene.render.filepath = os.path.join(frames_dir, "frame_")
        bpy.ops.render.render(animation=True)
        first_frame = os.path.join(frames_dir, "frame_0001.png")
        if os.path.exists(first_frame):
            with open(first_frame, "rb") as src, open(keyframe_path, "wb") as dst:
                dst.write(src.read())
        manifest["framesDir"] = frames_dir
    else:
        scene.frame_set(1)
        scene.render.filepath = keyframe_path
        bpy.ops.render.render(write_still=True)

    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh)


if __name__ == "__main__":
    main()
