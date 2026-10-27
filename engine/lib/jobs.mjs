import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @typedef {"queued" | "running" | "done" | "error" | "cancelled"} JobStatus
 * @typedef {{
 *   id: string,
 *   status: JobStatus,
 *   progress: number,
 *   stage: string,
 *   filename: string,
 *   quality: string,
 *   error?: string,
 *   createdAt: number,
 *   updatedAt: number,
 *   outPath?: string,
 *   studioUrl?: string,
 *   payloadPath: string,
 *   authToken?: string,
 * }} Job
 */

export function createJobStore(rootDir) {
  // ffmpeg's concat list resolves each entry relative to the list file, so a
  // relative data folder (the README starts workers with ./worker-3853) doubled
  // the path and failed every multi-scene render at the final join.
  rootDir = path.resolve(rootDir);
  const jobsDir = path.join(rootDir, "data", "jobs");
  const outDir = path.join(rootDir, "data", "out");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  /** @type {Map<string, Job>} */
  const jobs = new Map();
  /** In-memory only — never written to meta.json */
  /** @type {Map<string, string>} */
  const secrets = new Map();

  function persist(job) {
    const metaPath = path.join(jobsDir, job.id, "meta.json");
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    const { authToken: _drop, ...safe } = job;
    fs.writeFileSync(metaPath, JSON.stringify(safe, null, 2));
  }

  function loadExisting() {
    const interruptedOnLoad = [];
    if (!fs.existsSync(jobsDir)) return interruptedOnLoad;
    for (const id of fs.readdirSync(jobsDir)) {
      const metaPath = path.join(jobsDir, id, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const job = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (job.status === "running" || job.status === "queued") {
          job.status = "queued";
          job.stage = "resuming after restart…";
          delete job.error;
          job.updatedAt = Date.now();
          persist(job);
          interruptedOnLoad.push(job.id);
        }
        jobs.set(job.id, job);
      } catch {
        /* skip */
      }
    }
    return interruptedOnLoad;
  }

  const interruptedOnLoad = loadExisting();

  return {
    outDir,
    jobsDir,
    interruptedOnLoad,

    list() {
      return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    },

    get(id) {
      const job = jobs.get(id);
      if (!job) return undefined;
      const token = secrets.get(id) || process.env.RENDER_API_KEY || "";
      return token ? { ...job, authToken: token } : job;
    },

    /**
     * @param {{
     *   filename?: string,
     *   quality?: string,
     *   studioUrl?: string,
     *   authToken?: string,
     *   payload: unknown,
     * }} input
     */
    create(input) {
      const id = randomUUID();
      const dir = path.join(jobsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      const payloadPath = path.join(dir, "payload.json");
      fs.writeFileSync(payloadPath, JSON.stringify(input.payload, null, 2));

      if (input.authToken) secrets.set(id, String(input.authToken));

      /** @type {Job} */
      const job = {
        id,
        status: "queued",
        progress: 0,
        stage: "queued",
        filename:
          String(input.filename || input.payload?.filename || "export.mp4")
            .replace(/[^\w.\- ]+/g, "")
            .trim() || "export.mp4",
        quality: String(input.quality || input.payload?.quality || "hd"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        studioUrl: input.studioUrl,
        payloadPath,
      };
      jobs.set(id, job);
      persist(job);
      return this.get(id);
    },

    update(id, patch) {
      const job = jobs.get(id);
      if (!job) return null;
      Object.assign(job, patch, { updatedAt: Date.now() });
      persist(job);
      return this.get(id);
    },

    remove(id) {
      const job = jobs.get(id);
      if (!job) return false;
      jobs.delete(id);
      secrets.delete(id);
      const dir = path.join(jobsDir, id);
      fs.rmSync(dir, { recursive: true, force: true });
      if (job.outPath && fs.existsSync(job.outPath)) {
        try {
          fs.unlinkSync(job.outPath);
        } catch {
          /* ignore */
        }
      }
      return true;
    },
  };
}
