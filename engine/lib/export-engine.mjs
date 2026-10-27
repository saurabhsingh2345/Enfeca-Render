import { spawn } from "node:child_process";
import os from "node:os";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  cardRect,
  shouldSkipFullBackground,
  paintCanvasScene,
  questionPostVisualMs,
  questionPreMs,
} from "./paint-scene.mjs";
import { resolveTemplateTheme } from "./template-theme.mjs";
import {
  computeTypingSegments,
  TYPING_SFX_VOLUME,
  buildCodeBeatTimeline,
  resolveCodeTypingBeats,
  DEFAULT_CODE_TYPING_CPS,
  DEFAULT_CODE_OUTPUT_HOLD_MS,
} from "./code-typing.mjs";
import {
  detectVideoContentCropFromCanvas,
  isFullFrameCrop,
} from "./video-black-bars.mjs";

/**
 * Load @napi-rs/canvas from app.asar.unpacked when packaged.
 * Electron still resolves the JS from asar, which cannot load .node binaries.
 */
function loadCanvas() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@napi-rs",
        "canvas",
      ),
      path.join(process.resourcesPath, "app", "node_modules", "@napi-rs", "canvas"),
      path.join(process.resourcesPath, "node_modules", "@napi-rs", "canvas"),
    );
  }
  // Dev / npm start / electron .
  try {
    candidates.push(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@napi-rs", "canvas"),
    );
  } catch {
    /* ignore */
  }
  candidates.push("@napi-rs/canvas");
  let lastErr = null;
  for (const c of candidates) {
    try {
      if (c.startsWith("/") && !fs.existsSync(c)) continue;
      return require(c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Cannot load @napi-rs/canvas");
}

let _canvasMod = null;
function canvasMod() {
  if (!_canvasMod) _canvasMod = loadCanvas();
  return _canvasMod;
}
function createCanvas(...args) {
  return canvasMod().createCanvas(...args);
}
function loadImage(...args) {
  return canvasMod().loadImage(...args);
}

function run(cmd, args, onLog) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stdout?.on("data", (d) => onLog?.(String(d)));
    proc.stderr?.on("data", (d) => {
      const s = String(d);
      err += s;
      onLog?.(s);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(-1200)}`));
    });
  });
}

/** Per-job wall-clock totals by step, logged when the encode finishes. */
let timings = new Map();

function addTime(tag, ms) {
  timings.set(tag, (timings.get(tag) || 0) + ms);
}

/** run() that also adds its wall time to the job's timings under `tag`. */
async function timedRun(tag, cmd, args) {
  const t0 = performance.now();
  try {
    await run(cmd, args);
  } finally {
    addTime(tag, performance.now() - t0);
  }
}

/**
 * ENGINE=fast turns on the optimised render paths. Unset, the worker behaves
 * exactly as before, so a Mac can be switched back by clearing one setting.
 */
const FAST_ENGINE = String(process.env.ENGINE || "").toLowerCase() === "fast";

/**
 * Paint frames and stream them to ffmpeg as raw RGBA, instead of saving a PNG
 * per frame and re-reading the folder. PNG encoding was ~70% of a render and
 * runs on one core; raw pixels cost almost nothing and the picture is the same
 * (both are lossless before x264).
 */
async function encodeRawFrames({ ffmpeg, W, H, fps, count, outPath, quality, cfr, tag, frame }) {
  const args = [
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${W}x${H}`,
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
    "-frames:v",
    String(count),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    quality === "hd" ? "20" : "23",
    "-pix_fmt",
    "yuv420p",
  ];
  if (cfr) args.push("-r", String(fps), "-vsync", "cfr");
  args.push("-an", outPath);

  const t0 = performance.now();
  const proc = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => {
    err = (err + String(d)).slice(-1200);
  });
  let stdinError = null;
  proc.stdin.on("error", (e) => {
    stdinError = e;
  });
  const closed = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err}`)),
    );
  });
  // Surface ffmpeg's own error below; don't let it count as unhandled while we paint.
  closed.catch(() => {});
  const ended = closed.then(
    () => undefined,
    () => undefined,
  );

  try {
    for (let i = 0; i < count && !stdinError; i++) {
      const tPaint = performance.now();
      const canvas = await frame(i);
      const pixels = canvas.data();
      const tWrite = performance.now();
      addTime("frames:paint", tWrite - tPaint);
      if (!proc.stdin.write(pixels)) {
        await Promise.race([new Promise((r) => proc.stdin.once("drain", r)), ended]);
      }
      addTime("frames:pipe-write", performance.now() - tWrite);
      addTime("frames:count", 1);
    }
  } finally {
    proc.stdin.end();
  }
  await closed;
  addTime(tag, performance.now() - t0);
}

/** Probe media duration in seconds (ffmpeg stderr). */
async function probeDurationSec(ffmpeg, file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ["-i", file], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stderr?.on("data", (d) => {
      err += String(d);
    });
    proc.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      if (!m) {
        resolve(0);
        return;
      }
      resolve(
        parseInt(m[1], 10) * 3600 +
          parseInt(m[2], 10) * 60 +
          parseFloat(m[3]),
      );
    });
    proc.on("error", () => resolve(0));
  });
}

/** Probe video dimensions from ffmpeg stderr. */
async function probeVideoSize(ffmpeg, file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ["-i", file], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stderr?.on("data", (d) => {
      err += String(d);
    });
    proc.on("close", () => {
      const m = /Video:.*\s(\d{2,5})x(\d{2,5})/.exec(err);
      if (!m) {
        resolve({ w: 0, h: 0 });
        return;
      }
      resolve({ w: parseInt(m[1], 10), h: parseInt(m[2], 10) });
    });
    proc.on("error", () => resolve({ w: 0, h: 0 }));
  });
}

function isFullFrameRecordingCrop(crop, srcW, srcH) {
  return isFullFrameCrop(crop, srcW, srcH);
}

/** Prefer Studio-provided crop when present (cloud parity). */
function resolveRecordingContentCrop(scene) {
  const c = scene?.recordingContentCrop;
  if (!c || typeof c !== "object") return null;
  const w = Math.round(Number(c.w));
  const h = Math.round(Number(c.h));
  const x = Math.round(Number(c.x));
  const y = Math.round(Number(c.y));
  if (w > 0 && h > 0 && x >= 0 && y >= 0) return { w, h, x, y };
  return null;
}

function isScreenRecordingScene(scene) {
  const kind = scene?.kind;
  return kind === "recording" || kind === "recording2";
}

/** Video clip = screen recording with embedded audio (Studio "clip" mode). */
function isVideoClipScene(scene) {
  return (
    scene?.kind === "clip" ||
    (scene?.kind === "recording" &&
      scene.recordingUseEmbeddedAudio === true &&
      scene.recordingVoiceReplace !== true)
  );
}

function isBumperScene(scene) {
  if (/common-intro|common-outro/i.test(String(scene?.mediaUrl || ""))) return true;
  // A course can replace the brand intro/outro with its own upload, which has any
  // filename. Studio still labels those scenes "Intro"/"Outro" (see
  // commonBumperLabelForScene), so go by the label too — otherwise the clip is
  // treated as a screen recording and stretched to fill the card.
  return (
    FAST_ENGINE &&
    (scene?.subtitle === "Intro" || scene?.subtitle === "Outro") &&
    scene?.recordingUseEmbeddedAudio === true
  );
}

/** Auto matte scan disabled — IDE chrome was misread as letterboxing and zoomed clips. */
function shouldDetectMatteCrop(_scene) {
  return false;
}

/** Intro/outro bumpers stay letterboxed. Other recordings match Studio compose (`cameraFit: fill`). */
function shouldStretchFillVideo(scene) {
  return !isBumperScene(scene);
}

/** Expand anamorphic pixels so ffmpeg uses the same display size as the browser. */
function squarePixelVf() {
  return "scale=iw*sar:ih,setsar=1";
}

/** Pick the most frequent stable crop from cropdetect stderr lines. */
function pickStableCropdetect(matches) {
  if (!matches.length) return null;
  const counts = new Map();
  for (const m of matches) {
    const key = `${m[1]},${m[2]},${m[3]},${m[4]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  const [w, h, x, y] = bestKey.split(",").map((n) => parseInt(n, 10));
  return { w, h, x, y };
}

