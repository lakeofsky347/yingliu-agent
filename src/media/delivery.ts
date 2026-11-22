import { randomUUID } from 'node:crypto';
import type { SubtitleCue, VideoProject, VideoTarget } from '../shared/types.ts';
import type { Story } from '../agent/story.ts';
import { compileSpec } from '../core/index.ts';

function pad2(n: number): string { return String(Math.floor(n)).padStart(2, '0'); }
function pad3(n: number): string { return String(Math.floor(n)).padStart(3, '0'); }

function srtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(Math.min(999, ms))}`;
}

function assTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(Math.min(99, cs))}`;
}

function smpteTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(seconds * fps));
  const f = Math.round(fps);
  const ff = totalFrames % f;
  const totalSecs = Math.floor(totalFrames / f);
  const ss = totalSecs % 60;
  const mm = Math.floor(totalSecs / 60) % 60;
  const hh = Math.floor(totalSecs / 3600);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Derive timeline subtitles from explicit project.subtitles or automatically from voice clips + shot narration/subtitle. */
export function deriveSubtitles(project: VideoProject, story?: Story | null): SubtitleCue[] {
  if (project.subtitles?.length) {
    return [...project.subtitles].sort((a, b) => a.startSeconds - b.startSeconds);
  }
  const spec = compileSpec(project);
  const fps = project.target.fps.num / project.target.fps.den;
  const cues: SubtitleCue[] = [];
  for (const shot of spec.shots) {
    const shotStart = shot.startFrame / fps;
    const shotEnd = shot.endFrame / fps;
    const voiceClips = (project.audioClips ?? []).filter(c => c.role === 'voice' && c.shotId === shot.id);
    if (voiceClips.length) {
      for (const clip of voiceClips) {
        const asset = project.assets.find(a => a.id === clip.assetId);
        const dur = asset?.duration ? Math.min(clip.trimEnd ?? asset.duration, asset.duration) - clip.trimStart : (shotEnd - shotStart);
        const text = (asset?.description && !asset.description.startsWith('由 ') ? asset.description : '') || shot.narration || shot.params.subtitle || '';
        if (!text.trim()) continue;
        cues.push({
          id: `cue-${clip.id}`,
          shotId: shot.id,
          ...(clip.speaker ? { speaker: clip.speaker } : {}),
          startSeconds: Math.round((shotStart + clip.startSeconds) * 1000) / 1000,
          endSeconds: Math.round(Math.min(shotEnd, shotStart + clip.startSeconds + Math.max(0.3, dur)) * 1000) / 1000,
          text: text.trim(),
        });
      }
      continue;
    }
    const planned = story?.shots.find(s => s.shotId === shot.id || s.id === shot.id);
    const fallbackText = (shot.narration || shot.params.subtitle || planned?.dialogue || '').trim();
    if (fallbackText && !fallbackText.startsWith('编辑文字、绑定图片')) {
      cues.push({
        id: `cue-${shot.id}`,
        shotId: shot.id,
        startSeconds: Math.round((shotStart + 0.1) * 1000) / 1000,
        endSeconds: Math.round(Math.max(shotStart + 0.4, shotEnd - 0.15) * 1000) / 1000,
        text: fallbackText,
      });
    }
  }
  return cues.sort((a, b) => a.startSeconds - b.startSeconds);
}

export function formatSrt(cues: SubtitleCue[]): string {
  return cues.map((cue, idx) => {
    const line = cue.speaker ? `${cue.speaker}：${cue.text}` : cue.text;
    return `${idx + 1}\n${srtTimestamp(cue.startSeconds)} --> ${srtTimestamp(cue.endSeconds)}\n${line}\n`;
  }).join('\n');
}

