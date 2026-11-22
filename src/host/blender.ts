import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnvironmentSettings } from '../shared/types.ts';
import { inspectToolEnvironment } from './tool-environment.ts';
import { mediaSignature } from '../jobs/download.ts';

export type PrevizOutputMode = 'image' | 'video' | 'both';
export type PrevizPose = 'stand' | 'walk' | 'run' | 'sit' | 'point' | 'crouch';
export type PrevizLighting = 'three_point' | 'daylight' | 'noir_rim' | 'neon_night' | 'golden_hour';

export interface PrevizObjectSpec {
  id: string;
  kind: 'character' | 'box' | 'cylinder' | 'sphere' | 'plane';
  position: [number, number, number];
  /** Optional end position [x,y,z] for character/object blocking movement across the shot. */
  endPos?: [number, number, number];
  scale?: [number, number, number];
  height?: number;
  facingDeg?: number;
  /** Optional end yaw angle for turning characters. */
  endFacingDeg?: number;
  /** Articulated humanoid pose for character stand-ins. */
  pose?: PrevizPose;
  color?: string;
}
export interface PrevizCameraSpec {
  lensMm?: number;
  /** Optional Dutch tilt angle in degrees (-45 to 45). */
  rollDeg?: number;
  /** Optional aperture f-stop (e.g. 1.8, 2.8, 5.6) for depth of field. */
  fStop?: number;
  /** Optional focus distance in meters when fStop is set. */
  focusDistance?: number;
  startPos: [number, number, number];
  endPos?: [number, number, number];
  startTarget: [number, number, number];
  endTarget?: [number, number, number];
}
export interface PrevizSceneSpec {
  output?: PrevizOutputMode;
  /** Emit a normalized Z-depth pass PNG alongside the whitebox keyframe (default true). */
  emitDepth?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  durationSeconds?: number;
  engine?: 'BLENDER_WORKBENCH' | 'BLENDER_EEVEE_NEXT';
  lighting?: PrevizLighting;
  background?: string;
  camera: PrevizCameraSpec;
  objects: PrevizObjectSpec[];
}
export interface PrevizRenderResult {
  keyframePng: Uint8Array;
  depthPng?: Uint8Array;
  videoMp4?: Uint8Array;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
}