async function detectMatteCropViaCropdetect(ffmpeg, file, ssSec = 0) {
  return new Promise((resolve) => {
    const args = ["-y"];
    if (ssSec > 0) args.push("-ss", String(ssSec));
    args.push("-i", file, "-t", "2", "-vf", "cropdetect=24:2:0", "-f", "null", "-");
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stderr?.on("data", (d) => {
      err += String(d);
    });
    proc.on("close", async () => {
      const matches = [
        ...err.matchAll(/\bw=(\d+)\s+h=(\d+)\s+x=(\d+)\s+y=(\d+)/g),
      ];
      const crop = pickStableCropdetect(matches);
      if (!crop) {
        resolve(null);
        return;
      }
      const { w: srcW, h: srcH } = await probeVideoSize(ffmpeg, file);
      if (srcW > 0 && srcH > 0 && isFullFrameRecordingCrop(crop, srcW, srcH)) {
        resolve(null);
        return;
      }
      resolve(crop);
    });
    proc.on("error", () => resolve(null));
  });
}

/** Canvas matte scan on one frame (matches Studio video-black-bars.ts). */
async function detectMatteCropViaCanvas(ffmpeg, file, ssSec, workDir) {
  const framePath = path.join(workDir, `_matte-${Math.round(ssSec * 1000)}.png`);
  try {
    const args = ["-y"];
    if (ssSec > 0) args.push("-ss", String(ssSec));
    args.push("-i", file, "-frames:v", "1", framePath);
    await run(ffmpeg, args);
    if (!fs.existsSync(framePath) || fs.statSync(framePath).size < 100) return null;

    const { w: srcW, h: srcH } = await probeVideoSize(ffmpeg, file);
    if (srcW < 8 || srcH < 8) return null;

    const img = await loadImage(framePath);
    const maxSide = 320;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const sw = Math.max(8, Math.round(srcW * scale));
    const sh = Math.max(8, Math.round(srcH * scale));
    const canvas = createCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, sw, sh);
    const crop = detectVideoContentCropFromCanvas(canvas, srcW, srcH);
    if (isFullFrameRecordingCrop(crop, srcW, srcH)) return null;
    return crop;
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(framePath);
    } catch {
      /* ignore */
    }
  }
}

/** Detect baked-in black/white mattes before scale (Studio + cropdetect fallback). */
async function detectRecordingContentCrop(ffmpeg, file, ssSec, workDir) {
  const canvasCrop = await detectMatteCropViaCanvas(ffmpeg, file, ssSec, workDir);
  if (canvasCrop) return canvasCrop;
  return detectMatteCropViaCropdetect(ffmpeg, file, ssSec);
}

function buildRecordingScaleVf(innerW, innerH, fps, useContain, crop) {
  const cropVf = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "";
  const square = `${cropVf}${squarePixelVf()}`;
  if (useContain) {
    return `${square},scale=${innerW}:${innerH}:force_original_aspect_ratio=decrease,format=rgba,pad=${innerW}:${innerH}:(ow-iw)/2:(oh-ih)/2:black@0,setsar=1,fps=${fps}`;
  }
  return `${square},scale=${innerW}:${innerH},setsar=1,fps=${fps}`;
}

function msToFrame(ms, fps) {
  return Math.round((Math.max(0, Number(ms) || 0) / 1000) * fps);
}

/** Frame count for a scene window, quantized to the master clock (not round(duration)*fps). */
function sceneFrameCount(scene, fps) {
  if (scene.startMs != null && scene.endMs != null && scene.endMs > scene.startMs) {
    return Math.max(1, msToFrame(scene.endMs, fps) - msToFrame(scene.startMs, fps));
  }
  return Math.max(1, Math.round((sceneDurationMs(scene) / 1000) * fps));
}

/**
 * Freeze-pad (or trim) a video to an exact CFR frame count.
 * Using -t seconds let container rounding drift ~1 frame per scene and desync A/V.
 */
async function fitVideoToFrames(ffmpeg, inPath, outPath, frames, fps, quality) {
  const n = Math.max(1, Math.round(frames));
  await timedRun("ffmpeg:fit", ffmpeg, [
    "-y",
    "-i",
    inPath,
    "-vf",
    `fps=${fps},format=yuv420p,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=30`,
    "-frames:v",
    String(n),
    "-r",
    String(fps),
    "-vsync",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    quality === "hd" ? "20" : "23",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outPath,
  ]);
}

async function fitVideoToWindow(ffmpeg, inPath, outPath, targetSec, fps, quality) {
  const frames = Math.max(1, Math.round(targetSec * fps));
  await fitVideoToFrames(ffmpeg, inPath, outPath, frames, fps, quality);
}

export function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  try {
    let p = createRequire(import.meta.url)("ffmpeg-static");
    if (typeof p === "string" && p.includes("app.asar")) {
      p = p.replace("app.asar", "app.asar.unpacked");
    }
    if (typeof p === "string" && fs.existsSync(p)) return p;
  } catch {
    /* optional */
  }
  return "ffmpeg";
}

export function exportSize(quality) {
  return quality === "hd"
    ? { w: 1920, h: 1080, fps: 30 }
    : { w: 1280, h: 720, fps: 30 };
}

const PREFETCH_AHEAD = 3;
const PREFETCH_CONCURRENCY = 2;

function fileReady(dest) {
  try {
    return Boolean(dest) && fs.existsSync(dest) && fs.statSync(dest).size > 1000;
  } catch {
    return false;
  }
}