export function formatAss(cues: SubtitleCue[], target: VideoTarget, title = '映流成片字幕'): string {
  const fontSize = Math.max(28, Math.round(Math.min(target.width, target.height) * 0.045));
  const marginV = target.height > target.width ? Math.round(target.height * 0.09) : Math.round(target.height * 0.06);
  const marginH = Math.round(target.width * 0.07);
  const header = [
    '[Script Info]',
    `Title: ${title}`,
    'ScriptType: v4.00+',
    `PlayResX: ${target.width}`,
    `PlayResY: ${target.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,PingFang SC,${fontSize},&H00FFFFFF,&H0000FFFF,&H66000000,&H80000000,0,0,0,0,100,100,0,0,1,2.5,1,2,${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = cues.map(cue => {
    const cleanText = (cue.speaker ? `{\\b1}${cue.speaker}：{\\b0}` : '') + cue.text.replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${assTimestamp(cue.startSeconds)},${assTimestamp(cue.endSeconds)},Default,${cue.speaker ?? ''},0,0,0,,${cleanText}`;
  });
  return [...header, ...events, ''].join('\n');
}

/** Export OpenTimelineIO (.otio JSON) for DaVinci Resolve / Premiere Pro / Nuke timeline handoff. */
export function formatOtio(project: VideoProject): string {
  const spec = compileSpec(project);
  const rate = project.target.fps.num / project.target.fps.den;
  const videoChildren: Record<string, unknown>[] = [];
  for (const [idx, shot] of spec.shots.entries()) {
    const clipAsset = shot.videoClip ? project.assets.find(a => a.id === shot.videoClip!.assetId) : undefined;
    const startFrame = shot.videoClip ? Math.round(shot.videoClip.trimStart * rate) : 0;
    videoChildren.push({
      OTIO_SCHEMA: 'Clip.2',
      name: shot.title || shot.id,
      metadata: { yingliuShotId: shot.id, sourcePath: shot.sourcePath, colorGrade: shot.colorGrade ?? null },
      source_range: {
        OTIO_SCHEMA: 'TimeRange.1',
        start_time: { OTIO_SCHEMA: 'RationalTime.1', value: startFrame, rate },
        duration: { OTIO_SCHEMA: 'RationalTime.1', value: shot.durationFrames, rate },
      },
      media_reference: clipAsset?.path
        ? { OTIO_SCHEMA: 'ExternalReference.1', target_url: clipAsset.path, available_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate }, duration: { OTIO_SCHEMA: 'RationalTime.1', value: Math.round((clipAsset.duration ?? (shot.durationFrames / rate)) * rate), rate } } }
        : { OTIO_SCHEMA: 'MissingReference.1', name: `${shot.sourcePath}/index.js` },
    });
    const next = spec.shots[idx + 1];
    if (next && ['dissolve', 'fade', 'wipe_left'].includes(next.transition)) {
      const half = Math.max(1, Math.round((next.transitionFrames ?? Math.round(0.25 * rate)) / 2));
      videoChildren.push({
        OTIO_SCHEMA: 'Transition.1',
        name: next.transition,
        transition_type: 'SMPTE_Dissolve',
        in_offset: { OTIO_SCHEMA: 'RationalTime.1', value: half, rate },
        out_offset: { OTIO_SCHEMA: 'RationalTime.1', value: half, rate },
      });
    }
  }

  const audioTrack = (role: 'voice' | 'music' | 'sfx', label: string) => {
    const items = (project.audioClips ?? []).filter(c => c.role === role);
    return {
      OTIO_SCHEMA: 'Track.1',
      name: label,
      kind: 'Audio',
      children: items.map(clip => {
        const asset = project.assets.find(a => a.id === clip.assetId);
        const shot = clip.shotId ? spec.shots.find(s => s.id === clip.shotId) : undefined;
        const timelineStart = (shot ? shot.startFrame / rate : 0) + clip.startSeconds;
        const durSec = Math.max(0.1, (clip.trimEnd ?? asset?.duration ?? 1) - clip.trimStart);
        return {
          OTIO_SCHEMA: 'Clip.2',
          name: asset?.name ?? clip.id,
          metadata: { timelineStartSeconds: timelineStart, volume: clip.volume, role: clip.role },
          source_range: {
            OTIO_SCHEMA: 'TimeRange.1',
            start_time: { OTIO_SCHEMA: 'RationalTime.1', value: Math.round(clip.trimStart * rate), rate },
            duration: { OTIO_SCHEMA: 'RationalTime.1', value: Math.round(durSec * rate), rate },
          },
          media_reference: asset?.path ? { OTIO_SCHEMA: 'ExternalReference.1', target_url: asset.path } : { OTIO_SCHEMA: 'MissingReference.1' },
        };
      }),
    };
  };

  const doc = {
    OTIO_SCHEMA: 'Timeline.1',
    name: project.title,
    global_start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [
        { OTIO_SCHEMA: 'Track.1', name: 'V1 Primary Storyline', kind: 'Video', children: videoChildren },
        audioTrack('voice', 'A1 Dialogue / VO'),
        audioTrack('sfx', 'A2 SFX'),
        audioTrack('music', 'A3 Music'),
      ],
    },
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Export Final Cut Pro XML v1.10 (.fcpxml) compatible with Final Cut Pro, DaVinci Resolve, Premiere & CapCut Pro. */
export function formatFcpxml(project: VideoProject): string {
  const spec = compileSpec(project);
  const { num, den } = project.target.fps;
  const frameDur = `${den}/${num}s`;
  const totalDur = `${spec.durationFrames * den}/${num}s`;
  const resources: string[] = [
    `    <format id="r1" name="FFVideoFormat${project.target.height}p" frameDuration="${frameDur}" width="${project.target.width}" height="${project.target.height}"/>`,
  ];
  const assetResMap = new Map<string, string>();
  let resIdx = 2;
  for (const asset of project.assets) {
    if (!asset.path || !['video', 'audio', 'image'].includes(asset.kind)) continue;
    const rid = `r${resIdx++}`;
    assetResMap.set(asset.id, rid);
    const durFrames = Math.max(1, Math.round((asset.duration ?? 10) * num / den));
    resources.push(`    <asset id="${rid}" name="${escapeXml(asset.name)}" uid="${escapeXml(asset.id)}" src="./${escapeXml(asset.path)}" start="0s" duration="${durFrames * den}/${num}s" hasVideo="${asset.kind !== 'audio' ? 1 : 0}" hasAudio="${asset.kind === 'audio' || asset.hasAudio ? 1 : 0}"/>`);
  }
  const spineItems = spec.shots.map(shot => {
    const offset = `${shot.startFrame * den}/${num}s`;
    const duration = `${shot.durationFrames * den}/${num}s`;
    const vClip = shot.videoClip;
    const rid = vClip ? assetResMap.get(vClip.assetId) : undefined;
    if (rid && vClip) {
      const startFrames = Math.round(vClip.trimStart * num / den);
      return `            <asset-clip name="${escapeXml(shot.title)}" ref="${rid}" offset="${offset}" start="${startFrames * den}/${num}s" duration="${duration}" format="r1"/>`;
    }
    return `            <gap name="${escapeXml(shot.title)}" offset="${offset}" start="0s" duration="${duration}"/>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    ...resources,
    '  </resources>',
    `  <library><event name="${escapeXml(project.title)}"><project name="${escapeXml(project.title)}" uid="${escapeXml(project.id || randomUUID())}">`,
    `    <sequence format="r1" duration="${totalDur}" tcStart="0s" tcFormat="NDF">`,
    '      <spine>',
    ...spineItems,
    '      </spine>',
    '    </sequence>',
    '  </project></event></library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

/** Export CMX 3600 EDL (.edl) edit decision list. */
export function formatEdl(project: VideoProject): string {
  const spec = compileSpec(project);
  const fps = project.target.fps.num / project.target.fps.den;
  const lines = [`TITLE: ${project.title}`, 'FCM: NON-DROP FRAME', ''];
  spec.shots.forEach((shot, idx) => {
    const eventNum = String(idx + 1).padStart(3, '0');
    const reel = (shot.videoClip?.assetId ?? shot.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase().padEnd(8, ' ');
    const srcIn = shot.videoClip?.trimStart ?? 0;
    const dur = shot.durationFrames / fps;
    const srcOut = srcIn + dur;
    const recIn = shot.startFrame / fps;
    const recOut = shot.endFrame / fps;
    lines.push(`${eventNum}  ${reel} V     C        ${smpteTimecode(srcIn, fps)} ${smpteTimecode(srcOut, fps)} ${smpteTimecode(recIn, fps)} ${smpteTimecode(recOut, fps)}`);
    lines.push(`* FROM CLIP NAME: ${shot.title}`);
  });
  return lines.join('\n') + '\n';
}
