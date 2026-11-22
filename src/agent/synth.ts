/** Offline procedural sound & Foley synthesizer: tones, sweeps, chimes, noise, whoosh, clicks, rain, heartbeat, footsteps, risers, sub-drops & ambience → 16-bit mono WAV. */
export type SynthKind = 'tone' | 'sweep' | 'chime' | 'noise' | 'whoosh' | 'click' | 'rain' | 'heartbeat' | 'footstep' | 'riser' | 'sub_drop' | 'ambience_hum';
export interface SynthSpec { kind: SynthKind; durationSeconds: number; frequency?: number; endFrequency?: number; volume?: number; seed?: number }
const RATE = 44100;
export function synthesize(spec: SynthSpec): Uint8Array {
  const duration = Math.max(0.05, Math.min(30, Number(spec.durationSeconds) || 0.5));
  const f0 = Math.max(20, Math.min(12000, Number(spec.frequency) || 440)), f1 = Math.max(20, Math.min(12000, Number(spec.endFrequency) || f0 * 2));
  const volume = Math.max(0, Math.min(1, spec.volume ?? 0.6)), n = Math.floor(duration * RATE);
  let seed = (spec.seed ?? 1) >>> 0 || 1; const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
  const data = new Int16Array(n); let phase = 0, low = 0, low2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE, p = i / n;
    const attack = Math.min(1, t / 0.01), release = Math.min(1, (duration - t) / 0.05);
    let env = attack * release, sample = 0;
    switch (spec.kind) {
      case 'tone': sample = Math.sin(2 * Math.PI * f0 * t); break;
      case 'sweep': { const f = f0 + (f1 - f0) * p; phase += 2 * Math.PI * f / RATE; sample = Math.sin(phase); break; }
      case 'chime': env *= Math.exp(-4 * t / duration); sample = 0.6 * Math.sin(2 * Math.PI * f0 * t) + 0.3 * Math.sin(2 * Math.PI * f0 * 2.76 * t) + 0.1 * Math.sin(2 * Math.PI * f0 * 5.4 * t); break;
      case 'noise': env *= Math.exp(-6 * t / duration); sample = rand(); break;
      case 'whoosh': { low += (rand() - low) * (0.02 + 0.2 * Math.sin(Math.PI * p)); sample = low * 3; env *= Math.sin(Math.PI * p); break; }
      case 'click': env = Math.exp(-t * 400); sample = Math.sin(2 * Math.PI * 2000 * t); break;
      case 'rain': {
        const white = rand();
        low += (white - low) * 0.08;
        const drop = (i % 1973 === 0 || rand() > 0.9985) ? 0.65 : 0;
        low2 = low2 * 0.96 + drop;
        sample = (white * 0.22 + low * 0.55 + low2 * Math.sin(2 * Math.PI * 1800 * t) * 0.35);
        env = Math.min(1, t / 0.15) * Math.min(1, (duration - t) / 0.15);
        break;
      }
      case 'heartbeat': {
        const cycle = t % 0.92;
        const beat1 = cycle < 0.14 ? Math.exp(-cycle * 28) * Math.sin(2 * Math.PI * 58 * cycle) : 0;
        const beat2 = cycle >= 0.20 && cycle < 0.36 ? 0.78 * Math.exp(-(cycle - 0.20) * 32) * Math.sin(2 * Math.PI * 48 * (cycle - 0.20)) : 0;
        sample = (beat1 + beat2) * 1.4;
        break;
      }
      case 'footstep': {
        const stepPeriod = 0.52, st = t % stepPeriod;
        const thud = Math.exp(-st * 45) * Math.sin(2 * Math.PI * 95 * st);
        const grit = Math.exp(-st * 90) * rand() * 0.5;
        sample = (thud * 0.8 + grit);
        break;
      }
      case 'riser': {
        const curve = p * p;
        const f = 90 + (f1 - 90) * curve;
        phase += 2 * Math.PI * f / RATE;
        low += (rand() - low) * (0.01 + 0.18 * curve);
        sample = 0.65 * Math.sin(phase) + 0.55 * low;
        env = curve * Math.min(1, (duration - t) / 0.03);
        break;
      }
      case 'sub_drop': {
        const f = 110 * Math.exp(-2.4 * p) + 28;
        phase += 2 * Math.PI * f / RATE;
        sample = Math.tanh(1.6 * Math.sin(phase));
        env *= Math.exp(-1.8 * p);
        break;
      }
      case 'ambience_hum': {
        const mod = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.35 * t);
        low += (rand() - low) * 0.008;
        sample = (0.45 * Math.sin(2 * Math.PI * 65 * t) + 0.25 * Math.sin(2 * Math.PI * 97.5 * t) + low * 1.2) * mod;
        env = Math.min(1, t / 0.25) * Math.min(1, (duration - t) / 0.25);
        break;
      }
    }
    data[i] = Math.round(Math.max(-1, Math.min(1, sample * env * volume)) * 32767);
  }
  const buffer = Buffer.alloc(44 + n * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + n * 2, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(RATE, 24); buffer.writeUInt32LE(RATE * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(n * 2, 40); Buffer.from(data.buffer).copy(buffer, 44);
  return new Uint8Array(buffer);
}
