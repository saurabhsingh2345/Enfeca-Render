#!/usr/bin/env node
/**
 * Enfeca Render — self-contained HD queue + local encode workers.
 *   bash setup.sh && open http://127.0.0.1:3849
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// Root .env is the single config file for every machine.
loadEnv(path.join(ROOT, ".env"), true);

const PORT = Number(process.env.PORT || 3849);
const PUBLIC = path.join(__dirname, "public");
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || "data/out");
const COMPLETED_DIR = path.join(ROOT, "data", "completed");
const DISMISSED_PATH = path.join(ROOT, "data", "dismissed.json");
const LEGACY_COMPLETED_PATH = path.join(ROOT, "data", "completed.json");
const AGENT_DATA_ROOT = path.resolve(process.env.AGENT_DATA_ROOT || ROOT);
const AGENT_APP_ROOT = path.resolve(process.env.AGENT_APP_ROOT || path.join(ROOT, "engine"));
const JOBS = new Map();
/** @type {Set<string>} */
const WATCHING = new Set();
/** @type {Set<string>} */
const CANCELLED = new Set();
/** @type {Set<string>} */
const AUTO_CLAIMING = new Set();

function isCancelled(bundleId) {
  return CANCELLED.has(bundleId);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(COMPLETED_DIR, { recursive: true });
migrateLegacyCompleted();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      return sendFile(res, path.join(PUBLIC, "index.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, {
        studioUrl: studioUrl(),
        hasKey: Boolean(renderKey()),
        agentPorts: agentPorts(),
        port: PORT,
        outDir: OUT_DIR,
        renderMachine: renderMachine(),
        autoClaim: autoClaimEnabled(),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJson(req);
      const envPath = path.join(ROOT, ".env");
      writeEnv(envPath, {
        STUDIO_URL: String(body.studioUrl || studioUrl()).replace(/\/$/, ""),
        RENDER_API_KEY: String(body.apiKey || renderKey() || ""),
        RENDER_MACHINE: String(body.renderMachine || renderMachine() || ""),
        AUTO_CLAIM: body.autoClaim ? "1" : "0",
        AGENT_PORTS: process.env.AGENT_PORTS || "3853,3854",
        PORT: String(PORT),
        OUT_DIR: process.env.OUT_DIR || "./data/out",
      });
      loadEnv(envPath, true);
      return json(res, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      const agents = {};
      for (const port of agentPorts()) {
        const health = await pingAgent(port);
        agents[port] = health || (portListening(port) ? { ok: true, busy: true } : null);
      }
      return json(res, { ok: true, agents });
    }
    if (req.method === "GET" && url.pathname === "/api/agents") {
      return json(res, { agents: await listAgentWorkers() });
    }
    const agentJobDel = url.pathname.match(/^\/api\/agents\/(\d+)\/jobs\/([^/]+)$/);
    if (req.method === "DELETE" && agentJobDel) {
      const port = Number(agentJobDel[1]);
      const jobId = decodeURIComponent(agentJobDel[2]);
      if (!agentPorts().includes(port)) return json(res, { error: "unknown worker port" }, 400);
      await removeAgentJob(port, jobId);
      clearLocalJobsForAgentJob(jobId);
      return json(res, { ok: true });
    }
    const agentRestart = url.pathname.match(/^\/api\/agents\/(\d+)\/restart$/);
    if (req.method === "POST" && agentRestart) {
      const port = Number(agentRestart[1]);
      if (!agentPorts().includes(port)) return json(res, { error: "unknown worker port" }, 400);
      await restartAgentWorker(port);
      return json(res, { ok: true, agents: await listAgentWorkers() });
    }
    if (req.method === "GET" && url.pathname === "/api/bundles") {
      syncLocalJobsFromDisk();
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const offset = (page - 1) * limit;
      const data = await fetchRenderQueue({ limit, offset });
      const dismissed = loadDismissed();
      const raw = normalizeList(data).filter((b) => !dismissed.has(b.id));
      const total = Number(data?.total ?? raw.length);
      for (const b of raw) {
        const hit = findRunningAgentJobForBundle(b);
        if (!hit) continue;
        const local = JOBS.get(b.id);
        const stale =
          !local ||
          (local.stage || "").includes("queueing HD agent") ||
          ((local.progress || 0) <= 0 && (hit.job.progress || 0) > 0);
        if (!stale) continue;
        JOBS.set(b.id, {
          status: "running",
          progress: hit.job.progress || 0,
          stage: hit.job.stage || hit.job.status,
          error: null,
          outPath: null,
          agentPort: hit.port,
          agentJobId: hit.agentJobId,
          title: hit.job.filename || b.title,
        });
      }
      const bundles = raw.map((b) => ({
        ...b,
        job: publicLocalJob(JOBS.get(b.id)),
        mp4Ready: Boolean(findMp4(b)),
        mp4Name: findMp4(b)?.name ?? null,
      }));
      reattachStaleJobs(bundles).catch((e) =>
        console.warn("[cloud-render] reattach:", e.message),
      );
      return json(res, {
        bundles,
        completed: listCompleted(),
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit)),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/completed") {
      return json(res, { completed: listCompleted() });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/completed/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/completed/".length));
      if (!id) return json(res, { error: "missing id" }, 400);
      if (!removeCompleted(id)) return json(res, { error: "not found" }, 404);
      return json(res, { ok: true });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/bundles/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/bundles/".length));
      if (!id) return json(res, { error: "missing id" }, 400);
      let bundleHint = null;
      try {
        bundleHint = await studioJson(`/api/public/bundles/${encodeURIComponent(id)}`);
      } catch {
        /* local delete still works without Studio */
      }
      await deleteBundleFromQueue(id, bundleHint);
      return json(res, { ok: true });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/render/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/render/".length));
      if (!id) return json(res, { error: "missing id" }, 400);
      let bundleHint = null;
      try {
        bundleHint = await studioJson(`/api/public/bundles/${encodeURIComponent(id)}`);
      } catch {
        /* local stop still works without Studio */
      }
      await stopBundleRender(id, bundleHint);
      return json(res, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/render/claim") {
      if (!renderKey()) return json(res, { error: "Set RENDER_API_KEY first" }, 400);
      let body = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const claimed = await claimNextRenderJob(body.machine || renderMachine());
      if (!claimed?.id) return json(res, { ok: true, job: null });
      startCloudRender(claimed.id, { job: claimed, payload: extractPayload(claimed), claimed: true }).catch(
        (err) => {
          if (isCancelled(claimed.id)) {
            JOBS.delete(claimed.id);
            return;
          }
          const job = JOBS.get(claimed.id) ?? {};
          JOBS.set(claimed.id, {
            ...job,
            status: "error",
            error: err.message || String(err),
            stage: "error",
          });
          failRenderJob(claimed.id, err.message || String(err)).catch(() => {});
        },
      );
      return json(res, { ok: true, job: { id: claimed.id, title: claimed.title || claimed.filename } });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/render/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/render/".length));
      if (!id) return json(res, { error: "missing id" }, 400);
      CANCELLED.delete(id);
      if (JOBS.get(id)?.status === "running") {
        const running = JOBS.get(id);
        if (running?.agentPort && running?.agentJobId) {
          try {
            const agentRes = await fetch(
              `http://127.0.0.1:${running.agentPort}/api/jobs/${encodeURIComponent(running.agentJobId)}`,
              { signal: AbortSignal.timeout(5000) },
            );
            if (agentRes.ok) {
              const { job } = await agentRes.json();
              if (job?.status === "running" || job?.status === "queued") {
                return json(res, { error: "already rendering" }, 409);
              }
            }
          } catch {
            /* stale local job — allow retry */
          }
        } else if ((running?.stage || "").includes("queueing HD agent")) {
          /* stuck waiting for busy worker — fall through and reconnect/resume */
        } else {
          return json(res, { error: "already rendering" }, 409);
        }
      }
      startCloudRender(id).catch((err) => {
        if (isCancelled(id)) {
          JOBS.delete(id);
          return;
        }
        const job = JOBS.get(id) ?? {};
        JOBS.set(id, {
          ...job,
          status: "error",
          error: err.message || String(err),
          stage: "error",
        });
        failRenderJob(id, err.message || String(err)).catch(() => {});
      });
      return json(res, { ok: true, job: publicLocalJob(JOBS.get(id)) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/jobs/".length));
      return json(res, publicLocalJob(JOBS.get(id)) ?? { status: "idle" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/download/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/download/".length));
      const file = resolveDownloadPath(id);
      if (!file) return json(res, { error: "MP4 not ready" }, 404);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${path.basename(file)}"`,
        "Content-Length": fs.statSync(file).size,
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    json(res, { error: "not found" }, 404);
  } catch (err) {
    json(res, { error: err.message || String(err) }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Enfeca Render  http://127.0.0.1:${PORT}`);
  console.log(`Studio                   ${studioUrl() || "(set on the page)"}`);
  console.log(`HD workers               ${agentPorts().join(", ")}  (8080 / 3850 unused)`);
  console.log(`MP4s                     ${OUT_DIR}`);
  if (!renderKey()) console.log("Paste RENDER_API_KEY on the page (Lovable Secrets).");
  if (autoClaimEnabled()) {
    console.log(`Auto-claim enabled · machine ${renderMachine()}`);
    runAutoClaimLoop().catch((e) => console.error("[auto-claim]", e));
  }
});

async function startCloudRender(id, opts = {}) {
  JOBS.set(id, {
    status: "running",
    progress: 0,
    stage: "fetching render job…",
    error: null,
    outPath: null,
    agentPort: null,
    agentJobId: null,
    title: id,
  });

  let bundle = opts.job || null;
  let payload = opts.payload || null;
  if (!opts.claimed) {
    try {
      const claimed = await claimNextRenderJob(renderMachine());
      if (claimed?.id && claimed.id !== id) {
        throw new Error(
          `Another job is ahead in the queue (${claimed.title || claimed.filename || claimed.id}). Render that one first.`,
        );
      }
      if (claimed?.id === id) {
        bundle = claimed;
        payload = extractPayload(claimed);
        opts.claimed = true;
      }
    } catch (e) {
      if (String(e.message || e).includes("ahead in the queue")) throw e;
      console.warn("[hd-render] claim skipped:", e.message || e);
    }
  }
  if (!payload) {
    const fromQueue = await findRenderJob(id);
    if (fromQueue) {
      bundle = fromQueue;
      payload = extractPayload(fromQueue);
    }
  }
  if (!payload) {
    try {
      bundle = await studioJson(`/api/public/bundles/${encodeURIComponent(id)}`);
      payload = extractPayload(bundle);
    } catch (e) {
      throw new Error(`Render job ${id} not found (${e.message || e})`);
    }
  }
  if (isCancelled(id)) {
    JOBS.delete(id);
    return;
  }

  const filename =
    payload.filename ||
    bundle?.filename ||
    `${slug(bundle?.title || bundle?.episodeTitle || id)}-1080p.mp4`;
  payload.filename = filename;
  payload.quality = payload.quality || "hd";
  if (!Array.isArray(payload.scenes) || !payload.scenes.length) {
    throw new Error("Job has no scenes — click Ready for HD again after stitch.");
  }
  if (!payload.masterAudioUrl) {
    throw new Error("Job has no masterAudioUrl — stitch the part first.");
  }

  const origin = studioUrl();
  const rewritten = rewriteCloudUrls(payload, origin);
  JOBS.set(id, { ...JOBS.get(id), title: filename, stage: "queueing HD agent…" });

  if (isCancelled(id)) {
    JOBS.delete(id);
    return;
  }
  if (!opts.claimed) {
    await reportRenderProgress(id, 0, "queueing HD agent…").catch(() => {});
  }

  const existing =
    findRunningAgentJob(filename) ||
    findRunningAgentJobForBundle({ ...bundle, filename, payload }) ||
    findResumableAgentJob(filename);
  let port;
  let agentJobId;
  if (existing) {
    port = existing.port;
    agentJobId = existing.agentJobId;
    if (existing.job.status === "error") {
      await resumeAgentJob(port, agentJobId);
    }
    console.log(`[hd-render] resume existing ${agentJobId} on ${port} for ${filename}`);
    JOBS.set(id, {
      ...JOBS.get(id),
      status: "running",
      error: null,
      agentPort: port,
      agentJobId,
      progress: existing.job.progress || 0,
      stage: existing.job.stage || "running",
    });
  } else {
    port = await pickAgent();
    const agentJob = await postAgentJob(port, {
      filename,
      quality: "hd",
      studioUrl: origin,
      authToken: renderKey(),
      payload: rewritten,
    });
    agentJobId = agentJob.jobId || agentJob.job?.id;
    if (!agentJobId) throw new Error("Agent did not return jobId");
    JOBS.set(id, {
      ...JOBS.get(id),
      agentPort: port,
      agentJobId,
      stage: `queued on ${port}`,
    });
  }

  if (isCancelled(id)) {
    if (port && agentJobId) await removeAgentJob(port, agentJobId);
    JOBS.delete(id);
    return;
  }
  const done = await finishAgentJob(id, port, agentJobId, filename);
  if (isCancelled(id) || done.status === "cancelled") {
    JOBS.delete(id);
    return;
  }
}

async function finishAgentJob(id, port, agentJobId, filename) {
  const done = await waitForAgentJob(port, agentJobId, id);
  if (isCancelled(id) || done.status === "cancelled") {
    return { status: "cancelled" };
  }
  if (done.status !== "done" || !done.outPath || !fs.existsSync(done.outPath)) {
    throw new Error(done.error || `Agent job ${done.status}`);
  }

  const dest = path.join(OUT_DIR, safeName(filename));
  fs.copyFileSync(done.outPath, dest);

  rememberCompleted({
    id,
    title: JOBS.get(id)?.title || filename,
    filename: safeName(filename),
    outPath: dest,
  });

  JOBS.set(id, {
    ...JOBS.get(id),
    stage: "uploading MP4 to cloud…",
    progress: 0.96,
    outPath: dest,
  });
  await reportRenderProgress(id, 0.96, "uploading MP4…").catch(() => {});
  await uploadRenderOutput(id, dest, filename);

  JOBS.set(id, {
    ...JOBS.get(id),
    status: "done",
    progress: 1,
    stage: "done",
    outPath: dest,
  });
}

function extractPayload(bundle) {
  if (bundle?.payload && typeof bundle.payload === "object") {
    return { ...bundle.payload };
  }
  const {
    id: _id,
    status: _s,
    ownerEmail: _o,
    readyAt: _r,
    machine: _m,
    progress: _p,
    stage: _st,
    error: _e,
    queuedAt: _q,
    ...rest
  } = bundle || {};
  return rest;
}

function pinStudioPath(pathname, origin) {
  const path = pathname.startsWith("/api/assets/")
    ? `/api/public/assets/${pathname.slice("/api/assets/".length)}`
    : pathname;
  return `${String(origin).replace(/\/$/, "")}${path}`;
}

function rewriteStudioUrl(value, origin) {
  if (!origin || typeof value !== "string") return value;
  const originNorm = String(origin).replace(/\/$/, "");
  if (value.startsWith("/api/assets/")) {
    return pinStudioPath(value, originNorm);
  }
  if (value.startsWith("/api/public/assets/")) return `${originNorm}${value}`;
  if (value.startsWith("/") && !value.startsWith("//")) return `${originNorm}${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return value;
  let originHost = "";
  try {
    originHost = new URL(originNorm).host;
  } catch {
    return value;
  }
  const staleHost =
    parsed.host !== originHost &&
    (/\/api\/(public\/)?assets\//i.test(parsed.pathname) ||
      parsed.host === "divstudio.enfeca.com" ||
      parsed.host === "divstudio.lovable.app" ||
      /\.lovableproject\.com$/i.test(parsed.host));
  if (!staleHost) return value;
  return `${pinStudioPath(parsed.pathname, originNorm)}${parsed.search}`;
}

function rewriteCloudUrls(value, origin) {
  if (typeof value === "string") {
    // Asset URLs are often stored on an old Studio host; the API key only works on STUDIO_URL.
    return rewriteStudioUrl(value, origin);
  }
  if (Array.isArray(value)) return value.map((v) => rewriteCloudUrls(v, origin));
  if (value && typeof value === "object") {
    const out = Array.isArray(value) ? [] : { ...value };
    for (const [k, v] of Object.entries(value)) out[k] = rewriteCloudUrls(v, origin);
    return out;
  }
  return value;
}

async function pickAgent() {
  const ports = agentPorts();
  for (const port of ports) {
    if (!(await agentReachable(port))) continue;
    if (!agentBusyOnDisk(port)) return port;
  }
  const live = [];
  for (const port of ports) {
    if (await agentReachable(port)) live.push(port);
  }
  if (!live.length) {
    throw new Error(
      `No HD worker on ${ports.join(", ")}. Start isolated agents (not 3850 / 8080).`,
    );
  }
  return live[0];
}

/** Port listen fallback — busy encoders often cannot answer /api/health in time. */
function portListening(port) {
  const r = spawnSync("lsof", [`-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("LISTEN");
}

async function agentReachable(port) {
  const health = await pingAgent(port);
  if (health) return true;
  return portListening(port);
}

async function pingAgent(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function agentJobMetaPath(port, agentJobId) {
  const metaPath = path.join(agentJobsDir(port), agentJobId, "meta.json");
  if (fs.existsSync(metaPath)) return metaPath;
  return path.join(AGENT_DATA_ROOT, "data", "jobs", agentJobId, "meta.json");
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\.mp4$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

function bundleFilenameHint(b) {
  const ep = String(b.episodeTitle || "").trim();
  const part = String(b.partTitle || "").trim();
  if (ep && part) {
    return `${ep} ${part}`.replace(/\s+/g, " ").trim();
  }
  return String(b.title || "")
    .replace(/—/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findRunningAgentJobForBundle(b) {
  const hints = [
    b.filename,
    b.payload?.filename,
    b.title ? `${slug(b.title)}-1080p.mp4` : null,
  ];
  const nameHint = bundleFilenameHint(b);
  if (nameHint) {
    hints.push(`${nameHint}-1080p.mp4`, nameHint);
  }
  for (const name of hints.filter(Boolean)) {
    const hit = findRunningAgentJob(name);
    if (hit) return hit;
  }
  const target = normName(nameHint);
  if (!target) return null;
  for (const port of agentPorts()) {
    const jobsDir = agentJobsDir(port);
    if (!fs.existsSync(jobsDir)) continue;
    for (const id of fs.readdirSync(jobsDir)) {
      const metaPath = path.join(jobsDir, id, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (j.status !== "running" && j.status !== "queued") continue;
        const fn = normName(j.filename || "");
        if (fn.includes(target) || target.includes(fn.replace(/1080p$/, ""))) {
          return { port, agentJobId: j.id, job: j };
        }
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

function findRunningAgentJob(filename) {
  const target = safeName(filename);
  for (const port of agentPorts()) {
    const jobsDir = agentJobsDir(port);
    if (!fs.existsSync(jobsDir)) continue;
    for (const id of fs.readdirSync(jobsDir)) {
      const metaPath = path.join(jobsDir, id, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (j.status !== "running" && j.status !== "queued") continue;
        if (safeName(j.filename || "") !== target) continue;
        return { port, agentJobId: j.id, job: j };
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

/** Reconnect UI to agent jobs still encoding after Cloud Render restarts. */
async function reattachStaleJobs(bundles) {
  for (const b of bundles) {
    if (isCancelled(b.id)) continue;
    const local = JOBS.get(b.id);
    const filename =
      b.filename ||
      b.payload?.filename ||
      (b.title ? `${slug(b.title)}-1080p.mp4` : null);
    const hit = findRunningAgentJobForBundle(b);
    if (!hit) continue;
    const outName = hit.job.filename || filename || `${bundleFilenameHint(b)}-1080p.mp4`;
    const stale =
      !local ||
      local.status !== "running" ||
      (local.stage || "").includes("queueing HD agent") ||
      ((local.progress || 0) <= 0 && (hit.job.progress || 0) > 0);
    if (!stale || WATCHING.has(b.id)) continue;
    WATCHING.add(b.id);
    JOBS.set(b.id, {
      status: "running",
      progress: hit.job.progress || 0,
      stage: hit.job.stage || hit.job.status,
      error: null,
      outPath: null,
      agentPort: hit.port,
      agentJobId: hit.agentJobId,
      title: outName,
    });
    console.log(`[cloud-render] reattach ${b.id} → ${hit.agentJobId} on ${hit.port}`);
    finishAgentJob(b.id, hit.port, hit.agentJobId, outName)
      .catch((err) => {
        const job = JOBS.get(b.id) ?? {};
        JOBS.set(b.id, {
          ...job,
          status: "error",
          error: err.message || String(err),
          stage: "error",
        });
        failRenderJob(b.id, err.message || String(err)).catch(() => {});
      })
      .finally(() => WATCHING.delete(b.id));
  }
}

/** Each worker keeps jobs under worker-{port}/data/jobs in this folder. */
function agentJobsDir(port) {
  const workerDir = path.join(AGENT_DATA_ROOT, `worker-${port}`, "data", "jobs");
  if (fs.existsSync(path.dirname(workerDir))) return workerDir;
  const legacy = path.join(AGENT_DATA_ROOT, `.data-${port}`, "data", "jobs");
  if (fs.existsSync(path.dirname(legacy))) return legacy;
  return path.join(AGENT_DATA_ROOT, "data", "jobs");
}

function agentBusyOnDisk(port) {
  const jobsDir = agentJobsDir(port);
  if (!fs.existsSync(jobsDir)) return false;
  for (const id of fs.readdirSync(jobsDir)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(jobsDir, id, "meta.json"), "utf8"));
      if (j.status === "running" || j.status === "queued") return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

const STUCK_MS = 90_000;

function agentJobFromDisk(jobsDir, id, port) {
  const metaPath = path.join(jobsDir, id, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const ageMs = Date.now() - (j.updatedAt || j.createdAt || 0);
    const workerUp = portListening(port);
    const stuck =
      (j.status === "running" || j.status === "queued") &&
      (!workerUp || (j.status === "running" && ageMs > STUCK_MS));
    return {
      id: j.id || id,
      status: j.status,
      progress: Math.round((j.progress || 0) * 100),
      stage: j.stage || j.status,
      filename: j.filename || id,
      error: j.error || null,
      updatedAt: j.updatedAt || j.createdAt || 0,
      ageSec: Math.round(ageMs / 1000),
      stuck,
      stuckReason: !workerUp
        ? "worker down"
        : j.status === "running" && ageMs > STUCK_MS
          ? "no progress"
          : null,
    };
  } catch {
    return null;
  }
}

function listActiveAgentJobs(port) {
  const jobsDir = agentJobsDir(port);
  if (!fs.existsSync(jobsDir)) return [];
  const out = [];
  for (const id of fs.readdirSync(jobsDir)) {
    const j = agentJobFromDisk(jobsDir, id, port);
    if (!j) continue;
    if (j.status === "running" || j.status === "queued") out.push(j);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function listAgentWorkers() {
  const workers = [];
  for (const port of agentPorts()) {
    const up = portListening(port);
    const health = up ? await pingAgent(port) : null;
    const jobs = listActiveAgentJobs(port);
    for (const j of jobs) {
      j.stuck = j.stuck || !up;
      if (!up) j.stuckReason = "worker down";
    }
    workers.push({
      port,
      up,
      busy: health?.busy || (!health && up),
      pid: listenerPid(port),
      jobsDir: agentJobsDir(port),
      jobs,
      stuckCount: jobs.filter((j) => j.stuck).length,
    });
  }
  return workers;
}

function listenerPid(port) {
  const r = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const pid = Number(String(r.stdout || "").trim().split("\n")[0]);
  return pid > 0 ? pid : null;
}

function killJobProcesses(jobId) {
  spawnSync("pkill", ["-f", jobId], { encoding: "utf8" });
}

async function removeAgentJob(port, jobId) {
  killJobProcesses(jobId);
  try {
    await fetch(`http://127.0.0.1:${port}/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* agent may be down or busy */
  }
  for (const jobsDir of [agentJobsDir(port), path.join(AGENT_DATA_ROOT, "data", "jobs")]) {
    const dir = path.join(jobsDir, jobId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function clearLocalJobsForAgentJob(agentJobId) {
  for (const [bundleId, job] of JOBS.entries()) {
    if (job.agentJobId === agentJobId) {
      JOBS.delete(bundleId);
      WATCHING.delete(bundleId);
    }
  }
}

/** Stop an in-progress HD encode and clear local queue state. */
async function stopBundleRender(bundleId, bundleHint = null, { resetCloud = true } = {}) {
  CANCELLED.add(bundleId);
  WATCHING.delete(bundleId);

  const local = JOBS.get(bundleId);
  let port = local?.agentPort;
  let agentJobId = local?.agentJobId;

  if (!agentJobId && bundleHint) {
    const hit = findRunningAgentJobForBundle(bundleHint);
    if (hit) {
      port = hit.port;
      agentJobId = hit.agentJobId;
    }
  }

  if (port && agentJobId) {
    await removeAgentJob(port, agentJobId);
  }

  JOBS.delete(bundleId);
  if (agentJobId) clearLocalJobsForAgentJob(agentJobId);

  if (resetCloud) {
    failRenderJob(bundleId, "Stopped on render Mac").catch(() => {});
  }

  setTimeout(() => CANCELLED.delete(bundleId), 120_000);
  console.log(`[hd-render] stopped ${bundleId}${agentJobId ? ` (${agentJobId.slice(0, 8)} on ${port})` : ""}`);
}

/** Remove a part from the Ready-for-HD queue (stop encode if needed, hide locally, delete on Studio). */
async function deleteBundleFromQueue(bundleId, bundleHint = null) {
  await stopBundleRender(bundleId, bundleHint, { resetCloud: false });

  let cloudDeleted = false;
  try {
    await studioFetch(`/api/public/bundles/${encodeURIComponent(bundleId)}`, {
      method: "DELETE",
    });
    cloudDeleted = true;
  } catch (e) {
    const msg = String(e.message || e);
    if (!/\b(404|405|501)\b/.test(msg)) {
      for (const status of ["deleted", "dismissed", "removed"]) {
        try {
          await markBundle(bundleId, status);
          cloudDeleted = true;
          break;
        } catch {
          /* try next status */
        }
      }
    }
  }

  dismissBundle(bundleId);
  console.log(
    `[hd-render] deleted ${bundleId} from queue${cloudDeleted ? "" : " (local hide only — Studio API unavailable)"}`,
  );
}

function loadDismissed() {
  try {
    const raw = JSON.parse(fs.readFileSync(DISMISSED_PATH, "utf8"));
    return new Set(Array.isArray(raw) ? raw : raw?.ids || []);
  } catch {
    return new Set();
  }
}

function dismissBundle(id) {
  const dismissed = loadDismissed();
  dismissed.add(id);
  fs.mkdirSync(path.dirname(DISMISSED_PATH), { recursive: true });
  fs.writeFileSync(DISMISSED_PATH, JSON.stringify([...dismissed], null, 2) + "\n");
}

function syncLocalJobsFromDisk() {
  for (const [bundleId, local] of JOBS.entries()) {
    if (!local?.agentJobId || !local?.agentPort) continue;
    const metaPath = agentJobMetaPath(local.agentPort, local.agentJobId);
    if (!fs.existsSync(metaPath)) {
      if (local.status === "running") JOBS.delete(bundleId);
      continue;
    }
    try {
      const disk = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (disk.status === "done" || disk.status === "error" || disk.status === "cancelled") {
        if (local.status === "running" && disk.status !== "done") {
          JOBS.set(bundleId, {
            ...local,
            status: "error",
            stage: disk.stage || disk.status,
            error: disk.error || "agent job ended",
          });
        } else if (local.status === "running" && disk.status === "done") {
          JOBS.delete(bundleId);
        }
        continue;
      }
      const ageMs = Date.now() - (disk.updatedAt || 0);
      const stuck = disk.status === "running" && ageMs > STUCK_MS && !portListening(local.agentPort);
      if (stuck) continue;
      JOBS.set(bundleId, {
        ...local,
        progress: disk.progress ?? local.progress,
        stage: disk.stage || disk.status,
      });
    } catch {
      /* skip */
    }
  }
}

async function restartAgentWorker(port) {
  const pid = listenerPid(port);
  if (pid) {
    spawnSync("kill", [String(pid)], { encoding: "utf8" });
    await sleep(1200);
  }
  const env = {
    ...process.env,
    PORT: String(port),
    AGENT_ISOLATED: "1",
    AGENT_DATA_ROOT: path.join(AGENT_DATA_ROOT, `worker-${port}`),
  };
  const logPath = `/tmp/divstudio-hd-render/worker-${port}.log`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child = spawn("node", ["server.mjs"], {
    cwd: AGENT_APP_ROOT,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  await sleep(1500);
}

async function postAgentJob(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Agent ${port} ${res.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text);
}

async function waitForAgentJob(port, agentJobId, renderJobId) {
  const deadline = Date.now() + 4 * 60 * 60 * 1000;
  let last = "";
  while (Date.now() < deadline) {
    if (isCancelled(renderJobId)) {
      return { status: "cancelled" };
    }
    let j = null;
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/jobs/${encodeURIComponent(agentJobId)}`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (res.ok) {
        const data = await res.json();
        j = data.job ?? null;
      }
    } catch {
      /* fall back to disk */
    }
    const metaPath = agentJobMetaPath(port, agentJobId);
    if (!j && fs.existsSync(metaPath)) {
      j = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } else if (j && fs.existsSync(metaPath)) {
      const disk = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      j = { ...disk, ...j, outPath: disk.outPath || j.outPath };
    }
    if (j) {
      const msg = `${j.status} ${j.stage || ""}`;
      if (msg !== last) {
        last = msg;
        JOBS.set(renderJobId, {
          ...JOBS.get(renderJobId),
          progress: j.progress || 0,
          stage: j.stage || j.status,
          error: j.error || null,
        });
      }
      if (renderJobId && j.status === "running") {
        try {
          const { abort } = await reportRenderProgress(
            renderJobId,
            j.progress || 0,
            j.stage || j.status,
          );
          if (abort) {
            await removeAgentJob(port, agentJobId);
            return { status: "cancelled" };
          }
        } catch (e) {
          console.warn("[hd-render] progress report failed:", e.message);
        }
      }
      if (j.status === "done" || j.status === "error" || j.status === "cancelled") {
        return j;
      }
    }
    await sleep(2000);
  }
  throw new Error("Timed out waiting for HD agent");
}

async function fetchRenderQueue({ limit = 50, offset = 0 } = {}) {
  try {
    return await studioJson(
      `/api/public/render/jobs?limit=${limit}&offset=${offset}`,
    );
  } catch (e) {
    console.warn("[hd-render] render/jobs failed, falling back to bundles:", e.message);
    return studioJson(`/api/public/bundles?limit=${limit}&offset=${offset}`);
  }
}

async function findRenderJob(id) {
  const data = await fetchRenderQueue({ limit: 50, offset: 0 });
  const list = normalizeList(data);
  const hit = list.find((j) => j.id === id);
  return hit || null;
}

async function claimNextRenderJob(machine = renderMachine()) {
  const res = await studioFetch("/api/public/render/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine }),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  const data = JSON.parse(text);
  const job = data?.job ?? data;
  if (!job?.id) return null;
  return job;
}

async function reportRenderProgress(id, progress, stage) {
  const res = await studioFetch(`/api/public/render/${encodeURIComponent(id)}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      progress: Math.max(0, Math.min(1, Number(progress) || 0)),
      stage: String(stage || "").slice(0, 200),
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { abort: Boolean(data.abort) };
}

async function failRenderJob(id, error) {
  const msg = String(error || "render failed").slice(0, 500);
  try {
    await studioFetch(`/api/public/render/${encodeURIComponent(id)}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: msg }),
    });
  } catch (e) {
    console.warn("[hd-render] render/fail failed, legacy bundles fallback:", e.message);
    await markBundle(id, "failed", msg);
  }
}

async function uploadRenderOutput(id, filePath, filename) {
  const buf = fs.readFileSync(filePath);
  const key = renderKey();
  const origin = studioUrl();
  const putUrl = `${origin}/api/public/render/${encodeURIComponent(id)}/output`;
  const headers = {
    Authorization: `Bearer ${key}`,
    "x-render-key": key,
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
  let res = await fetch(putUrl, { method: "PUT", headers, body: buf });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  if (/\b404\b/.test(`${res.status} ${text}`)) {
    console.warn("[hd-render] render/output 404 — trying legacy bundles/output");
    await uploadOutputLegacy(id, filePath, filename);
    return;
  }
  throw new Error(`Upload MP4 failed ${res.status}: ${text.slice(0, 240)}`);
}

async function uploadOutputLegacy(id, filePath, filename) {
  const buf = fs.readFileSync(filePath);
  const key = renderKey();
  const origin = studioUrl();
  const putUrl = `${origin}/api/public/bundles/${encodeURIComponent(id)}/output`;
  const headers = {
    Authorization: `Bearer ${key}`,
    "x-render-key": key,
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
  const res = await fetch(putUrl, { method: "PUT", headers, body: buf });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload MP4 failed ${res.status}: ${text.slice(0, 240)}`);
  }
  await markBundle(id, "done");
}

async function markBundle(id, status, error) {
  const body = { status };
  if (error) body.error = String(error).slice(0, 500);
  try {
    await studioFetch(`/api/public/bundles/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn(`[cloud-render] mark ${status} failed:`, e.message);
  }
}

async function runAutoClaimLoop() {
  const machine = renderMachine();
  while (autoClaimEnabled()) {
    if (!renderKey() || !studioUrl()) {
      await sleep(10_000);
      continue;
    }
    const idle = agentPorts().every((port) => !agentBusyOnDisk(port));
    if (!idle) {
      await sleep(5000);
      continue;
    }
    try {
      const claimed = await claimNextRenderJob(machine);
      if (!claimed?.id || AUTO_CLAIMING.has(claimed.id)) {
        await sleep(8000);
        continue;
      }
      AUTO_CLAIMING.add(claimed.id);
      console.log(`[auto-claim] ${claimed.id} → ${machine}`);
      await startCloudRender(claimed.id, {
        job: claimed,
        payload: extractPayload(claimed),
        claimed: true,
      });
    } catch (e) {
      console.warn("[auto-claim]", e.message);
      await sleep(10_000);
    } finally {
      for (const id of AUTO_CLAIMING) {
        if (!JOBS.has(id) || JOBS.get(id)?.status !== "running") AUTO_CLAIMING.delete(id);
      }
    }
    await sleep(2000);
  }
}

function normalizeList(data) {
  const list = Array.isArray(data)
    ? data
    : data?.bundles ?? data?.items ?? data?.jobs ?? [];
  return [...list]
    .map((b) => ({
      id: b.id ?? b.bundleId ?? b.renderJobId ?? b.partId ?? b.key,
      title:
        b.title ??
        b.filename ??
        [b.episodeTitle, b.partTitle].filter(Boolean).join(" — ") ??
        "Untitled",
      episodeTitle: b.episodeTitle,
      partTitle: b.partTitle,
      ownerEmail: b.ownerEmail ?? b.email ?? b.userEmail,
      status: b.status,
      sceneCount: b.sceneCount ?? b.scenes?.length ?? b.payload?.scenes?.length,
      durationMs: b.durationMs ?? b.duration ?? b.payload?.durationMs,
      readyAt: b.readyAt ?? b.createdAt ?? b.updatedAt ?? b.queuedAt,
      payload: b.payload,
      machine: b.machine,
      progress: b.progress,
      stage: b.stage,
      error: b.error,
    }))
    .filter((b) => b.id);
}

function completedEntryPath(id) {
  const safe = Buffer.from(String(id)).toString("base64url");
  return path.join(COMPLETED_DIR, `${safe}.json`);
}

function readCompletedEntryFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readCompletedEntries() {
  const entries = [];
  if (!fs.existsSync(COMPLETED_DIR)) return entries;
  for (const name of fs.readdirSync(COMPLETED_DIR)) {
    if (!name.endsWith(".json")) continue;
    const entry = readCompletedEntryFile(path.join(COMPLETED_DIR, name));
    if (entry?.id) entries.push(entry);
  }
  return entries;
}

function writeCompletedEntry(entry) {
  const full = {
    ...entry,
    completedAt: entry.completedAt || new Date().toISOString(),
  };
  fs.writeFileSync(completedEntryPath(entry.id), JSON.stringify(full, null, 2));
}

function rememberCompleted(entry) {
  for (const existing of readCompletedEntries()) {
    if (existing.id !== entry.id && existing.filename === entry.filename) {
      try {
        fs.unlinkSync(completedEntryPath(existing.id));
      } catch {
        /* ignore */
      }
    }
  }
  writeCompletedEntry(entry);
}

function removeCompleted(id) {
  let entry = readCompletedEntries().find((e) => e.id === id);
  if (!entry && id.startsWith("local:")) {
    const name = safeName(decodeURIComponent(id.slice("local:".length)));
    const p = path.join(OUT_DIR, name);
    if (fs.existsSync(p)) entry = { id, outPath: p, filename: name };
  }
  const fp = completedEntryPath(id);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  if (entry?.outPath && fs.existsSync(entry.outPath)) {
    try {
      fs.unlinkSync(entry.outPath);
    } catch {
      /* ignore */
    }
  }
  return Boolean(entry);
}

function migrateLegacyCompleted() {
  if (!fs.existsSync(LEGACY_COMPLETED_PATH)) return;
  try {
    const list = JSON.parse(fs.readFileSync(LEGACY_COMPLETED_PATH, "utf8"));
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item?.id) writeCompletedEntry(item);
      }
    }
    fs.renameSync(LEGACY_COMPLETED_PATH, `${LEGACY_COMPLETED_PATH}.bak`);
  } catch {
    /* ignore */
  }
}

function listCompleted() {
  const byFilename = new Map();
  for (const entry of readCompletedEntries()) {
    if (entry.filename) byFilename.set(entry.filename, entry);
  }
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (!/\.mp4$/i.test(name)) continue;
    if (byFilename.has(name)) continue;
    const p = path.join(OUT_DIR, name);
    byFilename.set(name, {
      id: `local:${encodeURIComponent(name)}`,
      title: name.replace(/-1080p\.mp4$/i, ""),
      filename: name,
      outPath: p,
      completedAt: new Date(fs.statSync(p).mtimeMs).toISOString(),
    });
  }
  return [...byFilename.values()]
    .filter((e) => e.outPath && fs.existsSync(e.outPath))
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
}

function resolveDownloadPath(id) {
  const job = JOBS.get(id);
  if (job?.outPath && fs.existsSync(job.outPath)) return job.outPath;

  const fromRegistry = readCompletedEntries().find((e) => e.id === id);
  if (fromRegistry?.outPath && fs.existsSync(fromRegistry.outPath)) {
    return fromRegistry.outPath;
  }

  if (id.startsWith("local:")) {
    const name = safeName(decodeURIComponent(id.slice("local:".length)));
    const p = path.join(OUT_DIR, name);
    if (fs.existsSync(p)) return p;
  }

  for (const entry of listCompleted()) {
    if (entry.id === id && entry.outPath && fs.existsSync(entry.outPath)) {
      return entry.outPath;
    }
  }

  return findMp4({ id })?.path ?? null;
}

function findMp4(b) {
  if (!b?.id) return null;
  const job = JOBS.get(b.id);
  if (job?.outPath && fs.existsSync(job.outPath)) {
    return { path: job.outPath, name: path.basename(job.outPath) };
  }
  for (const entry of readCompletedEntries()) {
    if (entry.id === b.id && entry.outPath && fs.existsSync(entry.outPath)) {
      return { path: entry.outPath, name: entry.filename };
    }
  }
  const name = safeName(b.title ? `${slug(b.title)}-1080p.mp4` : `${b.id}.mp4`);
  const p = path.join(OUT_DIR, name);
  if (fs.existsSync(p)) return { path: p, name };
  return null;
}

function publicLocalJob(job) {
  if (!job) return null;
  return {
    status: job.status,
    progress: Math.round((job.progress || 0) * 100),
    stage: job.stage,
    error: job.error,
    agentPort: job.agentPort,
    agentJobId: job.agentJobId,
  };
}

function studioUrl() {
  return (process.env.STUDIO_URL || "https://divstudio.lovable.app").replace(/\/$/, "");
}
function renderKey() {
  return (process.env.RENDER_API_KEY || "").trim();
}
function renderMachine() {
  return (process.env.RENDER_MACHINE || `mac-${os.hostname()}`).trim();
}
function autoClaimEnabled() {
  return process.env.AUTO_CLAIM === "1";
}
function findResumableAgentJob(filename) {
  const target = safeName(filename);
  for (const port of agentPorts()) {
    const jobsDir = agentJobsDir(port);
    if (!fs.existsSync(jobsDir)) continue;
    for (const id of fs.readdirSync(jobsDir)) {
      const metaPath = path.join(jobsDir, id, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (safeName(j.filename || "") !== target) continue;
        if (j.status === "queued") return { port, agentJobId: j.id, job: j };
        if (j.status !== "error") continue;
        const err = String(j.error || "");
        if (
          err.includes("interrupted") ||
          err.includes("Download failed") ||
          err.includes("401") ||
          err.includes("fetch failed")
        ) {
          return { port, agentJobId: j.id, job: j };
        }
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

async function resumeAgentJob(port, agentJobId) {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/jobs/${encodeURIComponent(agentJobId)}/resume`,
    { method: "POST", signal: AbortSignal.timeout(120000) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resume on ${port} failed: ${text.slice(0, 200)}`);
  }
}

function agentPorts() {
  return String(process.env.AGENT_PORTS || "3853,3854")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0);
}

function studioHeaders() {
  const key = renderKey();
  return {
    Accept: "application/json",
    Authorization: `Bearer ${key}`,
    "x-render-key": key,
  };
}

async function studioFetch(pathname, opts = {}) {
  const key = renderKey();
  const origin = studioUrl();
  if (!origin || !key) throw new Error("Set Studio URL and RENDER_API_KEY on this page first.");
  const sep = pathname.includes("?") ? "&" : "?";
  const url = `${origin}${pathname}${pathname.includes("key=") ? "" : `${sep}key=${encodeURIComponent(key)}`}`;
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { ...studioHeaders(), ...(opts.headers || {}) },
    });
  } catch (e) {
    const detail = e?.cause?.code || e?.cause?.message || e?.message || "fetch failed";
    throw new Error(
      `Cannot reach ${origin} (${detail}). Check internet/VPN, then restart Cloud Render (npm start).`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (/Only HTML requests are supported here/i.test(body)) {
      throw new Error(
        `${res.status}: this host is the HTML app, not the Ready-for-HD API. Use https://divstudio.lovable.app (Save, then Refresh).`,
      );
    }
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function studioJson(pathname) {
  const res = await studioFetch(pathname);
  return res.json();
}

function writeEnv(file, values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

function loadEnv(file, overwrite = false) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    const cur = process.env[m[1]];
    if (overwrite || cur === undefined || cur === "") process.env[m[1]] = val;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, file, type) {
  const data = fs.readFileSync(file);
  res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
  res.end(data);
}

function slug(s) {
  return String(s || "part")
    .replace(/\.mp4$/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "part";
}

function safeName(name) {
  return String(name || "out.mp4").replace(/[/\\]/g, "-");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
