/** Port of Studio code-scene-sfx beat timeline (typing → run → output). */

export const DEFAULT_CODE_TYPING_CPS = 28;
export const DEFAULT_CODE_RUN_DELAY_MS = 700;
export const CODE_RUN_PRESS_MS = 180;
export const DEFAULT_CODE_OUTPUT_HOLD_MS = 2500;
export const TYPING_SFX_VOLUME = 0.42;

export function appendBeatCode(prefix, delta) {
  if (!delta) return prefix;
  if (!prefix) return delta;
  if (prefix.endsWith("\n") || delta.startsWith("\n")) return prefix + delta;
  return `${prefix}\n${delta}`;
}

export function beatDeltaForPrefix(prefix, delta) {
  if (!delta) return "";
  if (!prefix) return delta;
  if (prefix.endsWith("\n") || delta.startsWith("\n")) return delta;
  return `\n${delta}`;
}

export function typingDurationFromCps(code, cps) {
  const rate = Math.max(1, cps);
  if (!code.length) return 0;
  return Math.ceil((code.length / rate) * 1000);
}

export function normalizeCodeTypingBeats(beats) {
  if (!beats?.length) return [];
  return beats.map((b, i) => ({
    id: b.id || `beat-${i}`,
    code: b.code ?? "",
    output: b.output ?? "",
    outputHoldMs: Math.max(
      200,
      Math.round(b.outputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS),
    ),
    runDelayMs: Math.max(0, Math.round(b.runDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS)),
  }));
}

export function resolveCodeTypingBeats(input) {
  const fromBeats = normalizeCodeTypingBeats(input.beats);
  if (fromBeats.length > 0) return fromBeats;
  const code = input.code ?? "";
  if (!code.trim() && !(input.output ?? "").trim()) return [];
  return [
    {
      id: "beat-0",
      code,
      output: input.output ?? "",
      outputHoldMs: Math.max(
        200,
        Math.round(input.outputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS),
      ),
      runDelayMs: Math.max(0, Math.round(input.runDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS)),
    },
  ];
}

export function buildCodeBeatTimeline(beats, cps) {
  const rate = Math.max(1, cps);
  const segments = [];
  let cursor = 0;
  let prefix = "";

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const rawDelta = beat.code ?? "";
    const delta = beatDeltaForPrefix(prefix, rawDelta);
    const typeStartMs = cursor;
    const typeDur = typingDurationFromCps(delta, rate);
    const typeEndMs = typeStartMs + typeDur;
    const runDelay = Math.max(0, beat.runDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS);
    const runAtMs = typeEndMs + runDelay;
    const outputStartMs = runAtMs;
    const hold = Math.max(200, beat.outputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS);
    const outputEndMs = outputStartMs + CODE_RUN_PRESS_MS + hold;
    const cumulative = appendBeatCode(prefix, rawDelta);
    segments.push({
      index: i,
      prefix,
      delta,
      cumulative,
      output: beat.output ?? "",
      typeStartMs,
      typeEndMs,
      runAtMs,
      outputStartMs,
      outputEndMs,
    });
    prefix = cumulative;
    cursor = outputEndMs;
  }

  return {
    segments,
    totalMs: Math.max(0, cursor),
    fullCode: prefix,
  };
}

export function resolveCodeBeatFrame(elapsedMs, timeline, cps) {
  const t = Math.max(0, elapsedMs);
  const segs = timeline.segments;
  if (!segs.length) {
    return {
      visibleCode: "",
      showCaret: false,
      runPhase: "idle",
      output: null,
      typingActive: false,
      beatIndex: 0,
    };
  }

  const last = segs[segs.length - 1];
  if (t >= last.outputEndMs) {
    return {
      visibleCode: last.cumulative,
      showCaret: false,
      runPhase: "done",
      output: last.output.trim() ? last.output : null,
      typingActive: false,
      beatIndex: last.index,
    };
  }

  for (const seg of segs) {
    if (t < seg.typeStartMs) continue;
    if (t < seg.typeEndMs) {
      const localMs = t - seg.typeStartMs;
      const typed = Math.min(
        seg.delta.length,
        Math.floor((localMs / 1000) * Math.max(1, cps)),
      );
      return {
        visibleCode: seg.prefix + seg.delta.slice(0, typed),
        showCaret: typed < seg.delta.length,
        runPhase: "idle",
        output: null,
        typingActive: seg.delta.length > 0 && typed < seg.delta.length,
        beatIndex: seg.index,
      };
    }
    if (t < seg.runAtMs) {
      return {
        visibleCode: seg.cumulative,
        showCaret: false,
        runPhase: "ready",
        output: null,
        typingActive: false,
        beatIndex: seg.index,
      };
    }
    if (t < seg.runAtMs + CODE_RUN_PRESS_MS) {
      return {
        visibleCode: seg.cumulative,
        showCaret: false,
        runPhase: "pressing",
        output: seg.output.trim() ? seg.output : null,
        typingActive: false,
        beatIndex: seg.index,
      };
    }
    if (t < seg.outputEndMs) {
      return {
        visibleCode: seg.cumulative,
        showCaret: false,
        runPhase: "done",
        output: seg.output.trim() ? seg.output : null,
        typingActive: false,
        beatIndex: seg.index,
      };
    }
  }

  return {
    visibleCode: last.cumulative,
    showCaret: false,
    runPhase: "done",
    output: last.output.trim() ? last.output : null,
    typingActive: false,
    beatIndex: last.index,
  };
}

export function codeTypingSfxRangesMs(beats, cps) {
  const timeline = buildCodeBeatTimeline(beats, cps);
  return timeline.segments
    .filter((s) => s.typeEndMs > s.typeStartMs)
    .map((s) => ({ startMs: s.typeStartMs, endMs: s.typeEndMs }));
}

/** Absolute master-timeline ranges for keyboard SFX. */
export function computeTypingSegments(scenes) {
  const segments = [];
  for (const scene of scenes) {
    const isCode =
      scene.kind === "code" ||
      (scene.kind === "template" && scene.templateKind === "codeTyping");
    if (!isCode) continue;
    const variant = scene.codeVariant ?? "typing";
    if (variant !== "typing" && scene.templateKind !== "codeTyping") continue;

    const cps = scene.codeTypingCps ?? DEFAULT_CODE_TYPING_CPS;
    const beats = resolveCodeTypingBeats({
      beats: scene.codeTypingBeats,
      code: scene.code || scene.codingStarterCode || "",
      output: scene.codeOutput,
      runDelayMs: scene.codeRunDelayMs,
      outputHoldMs: scene.codeOutputHoldMs,
    });
    if (!beats.length) continue;
    const ranges = codeTypingSfxRangesMs(beats, cps);
    const base = scene.startMs ?? 0;
    for (const r of ranges) {
      segments.push({ startMs: base + r.startMs, endMs: base + r.endMs });
    }
  }
  return segments;
}
