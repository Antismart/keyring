/**
 * Lay the narration onto the capture.
 *
 *   node scripts/mix-demo.mjs [dir]
 *
 * Reads the cue sheet written by the recorder and the clips written by the
 * narrator, drops each clip at the millisecond its beat began, and writes one
 * narration track the length of the video. No alignment by ear: the recorder
 * held every beat for exactly as long as its clip runs, so the offsets are
 * already correct.
 *
 * With ffmpeg on PATH it then muxes picture and sound into an MP4, which is
 * what a submission form will accept. Without it, the WAV is still written and
 * can be dropped onto the video in any editor.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { wavData } from "./demo-script.mjs";

const run = promisify(execFile);
const DIR = path.resolve(process.argv[2] ?? "demo");
const BYTES_PER_SAMPLE = 2;

const sheet = JSON.parse(await fs.readFile(path.join(DIR, "cues.json"), "utf8"));
const clips = [];
for (const cue of sheet.cues) {
  const file = path.join(DIR, "voice", `${cue.id}.wav`);
  const buf = await fs.readFile(file).catch(() => null);
  if (!buf) {
    console.error(`missing ${file} — run scripts/narrate.mjs first`);
    process.exit(1);
  }
  clips.push({ ...cue, buf, ...wavData(buf) });
}

// The clips set the rate: `say` writes 22.05 kHz, ElevenLabs 44.1 kHz. Mixing
// across rates would shift every clip, so insist they agree.
const RATE = clips[0].sampleRate;
const odd = clips.find(
  (c) => c.sampleRate !== RATE || c.channels !== 1 || c.bitsPerSample !== 16,
);
if (odd) {
  console.error(
    `${odd.id}.wav is ${odd.sampleRate} Hz / ${odd.channels}ch / ${odd.bitsPerSample}-bit, expected ${RATE} Hz mono 16-bit`,
  );
  process.exit(1);
}

const lastEnd = Math.max(
  ...clips.map((c) => c.at + (c.size / (RATE * BYTES_PER_SAMPLE)) * 1000),
);
const totalMs = Math.ceil(Math.max(sheet.duration_ms, lastEnd) + 500);
const totalSamples = Math.ceil((totalMs / 1000) * RATE);
const pcm = Buffer.alloc(totalSamples * BYTES_PER_SAMPLE); // silence

let clipped = 0;
for (const c of clips) {
  const offset = Math.round((c.at / 1000) * RATE) * BYTES_PER_SAMPLE;
  const room = pcm.length - offset;
  if (c.size > room) clipped++;
  c.buf.copy(pcm, offset, c.start, c.start + Math.min(c.size, room));
}

// Canonical 44-byte WAV header for 16-bit mono PCM.
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * BYTES_PER_SAMPLE, 28);
header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);

const wav = path.join(DIR, "narration.wav");
await fs.writeFile(wav, Buffer.concat([header, pcm]));
console.log(`${wav}  (${(totalMs / 1000).toFixed(1)}s, ${clips.length} clips)`);
if (clipped) console.log(`  ${clipped} clip(s) ran past the end of the video and were truncated`);

const video = path.join(DIR, sheet.video);
const mp4 = path.join(DIR, "keyring-demo.mp4");
try {
  await run("ffmpeg", [
    "-y",
    "-i", video,
    "-i", wav,
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ac", "1",
    "-shortest",
    "-movflags", "+faststart",
    mp4,
  ]);
  const { size } = await fs.stat(mp4);
  console.log(`${mp4}  (${(size / 1e6).toFixed(1)} MB)`);
} catch (e) {
  console.log(
    `\nffmpeg is not available, so the MP4 was not written. The picture and the\n` +
      `voice are both finished and aligned — put them together with:\n\n` +
      `  ffmpeg -i ${video} -i ${wav} -c:v libx264 -crf 20 -pix_fmt yuv420p \\\n` +
      `    -c:a aac -b:a 160k -shortest ${mp4}\n`,
  );
  if (!/ENOENT/.test(e.message)) console.error(e.message.split("\n").slice(-3).join("\n"));
}
