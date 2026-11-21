import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnvironmentSettings } from '../shared/types.ts';
import { inspectToolEnvironment } from './tool-environment.ts';
import { mediaSignature } from '../jobs/download.ts';

export type PrevizOutputMode = 'image' | 'video' | 'both';
export interface PrevizObjectSpec {
  id: string;
  kind: 'character' | 'box' | 'cylinder' | 'sphere' | 'plane';
  position: [number, number, number];
  scale?: [number, number, number];
  height?: number;
  facingDeg?: number;
  color?: string;
}
export interface PrevizCameraSpec {
  lensMm?: number;
  startPos: [number, number, number];
  endPos?: [number, number, number];
  startTarget: [number, number, number];
  endTarget?: [number, number, number];
}
export interface PrevizSceneSpec {
  output?: PrevizOutputMode;
  width?: number;
  height?: number;
  fps?: number;
  durationSeconds?: number;
  engine?: 'BLENDER_WORKBENCH' | 'BLENDER_EEVEE_NEXT';
  lighting?: 'three_point' | 'daylight';
  background?: string;
  camera: PrevizCameraSpec;
  objects: PrevizObjectSpec[];
}
export interface PrevizRenderResult {
  keyframePng: Uint8Array;
  videoMp4?: Uint8Array;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
}

/** Embedded deterministic whitebox previz script (safe across ESM/CJS/Electron bundles). */
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
def add_standin(item):
    pos = item.get("position", [0.0,0.0,0.0]); h = float(item.get("height", 1.72)); yaw = float(item.get("facingDeg", 0.0))
    mat = make_mat("S_" + item.get("id","c"), hex_to_rgba(item.get("color"), (0.86,0.88,0.92,1.0)))
    acc = make_mat("N_" + item.get("id","c"), (0.20,0.52,0.78,1.0))
    root = bpy.data.objects.new("Char_" + item.get("id","c"), None); bpy.context.collection.objects.link(root)
    root.location = (float(pos[0]), float(pos[1]), float(pos[2])); root.rotation_euler = (0.0, 0.0, math.radians(yaw))
    th = h * 0.62; bpy.ops.mesh.primitive_cylinder_add(radius=h*0.14, depth=th, location=(0,0,th*0.5))
    t = bpy.context.active_object; assign_mat(t, mat); t.parent = root
    hr = h * 0.11; bpy.ops.mesh.primitive_uv_sphere_add(radius=hr, location=(0,0,th+hr*1.15))
    hd = bpy.context.active_object; assign_mat(hd, mat); hd.parent = root
    bpy.ops.mesh.primitive_cone_add(radius1=hr*0.35, depth=hr*0.8, location=(0,hr*1.1,th+hr*1.15), rotation=(-math.pi/2,0,0))
    ns = bpy.context.active_object; assign_mat(ns, acc); ns.parent = root
def add_prop(item):
    k = item.get("kind","box"); pos = item.get("position",[0.0,0.0,0.0]); sc = item.get("scale",[1.0,1.0,1.0]); yaw = float(item.get("facingDeg",0.0))
    mat = make_mat("P_" + item.get("id","p"), hex_to_rgba(item.get("color"), (0.74,0.77,0.82,1.0)))
    loc = (float(pos[0]), float(pos[1]), float(pos[2]) + (0.0 if k=="plane" else float(sc[2])*0.5))
    if k=="cylinder": bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1.0, location=loc)
    elif k=="sphere": bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=loc)
    elif k=="plane": bpy.ops.mesh.primitive_plane_add(size=1.0, location=loc)
    else: bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    o = bpy.context.active_object; o.scale = (float(sc[0]),float(sc[1]),float(sc[2])); o.rotation_euler = (0.0,0.0,math.radians(yaw)); assign_mat(o, mat)