/** Embedded deterministic whitebox previz script (articulated poses, actor blocking, DOF, cinematic lighting, depth pass). */
export const PREVIZ_TEMPLATE_PY = `import json, math, os, sys, bpy
def parse_spec():
    argv = sys.argv
    if "--" not in argv or argv.index("--") + 1 >= len(argv):
        raise RuntimeError("Missing spec path after --")
    with open(argv[argv.index("--") + 1], "r", encoding="utf-8") as fh:
        return json.load(fh)
def hex_to_rgba(c, d=(0.82, 0.84, 0.88, 1.0)):
    if not isinstance(c, str) or not c.startswith("#") or len(c) != 7: return d
    try: return (int(c[1:3],16)/255.0, int(c[3:5],16)/255.0, int(c[5:7],16)/255.0, 1.0)
    except ValueError: return d
def make_mat(name, rgba):
    m = bpy.data.materials.new(name=name); m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        if "Roughness" in bsdf.inputs: bsdf.inputs["Roughness"].default_value = 0.72
    m.diffuse_color = rgba; return m
def assign_mat(obj, m):
    if obj.data.materials: obj.data.materials[0] = m
    else: obj.data.materials.append(m)
def limb(parent, mat, r, length, loc, rot=(0.0,0.0,0.0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=length, location=loc, rotation=rot)
    o = bpy.context.active_object; assign_mat(o, mat); o.parent = parent; return o
def add_standin(item, frames):
    pos = item.get("position", [0.0,0.0,0.0]); epos = item.get("endPos", pos)
    h = float(item.get("height", 1.72)); yaw = float(item.get("facingDeg", 0.0)); eyaw = float(item.get("endFacingDeg", yaw))
    pose = item.get("pose", "stand")
    mat = make_mat("S_" + item.get("id","c"), hex_to_rgba(item.get("color"), (0.86,0.88,0.92,1.0)))
    acc = make_mat("N_" + item.get("id","c"), (0.20,0.52,0.78,1.0))
    root = bpy.data.objects.new("Char_" + item.get("id","c"), None); bpy.context.collection.objects.link(root)
    crouch_drop = -h * 0.22 if pose == "crouch" else (-h * 0.28 if pose == "sit" else 0.0)
    leg_len = h * 0.46; torso_len = h * 0.34; hr = h * 0.105
    hip_z = max(0.25 * h, leg_len + crouch_drop)
    bpy.ops.mesh.primitive_cylinder_add(radius=h*0.13, depth=torso_len, location=(0, 0, hip_z + torso_len*0.5))
    t = bpy.context.active_object; assign_mat(t, mat); t.parent = root
    bpy.ops.mesh.primitive_uv_sphere_add(radius=hr, location=(0, 0, hip_z + torso_len + hr*1.05))
    hd = bpy.context.active_object; assign_mat(hd, mat); hd.parent = root
    bpy.ops.mesh.primitive_cone_add(radius1=hr*0.32, depth=hr*0.75, location=(0, hr*1.08, hip_z + torso_len + hr*1.05), rotation=(-math.pi/2,0,0))
    ns = bpy.context.active_object; assign_mat(ns, acc); ns.parent = root
    arm_len = h * 0.34; sh_z = hip_z + torso_len * 0.88; sh_x = h * 0.18
    la_pitch = math.radians(-35) if pose in ("walk","run") else (math.radians(-78) if pose == "point" else math.radians(-8))
    ra_pitch = math.radians(35) if pose in ("walk","run") else (math.radians(-85) if pose == "point" else math.radians(8))
    limb(root, mat, h*0.042, arm_len, (-sh_x, 0, sh_z - arm_len*0.42), (la_pitch, 0, math.radians(8)))
    limb(root, mat, h*0.042, arm_len, (sh_x, 0.08 if pose=="point" else 0, sh_z - (0.1 if pose=="point" else arm_len*0.42)), (ra_pitch, 0, math.radians(-8)))
    ll_pitch = math.radians(26) if pose == "walk" else (math.radians(42) if pose == "run" else (math.radians(-70) if pose == "sit" else 0.0))
    rl_pitch = -ll_pitch if pose in ("walk","run") else ll_pitch
    limb(root, mat, h*0.055, leg_len, (-h*0.08, 0, hip_z*0.5), (ll_pitch, 0, 0))
    limb(root, mat, h*0.055, leg_len, (h*0.08, 0, hip_z*0.5), (rl_pitch, 0, 0))
    root.location = (float(pos[0]), float(pos[1]), float(pos[2]))
    root.rotation_euler = (0.0, 0.0, math.radians(yaw))
    if frames > 1 and (epos != pos or eyaw != yaw):
        root.keyframe_insert(data_path="location", frame=1)
        root.keyframe_insert(data_path="rotation_euler", frame=1)
        root.location = (float(epos[0]), float(epos[1]), float(epos[2]))
        root.rotation_euler = (0.0, 0.0, math.radians(eyaw))
        root.keyframe_insert(data_path="location", frame=frames)
        root.keyframe_insert(data_path="rotation_euler", frame=frames)
        root.location = (float(pos[0]), float(pos[1]), float(pos[2]))
        root.rotation_euler = (0.0, 0.0, math.radians(yaw))
    return root
def add_prop(item, frames):
    k = item.get("kind","box"); pos = item.get("position",[0.0,0.0,0.0]); epos = item.get("endPos", pos)
    sc = item.get("scale",[1.0,1.0,1.0]); yaw = float(item.get("facingDeg",0.0))
    mat = make_mat("P_" + item.get("id","p"), hex_to_rgba(item.get("color"), (0.74,0.77,0.82,1.0)))
    z_off = 0.0 if k=="plane" else float(sc[2])*0.5
    loc = (float(pos[0]), float(pos[1]), float(pos[2]) + z_off)
    if k=="cylinder": bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1.0, location=loc)
    elif k=="sphere": bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=loc)
    elif k=="plane": bpy.ops.mesh.primitive_plane_add(size=1.0, location=loc)
    else: bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    o = bpy.context.active_object; o.scale = (float(sc[0]),float(sc[1]),float(sc[2])); o.rotation_euler = (0.0,0.0,math.radians(yaw)); assign_mat(o, mat)
    if frames > 1 and epos != pos:
        o.keyframe_insert(data_path="location", frame=1)
        o.location = (float(epos[0]), float(epos[1]), float(epos[2]) + z_off)
        o.keyframe_insert(data_path="location", frame=frames)
        o.location = loc
    return o
def setup_lights(preset):
    def add_l(name, lt, loc, e, rot=(0,0,0), sz=3.0, col=(1.0,1.0,1.0)):
        d = bpy.data.lights.new(name=name, type=lt); d.energy = e; d.color = col
        if lt=="AREA": d.size = sz
        o = bpy.data.objects.new(name=name, object_data=d); bpy.context.collection.objects.link(o); o.location = loc; o.rotation_euler = rot
    if preset=="daylight":
        add_l("Sun","SUN",(6,-6,10),4.0,(math.radians(45),math.radians(15),math.radians(35)),col=(1.0,0.98,0.94))
        add_l("Sky","AREA",(-5,-4,6),120.0,(math.radians(55),0,math.radians(-35)),6.0,col=(0.82,0.90,1.0))
    elif preset=="noir_rim":
        add_l("Rim","AREA",(0,6,4.5),520.0,(math.radians(-55),0,math.radians(180)),2.5,col=(0.95,0.97,1.0))
        add_l("KeyLow","AREA",(3.5,-3.5,2.2),110.0,(math.radians(72),0,math.radians(45)),2.0,col=(1.0,0.92,0.82))
    elif preset=="neon_night":
        add_l("CyanKey","AREA",(-4.5,-3.5,3.2),360.0,(math.radians(65),0,math.radians(-42)),3.2,col=(0.22,0.86,1.0))
        add_l("MagentaRim","AREA",(4.5,3.5,3.6),380.0,(math.radians(-60),0,math.radians(138)),3.2,col=(1.0,0.24,0.68))
    elif preset=="golden_hour":
        add_l("GoldenSun","SUN",(8,-4,3.5),4.5,(math.radians(72),math.radians(10),math.radians(60)),col=(1.0,0.74,0.42))
        add_l("CoolFill","AREA",(-5,-4,5),130.0,(math.radians(55),0,math.radians(-35)),6.0,col=(0.68,0.80,1.0))
    else:
        add_l("Key","AREA",(5,-5,6),380.0,(math.radians(52),0,math.radians(42)),4.0)
        add_l("Fill","AREA",(-6,-4,4),160.0,(math.radians(60),0,math.radians(-48)),5.0)
        add_l("Rim","AREA",(0,6,5),220.0,(math.radians(-50),0,math.radians(180)),4.0)
def render_depth_pass(sc, cam_pos, ground_obj, out_path):
    old_light = sc.display.shading.light; old_color = sc.display.shading.color_type; old_shadows = sc.display.shading.show_shadows
    old_bg = tuple(sc.world.color)
    meshes = [o for o in sc.objects if o.type == "MESH"]
    dists = []
    for o in meshes:
        if o == ground_obj: continue
        mw = o.matrix_world.translation
        d = math.sqrt((mw.x - cam_pos[0])**2 + (mw.y - cam_pos[1])**2 + (mw.z - cam_pos[2])**2)
        dists.append((o, d))
    near = max(0.5, min([d for _, d in dists], default=2.0) - 0.8)
    far = max(near + 3.0, max([d for _, d in dists], default=8.0) + 2.5)
    for o, d in dists:
        v = max(0.14, min(0.96, 1.0 - (d - near) / (far - near)))
        o.color = (v, v, v, 1.0)
    ground_obj.color = (0.09, 0.09, 0.09, 1.0)
    sc.world.color = (0.02, 0.02, 0.02)
    sc.display.shading.light = "FLAT"; sc.display.shading.color_type = "OBJECT"; sc.display.shading.show_shadows = False
    sc.frame_set(1); sc.render.filepath = out_path; bpy.ops.render.render(write_still=True)
    sc.display.shading.light = old_light; sc.display.shading.color_type = old_color; sc.display.shading.show_shadows = old_shadows
    sc.world.color = old_bg
def main():
    spec = parse_spec(); out_dir = spec["outputDir"]; os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
    w = bpy.data.worlds.new("PrevizWorld"); sc.world = w; w.color = hex_to_rgba(spec.get("background"),(0.14,0.16,0.20,1.0))[:3]
    try: sc.render.engine = spec.get("engine","BLENDER_WORKBENCH")
    except Exception: sc.render.engine = "BLENDER_WORKBENCH"
    if sc.render.engine == "BLENDER_WORKBENCH":
        sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "MATERIAL"; sc.display.shading.show_shadows = True
    bpy.ops.mesh.primitive_plane_add(size=40.0, location=(0,0,0)); ground_obj = bpy.context.active_object
    assign_mat(ground_obj, make_mat("Ground",(0.28,0.30,0.34,1.0)))
    setup_lights(spec.get("lighting","three_point"))
    frames = max(1, int(spec.get("frames",1))); sc.frame_start = 1; sc.frame_end = frames
    for obj in spec.get("objects",[]):
        if obj.get("kind")=="character": add_standin(obj, frames)
        else: add_prop(obj, frames)
    cs = spec.get("camera",{}); cd = bpy.data.cameras.new("Cam"); cd.lens = float(cs.get("lensMm",35.0))
    if cs.get("fStop") is not None:
        cd.dof.use_dof = True; cd.dof.aperture_fstop = float(cs["fStop"])
        if cs.get("focusDistance") is not None: cd.dof.focus_distance = float(cs["focusDistance"])
    co = bpy.data.objects.new("Cam", cd); bpy.context.collection.objects.link(co); sc.camera = co
    to = bpy.data.objects.new("Target", None); bpy.context.collection.objects.link(to)
    tr = co.constraints.new(type="TRACK_TO"); tr.target = to; tr.track_axis = "TRACK_NEGATIVE_Z"; tr.up_axis = "UP_Y"
    sp = cs.get("startPos",[0,-6,1.8]); ep = cs.get("endPos",sp); st = cs.get("startTarget",[0,0,1.2]); et = cs.get("endTarget",st)
    sc.render.fps = max(1, int(spec.get("fps",12))); sc.render.resolution_x = int(spec.get("width",960)); sc.render.resolution_y = int(spec.get("height",540))
    sc.render.resolution_percentage = 100; sc.render.image_settings.file_format = "PNG"
    co.location = (float(sp[0]),float(sp[1]),float(sp[2])); co.keyframe_insert(data_path="location", frame=1)
    to.location = (float(st[0]),float(st[1]),float(st[2])); to.keyframe_insert(data_path="location", frame=1)
    if frames > 1:
        co.location = (float(ep[0]),float(ep[1]),float(ep[2])); co.keyframe_insert(data_path="location", frame=frames)
        to.location = (float(et[0]),float(et[1]),float(et[2])); to.keyframe_insert(data_path="location", frame=frames)
    mode = spec.get("output","both"); kp = os.path.join(out_dir,"keyframe.png"); dp = os.path.join(out_dir,"depth.png")
    manifest = {"keyframe": kp, "depth": None, "framesDir": None, "frameCount": frames}
    if mode in ("video","both") and frames > 1:
        fd = os.path.join(out_dir,"frames"); os.makedirs(fd, exist_ok=True); sc.render.filepath = os.path.join(fd,"frame_")
        bpy.ops.render.render(animation=True)
        f1 = os.path.join(fd,"frame_0001.png")
        if os.path.exists(f1):
            with open(f1,"rb") as a, open(kp,"wb") as b: b.write(a.read())
        manifest["framesDir"] = fd
    else:
        sc.frame_set(1); sc.render.filepath = kp; bpy.ops.render.render(write_still=True)
    if spec.get("emitDepth", True) and sc.render.engine == "BLENDER_WORKBENCH":
        render_depth_pass(sc, sp, ground_obj, dp)
        if os.path.exists(dp): manifest["depth"] = dp
    with open(os.path.join(out_dir,"manifest.json"),"w",encoding="utf-8") as fh: json.dump(manifest, fh)
if __name__ == "__main__": main()
`;

