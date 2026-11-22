import { spawn, type ChildProcess } from 'node:child_process';
import type { EnvironmentSettings } from '../shared/types.ts';
import { audioExecutable } from '../host/audio.ts';

export interface VideoShotBoundary {
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  cutScore?: number;
}
export interface ReferenceVideoAnalysis {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  shotCount: number;
  averageShotLengthSeconds: number;
  pacing: 'fast_montage' | 'dynamic_commercial' | 'narrative_balanced' | 'slow_cinematic';
  shots: VideoShotBoundary[];
}
export interface AudioAcousticReport {
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
  clippingRisk: boolean;
  tooQuiet: boolean;
  silenceIntervals: { startSeconds: number; endSeconds: number; durationSeconds: number }[];
  totalSilenceSeconds: number;
}

function runProcess(executable: string, args: string[], signal?: AbortSignal, timeoutMs = 45_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child: ChildProcess = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const t = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1500);
      t.unref();
      child.once('close', () => clearTimeout(t));
    };
    const done = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve({ stdout, stderr });
    };
    const onAbort = () => { stop(); done(new Error('媒体分析已取消')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { stop(); done(new Error('媒体分析超时')); }, timeoutMs);
    timer.unref();
    child.stdout?.on('data', chunk => { if (stdout.length < 256_000) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { if (stderr.length < 256_000) stderr += String(chunk); });
    child.once('error', err => done(err instanceof Error ? err : new Error(String(err))));
    child.once('close', code => code === 0 ? done(null) : done(new Error(`FFmpeg 分析退出码 ${code}：${stderr.slice(-500)}`)));
  });
}

/** Deconstruct an imported reference video into shot boundaries, ASL pacing, and technical specs via ffprobe + FFmpeg scdet. */
export async function deconstructReferenceVideo(
  filePath: string,
  settings: Partial<EnvironmentSettings> = {},
  options: { threshold?: number; signal?: AbortSignal } = {},
): Promise<ReferenceVideoAnalysis> {
  const ffprobe = audioExecutable('ffprobe', settings.ffprobePath);
  const ffmpeg = audioExecutable('ffmpeg', settings.ffmpegPath);
  const probeOut = await runProcess(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', filePath], options.signal);
  const info = JSON.parse(probeOut.stdout) as { streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[]; format?: { duration?: string } };
  const vStream = info.streams?.find(s => s.codec_type === 'video');
  if (!vStream) throw new Error('目标文件不包含可识别的视频轨');
  const hasAudio = Boolean(info.streams?.some(s => s.codec_type === 'audio'));
  const durationSeconds = Math.max(0.1, Number(info.format?.duration ?? 0));
  const [rNum, rDen] = String(vStream.r_frame_rate ?? '30/1').split('/').map(Number);
  const fps = rNum && rDen ? Math.round((rNum / rDen) * 100) / 100 : 30;
  const threshold = Number.isFinite(options.threshold) ? Math.max(4, Math.min(40, Number(options.threshold))) : 12;

  const scdetOut = await runProcess(ffmpeg, ['-hide_banner', '-nostats', '-i', filePath, '-vf', `scdet=threshold=${threshold}`, '-an', '-f', 'null', '-'], options.signal, 60_000);
  const cuts: { time: number; score: number }[] = [];
  for (const match of scdetOut.stderr.matchAll(/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g)) {
    const score = Number(match[1]), time = Number(match[2]);
    if (Number.isFinite(time) && time > 0.15 && time < durationSeconds - 0.15) {
      if (!cuts.length || time - cuts.at(-1)!.time >= 0.25) cuts.push({ time, score });
    }
  }

  const shots: VideoShotBoundary[] = [];
  let cursor = 0;
  for (const [idx, cut] of cuts.entries()) {
    shots.push({
      index: idx + 1,
      startSeconds: Math.round(cursor * 100) / 100,
      endSeconds: Math.round(cut.time * 100) / 100,
      durationSeconds: Math.round((cut.time - cursor) * 100) / 100,
      cutScore: Math.round(cut.score * 10) / 10,
    });
    cursor = cut.time;
  }
  shots.push({
    index: shots.length + 1,
    startSeconds: Math.round(cursor * 100) / 100,
    endSeconds: Math.round(durationSeconds * 100) / 100,
    durationSeconds: Math.round((durationSeconds - cursor) * 100) / 100,
  });

  const asl = Math.round((durationSeconds / shots.length) * 100) / 100;
  const pacing: ReferenceVideoAnalysis['pacing'] = asl < 1.8 ? 'fast_montage' : asl < 3.5 ? 'dynamic_commercial' : asl < 7.0 ? 'narrative_balanced' : 'slow_cinematic';
  return {
    durationSeconds: Math.round(durationSeconds * 100) / 100,
    width: Number(vStream.width ?? 1920),
    height: Number(vStream.height ?? 1080),
    fps,
    hasAudio,
    shotCount: shots.length,
    averageShotLengthSeconds: asl,
    pacing,
    shots: shots.slice(0, 120),
  };
}

/** Measure true acoustic loudness (EBU R128 LUFS / dBTP) and silence intervals on an audio/video file via FFmpeg. */
export async function analyzeAudioAcoustics(
  filePath: string,
  settings: Partial<EnvironmentSettings> = {},
  signal?: AbortSignal,
): Promise<AudioAcousticReport> {
  const ffmpeg = audioExecutable('ffmpeg', settings.ffmpegPath);
  const { stderr } = await runProcess(
    ffmpeg,
    ['-hide_banner', '-nostats', '-i', filePath, '-af', 'silencedetect=noise=-45dB:d=0.6,ebur128=peak=true', '-vn', '-f', 'null', '-'],
    signal,
    45_000,
  );
  const iMatch = /I:\s*(-?[\d.]+)\s*LUFS/.exec(stderr);
  const lraMatch = /LRA:\s*(-?[\d.]+)\s*LU/.exec(stderr);
  const tpMatch = /Peak:\s*(-?[\d.]+)\s*dBFS/.exec(stderr);
  const integratedLufs = iMatch && Number.isFinite(Number(iMatch[1])) ? Number(iMatch[1]) : null;
  const loudnessRangeLu = lraMatch && Number.isFinite(Number(lraMatch[1])) ? Number(lraMatch[1]) : null;
  const truePeakDbtp = tpMatch && Number.isFinite(Number(tpMatch[1])) ? Number(tpMatch[1]) : null;

  const silenceIntervals: AudioAcousticReport['silenceIntervals'] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const st = /silence_start:\s*([\d.]+)/.exec(line);
    if (st) pendingStart = Number(st[1]);
    const en = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(line);
    if (en) {
      const end = Number(en[1]), dur = Number(en[2]);
      const start = pendingStart ?? Math.max(0, end - dur);
      silenceIntervals.push({
        startSeconds: Math.round(start * 100) / 100,
        endSeconds: Math.round(end * 100) / 100,
        durationSeconds: Math.round(dur * 100) / 100,
      });
      pendingStart = null;
    }
  }
  const totalSilenceSeconds = Math.round(silenceIntervals.reduce((s, x) => s + x.durationSeconds, 0) * 100) / 100;
  return {
    integratedLufs,
    loudnessRangeLu,
    truePeakDbtp,
    clippingRisk: truePeakDbtp !== null && truePeakDbtp > -0.2,
    tooQuiet: integratedLufs !== null && integratedLufs < -30,
    silenceIntervals: silenceIntervals.slice(0, 40),
    totalSilenceSeconds,
  };
}
