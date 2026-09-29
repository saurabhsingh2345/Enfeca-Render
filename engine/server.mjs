#!/usr/bin/env node
/**
 * Explainer Render Agent — local Mac companion for Studio HD/720 exports.
 *
 *   npm start          → CLI server
 *   npm run electron   → desktop window (DMG build uses this)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJobStore } from "./lib/jobs.mjs";
import { STABLE_PORT } from "./lib/agent-ports.mjs";
import {
  checkForUpdate,
  currentVersion,
  downloadAndOpenDmg,
  hostArch,
  loadUpdateSettings,
  openPath,
  saveUpdateSettings,
} from "./lib/update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {{
 *   appRoot?: string,
 *   dataRoot?: string,
 *   port?: number,
 *   host?: string,
 * }} [opts]
 */
export function startAgent(opts = {}) {
  const appRoot = opts.appRoot || process.env.AGENT_APP_ROOT || __dirname;
  const dataRoot = opts.dataRoot || process.env.AGENT_DATA_ROOT || appRoot;
  loadEnv(path.join(appRoot, ".env"));
  // Isolated workers run from engine/; the render key lives in the stack root .env.
  loadEnv(path.join(appRoot, "..", ".env"));
  if (dataRoot !== appRoot) loadEnv(path.join(dataRoot, "..", ".env"));

  const PORT = Number(opts.port || process.env.PORT || STABLE_PORT);
  const HOST = opts.host || process.env.HOST || "127.0.0.1";
  const PUBLIC = path.join(appRoot, "public");
  const store = createJobStore(dataRoot);
  const isolated =
    process.env.ELECTRON_RUN_AS_NODE === "1" ||
    process.env.AGENT_ISOLATED === "1" ||
    !process.versions.electron;

  /** @type {Promise<void>} */
  let queueTail = Promise.resolve();

  function enqueue(jobId) {
    queueTail = queueTail.then(() => processJob(jobId)).catch((err) => {
      console.error("[agent] queue error", err);
    });
  }

  async function processJob(jobId) {
    const job = store.get(jobId);
    if (!job || job.status === "cancelled") return;

    store.update(jobId, { status: "running", progress: 0.02, stage: "starting…" });
    try {
      const { runRenderJob } = await import("./lib/render-worker.mjs");
      await runRenderJob({
        job: store.get(jobId),
        store,
        onProgress: (stage, progress) => {
          store.update(jobId, { stage, progress });
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.update(jobId, {
        status: "error",
        error: msg,
        stage: msg,
        progress: store.get(jobId)?.progress ?? 0,
      });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      cors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/") {
        return sendFile(res, path.join(PUBLIC, "index.html"), "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, {
          ok: true,
          name: "explainer-render-agent",
          version: currentVersion(),
          engine: "local-ffmpeg+canvas",
          port: PORT,
          jobs: store.list().length,
          arch: hostArch(),
          isolated,
          pid: process.pid,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/update/status") {
        const settings = loadUpdateSettings(dataRoot);
        return json(res, {
          ok: true,
          version: currentVersion(),
          arch: hostArch(),
          feedUrl: settings.feedUrl,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/update/settings") {
        const body = await readJson(req);
        const settings = saveUpdateSettings(dataRoot, {
          feedUrl: body.feedUrl || "",
        });
        return json(res, { ok: true, ...settings, version: currentVersion() });
      }

      if (req.method === "POST" && url.pathname === "/api/update/check") {
        try {
          return json(res, await checkForUpdate(dataRoot));
        } catch (e) {
          return json(
            res,
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            500,
          );
        }
      }

      if (req.method === "POST" && url.pathname === "/api/update/install") {
        try {
          const body = await readJson(req);
          const check =
            body.dmgUrl && body.dmgName
              ? {
                  dmgUrl: body.dmgUrl,
                  dmgName: body.dmgName,
                }
              : await checkForUpdate(dataRoot);
          if (!check.dmgUrl) {
            return json(res, { error: check.message || "No update to install" }, 400);
          }
          const result = await downloadAndOpenDmg(
            dataRoot,
            check.dmgUrl,
            check.dmgName,
          );
          return json(res, {
            ok: true,
            ...result,
            message:
              "DMG downloaded to Downloads and opened. Drag the app to Applications to finish updating, then reopen Explainer Render Agent.",
          });
        } catch (e) {
          return json(
            res,
            { error: e instanceof Error ? e.message : String(e) },
            500,
          );
        }
      }

      if (req.method === "POST" && url.pathname === "/api/update/open-dmg") {
        try {
          const body = await readJson(req);
          const p = String(body.path || "").trim();
          if (!p) return json(res, { error: "path required" }, 400);
          await openPath(p);
          return json(res, { ok: true });
        } catch (e) {
          return json(
            res,
            { error: e instanceof Error ? e.message : String(e) },
            500,
          );
        }
      }

      if (req.method === "GET" && url.pathname === "/api/jobs") {
        return json(res, { jobs: store.list().map(publicJob) });
      }

      if (req.method === "POST" && url.pathname === "/api/jobs") {
        const body = await readJson(req);
        const payload = body.payload ?? body;
        if (!payload || typeof payload !== "object") {
          return json(res, { error: "missing payload" }, 400);
        }
        const job = store.create({
          filename: body.filename || payload.filename,
          quality: body.quality || payload.quality,
          studioUrl: body.studioUrl || process.env.STUDIO_URL,
          authToken: body.authToken || body.token || undefined,
          payload,
        });
        enqueue(job.id);
        return json(res, { jobId: job.id, job: publicJob(job) }, 201);
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(\/download)?$/);
      if (jobMatch) {
        const id = decodeURIComponent(jobMatch[1]);
        const job = store.get(id);
        if (!job) return json(res, { error: "not found" }, 404);

        if (jobMatch[2] === "/download") {
          if (job.status !== "done" || !job.outPath || !fs.existsSync(job.outPath)) {
            return json(res, { error: "not ready" }, 409);
          }
          const data = fs.readFileSync(job.outPath);
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Length": data.length,
            "Content-Disposition": `attachment; filename="${job.filename}"`,
          });
          res.end(data);
          return;
        }

        if (req.method === "GET") {
          return json(res, { job: publicJob(job) });
        }

        if (req.method === "DELETE") {
          store.remove(id);
          return json(res, { ok: true });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/demo") {
        const job = store.create({
          filename: "agent-demo-720p.mp4",
          quality: "preview",
          payload: {
            quality: "preview",
            filename: "agent-demo-720p.mp4",
            scenes: [
              {
                kind: "template",
                durationMs: 3000,
                title: "Demo",
              },
            ],
          },
        });
        enqueue(job.id);
        return json(res, { jobId: job.id, job: publicJob(job) }, 201);
      }

      // POST /api/jobs/:id/resume
      // Re-enqueue the same jobId so it can continue using the existing workDir artifacts.
      if (req.method === "POST") {
        const resumeMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/resume$/);
        if (resumeMatch) {
          const id = decodeURIComponent(resumeMatch[1]);
          const job = store.get(id);
          if (!job) return json(res, { error: "not found" }, 404);
          if (job.status === "done") return json(res, { ok: true, job: publicJob(job) });
          if (job.status !== "error") {
            return json(res, { error: "job not in resumable error state" }, 409);
          }
          // Allow resume for crash-interruptions and transient download failures
          // (deskos tunnel / common-intro.mp4 / asset fetch hiccups).
          const err = typeof job.error === "string" ? job.error : "";
          const resumable =
            err.includes("interrupted (agent restarted)") ||
            err.includes("Download failed") ||
            err.includes("fetch failed");
          if (!resumable) {
            return json(res, { error: "only interrupted or download-failed jobs can be resumed" }, 409);
          }

          store.update(id, {
            status: "queued",
            progress: job.progress ?? 0.02,
            stage: "resuming…",
            error: undefined,
          });
          enqueue(id);
          const next = store.get(id);
          return json(res, { ok: true, job: publicJob(next) });
        }
      }

      json(res, { error: "not found" }, 404);
    } catch (e) {
      console.error(e);
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      console.log(
        `Explainer Render Agent  http://${HOST}:${PORT}` +
          (isolated ? "  (isolated worker — window crash will not stop encodes)" : ""),
      );
      for (const id of store.interruptedOnLoad || []) {
        const job = store.get(id);
        if (!job) continue;
        store.update(id, {
          status: "queued",
          progress: job.progress ?? 0.02,
          stage: "resuming…",
          error: undefined,
        });
        enqueue(id);
        console.log("[agent] auto-resume", id);
      }
      resolve({ port: PORT, host: HOST, server, store, isolated });
    });
  });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    filename: job.filename,
    quality: job.quality,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    downloadReady: job.status === "done" && Boolean(job.outPath),
  };
}

function cors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  // Required when Studio is opened via https://… (deskos) and the browser calls localhost:3850.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function json(res, body, status = 200) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendFile(res, filePath, type) {
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && pathToFileURL(entry).href === import.meta.url) {
  startAgent().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
