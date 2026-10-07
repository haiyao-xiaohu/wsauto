// 生成“滴滴滴”提示音 WAV 文件到 public/siren.wav
// 运行：node scripts/generate-siren.js

import { writeFileSync } from "node:fs";

const SAMPLE_RATE = 44100;
const DURATION_SECONDS = 1.5;
const NUM_SAMPLES = Math.round(SAMPLE_RATE * DURATION_SECONDS);
const BYTES_PER_SAMPLE = 2;
const NUM_CHANNELS = 1;

// 滴滴滴模式：3 声短促的“滴”，每声 200ms，间隔 200ms
function generateBeeps() {
  const buffer = new Int16Array(NUM_SAMPLES);
  const BEEP_MS = 200;
  const GAP_MS = 200;
  const CYCLE_MS = BEEP_MS + GAP_MS;
  const FREQ = 1200; // 清脆的高音“滴”

  for (let i = 0; i < NUM_SAMPLES; i += 1) {
    const t = i / SAMPLE_RATE;
    const msInCycle = (t * 1000) % CYCLE_MS;
    const isInBeep = msInCycle < BEEP_MS;

    if (isInBeep) {
      // 正弦波 + 轻微衰减，听起来更像电子提示音
      const beepT = msInCycle / BEEP_MS; // 0~1
      const envelope = 1 - beepT * 0.3; // 轻微衰减
      const sample = Math.sin(2 * Math.PI * FREQ * t) * 0.85 * envelope;
      buffer[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    } else {
      buffer[i] = 0; // 静音间隔
    }
  }
  return Buffer.from(buffer.buffer);
}

function writeWav(filename, pcmData) {
  const dataChunkSize = pcmData.length;
  const fileSize = 44 + dataChunkSize;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize - 8, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(NUM_CHANNELS * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataChunkSize, 40);

  writeFileSync(filename, Buffer.concat([header, pcmData]));
}

const pcm = generateBeeps();
writeWav("public/siren.wav", pcm);
console.log("Generated public/siren.wav");
