/**
 * Worker thread: paints and encodes one overlay scene (ENGINE=fast).
 * Skia rasterising is CPU-bound and synchronous, so scenes run on separate
 * threads to use more than one core.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runOverlayTask } from "./export-engine.mjs";

runOverlayTask(workerData).then(
  (timings) => parentPort.postMessage({ ok: true, timings }),
  (err) => parentPort.postMessage({ ok: false, error: String(err?.stack || err) }),
);
