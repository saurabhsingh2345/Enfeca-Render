/**
 * Compare two rendered MP4s: duration, frame count, audio length, and
 * average SSIM / PSNR of the picture (1.0 / inf = identical).
 *
 *   node bench/compare.mjs <reference.mp4> <candidate.mp4>
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = createRequire(path.join(here, "..", "engine", "package.json"))("ffmpeg-static");

function ff(args) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  return r.stderr;
}

function info(file) {
  const head = ff(["-i", file]);
  const dur = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(head);
  const durationSec = dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0;
  const size = /Video:.*?(\d{3,5})x(\d{3,5})/.exec(head);
  const hasAudio = /Audio:/.test(head);
  const counted = ff(["-i", file, "-map", "0:v:0", "-f", "null", "-"]);
  const frames = [...counted.matchAll(/frame=\s*(\d+)/g)].pop()?.[1];
  return { durationSec, width: size?.[1], height: size?.[2], hasAudio, frames: Number(frames ?? 0) };
}

const [ref, cand] = process.argv.slice(2);
if (!ref || !cand) {
  console.error("usage: node bench/compare.mjs <reference.mp4> <candidate.mp4>");
  process.exit(1);
}
const a = info(ref);
const b = info(cand);
const stats = ff(["-i", ref, "-i", cand, "-lavfi", "[0:v][1:v]ssim;[0:v][1:v]psnr", "-f", "null", "-"]);
const ssim = /SSIM[^\n]*All:([\d.]+)/.exec(stats)?.[1];
const psnr = /PSNR[^\n]*average:([\w.]+)/.exec(stats)?.[1];

console.log(JSON.stringify({ reference: a, candidate: b, ssim, psnr }, null, 2));
const frameDelta = Math.abs(a.frames - b.frames);
const ok = frameDelta === 0 && Math.abs(a.durationSec - b.durationSec) < 0.05 && a.hasAudio === b.hasAudio && Number(ssim) >= 0.99;
console.log(ok ? "MATCH" : "DIFFERENT");
process.exit(ok ? 0 : 2);
