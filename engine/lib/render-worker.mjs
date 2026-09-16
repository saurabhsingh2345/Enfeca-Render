import fs from "node:fs";
import path from "node:path";
import { encodeExportJob } from "./export-engine.mjs";

/**
 * Real local export: download Studio assets + ffmpeg assemble on this Mac.
 * Canvas is loaded lazily inside encodeExportJob path (unpacked native binding).
 */
export async function runRenderJob({ job, store, onProgress }) {
  const payload = JSON.parse(fs.readFileSync(job.payloadPath, "utf8"));
  const workDir = path.join(path.dirname(job.payloadPath), "work");
  const outPath = path.join(store.outDir, `${job.id}-${job.filename}`);

  fs.mkdirSync(store.outDir, { recursive: true });
  // Resume support:
  // If the agent previously crashed/restarted mid-job, Studio will call "resume"
  // on the same jobId. In that case we keep the existing workDir so
  // encodeExportJob can reuse already-baked intermediate artifacts.
  const isResume =
    job.status === "error" &&
    typeof job.error === "string" &&
    job.error.includes("interrupted (agent restarted)") &&
    fs.existsSync(workDir);

  fs.mkdirSync(workDir, { recursive: true });
  if (!isResume) {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
  }

  // If a previous attempt already produced the final MP4, don't re-encode.
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
    store.update(job.id, {
      status: "done",
      progress: 1,
      stage: "done",
      outPath,
    });
    return;
  }

  await encodeExportJob({
    job,
    payload,
    workDir,
    outPath,
    onProgress,
  });

  // Keep disk tidy (payload + meta remain)
  fs.rmSync(workDir, { recursive: true, force: true });

  store.update(job.id, {
    status: "done",
    progress: 1,
    stage: "done",
    outPath,
  });
}