function vec3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 500))
    throw new Error(`${label} 须为 3 个 -500 至 500 的有限数值坐标`);
  return [value[0]!, value[1]!, value[2]!];
}
function safeColor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('颜色须为 #RRGGBB 格式');
  return value;
}

const POSES: readonly PrevizPose[] = ['stand', 'walk', 'run', 'sit', 'point', 'crouch'];
const LIGHTINGS: readonly PrevizLighting[] = ['three_point', 'daylight', 'noir_rim', 'neon_night', 'golden_hour'];

export function validatePrevizSpec(input: unknown): Required<Pick<PrevizSceneSpec, 'output' | 'emitDepth' | 'width' | 'height' | 'fps' | 'durationSeconds' | 'engine' | 'lighting' | 'camera' | 'objects'>> & { background?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预演场景参数须为对象');
  const raw = input as Record<string, unknown>;
  const output: PrevizOutputMode = raw.output === 'image' || raw.output === 'video' || raw.output === 'both' ? raw.output : 'both';
  const emitDepth = raw.emitDepth !== false;
  const width = raw.width === undefined ? 960 : Number(raw.width);
  const height = raw.height === undefined ? 540 : Number(raw.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 256 || height < 256 || width > 1920 || height > 1920 || width % 2 !== 0 || height % 2 !== 0)
    throw new Error('预演画面尺寸须为 256–1920 范围内的偶数');
  const fps = raw.fps === undefined ? 12 : Number(raw.fps);
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 60) throw new Error('预演 FPS 须为 1–60 的整数');
  const durationSeconds = raw.durationSeconds === undefined ? 3 : Number(raw.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30) throw new Error('单镜头预演时长须为 0–30 秒');
  const engine = raw.engine === 'BLENDER_EEVEE_NEXT' ? 'BLENDER_EEVEE_NEXT' : 'BLENDER_WORKBENCH';
  const lighting: PrevizLighting = LIGHTINGS.includes(raw.lighting as PrevizLighting) ? raw.lighting as PrevizLighting : 'three_point';
  const background = safeColor(raw.background);
  if (!raw.camera || typeof raw.camera !== 'object' || Array.isArray(raw.camera)) throw new Error('缺少预演机位 camera 参数');
  const cam = raw.camera as Record<string, unknown>;
  const lensMm = cam.lensMm === undefined ? 35 : Number(cam.lensMm);
  if (!Number.isFinite(lensMm) || lensMm < 10 || lensMm > 250) throw new Error('镜头焦距 lensMm 须在 10–250mm 之间');
  const rollDeg = cam.rollDeg === undefined ? undefined : Number(cam.rollDeg);
  if (rollDeg !== undefined && (!Number.isFinite(rollDeg) || Math.abs(rollDeg) > 60)) throw new Error('荷兰角 rollDeg 须在 -60 至 60 度之间');
  const fStop = cam.fStop === undefined ? undefined : Number(cam.fStop);
  if (fStop !== undefined && (!Number.isFinite(fStop) || fStop < 0.7 || fStop > 32)) throw new Error('光圈 fStop 须在 0.7–32 之间');
  const focusDistance = cam.focusDistance === undefined ? undefined : Number(cam.focusDistance);
  if (focusDistance !== undefined && (!Number.isFinite(focusDistance) || focusDistance <= 0.1 || focusDistance > 500)) throw new Error('对焦距离 focusDistance 须在 0.1–500 米之间');
  const startPos = vec3(cam.startPos, 'camera.startPos');
  const endPos = cam.endPos !== undefined ? vec3(cam.endPos, 'camera.endPos') : startPos;
  const startTarget = vec3(cam.startTarget, 'camera.startTarget');
  const endTarget = cam.endTarget !== undefined ? vec3(cam.endTarget, 'camera.endTarget') : startTarget;
  if (!Array.isArray(raw.objects) || raw.objects.length > 32) throw new Error('预演物体 objects 须为不超过 32 项的数组');
  const objects: PrevizObjectSpec[] = raw.objects.map((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`objects[${idx}] 须为对象`);
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(item.id) ? item.id : `obj-${idx + 1}`;
    const kind = ['character', 'box', 'cylinder', 'sphere', 'plane'].includes(String(item.kind)) ? item.kind as PrevizObjectSpec['kind'] : 'box';
    const position = vec3(item.position, `objects[${idx}].position`);
    const objEndPos = item.endPos !== undefined ? vec3(item.endPos, `objects[${idx}].endPos`) : undefined;
    const scale = item.scale !== undefined ? vec3(item.scale, `objects[${idx}].scale`) : undefined;
    const heightVal = item.height !== undefined ? Number(item.height) : undefined;
    if (heightVal !== undefined && (!Number.isFinite(heightVal) || heightVal < 0.2 || heightVal > 10)) throw new Error(`objects[${idx}].height 无效`);
    const facingDeg = item.facingDeg !== undefined ? Number(item.facingDeg) : 0;
    if (!Number.isFinite(facingDeg)) throw new Error(`objects[${idx}].facingDeg 无效`);
    const endFacingDeg = item.endFacingDeg !== undefined ? Number(item.endFacingDeg) : undefined;
    if (endFacingDeg !== undefined && !Number.isFinite(endFacingDeg)) throw new Error(`objects[${idx}].endFacingDeg 无效`);
    const pose = item.pose !== undefined && POSES.includes(item.pose as PrevizPose) ? item.pose as PrevizPose : undefined;
    const color = safeColor(item.color);
    return {
      id, kind, position,
      ...(objEndPos ? { endPos: objEndPos } : {}),
      ...(scale ? { scale } : {}),
      ...(heightVal !== undefined ? { height: heightVal } : {}),
      facingDeg,
      ...(endFacingDeg !== undefined ? { endFacingDeg } : {}),
      ...(pose ? { pose } : {}),
      ...(color ? { color } : {}),
    };
  });
  return {
    output, emitDepth, width, height, fps, durationSeconds, engine, lighting,
    ...(background ? { background } : {}),
    camera: { lensMm, ...(rollDeg !== undefined ? { rollDeg } : {}), ...(fStop !== undefined ? { fStop } : {}), ...(focusDistance !== undefined ? { focusDistance } : {}), startPos, endPos, startTarget, endTarget },
    objects,
  };
}