function collectSceneDownloads(scene, index, workDir, studioUrl) {
  const jobs = [];
  const add = (url, dest) => {
    if (!url || !dest) return;
    if (!/^https?:\/\//i.test(url) && !String(url).startsWith("data:")) return;
    jobs.push({ url, dest });
  };

  try {
    const mediaUrl = resolveAssetUrl(scene?.mediaUrl, studioUrl);
    if (isVideoScene(scene) && mediaUrl) {
      add(mediaUrl, path.join(workDir, `src-v-${index}${extFromUrl(mediaUrl, ".mp4")}`));
    }
  } catch {
    /* resolve errors are handled when the scene encodes */
  }

  const skipFullBackground = shouldSkipFullBackground(scene);
  try {
    const still = resolveAssetUrl(
      skipFullBackground
        ? null
        : scene?.backgroundUrl || (scene?.revealCovers?.length ? scene.backgroundUrl : null) || null,
      studioUrl,
    );
    if (still) add(still, path.join(workDir, `still-${index}${extFromUrl(still, ".png")}`));
  } catch {
    /* skip */
  }

  if (!skipFullBackground && scene?.revealCovers?.length && scene.backgroundUrl) {
    try {
      const u = resolveAssetUrl(scene.backgroundUrl, studioUrl);
      if (u) add(u, path.join(workDir, `cover-bg-${index}${extFromUrl(u, ".png")}`));
    } catch {
      /* skip */
    }
  }

  for (const el of scene?.elements || []) {
    if (!el?.id || !el.mediaUrl) continue;
    try {
      const u = resolveAssetUrl(el.mediaUrl, studioUrl);
      if (!u) continue;
      add(u, path.join(workDir, `el-${index}-${el.id}${extFromUrl(u, ".png")}`));
    } catch {
      /* skip */
    }
  }
  return jobs;
}

function sceneDownloadsReady(jobs) {
  return jobs.every((j) => fileReady(j.dest));
}

function createAssetPrefetch({ authToken, concurrency = PREFETCH_CONCURRENCY, isCancelled } = {}) {
  /** @type {Map<string, Promise<string>>} */
  const inflight = new Map();
  const queue = [];
  let active = 0;
  let stopped = false;

  function cancelled() {
    return stopped || Boolean(isCancelled?.());
  }

  function pump() {
    while (active < concurrency && queue.length) {
      if (cancelled()) {
        while (queue.length) {
          const item = queue.shift();
          inflight.delete(item.dest);
          item.resolve(item.dest);
        }
        return;
      }
      const item = queue.shift();
      if (fileReady(item.dest)) {
        inflight.delete(item.dest);
        item.resolve(item.dest);
        continue;
      }
      active += 1;
      fetchToFile(item.url, item.dest, authToken)
        .then((dest) => {
          inflight.delete(item.dest);
          item.resolve(dest);
        })
        .catch((err) => {
          inflight.delete(item.dest);
          item.reject(err);
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  function enqueue(url, dest) {
    if (!url || !dest) return Promise.resolve(dest);
    if (fileReady(dest) || cancelled()) return Promise.resolve(dest);
    const existing = inflight.get(dest);
    if (existing) return existing;
    const p = new Promise((resolve, reject) => {
      queue.push({ url, dest, resolve, reject });
    });
    inflight.set(dest, p);
    pump();
    return p;
  }

  return {
    enqueue,
    prefetchAhead(scenes, fromIndex, workDir, studioUrl, ahead = PREFETCH_AHEAD) {
      if (cancelled()) return;
      const end = Math.min(scenes.length, Math.max(0, fromIndex) + ahead);
      for (let i = Math.max(0, fromIndex); i < end; i++) {
        for (const job of collectSceneDownloads(scenes[i], i, workDir, studioUrl)) {
          enqueue(job.url, job.dest).catch((e) => {
            if (!cancelled()) {
              console.warn("[agent] prefetch", path.basename(job.dest), e.message || e);
            }
          });
        }
      }
    },
    async waitForScene(scene, index, workDir, studioUrl) {
      const jobs = collectSceneDownloads(scene, index, workDir, studioUrl);
      if (!jobs.length) return;
      await Promise.all(
        jobs.map((job) =>
          enqueue(job.url, job.dest).catch((e) => {
            if (!cancelled()) {
              console.warn("[agent] prefetch wait", path.basename(job.dest), e.message || e);
            }
          }),
        ),
      );
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
}

function extFromUrl(url, fallback) {
  try {
    const u = /^https?:\/\//i.test(url) ? new URL(url) : new URL(url, "http://local");
    return path.extname(u.pathname) || fallback;
  } catch {
    return fallback;
  }
}

function sceneDurationMs(scene) {
  if (scene.startMs != null && scene.endMs != null && scene.endMs > scene.startMs) {
    return Math.max(200, scene.endMs - scene.startMs);
  }
  if (scene.durationMs != null && scene.durationMs > 0) return scene.durationMs;
  return 4000;
}

function totalTimelineMs(scenes) {
  if (!scenes?.length) return 3000;
  const last = scenes[scenes.length - 1];
  if (
    scenes.every((s) => s.startMs != null && s.endMs != null) &&
    last.endMs != null
  ) {
    return Math.max(1000, last.endMs);
  }
  return scenes.reduce((acc, s) => acc + sceneDurationMs(s), 0);
}

/** Default stitch gap: 2s hold then 1s slide (matches Studio part-transition). */
const DEFAULT_HOLD_MS = 2000;
const DEFAULT_TRANSITION_MS = 1000;

/** Hold after speech before slide — from stitch transition box / scene.holdMs. */
function sceneHoldMs(scene) {
  if (!scene) return DEFAULT_HOLD_MS;
  if (scene.kind === "question") return questionPostVisualMs(scene);
  if (scene.holdMs != null && scene.holdMs >= 0) return scene.holdMs;
  if (scene.outTransition?.holdMs != null && scene.outTransition.holdMs >= 0) {
    return scene.outTransition.holdMs;
  }
  return DEFAULT_HOLD_MS;
}

/** Right-to-left slide duration — from stitch transition box / scene.transitionMs. */
function sceneTransitionMs(scene) {
  if (!scene) return DEFAULT_TRANSITION_MS;
  const raw =
    scene.transitionMs ??
    scene.outTransition?.durationMs ??
    DEFAULT_TRANSITION_MS;
  return Math.max(100, Math.min(3000, Math.round(raw)));
}

/** @deprecated use sceneTransitionMs — kept for call sites expecting gap slide only */
function transitionAfterMs(scene) {
  return sceneTransitionMs(scene);
}

function isVideoScene(scene) {
  const kind = scene?.kind;
  return (
    kind === "recording" ||
    kind === "recording2" ||
    kind === "clip" ||
    kind === "video" ||
    Boolean(scene?.mediaUrl && /\.(mp4|webm|mov)(\?|$)/i.test(String(scene.mediaUrl)))
  );
}

function coverVf(w, h, fps) {
  return `${squarePixelVf()},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps}`;
}

function containVf(w, h, fps) {
  // Transparent pad so orange bg shows in letterbox (not white).
  return `${squarePixelVf()},scale=${w}:${h}:force_original_aspect_ratio=decrease,format=rgba,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black@0,setsar=1,fps=${fps}`;
}

function isCodeTypingScene(scene) {
  return (
    scene?.kind === "code" ||
    (scene?.kind === "template" && scene?.templateKind === "codeTyping")
  );
}

function codeBeatTotalMs(scene) {
  if (!isCodeTypingScene(scene)) return 0;
  const cps = scene.codeTypingCps ?? DEFAULT_CODE_TYPING_CPS;
  const beats = resolveCodeTypingBeats({
    beats: scene.codeTypingBeats,
    code: scene.code || scene.codingStarterCode || "",
    output: scene.codeOutput,
    runDelayMs: scene.codeRunDelayMs,
    outputHoldMs: scene.codeOutputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS,
  });
  if (!beats.length) return 0;
  return buildCodeBeatTimeline(beats, cps).totalMs;
}

/** Spoken clip length inside a master window — matches Studio revealSpeechDurationMs. */
function revealSpeechMs(scene) {
  if (scene.kind === "template" && scene.templateKind === "countdown") {
    return Math.max(1000, Math.round((scene.templateCountdownSec ?? 5) * 1000));
  }

  let base = 0;
  if (scene.durationMs && scene.durationMs > 0) {
    base = scene.durationMs;
  } else if (
    scene.startMs != null &&
    scene.endMs != null &&
    scene.endMs > scene.startMs
  ) {
    const windowMs = scene.endMs - scene.startMs;
    if (scene.masterAudioUrl) {
      // Window = speech + hold(2s default) + transition(1s default).
      const hold = sceneHoldMs(scene);
      const transition = sceneTransitionMs(scene);
      base = Math.max(0, windowMs - hold - transition);
    } else {
      base = windowMs;
    }
  } else {
    base = sceneDurationMs(scene);
  }

  if (scene.kind === "question" && scene.durationMs && scene.durationMs > 0) {
    return Math.max(400, scene.durationMs);
  }

  // Code typing must cover full type → Run → output steps.
  if (isCodeTypingScene(scene)) {
    return Math.max(400, base, codeBeatTotalMs(scene));
  }
  return Math.max(200, base);
}

async function bakeBgLoopFrames(ffmpeg, bgFile, W, H, workDir, fps, lazy = false) {
  const framesDir = path.join(workDir, "bg-loop-frames");
  const sampleFps = Math.min(15, fps);

  const ensureFramesDir = () => fs.mkdirSync(framesDir, { recursive: true });

  // Prefer already-baked JPEG frames.
  ensureFramesDir();
  const existing = fs
    .readdirSync(framesDir)
    .filter((n) => /^f\d+\.(png|jpg)$/i.test(n))
    .sort();
  const hasJpg = existing.some((n) => /\.jpg$/i.test(n));
  const hasPng = existing.some((n) => /\.png$/i.test(n));

  if (hasJpg) {
    if (lazy) {
      const jpgs = existing.filter((n) => /\.jpg$/i.test(n));
      return { files: jpgs.map((f) => path.join(framesDir, f)), fps: sampleFps };
    }
    const imgs = [];
    for (const f of existing.filter((n) => /\.jpg$/i.test(n))) {
      imgs.push(await loadImage(path.join(framesDir, f)));
    }
    return { imgs, fps: sampleFps };
  }

  // If only PNG exists (from an older version), remove it so we don't hit
  // the PNG decode SIGTRAP path on resume.
  if (hasPng) {
    fs.rmSync(framesDir, { recursive: true, force: true });
    ensureFramesDir();
  }

  if (bgFile && fs.existsSync(bgFile)) {
    await timedRun("ffmpeg:bg-loop-bake", ffmpeg, [
      "-y",
      "-i",
      bgFile,
      "-vf",
      `fps=${sampleFps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
      "-q:v",
      "2",
      path.join(framesDir, "f%04d.jpg"),
    ]);
  } else {
    // Solid orange fallback still (no motion) — write JPEG so decoding stays stable.
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#E8A35C";
    ctx.fillRect(0, 0, W, H);
    fs.writeFileSync(path.join(framesDir, "f0001.jpg"), canvas.toBuffer("image/jpeg"));
  }

  const files = fs
    .readdirSync(framesDir)
    .filter((n) => /^f\d+\.(png|jpg)$/i.test(n))
    .sort();

  if (!files.length) throw new Error("Failed to bake orange bg-loop frames");

  const imgs = [];
  // Prefer JPEG decode order.
  const ordered = files.filter((n) => /\.jpg$/i.test(n)).length
    ? files.filter((n) => /\.jpg$/i.test(n))
    : files;
  if (lazy) {
    return { files: ordered.map((f) => path.join(framesDir, f)), fps: sampleFps };
  }
  for (const f of ordered) {
    // loadImage handles both jpg/png; for the fallback we wrote png.
    imgs.push(await loadImage(path.join(framesDir, f)));
  }
  return { imgs, fps: sampleFps };
}

/**
 * Background loop that decodes a frame only when it is drawn. Decoding all ~280
 * frames up front held ~2.2 GB of RAM for the whole job; a scene walks the loop
 * in order, so a handful of cached frames is enough.
 */
function makeLazyBgLoop({ files, fps }, keep = 6) {
  const cache = new Map();
  return {
    fps,
    count: files.length,
    async frameAt(idx) {
      const hit = cache.get(idx);
      if (hit) return hit;
      const img = await loadImage(files[idx]);
      cache.set(idx, img);
      if (cache.size > keep) cache.delete(cache.keys().next().value);
      return img;
    },
  };
}

/** How many scenes render at once under ENGINE=fast (override: RENDER_SCENE_CONCURRENCY). */
function sceneConcurrency() {
  const forced = Number(process.env.RENDER_SCENE_CONCURRENCY);
  if (Number.isFinite(forced) && forced >= 1) return Math.floor(forced);
  return Math.min(6, Math.max(2, Math.floor(os.cpus().length / 2)));
}

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/** Threads still running, so a failed job can stop them instead of leaving them painting. */
const activeThreads = new Set();

function runOverlayInThread(task) {
  return new Promise((resolve, reject) => {
    const thread = new Worker(new URL("./overlay-worker.mjs", import.meta.url), {
      workerData: task,
    });
    activeThreads.add(thread);
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    thread.once("message", (msg) => {
      if (!msg?.ok) return settle(reject, new Error(msg?.error || "overlay worker failed"));
      for (const [k, v] of Object.entries(msg.timings || {})) addTime(k, v);
      settle(resolve);
    });
    thread.once("error", (e) => settle(reject, e));
    thread.once("exit", (code) => {
      activeThreads.delete(thread);
      settle(reject, new Error(`overlay worker exited early (${code})`));
    });
  });
}

/** Runs inside a worker thread: load this scene's files, paint, encode. */
export async function runOverlayTask(task) {
  timings = new Map();
  const assets = { elementImgs: new Map() };
  if (task.assets.bgImg) {
    try {
      assets.bgImg = await loadImage(task.assets.bgImg);
    } catch (e) {
      console.warn("[agent] scene still", e);
    }
  }
  for (const el of task.assets.elements) {
    try {
      assets.elementImgs.set(el.id, await loadImage(el.path));
    } catch (e) {
      console.warn("[agent] element skip", el.id, e);
    }
  }
  await encodeOverlayFrames({
    ffmpeg: task.ffmpeg,
    scene: task.scene,
    W: task.W,
    H: task.H,
    fps: task.fps,
    durSec: task.durSec,
    workDir: task.workDir,
    index: task.index,
    assets,
    bgLoop: makeLazyBgLoop(task.bgLoop),
    outSeg: task.outSeg,
    quality: task.quality,
    templateTheme: task.templateTheme,
  });
  return Object.fromEntries(timings);
}

function pinStudioPath(pathname, origin) {
  const path = pathname.startsWith("/api/assets/")
    ? `/api/public/assets/${pathname.slice("/api/assets/".length)}`
    : pathname;
  return `${String(origin).replace(/\/$/, "")}${path}`;
}

function resolveAssetUrl(url, studioUrl) {
  if (!url) return url;
  if (String(url).startsWith("data:")) return url;
  if (url.startsWith("blob:")) {
    throw new Error(
      `Blob URL cannot be fetched by the agent. Re-save the part in Studio so media is stored under /api/assets.`,
    );
  }
  const origin = studioUrl ? String(studioUrl).replace(/\/$/, "") : "";
  if (!origin) return url;
  if (url.startsWith("/api/assets/")) return pinStudioPath(url, origin);
  if (url.startsWith("/api/public/assets/")) return `${origin}${url}`;
  if (url.startsWith("/") && !url.startsWith("//")) return `${origin}${url}`;
  if (!/^https?:\/\//i.test(url)) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    return url;
  }
  const staleHost =
    parsed.host !== originHost &&
    (/\/api\/(public\/)?assets\//i.test(parsed.pathname) ||
      parsed.host === "divstudio.enfeca.com" ||
      parsed.host === "divstudio.lovable.app" ||
      /\.lovableproject\.com$/i.test(parsed.host));
  if (!staleHost) return url;
  return `${pinStudioPath(parsed.pathname, origin)}${parsed.search}`;
}

async function fetchToFile(url, dest, authToken, { retries = 3 } = {}) {
  authToken = authToken || process.env.RENDER_API_KEY || "";
  if (fileReady(dest)) return dest;
  if (String(url).startsWith("data:")) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(String(url));
    if (!m) throw new Error("Invalid data URL");
    const buf = m[2]
      ? Buffer.from(m[3], "base64")
      : Buffer.from(decodeURIComponent(m[3]), "utf8");
    fs.writeFileSync(dest, buf);
    return dest;
  }

  const rawUrl = String(url);
  // Any Studio HTTPS path (assets OR public files like /common-intro.mp4).
  const pathMatch = (() => {
    const m = rawUrl.match(/^https?:\/\/[^/]+(\/.*)$/i);
    return m?.[1] ?? (rawUrl.startsWith("/") ? rawUrl : null);
  })();
  const isDeskos = /deskos\.app/i.test(rawUrl);

  function renderAuthHeaders() {
    if (!authToken) return {};
    return {
      Authorization: `Bearer ${authToken}`,
      "x-render-key": authToken,
    };
  }

  /** Lovable public asset routes accept ?key= as well as Bearer (matches Cloud Render studioFetch). */
  function assetDownloadTargets(targetUrl) {
    const base = String(targetUrl);
    const out = [base];
    if (authToken && /\/api\/public\//i.test(base) && !/[?&]key=/i.test(base)) {
      out.push(`${base}${base.includes("?") ? "&" : "?"}key=${encodeURIComponent(authToken)}`);
    }
    if (/\/api\/public\/assets\//i.test(base)) {
      const privateUrl = base.replace("/api/public/assets/", "/api/assets/");
      out.push(privateUrl);
      if (authToken && !/[?&]key=/i.test(privateUrl)) {
        out.push(
          `${privateUrl}${privateUrl.includes("?") ? "&" : "?"}key=${encodeURIComponent(authToken)}`,
        );
      }
    }
    return [...new Set(out)];
  }

  async function writeResponseBody(res, outPath) {
    const tmp = `${outPath}.part`;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    try {
      if (res.body) {
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      } else {
        fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      }
      fs.renameSync(tmp, outPath);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  async function tryDownload(targetUrl, timeoutMs = 10 * 60 * 1000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let url = String(targetUrl);
      let headers = renderAuthHeaders();
      for (let hop = 0; hop < 8; hop++) {
        const res = await fetch(url, {
          headers,
          redirect: "manual",
          signal: ctrl.signal,
        });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const loc = res.headers.get("location");
          if (!loc) {
            throw new Error(`HTTP ${res.status} redirect without Location for ${url.slice(0, 140)}`);
          }
          url = new URL(loc, url).href;
          headers = {};
          continue;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} for ${url.slice(0, 140)}`);
        }
        await writeResponseBody(res, dest);
        return dest;
      }
      throw new Error(`Too many redirects for ${String(targetUrl).slice(0, 140)}`);
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
      if (cause && e instanceof Error && !e.message.includes(cause)) {
        throw new Error(`${e.message} (${cause})`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function tryCurlDownload(targetUrl, timeoutSec = 600) {
    const tmp = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const args = [
      "-fsSL",
      "--max-time",
      String(timeoutSec),
      "-o",
      tmp,
    ];
    if (authToken) {
      args.push("-H", `Authorization: Bearer ${authToken}`, "-H", `x-render-key: ${authToken}`);
    }
    args.push(String(targetUrl));
    await new Promise((resolve, reject) => {
      const proc = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      proc.stderr?.on("data", (d) => {
        err += String(d);
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`curl failed (${code}): ${err.slice(-400)}`));
      });
    });
    fs.renameSync(tmp, dest);
    return dest;
  }

  async function tryLocalStudioFallback() {
    if (!pathMatch) return null;
    // Prefer LAN-stable (8080) then do-deploy (8081) then deskos proxy (3000).
    for (const p of [8080, 8081, 3000]) {
      try {
        return await tryDownload(`http://127.0.0.1:${p}${pathMatch}`, 30 * 1000);
      } catch {
        /* try next */
      }
    }
    // Bumpers bundled with the agent (common-intro.mp4, bg-loop.mp4, …).
    const baseName = path.basename(pathMatch.split("?")[0] || "");
    if (baseName) {
      const localFile = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "public",
        baseName,
      );
      try {
        if (fs.existsSync(localFile) && fs.statSync(localFile).size > 1000) {
          fs.copyFileSync(localFile, dest);
          return dest;
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  // On deskos URLs, try local Studio first — the Cloudflare tunnel is flaky for large MP4s.
  if (isDeskos || (pathMatch && /^\/(common-|bg-loop)/i.test(pathMatch))) {
    const local = await tryLocalStudioFallback();
    if (local) return local;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    for (const targetUrl of assetDownloadTargets(rawUrl)) {
      try {
        return await tryDownload(targetUrl);
      } catch (e) {
        lastErr = e;
      }
      if (/^https?:\/\//i.test(targetUrl)) {
        try {
          return await tryCurlDownload(targetUrl);
        } catch (curlErr) {
          lastErr = curlErr;
        }
      }
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }

    const local = await tryLocalStudioFallback();
    if (local) return local;

    const msg =
      lastErr instanceof Error ? lastErr.message : String(lastErr || "unknown");
    const hint = /localhost|127\.0\.0\.1/i.test(rawUrl)
      ? " Use Studio via the desk Mac LAN IP (not localhost) when the agent runs on another Mac."
      : "";
    throw new Error(
      `Download failed (${msg}): ${rawUrl.slice(0, 160)}.${hint}`,
    );
  }
  throw lastErr ?? new Error("Download failed");
}

async function makeBgSegment(ffmpeg, bgFile, W, H, fps, frames, outPath, quality) {
  const n = Math.max(1, Math.round(frames));
  const durSec = n / fps;
  if (bgFile && fs.existsSync(bgFile)) {
    await timedRun("ffmpeg:bg-segment", ffmpeg, [
      "-y",
      "-stream_loop",
      "-1",
      "-i",
      bgFile,
      "-vf",
      coverVf(W, H, fps),
      "-frames:v",
      String(n),
      "-r",
      String(fps),
      "-vsync",
      "cfr",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      quality === "hd" ? "20" : "26",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ]);
    return;
  }
  await timedRun("ffmpeg:bg-segment", ffmpeg, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0xE8A35C:s=${W}x${H}:d=${durSec}:r=${fps}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-frames:v",
    String(n),
    "-r",
    String(fps),
    "-vsync",
    "cfr",
    outPath,
  ]);
}

function compositeSlideCanvas(createCanvas, fromCanvas, toCanvas, W, H, slideT) {
  const slide = slideOffset(slideT);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#E8A35C";
  ctx.fillRect(0, 0, W, H);
  const fromX = Math.round(-slide * W);
  const toX = Math.round((1 - slide) * W);
  ctx.drawImage(fromCanvas, fromX, 0, W, H);
  ctx.drawImage(toCanvas, toX, 0, W, H);
  return canvas;
}

async function paintSceneAtElapsed(
  createCanvas,
  scene,
  W,
  H,
  sceneElapsed,
  speechMs,
  assets,
  bgLoop,
  templateTheme,
) {
  const speechT01 = Math.min(1, sceneElapsed / Math.max(1, speechMs));
  const bgCount = bgLoop?.count ?? bgLoop?.imgs?.length ?? 0;
  const bgIdx =
    bgCount > 0 ? Math.floor(((sceneElapsed / 1000) * (bgLoop.fps || 15)) % bgCount) : 0;
  const bgLoopFrame = bgLoop?.frameAt
    ? bgCount > 0
      ? await bgLoop.frameAt(bgIdx)
      : null
    : bgLoop?.imgs?.[bgIdx] || null;
  const theme = resolveTemplateTheme(scene, templateTheme);
  return paintCanvasScene(
    createCanvas,
    scene,
    W,
    H,
    speechT01,
    {
      ...assets,
      bgLoopFrame,
    },
    speechMs,
    { sceneElapsedMs: sceneElapsed, speechMs, templateTheme: theme },
  );
}

async function encodeOverlayFrames({
  ffmpeg,
  scene,
  W,
  H,
  fps,
  durSec,
  workDir,
  index,
  assets,
  bgLoop,
  outSeg,
  quality,
  templateTheme,
}) {
  const sampleFps = fps;
  const speechMs = revealSpeechMs(scene);
  // Paint on the output clock (i/fps), not i/(n-1), so hold/slide stay after speech.
  const n = Math.max(2, Math.round(durSec * sampleFps));
  if (FAST_ENGINE) {
    await encodeRawFrames({
      ffmpeg,
      W,
      H,
      fps,
      count: n,
      outPath: outSeg,
      quality,
      cfr: true,
      tag: "step:overlay-frames+encode",
      frame: (i) =>
        paintSceneAtElapsed(
          createCanvas,
          scene,
          W,
          H,
          (i / sampleFps) * 1000,
          speechMs,
          assets,
          bgLoop,
          templateTheme,
        ),
    });
    return;
  }
  const framesDir = path.join(workDir, `frames-${index}`);
  fs.mkdirSync(framesDir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const sceneElapsed = (i / sampleFps) * 1000;
    const tPaint = performance.now();
    const canvas = await paintSceneAtElapsed(
      createCanvas,
      scene,
      W,
      H,
      sceneElapsed,
      speechMs,
      assets,
      bgLoop,
      templateTheme,
    );
    const tPng = performance.now();
    const pngBytes = canvas.toBuffer("image/png");
    const tWrite = performance.now();
    fs.writeFileSync(
      path.join(framesDir, `f-${String(i).padStart(5, "0")}.png`),
      pngBytes,
    );
    addTime("frames:paint", tPng - tPaint);
    addTime("frames:png-encode", tWrite - tPng);
    addTime("frames:png-write", performance.now() - tWrite);
    addTime("frames:count", 1);
  }

  await timedRun("ffmpeg:overlay-encode", ffmpeg, [
    "-y",
    "-framerate",
    String(sampleFps),
    "-i",
    path.join(framesDir, "f-%05d.png"),
    "-frames:v",
    String(n),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    quality === "hd" ? "20" : "23",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-vsync",
    "cfr",
    "-an",
    outSeg,
  ]);
}

function questionMarkGapMs(scene) {
  if (scene?.kind !== "question") return 0;
  return scene.questionMarkGapMs ?? 2000;
}

/**
 * Studio layers mark VO on export (not in the stitched master).
 * start = sceneStart + intro/pre + question speech + mark gap.
 */
function computeMarkAudioClips(scenes) {
  const clips = [];
  for (const scene of scenes) {
    if (scene?.kind !== "question" || !scene.questionMarkAudioUrl) continue;
    const base = scene.startMs ?? 0;
    const pre = questionPreMs(scene);
    const speech = revealSpeechMs(scene);
    const gap = questionMarkGapMs(scene);
    clips.push({
      startMs: base + pre + speech + gap,
      url: scene.questionMarkAudioUrl,
    });
  }
  return clips;
}

/**
 * Mix one-shot clips + looping typing ranges onto master narration.
 * Matches Studio export-audio-mix for mark VO + typing SFX.
 */
async function mixOverlayAudio({
  ffmpeg,
  masterPath,
  workDir,
  scenes,
  studioUrl,
  authToken,
  onProgress,
}) {
  const markClips = computeMarkAudioClips(scenes);
  const typingSegs = computeTypingSegments(scenes).filter(
    (s) => s.endMs > s.startMs + 40,
  );

  if (!markClips.length && !typingSegs.length) return masterPath;

  onProgress?.("mixing mark VO / typing SFX…", 0.91);

  const inputs = ["-i", masterPath];
  const filters = [];
  const mixLabels = ["[0:a]"];
  let inputIdx = 1;

  for (let i = 0; i < markClips.length; i++) {
    const clip = markClips[i];
    const url = resolveAssetUrl(clip.url, studioUrl);
    if (!url || (!/^https?:\/\//i.test(url) && !url.startsWith("data:"))) {
      console.warn("[agent] skip mark audio (bad url)", clip.url);
      continue;
    }
    const dest = path.join(workDir, `mark-vo-${i}${extFromUrl(url, ".mp3")}`);
    try {
      await fetchToFile(url, dest, authToken);
    } catch (e) {
      console.warn("[agent] mark VO download failed", e);
      continue;
    }
    inputs.push("-i", dest);
    const delay = Math.max(0, Math.round(clip.startMs));
    // One-shot mark VO delayed onto master timeline.
    filters.push(
      `[${inputIdx}:a]asetpts=PTS-STARTPTS,adelay=${delay}|${delay},volume=1[m${i}]`,
    );
    mixLabels.push(`[m${i}]`);
    inputIdx += 1;
  }

  if (typingSegs.length > 0) {
    const typingSrc = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "public",
      "sfx",
      "typing-keyboard.mp3",
    );
    const studioTyping = studioUrl
      ? resolveAssetUrl("/sfx/typing-keyboard.mp3", studioUrl)
      : null;
    let typingFile = typingSrc;
    if (!fs.existsSync(typingFile) && studioTyping && /^https?:\/\//i.test(studioTyping)) {
      typingFile = path.join(workDir, "typing-keyboard.mp3");
      try {
        await fetchToFile(studioTyping, typingFile, authToken);
      } catch (e) {
        console.warn("[agent] typing sfx download failed", e);
        typingFile = null;
      }
    }
    if (typingFile && fs.existsSync(typingFile)) {
      inputs.push("-i", typingFile);
      const typingInput = inputIdx;
      inputIdx += 1;
      typingSegs.forEach((seg, i) => {
        const dur = Math.max(0.05, (seg.endMs - seg.startMs) / 1000);
        const delay = Math.max(0, Math.round(seg.startMs));
        filters.push(
          `[${typingInput}:a]volume=${TYPING_SFX_VOLUME},aloop=loop=-1:size=2e+09,atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delay}|${delay}[t${i}]`,
        );
        mixLabels.push(`[t${i}]`);
      });
    }
  }

  if (mixLabels.length === 1) return masterPath;

  const mixed = path.join(workDir, "audio-mixed.m4a");
  filters.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[aout]`,
  );
  await timedRun("ffmpeg:audio-mix", ffmpeg, [
    "-y",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    mixed,
  ]);
  return mixed;
}

function slideOffset(t) {
  const p = Math.min(1, Math.max(0, t));
  // Ease in-out (matches Studio scene-transition.slideOffset)
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

async function extractFramePng(ffmpeg, videoPath, destPng, { fromEnd = false } = {}) {
  const args = fromEnd
    ? ["-y", "-sseof", "-0.04", "-i", videoPath, "-frames:v", "1", "-q:v", "2", destPng]
    : ["-y", "-i", videoPath, "-frames:v", "1", "-q:v", "2", destPng];
  await timedRun("ffmpeg:slide-extract-frame", ffmpeg, args);
}

/**
 * Replace the last transitionMs of a segment with slide-left into the next
 * segment's first frame. Integer frame counts keep window length exact so
 * hold (default 2s) + transition (default 1s) stay aligned with master audio.
 */
async function applySegmentSlide({
  ffmpeg,
  fromSeg,
  toSeg,
  durSec,
  transitionMs,
  workDir,
  index,
  W,
  H,
  fps,
  quality,
}) {
  const transMs = Math.max(100, Math.min(3000, transitionMs || DEFAULT_TRANSITION_MS));
  const tSec = Math.min(transMs / 1000, Math.max(0.05, durSec - 0.2));
  if (tSec < 0.08) return fromSeg;

  const totalFrames = Math.max(2, Math.round(durSec * fps));
  const slideFrames = Math.max(1, Math.round(tSec * fps));
  const trimFrames = Math.max(1, totalFrames - slideFrames);

  const fromPng = path.join(workDir, `slide-from-${index}.png`);
  const toPng = path.join(workDir, `slide-to-${index}.png`);
  await extractFramePng(ffmpeg, fromSeg, fromPng, { fromEnd: true });
  await extractFramePng(ffmpeg, toSeg, toPng, { fromEnd: false });
  const fromImg = await loadImage(fromPng);
  const toImg = await loadImage(toPng);

  const slideMp4 = path.join(workDir, `slide-${index}.mp4`);
  if (FAST_ENGINE) {
    await encodeRawFrames({
      ffmpeg,
      W,
      H,
      fps,
      count: slideFrames,
      outPath: slideMp4,
      quality,
      cfr: false,
      tag: "step:slide-frames+encode",
      frame: (f) =>
        compositeSlideCanvas(
          createCanvas,
          fromImg,
          toImg,
          W,
          H,
          slideFrames <= 1 ? 1 : f / (slideFrames - 1),
        ),
    });
  } else {
    const framesDir = path.join(workDir, `slide-frames-${index}`);
    fs.mkdirSync(framesDir, { recursive: true });
    for (let f = 0; f < slideFrames; f++) {
      const slideT = slideFrames <= 1 ? 1 : f / (slideFrames - 1);
      const canvas = compositeSlideCanvas(createCanvas, fromImg, toImg, W, H, slideT);
      fs.writeFileSync(
        path.join(framesDir, `f-${String(f).padStart(5, "0")}.png`),
        canvas.toBuffer("image/png"),
      );
    }

    await timedRun("ffmpeg:slide-encode", ffmpeg, [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(framesDir, "f-%05d.png"),
      "-frames:v",
      String(slideFrames),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      quality === "hd" ? "20" : "23",
      "-pix_fmt",
      "yuv420p",
      "-an",
      slideMp4,
    ]);
  }

  const trimMp4 = path.join(workDir, `trim-${index}.mp4`);
  // Keep the hold portion (speech + 2s wait); only the last 1s becomes the slide.
  await timedRun("ffmpeg:slide-trim", ffmpeg, [
    "-y",
    "-i",
    fromSeg,
    "-vf",
    `fps=${fps},select='lt(n\\,${trimFrames})',setpts=N/${fps}/TB`,
    "-frames:v",
    String(trimFrames),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    quality === "hd" ? "20" : "23",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-r",
    String(fps),
    "-vsync",
    "cfr",
    trimMp4,
  ]);

  const merged = path.join(workDir, `seg-slide-${String(index).padStart(3, "0")}.mp4`);
  const listFile = path.join(workDir, `slide-concat-${index}.txt`);
  fs.writeFileSync(
    listFile,
    [`file '${trimMp4.replace(/'/g, "'\\''")}'`, `file '${slideMp4.replace(/'/g, "'\\''")}'`].join(
      "\n",
    ),
  );
  await timedRun("ffmpeg:slide-concat", ffmpeg, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-frames:v",
    String(totalFrames),
    "-r",
    String(fps),
    "-vsync",
    "cfr",
    merged,
  ]);
  return merged;
}

/** Hard-concat scene segments. Frame count = sum of master-clock windows. */
async function concatHard(ffmpeg, segments, outPath, fps, totalFrames) {
  if (segments.length === 1) {
    fs.copyFileSync(segments[0], outPath);
    return;
  }
  const listFile = path.join(path.dirname(outPath), "concat.txt");
  fs.writeFileSync(
    listFile,
    segments.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
  );
  if (FAST_ENGINE) {
    // Every segment is already x264 yuv420p at the same size and frame rate,
    // so join them without decoding and re-encoding the whole video again.
    await timedRun("ffmpeg:concat", ffmpeg, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c:v",
      "copy",
      "-an",
      "-frames:v",
      String(Math.max(1, totalFrames)),
      "-movflags",
      "+faststart",
      outPath,
    ]);
    return;
  }
  await timedRun("ffmpeg:concat", ffmpeg, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-r",
    String(fps),
    "-vsync",
    "cfr",
    "-frames:v",
    String(Math.max(1, totalFrames)),
    "-movflags",
    "+faststart",
    outPath,
  ]);
}

export async function encodeExportJob({
  job,
  payload,
  workDir,
  outPath,
  onProgress,
  isCancelled,
}) {
  // Local-only encode on this Mac — never starts a Studio SERVER job.
  const authToken = job.authToken || process.env.RENDER_API_KEY || null;
  const studioUrl = job.studioUrl || "";

  const ffmpeg = resolveFfmpeg();
  const quality = payload.quality === "hd" ? "hd" : "preview";
  const { w: W, h: H, fps } = exportSize(quality);
  const scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
  if (!scenes.length) throw new Error("Export payload has no scenes");

  fs.mkdirSync(workDir, { recursive: true });
  timings = new Map();

  let bgFile = null;
  try {
    const bgRaw = payload.background?.url || "/bg-loop.mp4";
    const bgUrl = resolveAssetUrl(bgRaw, studioUrl);
    if (bgUrl && (/^https?:\/\//i.test(bgUrl) || bgUrl.startsWith("data:"))) {
      bgFile = path.join(workDir, `bg-loop${extFromUrl(bgUrl, ".mp4")}`);
      if (!fs.existsSync(bgFile) || fs.statSync(bgFile).size < 1000) {
        onProgress("downloading background…", 0.03);
        await fetchToFile(bgUrl, bgFile, authToken);
      }
    }
  } catch (e) {
    console.warn("[agent] background skipped:", e);
    bgFile = null;
  }
  // Local fallback if Studio fetch failed
  if (!bgFile || !fs.existsSync(bgFile)) {
    const localBg = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "public",
      "bg-loop.mp4",
    );
    if (fs.existsSync(localBg)) {
      bgFile = localBg;
      console.warn("[agent] using bundled bg-loop.mp4");
    }
  }

  const prefetch = createAssetPrefetch({
    authToken,
    isCancelled: () => Boolean(isCancelled?.() || job.status === "cancelled"),
  });
  const encodeStartedAt = Date.now();
  let downloadWaitMs = 0;
  let prefetchHits = 0;
  prefetch.prefetchAhead(scenes, 0, workDir, studioUrl);
  const masterRaw =
    payload.masterAudioUrl ||
    scenes.find((s) => s.masterAudioUrl)?.masterAudioUrl ||
    (scenes.length === 1 ? scenes[0]?.audioUrl : null);
  try {
    const masterPrefetch = resolveAssetUrl(masterRaw, studioUrl);
    if (masterPrefetch && (/^https?:\/\//i.test(masterPrefetch) || masterPrefetch.startsWith("data:"))) {
      prefetch
        .enqueue(masterPrefetch, path.join(workDir, `audio${extFromUrl(masterPrefetch, ".mp3")}`))
        .catch((e) => console.warn("[agent] prefetch audio", e.message || e));
    }
  } catch {
    /* encode path still fetches master audio later */
  }

  const segments = [];
  const transitionsMs = [];
  const durs = [];

  try {
  onProgress("baking orange bg loop…", 0.04);
  const bgLoop = await bakeBgLoopFrames(ffmpeg, bgFile, W, H, workDir, fps, FAST_ENGINE);

  const sceneTasks = [];
  let sceneError = null;
  let scenesDone = 0;
  const limit = createLimiter(sceneConcurrency());
  if (FAST_ENGINE) {
    console.log(`[agent] rendering up to ${sceneConcurrency()} scenes at once`);
  }

  const encodeScene = async (i, scene, frames, durSec) => {
    const seg = path.join(workDir, `seg-${String(i).padStart(3, "0")}.mp4`);

    // Resume caching:
    // If the final per-scene segment exists, we can skip all intermediate
    // frame/audio/image work for that scene.
    if (fs.existsSync(seg) && fs.statSync(seg).size > 1000) {
      return seg;
    }

    let mediaUrl = null;
    try {
      mediaUrl = resolveAssetUrl(scene.mediaUrl, studioUrl);
    } catch (e) {
      if (isVideoScene(scene)) throw e;
    }
    const isRecordingOverlay =
      isVideoScene(scene) && Boolean(mediaUrl) && /^https?:\/\//i.test(mediaUrl);

    // Only recording scenes composite over this clip. Image/question/code scenes
    // paint their own background, so under ENGINE=fast the encode is skipped.
    const bgSeg = path.join(workDir, `bg-${i}.mp4`);
    if (
      (!FAST_ENGINE || isRecordingOverlay) &&
      (!fs.existsSync(bgSeg) || fs.statSync(bgSeg).size < 1000)
    ) {
      await makeBgSegment(ffmpeg, bgFile, W, H, fps, frames, bgSeg, quality);
    }

    if (isRecordingOverlay) {
      const src = path.join(workDir, `src-v-${i}${extFromUrl(mediaUrl, ".mp4")}`);
      await fetchToFile(mediaUrl, src, authToken);
      const card = cardRect(W, H);
      const innerW = Math.round(card.w);
      const innerH = Math.round(card.h);
      const ox = Math.round(card.x);
      const oy = Math.round(card.y);
      // Studio compose uses cameraFit "fill" for recordings; bumpers stay contain.
      const useContain = !shouldStretchFillVideo(scene);
      const recRaw = path.join(workDir, `rec-raw-${i}.mp4`);
      const trimStartMs = Math.max(0, Number(scene.recordingTrimStartMs) || 0);
      const trimEndMs = Number(scene.recordingTrimEndMs) || 0;
      const speechMs = revealSpeechMs(scene);
      const clipMs =
        trimEndMs > trimStartMs ? trimEndMs - trimStartMs : speechMs;
      const clipSec = Math.max(0.05, Math.min(clipMs, speechMs) / 1000);
      let contentCrop = resolveRecordingContentCrop(scene);
      if (!contentCrop && shouldDetectMatteCrop(scene)) {
        contentCrop = await detectRecordingContentCrop(
          ffmpeg,
          src,
          trimStartMs / 1000,
          workDir,
        );
        if (contentCrop) {
          console.log(
            `[agent] matte crop w=${contentCrop.w} h=${contentCrop.h} x=${contentCrop.x} y=${contentCrop.y}`,
          );
        }
      }
      const scaleVf = buildRecordingScaleVf(
        innerW,
        innerH,
        fps,
        useContain,
        contentCrop,
      );
      // Zero QuickTime start_time so recording video lines up with extracted audio.
      await timedRun("ffmpeg:rec-raw", ffmpeg, [
        "-y",
        "-fflags",
        "+genpts",
        "-ss",
        String(trimStartMs / 1000),
        "-i",
        src,
        "-t",
        String(clipSec),
        "-vf",
        `setpts=PTS-STARTPTS,${scaleVf}`,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        quality === "hd" ? "20" : "26",
        "-pix_fmt",
        "yuv420p",
        recRaw,
      ]);
      // Stretch to full stitch window: clip + hold + slide by freezing last frame.
      const rec = path.join(workDir, `rec-${i}.mp4`);
      await fitVideoToFrames(ffmpeg, recRaw, rec, frames, fps, quality);
      const overlaid = path.join(workDir, `rec-over-${i}.mp4`);
      await timedRun("ffmpeg:rec-overlay", ffmpeg, [
        "-y",
        "-i",
        bgSeg,
        "-i",
        rec,
        "-filter_complex",
        `[1:v]format=rgba,pad=${W}:${H}:${ox}:${oy}:black@0[fg];[0:v][fg]overlay=0:0:eof_action=repeat:format=auto,format=yuv420p`,
        "-frames:v",
        String(frames),
        "-r",
        String(fps),
        "-vsync",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        quality === "hd" ? "20" : "23",
        "-an",
        overlaid,
      ]);
      await fitVideoToFrames(ffmpeg, overlaid, seg, frames, fps, quality);
      return seg;
    }

    const assets = { elementImgs: new Map() };
    const fastAssets = { bgImg: null, elements: [] };
    const skipFullBackground = shouldSkipFullBackground(scene);
    // Never use full composite as underlay for upload-image timelines (shows whole image at once)
    const still = resolveAssetUrl(
      skipFullBackground
        ? null
        : scene.backgroundUrl ||
            (scene.revealCovers?.length ? scene.backgroundUrl : null) ||
            null,
      studioUrl,
    );
    if (still && (/^https?:\/\//i.test(still) || still.startsWith("data:"))) {
      try {
        const p = path.join(workDir, `still-${i}${extFromUrl(still, ".png")}`);
        await fetchToFile(still, p, authToken);
        if (FAST_ENGINE) fastAssets.bgImg = p;
        else assets.bgImg = await loadImage(p);
      } catch (e) {
        console.warn("[agent] scene still", e);
      }
    }
    // Reveal-cover scenes need the composite background
    if (!skipFullBackground && scene.revealCovers?.length && scene.backgroundUrl) {
      try {
        const u = resolveAssetUrl(scene.backgroundUrl, studioUrl);
        if (u && (/^https?:\/\//i.test(u) || u.startsWith("data:"))) {
          const p = path.join(workDir, `cover-bg-${i}${extFromUrl(u, ".png")}`);
          await fetchToFile(u, p, authToken);
          if (FAST_ENGINE) fastAssets.bgImg = p;
          else assets.bgImg = await loadImage(p);
        }
      } catch (e) {
        console.warn("[agent] cover bg", e);
      }
    }
    for (const el of scene.elements || []) {
      if (!el?.id || !el.mediaUrl) continue;
      try {
        const u = resolveAssetUrl(el.mediaUrl, studioUrl);
        if (!u || (!/^https?:\/\//i.test(u) && !u.startsWith("data:"))) continue;
        const p = path.join(workDir, `el-${i}-${el.id}${extFromUrl(u, ".png")}`);
        await fetchToFile(u, p, authToken);
        if (FAST_ENGINE) fastAssets.elements.push({ id: el.id, path: p });
        else assets.elementImgs.set(el.id, await loadImage(p));
      } catch (e) {
        console.warn("[agent] element skip", el.id, e);
      }
    }

    if (FAST_ENGINE) {
      await runOverlayInThread({
        ffmpeg,
        scene,
        W,
        H,
        fps,
        durSec,
        workDir,
        index: i,
        assets: fastAssets,
        bgLoop,
        outSeg: seg,
        quality,
        templateTheme: payload.templateTheme,
      });
      return seg;
    }

    await encodeOverlayFrames({
      ffmpeg,
      scene,
      W,
      H,
      fps,
      durSec,
      workDir,
      index: i,
      assets,
      bgLoop: FAST_ENGINE ? makeLazyBgLoop(bgLoop) : bgLoop,
      outSeg: seg,
      quality,
      templateTheme: payload.templateTheme,
    });
    return seg;
  };

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const frames = sceneFrameCount(scene, fps);
    const durSec = frames / fps;
    durs.push(durSec);
    transitionsMs.push(i < scenes.length - 1 ? transitionAfterMs(scene) : 0);
    prefetch.prefetchAhead(scenes, i + 1, workDir, studioUrl);
    const pending = collectSceneDownloads(scene, i, workDir, studioUrl);
    const waitStartedAt = Date.now();
    if (pending.length && !sceneDownloadsReady(pending)) {
      onProgress(
        `downloading scene ${i + 1}/${scenes.length}…`,
        0.05 + 0.7 * (i / scenes.length),
      );
      await prefetch.waitForScene(scene, i, workDir, studioUrl);
    } else if (pending.length) {
      prefetchHits += 1;
    }
    const waitedMs = Date.now() - waitStartedAt;
    downloadWaitMs += waitedMs;
    console.log(
      `[agent] scene ${i + 1}/${scenes.length} asset-wait ${waitedMs}ms files=${pending.length} hit=${pending.length > 0 && waitedMs < 50}`,
    );
    onProgress(
      `encoding scene ${i + 1}/${scenes.length}…`,
      0.05 + 0.7 * ((i + 0.5) / scenes.length),
    );

    if (sceneError) throw sceneError;
    if (FAST_ENGINE) {
      sceneTasks.push(
        limit(() => encodeScene(i, scene, frames, durSec))
          .then((seg) => {
            segments[i] = seg;
            scenesDone += 1;
            onProgress(
              `encoded ${scenesDone}/${scenes.length} scenes…`,
              0.05 + 0.7 * (scenesDone / scenes.length),
            );
          })
          .catch((e) => {
            sceneError = sceneError || e;
          }),
      );
    } else {
      segments[i] = await encodeScene(i, scene, frames, durSec);
    }
  }
  await Promise.all(sceneTasks);
  if (sceneError) throw sceneError;
  } finally {
    // A failed or cancelled job must not leave scene threads painting.
    for (const thread of activeThreads) thread.terminate();
    prefetch.stop();
  }

  onProgress("slide transitions…", 0.78);
  // Snap every segment to the master-clock frame count (no 80ms slop).
  for (let i = 0; i < segments.length; i++) {
    const fitted = path.join(workDir, `seg-fit-${String(i).padStart(3, "0")}.mp4`);
    if (fs.existsSync(fitted) && fs.statSync(fitted).size > 1000) {
      segments[i] = fitted;
      continue;
    }
    const frames = Math.max(1, Math.round(durs[i] * fps));
    // Scene segments are already encoded to exactly this many frames (overlay
    // scenes paint `frames`, recordings go through fitVideoToFrames), so under
    // ENGINE=fast the extra re-encode is skipped. A 1-frame scene is the one case
    // where the overlay path paints 2, so it still goes through the fit.
    if (FAST_ENGINE && frames >= 2) continue;
    await fitVideoToFrames(ffmpeg, segments[i], fitted, frames, fps, quality);
    segments[i] = fitted;
  }
  // Paint right-to-left swap into the last transitionMs of each scene window
  // (after the hold). Window length stays exact → audio stays synced.
  const slideOne = async (i, fromSeg, toSeg) => {
    const tMs = transitionsMs[i] || DEFAULT_TRANSITION_MS;
    onProgress(
      `slide ${i + 1}→${i + 2} (${Math.round(tMs)}ms)…`,
      0.78 + 0.04 * ((i + 1) / Math.max(1, segments.length - 1)),
    );
    try {
      const merged = path.join(
        workDir,
        `seg-slide-${String(i).padStart(3, "0")}.mp4`,
      );
      if (fs.existsSync(merged) && fs.statSync(merged).size > 1000) {
        return merged;
      }

      return await applySegmentSlide({
        ffmpeg,
        fromSeg,
        toSeg,
        durSec: durs[i],
        transitionMs: tMs,
        workDir,
        index: i,
        W,
        H,
        fps,
        quality,
      });
    } catch (e) {
      console.warn(`[agent] slide ${i}→${i + 1} failed, keeping hard cut`, e);
      return fromSeg;
    }
  };
  if (FAST_ENGINE) {
    // Each slide reads the original neighbouring segments, never another slide's
    // output, so they can all run at once.
    const original = segments.slice();
    const slideLimit = createLimiter(sceneConcurrency());
    await Promise.all(
      original.slice(0, -1).map((_, i) =>
        slideLimit(async () => {
          segments[i] = await slideOne(i, original[i], original[i + 1]);
        }),
      ),
    );
  } else {
    for (let i = 0; i < segments.length - 1; i++) {
      segments[i] = await slideOne(i, segments[i], segments[i + 1]);
    }
  }

  onProgress("concat…", 0.84);
  const silentVideo = path.join(workDir, "silent.mp4");
  const videoFrames = durs.reduce((n, d) => n + Math.max(1, Math.round(d * fps)), 0);
  if (!fs.existsSync(silentVideo) || fs.statSync(silentVideo).size < 1000) {
    await concatHard(ffmpeg, segments, silentVideo, fps, videoFrames);
  }

  const targetSec = videoFrames / fps;
  const videoForMux = silentVideo;

  const master = resolveAssetUrl(masterRaw, studioUrl);

  if (master && (/^https?:\/\//i.test(master) || master.startsWith("data:"))) {
    onProgress("muxing audio…", 0.9);
    const audioPath = path.join(workDir, `audio${extFromUrl(master, ".mp3")}`);
    await fetchToFile(master, audioPath, authToken);

    let mixedAudio = audioPath;
    try {
      mixedAudio = await mixOverlayAudio({
        ffmpeg,
        masterPath: audioPath,
        workDir,
        scenes,
        studioUrl,
        authToken,
        onProgress,
      });
    } catch (e) {
      console.warn("[agent] overlay audio mix failed, using master only", e);
      mixedAudio = audioPath;
    }

    // Video length = sum(scene windows). Lock mux to that so A/V stay 1:1.
    await timedRun("ffmpeg:mux", ffmpeg, [
      "-y",
      "-i",
      videoForMux,
      "-i",
      mixedAudio,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-af",
      "apad",
      "-t",
      String(targetSec),
      "-movflags",
      "+faststart",
      outPath,
    ]);
  } else {
    onProgress("finalizing…", 0.92);
    fs.copyFileSync(videoForMux, outPath);
  }

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
    throw new Error("Export produced an empty or missing MP4");
  }
  const stepSummary = Object.fromEntries(
    [...timings.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, k === "frames:count" ? v : Number((v / 1000).toFixed(1))]),
  );
  console.log(`[agent] step seconds ${JSON.stringify(stepSummary)}`);
  console.log(
    `[agent] encode finished in ${((Date.now() - encodeStartedAt) / 1000).toFixed(1)}s download-wait ${(downloadWaitMs / 1000).toFixed(1)}s prefetch-hits ${prefetchHits}/${scenes.length}`,
  );
}
