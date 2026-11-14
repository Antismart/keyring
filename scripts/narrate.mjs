/**
 * Synthesise the narration.
 *
 *   node scripts/narrate.mjs [out-dir]
 *
 * One clip per line of scripts/demo-script.mjs, plus the measured duration of
 * each. The recorder reads those durations and holds every beat for exactly as
 * long as its clip runs, so the picture is cut to the voice rather than the
 * voice being squeezed into a guessed hold.
 *
 * Two engines:
 *
 *   elevenlabs  when ELEVENLABS_API_KEY is set — what the finished video uses
 *   say         macOS fallback, so the pipeline runs with no key and no network
 *
 * The engine only changes how the WAV files are produced. Everything
 * downstream reads the same directory, so switching engines and re-running the
 * recorder is all that is needed to re-voice the demo.
 *
 * DEMO_VOICE_ID picks the ElevenLabs voice (default George); ELEVENLABS_MODEL
 * the model (default eleven_v4). DEMO_VOICE / DEMO_RATE tune `say`.
 */

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { LINES, RATE, VOICE, spoken, wavDurationMs } from "./demo-script.mjs";

// Read .env when there is one. Not `node --env-file`, which fails outright
// when the file is missing, and a missing file is the supported no-key case.
try {
  process.loadEnvFile(".env");
} catch {}

const run = promisify(execFile);
const OUT = path.resolve(process.argv[2] ?? "demo");
const VOICE_DIR = path.join(OUT, "voice");
const KEY = process.env.ELEVENLABS_API_KEY;
const ENGINE = KEY ? "elevenlabs" : "say";
const MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_v4";
// demo-script.mjs read these before .env was loaded; re-read them here.
const SAY_VOICE = process.env.DEMO_VOICE ?? VOICE;
const SAY_RATE = Number(process.env.DEMO_RATE ?? RATE);

if (ENGINE === "say" && process.platform !== "darwin") {
  console.error(
    "No ELEVENLABS_API_KEY, and `say` needs macOS.\n" +
      "Set the key in .env or synthesise demo/cues.md elsewhere.",
  );
  process.exit(1);
}

await fs.mkdir(VOICE_DIR, { recursive: true });

/**
 * George, a pre-made narrative voice that every plan can use through the API.
 * Voice Library voices return 402 on a free plan, so the default stays
 * pre-made; DEMO_VOICE_ID overrides it. DEMO_VOICE is not consulted here
 * because it names a macOS voice for the `say` fallback.
 */
const GEORGE = "JBFqnCBsd6RMkjVDRZzb";
const voiceId = ENGINE === "elevenlabs" ? (process.env.DEMO_VOICE_ID ?? GEORGE) : null;
// The client reads ELEVENLABS_API_KEY from the environment loaded above.
const client = ENGINE === "elevenlabs" ? new ElevenLabsClient() : null;

/**
 * ElevenLabs returns MP3; ffmpeg converts it to the mono 16-bit WAV the mixer
 * assembles. Requesting PCM at 44.1 kHz is a paid-tier feature, and MP3 is
 * available on every plan.
 *
 * previousText / nextText stitch each clip to its neighbours, so the voice
 * keeps one tone across the whole narration instead of resetting per beat.
 */
async function elevenlabs(i, file) {
  const audio = await client.textToSpeech.convert(voiceId, {
    text: spoken(LINES[i], ENGINE),
    modelId: MODEL,
    outputFormat: "mp3_44100_128",
    previousText: i > 0 ? spoken(LINES[i - 1], ENGINE) : undefined,
    nextText: i < LINES.length - 1 ? spoken(LINES[i + 1], ENGINE) : undefined,
    voiceSettings: { stability: 0.5, similarityBoost: 0.75 },
  });
  const mp3 = file.replace(/\.wav$/, ".mp3");
  await pipeline(Readable.fromWeb(audio), createWriteStream(mp3));
  await run("ffmpeg", ["-y", "-v", "error", "-i", mp3, "-ar", "44100", "-ac", "1", file]);
  await fs.rm(mp3);
}

const durations = {};
let total = 0;
for (const [i, line] of LINES.entries()) {
  const file = path.join(VOICE_DIR, `${line.id}.wav`);
  if (ENGINE === "elevenlabs") await elevenlabs(i, file);
  else
    await run("say", [
      "-v", SAY_VOICE,
      "-r", String(SAY_RATE),
      "-o", file,
      "--data-format=LEI16@22050",
      spoken(line, ENGINE),
    ]);
  const ms = wavDurationMs(await fs.readFile(file));
  durations[line.id] = ms;
  total += ms;
  console.log(`${line.id.padEnd(11)} ${(ms / 1000).toFixed(1)}s`);
}

await fs.writeFile(
  path.join(VOICE_DIR, "durations.json"),
  JSON.stringify(
    { engine: ENGINE, voice: voiceId ?? SAY_VOICE, model: ENGINE === "elevenlabs" ? MODEL : null, durations },
    null,
    2,
  ) + "\n",
);

console.log(
  `\n${LINES.length} clips · ${(total / 1000 / 60).toFixed(1)} min of speech · ${ENGINE}`,
);
console.log(VOICE_DIR);