/** Runs headless Blender strictly for deterministic whitebox previsualization; tracks owned subprocesses only. */
export class BlenderRunner {
  private owned = new Set<ChildProcess>();

  private runChild(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('预演已取消')); return; }
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.owned.add(child);
      let stdout = '', stderr = '', settled = false;
      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const hard = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1500);
        hard.unref();
        child.once('close', () => clearTimeout(hard));
      };
      const done = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.owned.delete(child);
        if (error) reject(error); else resolve({ stdout, stderr });
      };
      const onAbort = () => { stop(); done(new Error('Blender 预演已取消')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { stop(); done(new Error(`Blender 预演超时（${Math.round(timeoutMs / 1000)} 秒）`)); }, timeoutMs);
      timer.unref();
      child.stdout.on('data', chunk => { if (stdout.length < 32_000) stdout += String(chunk); });
      child.stderr.on('data', chunk => { if (stderr.length < 32_000) stderr += String(chunk); });
      child.once('error', error => done(new Error('启动工具失败：' + error.message)));
      child.once('close', code => {
        if (code === 0) done(null);
        else done(new Error(`工具退出码 ${code}：${(stderr || stdout).slice(-600)}`));
      });
    });
  }

  async renderPreviz(
    projectRoot: string,
    rawSpec: PrevizSceneSpec,
    environment: Partial<EnvironmentSettings> = {},
    options: { signal?: AbortSignal; timeoutMs?: number; templatePath?: string } = {},
  ): Promise<PrevizRenderResult> {
    const spec = validatePrevizSpec(rawSpec);
    const env = inspectToolEnvironment(environment);
    if (!env.blenderAvailable || !env.blenderPath) throw new Error('本机未检测到可用的 Blender，请在「运行环境」中配置 Blender 可执行路径');
    const wantsVideo = spec.output === 'video' || spec.output === 'both';
    if (wantsVideo && (!env.ffmpegAvailable || !env.ffmpegPath)) throw new Error('输出白模预演视频需要可用的 FFmpeg，或改用 output: "image" 仅渲染关键帧');

    const frames = wantsVideo ? Math.max(2, Math.min(360, Math.round(spec.durationSeconds * spec.fps))) : 1;
    const workDir = path.join(path.resolve(projectRoot), '.studio', 'runtime', 'blender-' + randomUUID());
    const specFile = path.join(workDir, 'spec.json');
    const outDir = path.join(workDir, 'out');
    await mkdir(outDir, { recursive: true });

    try {
      await writeFile(specFile, JSON.stringify({ ...spec, frames, outputDir: outDir }, null, 2));
      const scriptFile = options.templatePath ?? path.join(workDir, 'previz.py');
      if (!options.templatePath) await writeFile(scriptFile, PREVIZ_TEMPLATE_PY);
      const timeoutMs = options.timeoutMs ?? (wantsVideo ? 180_000 : 60_000);
      await this.runChild(
        env.blenderPath,
        ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', scriptFile, '--', specFile],
        timeoutMs,
        options.signal,
      );

      const manifestRaw = await readFile(path.join(outDir, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as { keyframe?: string; depth?: string | null; framesDir?: string | null; frameCount?: number };
      const keyframePath = path.resolve(manifest.keyframe ?? path.join(outDir, 'keyframe.png'));
      if (!keyframePath.startsWith(outDir + path.sep)) throw new Error('Blender 预演产物路径越界');
      const keyframePng = new Uint8Array(await readFile(keyframePath));
      if (mediaSignature(keyframePng) !== 'image/png') throw new Error('Blender 未产出有效 PNG 白模关键帧');

      let depthPng: Uint8Array | undefined;
      if (manifest.depth) {
        const depthPath = path.resolve(manifest.depth);
        if (!depthPath.startsWith(outDir + path.sep)) throw new Error('Blender 深度图路径越界');
        const bytes = new Uint8Array(await readFile(depthPath));
        if (mediaSignature(bytes) === 'image/png') depthPng = bytes;
      }

      let videoMp4: Uint8Array | undefined;
      if (wantsVideo && manifest.framesDir) {
        const framesDir = path.resolve(manifest.framesDir);
        if (!framesDir.startsWith(outDir + path.sep)) throw new Error('Blender 帧序列目录越界');
        const mp4Path = path.join(outDir, 'previz.mp4');
        await this.runChild(
          env.ffmpegPath,
          ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(spec.fps), '-i', path.join(framesDir, 'frame_%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Path],
          60_000,
          options.signal,
        );
        const bytes = new Uint8Array(await readFile(mp4Path));
        if (mediaSignature(bytes) !== 'video/mp4') throw new Error('白模预演 MP4 编码格式校验失败');
        videoMp4 = bytes;
      }

      return { keyframePng, ...(depthPng ? { depthPng } : {}), ...(videoMp4 ? { videoMp4 } : {}), width: spec.width, height: spec.height, fps: spec.fps, frameCount: frames };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    for (const child of this.owned) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    this.owned.clear();
  }
}
