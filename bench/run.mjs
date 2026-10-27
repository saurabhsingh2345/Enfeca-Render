/**
 * Render the synthetic fixture through the local encode worker and time it.
 *
 *   node bench/run.mjs <workDir> <label> [--custom-outro]
 *
 * Everything stays on this machine: the worker is started directly on a local
 * port (no cloud claim loop, no render key) and fetches its media from a small
 * static server. Nothing here talks to Studio.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.join(here, "..", "engine");

const workDir = path.resolve(process.argv[2] ?? "");
const label = process.argv[3] ?? "run";
const customOutro = process.argv.includes("--custom-outro");
const brokenRecording = process.argv.includes("--broken-recording");
const relativeRoot = process.argv.includes("--relative-root");
const l5eOutro = process.argv.includes("--l5e-outro");
// --no-fallback leaves the fallback host unset, to reproduce the failure.
const noFallback = process.argv.includes("--no-fallback");
if (!process.argv[2]) {
  console.error("usage: node bench/run.mjs <workDir> <label> [--custom-outro]");
  process.exit(1);
}

const ASSET_PORT = 8765;
const AGENT_PORT = 3863;

const fixtureDir = path.join(workDir, customOutro ? "fixture-custom-outro" : l5eOutro ? "fixture-l5e" : "fixture");
const { payload, totalMs } = buildFixture(fixtureDir, { customOutro, brokenRecording, l5eOutro });

const makeAssetServer = (hideL5e) => http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (hideL5e && rel.startsWith("/__l5e/")) {
    res.writeHead(404).end();
    return;
  }
  const file = path.join(fixtureDir, rel);
  if (!file.startsWith(fixtureDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  const size = fs.statSync(file).size;
  res.writeHead(200, { "Content-Length": size });
  fs.createReadStream(file).pipe(res);
});
const assetServer = makeAssetServer(l5eOutro);
await new Promise((r) => assetServer.listen(ASSET_PORT, "127.0.0.1", r));
const FALLBACK_PORT = 8766;
const fallbackServer = makeAssetServer(false);
await new Promise((r) => fallbackServer.listen(FALLBACK_PORT, "127.0.0.1", r));

const agentData = path.join(workDir, `agent-${label}`);
fs.rmSync(agentData, { recursive: true, force: true });
fs.mkdirSync(agentData, { recursive: true });

const env = {
  ...process.env,
  PORT: String(AGENT_PORT),
  AGENT_ISOLATED: "1",
  // --relative-root hands the worker a relative data folder (as `./worker-3853`
  // in the README), which is what once broke the final concat.
  AGENT_DATA_ROOT: relativeRoot ? path.relative(engineDir, agentData) : agentData,
  RENDER_API_KEY: "",
  ASSET_FALLBACK_ORIGIN: noFallback ? "" : `http://127.0.0.1:${FALLBACK_PORT}`,
};
const agent = spawn("node", ["server.mjs"], { cwd: engineDir, env, stdio: ["ignore", "pipe", "pipe"] });
const logPath = path.join(workDir, `log-${label}.txt`);
const log = fs.createWriteStream(logPath);
agent.stdout.pipe(log);
agent.stderr.pipe(log);

// The worker paints frames on its main thread, so it can drop a kept-alive
// connection while busy. Close after each call and retry on a reset.
async function api(method, route, body) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${AGENT_PORT}${route}`, {
        method,
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

// Never leave the worker running if the harness dies.
process.on("exit", () => agent.kill());
process.on("uncaughtException", (e) => {
  console.error(e);
  agent.kill();
  process.exit(1);
});

for (let i = 0; i < 50; i++) {
  try {
    await api("GET", "/api/health");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

const started = Date.now();
const { jobId } = await api("POST", "/api/jobs", {
  payload,
  studioUrl: `http://127.0.0.1:${ASSET_PORT}`,
});
console.log(`[bench:${label}] job ${jobId}, ${(totalMs / 1000).toFixed(1)}s of video`);

let last = "";
let job;
let peakRssMB = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 1500));
  const rss = Number(spawnSync("ps", ["-o", "rss=", "-p", String(agent.pid)], { encoding: "utf8" }).stdout) / 1024;
  if (rss > peakRssMB) peakRssMB = rss;
  job = (await api("GET", `/api/jobs/${jobId}`)).job;
  const line = `${job.status} ${Math.round(job.progress * 100)}% ${job.stage}`;
  if (line !== last) {
    console.log(`[bench:${label}] +${((Date.now() - started) / 1000).toFixed(0)}s ${line}`);
    last = line;
  }
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") break;
}
const wallSec = (Date.now() - started) / 1000;

let outFile = null;
if (job.status === "done") {
  const outDir = path.join(agentData, "data", "out");
  const produced = fs.readdirSync(outDir).find((f) => f.endsWith(".mp4"));
  outFile = path.join(workDir, `out-${label}.mp4`);
  fs.copyFileSync(path.join(outDir, produced), outFile);
}

agent.kill();
assetServer.close();
fallbackServer.close();
const result = {
  label,
  status: job.status,
  error: job.error ?? null,
  videoSec: totalMs / 1000,
  wallSec: Number(wallSec.toFixed(1)),
  xRealtime: Number((wallSec / (totalMs / 1000)).toFixed(2)),
  workerPeakRssMB: Math.round(peakRssMB),
  out: outFile,
};
fs.writeFileSync(path.join(workDir, `result-${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(job.status === "done" ? 0 : 1);