def setup_lights(preset):
    def add_l(name, lt, loc, e, rot=(0,0,0), sz=3.0):
        d = bpy.data.lights.new(name=name, type=lt); d.energy = e
        if lt=="AREA": d.size = sz
        o = bpy.data.objects.new(name=name, object_data=d); bpy.context.collection.objects.link(o); o.location = loc; o.rotation_euler = rot
    if preset=="daylight":
        add_l("Sun","SUN",(6,-6,10),4.0,(math.radians(45),math.radians(15),math.radians(35)))
        add_l("Sky","AREA",(-5,-4,6),120.0,(math.radians(55),0,math.radians(-35)),6.0)
    else:
        add_l("Key","AREA",(5,-5,6),380.0,(math.radians(52),0,math.radians(42)),4.0)
        add_l("Fill","AREA",(-6,-4,4),160.0,(math.radians(60),0,math.radians(-48)),5.0)
        add_l("Rim","AREA",(0,6,5),220.0,(math.radians(-50),0,math.radians(180)),4.0)
def main():
    spec = parse_spec(); out_dir = spec["outputDir"]; os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
    w = bpy.data.worlds.new("PrevizWorld"); sc.world = w; w.color = hex_to_rgba(spec.get("background"),(0.14,0.16,0.20,1.0))[:3]
    try: sc.render.engine = spec.get("engine","BLENDER_WORKBENCH")
    except Exception: sc.render.engine = "BLENDER_WORKBENCH"
    if sc.render.engine == "BLENDER_WORKBENCH":
        sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "MATERIAL"; sc.display.shading.show_shadows = True
    bpy.ops.mesh.primitive_plane_add(size=40.0, location=(0,0,0)); assign_mat(bpy.context.active_object, make_mat("Ground",(0.28,0.30,0.34,1.0)))
    setup_lights(spec.get("lighting","three_point"))
    for obj in spec.get("objects",[]):
        if obj.get("kind")=="character": add_standin(obj)
        else: add_prop(obj)
    cs = spec.get("camera",{}); cd = bpy.data.cameras.new("Cam"); cd.lens = float(cs.get("lensMm",35.0))
    co = bpy.data.objects.new("Cam", cd); bpy.context.collection.objects.link(co); sc.camera = co
    to = bpy.data.objects.new("Target", None); bpy.context.collection.objects.link(to)
    tr = co.constraints.new(type="TRACK_TO"); tr.target = to; tr.track_axis = "TRACK_NEGATIVE_Z"; tr.up_axis = "UP_Y"
    sp = cs.get("startPos",[0,-6,1.8]); ep = cs.get("endPos",sp); st = cs.get("startTarget",[0,0,1.2]); et = cs.get("endTarget",st)
    frames = max(1, int(spec.get("frames",1))); sc.frame_start = 1; sc.frame_end = frames
    sc.render.fps = max(1, int(spec.get("fps",12))); sc.render.resolution_x = int(spec.get("width",960)); sc.render.resolution_y = int(spec.get("height",540))
    sc.render.resolution_percentage = 100; sc.render.image_settings.file_format = "PNG"
    co.location = (float(sp[0]),float(sp[1]),float(sp[2])); co.keyframe_insert(data_path="location", frame=1)
    to.location = (float(st[0]),float(st[1]),float(st[2])); to.keyframe_insert(data_path="location", frame=1)
    if frames > 1:
        co.location = (float(ep[0]),float(ep[1]),float(ep[2])); co.keyframe_insert(data_path="location", frame=frames)
        to.location = (float(et[0]),float(et[1]),float(et[2])); to.keyframe_insert(data_path="location", frame=frames)
    mode = spec.get("output","both"); kp = os.path.join(out_dir,"keyframe.png")
    manifest = {"keyframe": kp, "framesDir": None, "frameCount": frames}
    if mode in ("video","both") and frames > 1:
        fd = os.path.join(out_dir,"frames"); os.makedirs(fd, exist_ok=True); sc.render.filepath = os.path.join(fd,"frame_")
        bpy.ops.render.render(animation=True)
        f1 = os.path.join(fd,"frame_0001.png")
        if os.path.exists(f1):
            with open(f1,"rb") as a, open(kp,"wb") as b: b.write(a.read())
        manifest["framesDir"] = fd
    else:
        sc.frame_set(1); sc.render.filepath = kp; bpy.ops.render.render(write_still=True)
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

