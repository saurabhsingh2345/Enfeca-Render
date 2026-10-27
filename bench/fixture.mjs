/**
 * Synthetic render job for local benchmarking — no Studio, no prod assets.
 *
 *   node bench/fixture.mjs <outDir> [--custom-outro]
 *
 * `--broken-recording` points the screen-recording scene at a file that does not
 * exist, to exercise the failure path.
 *
 * Writes the media files and payload.json into <outDir>. `--custom-outro`
 * swaps the brand outro for a 4:3 clip with a course-style filename, which is
 * how a course-level outro override reaches the worker.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.join(here, "..", "engine");
const require = createRequire(path.join(engineDir, "package.json"));
const ffmpeg = require("ffmpeg-static");
const { createCanvas } = require("@napi-rs/canvas");

const HOLD_MS = 2000;
const TRANSITION_MS = 1000;

function ff(args) {
  const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

function png(file, w, h, paint) {
  const c = createCanvas(w, h);
  paint(c.getContext("2d"), w, h);
  fs.writeFileSync(file, c.toBuffer("image/png"));
}

export function buildFixture(outDir, { customOutro = false, brokenRecording = false } = {}) {
  fs.mkdirSync(path.join(outDir, "files"), { recursive: true });
  const files = path.join(outDir, "files");

  // Brand intro and background loop ship with the worker.
  for (const name of ["common-intro.mp4", "bg-loop.mp4"]) {
    const dest = path.join(outDir, name);
    if (!fs.existsSync(dest)) fs.symlinkSync(path.join(engineDir, "public", name), dest);
  }

  // Outro: 16:9 brand-style clip, or a 4:3 course override with its own name.
  const outroName = customOutro ? "files/course-outro-7f3a9c.mp4" : "common-outro.mp4";
  const outroSize = customOutro ? "1440x1080" : "1920x1080";
  const outroFile = path.join(outDir, outroName);
  if (!fs.existsSync(outroFile)) {
    ff(["-f", "lavfi", "-i", `testsrc2=size=${outroSize}:rate=30:duration=6`, "-pix_fmt", "yuv420p", outroFile]);
  }

  const rec = path.join(files, "rec1.mp4");
  if (!fs.existsSync(rec)) {
    ff(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=10", "-pix_fmt", "yuv420p", rec]);
  }

  png(path.join(files, "still.png"), 1536, 1024, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#fde68a");
    g.addColorStop(1, "#93c5fd");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#111827";
    ctx.font = "bold 120px sans-serif";
    ctx.fillText("Still scene", 120, 520);
  });
  for (const [i, color] of ["#ef4444", "#10b981", "#6366f1"].entries()) {
    png(path.join(files, `el${i}.png`), 600, 400, (ctx, w, h) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(20, 20, w - 40, h - 40, 40);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 90px sans-serif";
      ctx.fillText(`Item ${i + 1}`, 140, 230);
    });
  }

  const el = (i, x, y, appearAt, anim) => ({
    id: `el${i}`,
    mediaUrl: `/files/el${i % 3}.png`,
    x,
    y,
    w: 0.28,
    appearAt,
    anim,
  });

  // [scene, speechMs] — windows are speech + hold + slide, like a stitched part.
  const spec = [
    [{ kind: "recording", subtitle: "Intro", mediaUrl: "/common-intro.mp4", recordingUseEmbeddedAudio: true, recordingTrimStartMs: 0, recordingTrimEndMs: 12217 }, 12217],
    [{ kind: "image", elements: [el(0, 0.25, 0.5, 0.05, "pop"), el(1, 0.5, 0.5, 0.35, "slide-up"), el(2, 0.75, 0.5, 0.65, "slide-left")] }, 8000],
    [{ kind: "image", backgroundUrl: "/files/still.png", bgAspect: 1.5 }, 8000],
    [{ kind: "recording", mediaUrl: brokenRecording ? "/files/missing-recording.mp4" : "/files/rec1.mp4", recordingTrimStartMs: 0, recordingTrimEndMs: 10000 }, 10000],
    [{ kind: "question", questionKind: "mcq", questionText: "Which option is the right one?", questionOptions: ["First", "Second", "Third", "Fourth"] }, 6000],
    [{ kind: "code", codeLanguage: "ts", code: "const total = items.reduce((a, b) => a + b, 0);\nconsole.log(total);", codeOutput: "42" }, 8000],
    [{ kind: "image", elements: [el(1, 0.3, 0.45, 0.1, "pop"), el(2, 0.7, 0.55, 0.5, "slide-right")] }, 6000],
    [{ kind: "recording", subtitle: "Outro", mediaUrl: `/${outroName}`, recordingUseEmbeddedAudio: true, recordingTrimStartMs: 0, recordingTrimEndMs: 6000 }, 6000],
  ];

  let cursor = 0;
  const scenes = spec.map(([scene, speechMs], i) => {
    const endMs = cursor + speechMs + HOLD_MS + TRANSITION_MS;
    const out = {
      id: `scene-${i}`,
      durationMs: speechMs,
      startMs: cursor,
      endMs,
      masterAudioUrl: "/files/master.m4a",
      holdMs: HOLD_MS,
      transitionMs: TRANSITION_MS,
      ...scene,
    };
    cursor = endMs;
    return out;
  });

  const master = path.join(files, "master.m4a");
  if (!fs.existsSync(master)) {
    ff(["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${cursor / 1000}`, "-c:a", "aac", "-b:a", "128k", master]);
  }

  const payload = {
    filename: `bench${customOutro ? "-custom-outro" : ""}${brokenRecording ? "-broken" : ""}-1080p.mp4`,
    quality: "hd",
    masterAudioUrl: "/files/master.m4a",
    scenes,
    background: { url: "/bg-loop.mp4" },
    templateTheme: "orange",
  };
  fs.writeFileSync(path.join(outDir, "payload.json"), JSON.stringify(payload, null, 2));
  return { payload, totalMs: cursor };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: node bench/fixture.mjs <outDir> [--custom-outro]");
    process.exit(1);
  }
  const { totalMs } = buildFixture(path.resolve(outDir), {
    customOutro: process.argv.includes("--custom-outro"),
    brokenRecording: process.argv.includes("--broken-recording"),
  });
  console.log(`fixture ready in ${outDir} (${(totalMs / 1000).toFixed(1)}s of video)`);
}
