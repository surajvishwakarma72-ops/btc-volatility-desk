import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWavBuffer(sampleRate, durationSeconds, generateSample) {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const blockAlign = 2; // 16-bit mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(1, 22); // NumChannels (1 = Mono)
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // BitsPerSample (16 bits)

  // data subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = generateSample(t, durationSeconds);
    sample = Math.max(-1, Math.min(1, sample));
    const intSample = Math.floor(sample * 32767);
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }

  return buffer;
}

// 1. Chime: Multi-harmonic soft bell (880Hz A5 + harmonics)
function synthChime(t, dur) {
  const env = Math.exp(-4.5 * t);
  const s1 = Math.sin(2 * Math.PI * 880 * t);
  const s2 = 0.5 * Math.sin(2 * Math.PI * 1320 * t);
  const s3 = 0.25 * Math.sin(2 * Math.PI * 1760 * t);
  return (s1 + s2 + s3) * env * 0.7;
}

// 2. Radar: Sonar pulse (1100Hz with fast attack and ring)
function synthRadar(t, dur) {
  const p1 = t < 0.3 ? Math.sin(2 * Math.PI * (1100 - t * 200) * t) * Math.exp(-5 * t) : 0;
  const p2 = t > 0.25 && t < 0.65 ? Math.sin(2 * Math.PI * (1100 - (t - 0.25) * 200) * (t - 0.25)) * Math.exp(-6 * (t - 0.25)) * 0.6 : 0;
  return (p1 + p2) * 0.8;
}

// 3. Urgent: Two-tone urgent beep (800Hz & 1200Hz)
function synthUrgent(t, dur) {
  let val = 0;
  if (t < 0.15) {
    val = Math.sin(2 * Math.PI * 880 * t) * Math.exp(-2 * t);
  } else if (t >= 0.2 && t < 0.4) {
    val = Math.sin(2 * Math.PI * 1320 * (t - 0.2)) * Math.exp(-2 * (t - 0.2));
  }
  return val * 0.8;
}

// 4. Cash / Coin ping (2000Hz metallic chime)
function synthCash(t, dur) {
  const env = Math.exp(-6 * t);
  const s1 = Math.sin(2 * Math.PI * 1980 * t);
  const s2 = 0.6 * Math.sin(2 * Math.PI * 2640 * t);
  const s3 = 0.3 * Math.sin(2 * Math.PI * 3960 * t);
  return (s1 + s2 + s3) * env * 0.7;
}

const sampleRate = 44100;
const sounds = [
  { name: 'chime', dur: 1.2, gen: synthChime },
  { name: 'radar', dur: 0.8, gen: synthRadar },
  { name: 'urgent', dur: 0.6, gen: synthUrgent },
  { name: 'cash', dur: 0.9, gen: synthCash },
];

const webSoundDir = path.resolve(__dirname, '../../../frontend/public/sounds');
const androidRawDir = path.resolve(__dirname, '../../../frontend/android/app/src/main/res/raw');

fs.mkdirSync(webSoundDir, { recursive: true });
fs.mkdirSync(androidRawDir, { recursive: true });

for (const s of sounds) {
  const buf = createWavBuffer(sampleRate, s.dur, s.gen);
  const webPath = path.join(webSoundDir, `${s.name}.wav`);
  const androidPath = path.join(androidRawDir, `${s.name}.wav`);
  fs.writeFileSync(webPath, buf);
  fs.writeFileSync(androidPath, buf);
  console.log(`Generated sound: ${s.name}.wav (${buf.length} bytes)`);
}

console.log('All notification sound files generated successfully in both web and Android raw directories!');