export function validatePrevizSpec(input: unknown): Required<Pick<PrevizSceneSpec, 'output' | 'width' | 'height' | 'fps' | 'durationSeconds' | 'engine' | 'lighting' | 'camera' | 'objects'>> & { background?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预演场景参数须为对象');
  const raw = input as Record<string, unknown>;
  const output: PrevizOutputMode = raw.output === 'image' || raw.output === 'video' || raw.output === 'both' ? raw.output : 'both';
  const width = raw.width === undefined ? 960 : Number(raw.width);
  const height = raw.height === undefined ? 540 : Number(raw.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 256 || height < 256 || width > 1920 || height > 1920 || width % 2 !== 0 || height % 2 !== 0)
    throw new Error('预演画面尺寸须为 256–1920 范围内的偶数');
  const fps = raw.fps === undefined ? 12 : Number(raw.fps);
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 60) throw new Error('预演 FPS 须为 1–60 的整数');
  const durationSeconds = raw.durationSeconds === undefined ? 3 : Number(raw.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30) throw new Error('单镜头预演时长须为 0–30 秒');
  const engine = raw.engine === 'BLENDER_EEVEE_NEXT' ? 'BLENDER_EEVEE_NEXT' : 'BLENDER_WORKBENCH';
  const lighting = raw.lighting === 'daylight' ? 'daylight' : 'three_point';
  const background = safeColor(raw.background);
  if (!raw.camera || typeof raw.camera !== 'object' || Array.isArray(raw.camera)) throw new Error('缺少预演机位 camera 参数');
  const cam = raw.camera as Record<string, unknown>;
  const lensMm = cam.lensMm === undefined ? 35 : Number(cam.lensMm);
  if (!Number.isFinite(lensMm) || lensMm < 10 || lensMm > 250) throw new Error('镜头焦距 lensMm 须在 10–250mm 之间');
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
    const scale = item.scale !== undefined ? vec3(item.scale, `objects[${idx}].scale`) : undefined;
    const heightVal = item.height !== undefined ? Number(item.height) : undefined;
    if (heightVal !== undefined && (!Number.isFinite(heightVal) || heightVal < 0.2 || heightVal > 10)) throw new Error(`objects[${idx}].height 无效`);
    const facingDeg = item.facingDeg !== undefined ? Number(item.facingDeg) : 0;
    if (!Number.isFinite(facingDeg)) throw new Error(`objects[${idx}].facingDeg 无效`);
    const color = safeColor(item.color);
    return { id, kind, position, ...(scale ? { scale } : {}), ...(heightVal !== undefined ? { height: heightVal } : {}), facingDeg, ...(color ? { color } : {}) };
  });
  return { output, width, height, fps, durationSeconds, engine, lighting, ...(background ? { background } : {}), camera: { lensMm, startPos, endPos, startTarget, endTarget }, objects };
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
      const manifest = JSON.parse(manifestRaw) as { keyframe?: string; framesDir?: string | null; frameCount?: number };
      const keyframePath = path.resolve(manifest.keyframe ?? path.join(outDir, 'keyframe.png'));
      if (!keyframePath.startsWith(outDir + path.sep)) throw new Error('Blender 预演产物路径越界');
      const keyframePng = new Uint8Array(await readFile(keyframePath));
      if (mediaSignature(keyframePng) !== 'image/png') throw new Error('Blender 未产出有效 PNG 白模关键帧');

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

      return { keyframePng, ...(videoMp4 ? { videoMp4 } : {}), width: spec.width, height: spec.height, fps: spec.fps, frameCount: frames };
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
