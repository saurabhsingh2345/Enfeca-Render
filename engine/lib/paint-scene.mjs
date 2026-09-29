/**
 * Canvas painters aligned with Studio preview/export (rasterize-scene).
 * Used by the local Render Agent so agent MP4s match Studio Mac quality closer.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  buildCodeBeatTimeline,
  DEFAULT_CODE_OUTPUT_HOLD_MS,
  DEFAULT_CODE_RUN_DELAY_MS,
  DEFAULT_CODE_TYPING_CPS,
  resolveCodeBeatFrame,
  resolveCodeTypingBeats,
} from "./code-typing.mjs";

const CARD_PAD = 0.04;
const OPTION_ACCENT = "#f67e00";
const GRADIENT_STOPS = ["#ffb404", "#f67e00", "#e13900"];
const FIXED_TEMPLATE_FONT = 100;
const FIXED_TEMPLATE_COLOR = "#1a1a1a";
const INTRO_DEFAULT = "Now test your understanding";
const CODING_INTRO_DEFAULT = "Now let's try to solve a coding problem";
const MARK_DEFAULT = "Mark your answers";
const CODING_MARK_DEFAULT = "Coding screen coming up in 3, 2, 1";
const QUESTION_INTRO_GAP_MS = 2000;
const QUESTION_MARK_GAP_MS = 2000;
const QUESTION_MARK_COUNTDOWN_SEC = 3;
const QUESTION_POST_COUNTDOWN_GAP_MS = 2000;

const EXCALIFONT = "Excalifont";
const EXCALI_STACK = `${EXCALIFONT}, cursive`;
const MONO_STACK = `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace`;
const SANS_STACK = `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

let fontsReady = false;

function loadCanvasFonts() {
  if (fontsReady) return;
  fontsReady = true;
  try {
    const require = createRequire(import.meta.url);
    const GlobalFonts = require("@napi-rs/canvas").GlobalFonts;
    const fontPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "public",
      "fonts",
      "Excalifont-Regular.woff2",
    );
    if (fs.existsSync(fontPath) && !GlobalFonts.has(EXCALIFONT)) {
      GlobalFonts.registerFromPath(fontPath, EXCALIFONT);
    }
  } catch (e) {
    console.warn("[agent] Excalifont register failed:", e?.message || e);
  }
}

function canvasFont(weight, sizePx) {
  return `${weight} ${Math.round(sizePx)}px ${EXCALI_STACK}`;
}

function monoFont(weight, sizePx) {
  return `${weight} ${Math.round(sizePx)}px ${MONO_STACK}`;
}

function sansFont(weight, sizePx) {
  return `${weight} ${Math.round(sizePx)}px ${SANS_STACK}`;
}

export function cardRect(W, H) {
  const padX = W * CARD_PAD;
  const padY = H * CARD_PAD;
  return { x: padX, y: padY, w: W - padX * 2, h: H - padY * 2 };
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapLines(ctx, text, maxWidth) {
  const paragraphs = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push("");
      continue;
    }
    const words = para.split(/\s+/);
    let cur = "";
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth) cur = test;
      else {
        if (cur) lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [""];
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  let line = "";
  let cy = y;
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, cy);
      cy += lineH;
      lines++;
      line = word;
      if (lines >= maxLines) return cy;
    } else {
      line = test;
    }
  }
  if (line && lines < maxLines) {
    ctx.fillText(line, x, cy);
    cy += lineH;
  }
  return cy;
}

function wrapTextPreserveNewlines(ctx, text, x, y, maxW, lineH, maxLines) {
  let cy = y;
  let linesUsed = 0;
  for (const paragraph of String(text || "").split("\n")) {
    if (linesUsed >= maxLines) break;
    if (!paragraph) {
      cy += lineH;
      linesUsed++;
      continue;
    }
    const before = cy;
    cy = wrapText(ctx, paragraph, x, cy, maxW, lineH, maxLines - linesUsed);
    linesUsed += Math.max(1, Math.round((cy - before) / lineH));
  }
  return cy;
}

function drawFadeGroup(ctx, alpha, draw) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  draw();
  ctx.restore();
}

const CODING_REVEAL_STEPS = ["problem", "code", "tests"];

function codingRevealProgress(progress, step) {
  const idx = CODING_REVEAL_STEPS.indexOf(step);
  if (idx < 0) return 0;
  const n = CODING_REVEAL_STEPS.length;
  const scaled = Math.min(1, progress * 1.05);
  const stepStart = idx / n;
  const stepEnd = (idx + 1) / n;
  if (scaled <= stepStart) return 0;
  if (scaled >= stepEnd) return 1;
  return (scaled - stepStart) / (stepEnd - stepStart);
}

function drawContain(ctx, img, x, y, w, h) {
  const ir = img.width / Math.max(1, img.height);
  const br = w / Math.max(1, h);
  let dw;
  let dh;
  if (ir > br) {
    dw = w;
    dh = w / ir;
  } else {
    dh = h;
    dw = h * ir;
  }
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function isCropOnlyScene(scene) {
  const els = scene.elements || [];
  return (
    els.length > 0 &&
    els.every((e) => e && e.bbox) &&
    !(scene.revealCovers && scene.revealCovers.length)
  );
}

/** Upload-image timeline: reveal cropped elements — never flash the full composite. */
function shouldSkipFullBackground(scene) {
  return (
    isCropOnlyScene(scene) ||
    ((scene.elements?.length ?? 0) > 0 && !(scene.revealCovers?.length))
  );
}

function questionPreMs(scene) {
  if (scene.kind !== "question" || !scene.questionIntroAudioUrl) return 0;
  const dur = scene.questionIntroDurationMs ?? 2500;
  const gap = scene.questionIntroGapMs ?? QUESTION_INTRO_GAP_MS;
  return dur + gap;
}

function questionMarkCountdownMs(scene) {
  const sec = scene.questionMarkCountdownSec ?? QUESTION_MARK_COUNTDOWN_SEC;
  return Math.max(1, sec) * 1000;
}

/** Match Studio questionPostSpeechVisualMs */
function questionPostVisualMs(scene) {
  const gap = scene.questionMarkGapMs ?? QUESTION_MARK_GAP_MS;
  const countdown = questionMarkCountdownMs(scene);
  const visualTail = countdown + QUESTION_POST_COUNTDOWN_GAP_MS;
  const audioTail =
    scene.questionMarkDurationMs != null && scene.questionMarkDurationMs > 0
      ? scene.questionMarkDurationMs + 250
      : visualTail;
  return gap + Math.max(visualTail, audioTail);
}

function markCountdownSeconds(elapsedMs, countdownMs) {
  if (countdownMs <= 0 || elapsedMs >= countdownMs) return 0;
  return Math.max(1, Math.ceil((countdownMs - elapsedMs) / 1000));
}

/**
 * Absolute elapsed from scene start + speech duration (Studio questionTimelineAt).
 * Do NOT pass speech-compressed elapsed here.
 */
function questionTimeline(elapsedMs, scene, speechMs) {
  const pre = questionPreMs(scene);
  const speech = Math.max(400, speechMs);

  if (scene.questionIntroAudioUrl) {
    const introDur = scene.questionIntroDurationMs ?? 2500;
    const introGap = scene.questionIntroGapMs ?? QUESTION_INTRO_GAP_MS;
    if (elapsedMs < introDur) {
      return { phase: "intro", progress: 0, markElapsedMs: 0 };
    }
    if (elapsedMs < introDur + introGap) {
      return { phase: "intro-gap", progress: 0, markElapsedMs: 0 };
    }
  }

  const afterPre = elapsedMs - pre;
  if (afterPre < speech) {
    return {
      phase: "question",
      progress: speech <= 1 ? 0 : Math.min(1, Math.max(0, afterPre / speech)),
      markElapsedMs: 0,
    };
  }

  const afterSpeech = afterPre - speech;
  const markGap = scene.questionMarkGapMs ?? QUESTION_MARK_GAP_MS;
  const countdownMs = questionMarkCountdownMs(scene);
  if (afterSpeech < markGap) {
    return { phase: "mark-gap", progress: 1, markElapsedMs: 0 };
  }
  const markElapsed = afterSpeech - markGap;
  return {
    phase: "mark",
    progress: 1,
    markElapsedMs: Math.min(countdownMs, markElapsed),
  };
}

function orangeGradient(ctx, x0, y0, x1, y1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, GRADIENT_STOPS[0]);
  g.addColorStop(0.5, GRADIENT_STOPS[1]);
  g.addColorStop(1, GRADIENT_STOPS[2]);
  return g;
}

function drawIntroScreen(ctx, x, y, w, h, text) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);
  const titleSize = Math.max(22, Math.round(Math.min(w, h) * 0.06));
  ctx.fillStyle = "#111827";
  ctx.font = canvasFont(700, titleSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text || INTRO_DEFAULT, x + w / 2, y + h / 2);
}

function drawMarkScreen(ctx, x, y, w, h, secondsLeft, holdSec, markText) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);

  const titleSize = Math.max(22, Math.round(Math.min(w, h) * 0.06));
  const timerSize = Math.max(48, Math.round(Math.min(w, h) * 0.16));
  const ringR = timerSize * 0.72;
  const holdLabelSize = Math.max(12, titleSize * 0.55);
  const gapTitleToRing = Math.round(timerSize * 0.85);
  const gapRingToHold = Math.round(titleSize * 0.7);

  const stackH =
    titleSize + gapTitleToRing + ringR * 2 + gapRingToHold + holdLabelSize;
  const stackTop = y + (h - stackH) / 2 - Math.round(h * 0.03);
  const titleY = stackTop + titleSize / 2;
  const ringCy = stackTop + titleSize + gapTitleToRing + ringR;
  const holdY = ringCy + ringR + gapRingToHold + holdLabelSize / 2;
  const cx = x + w / 2;

  ctx.fillStyle = "#111827";
  ctx.font = canvasFont(700, titleSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(markText || MARK_DEFAULT, cx, titleY);

  const lineW = Math.max(4, ringR * 0.08);
  ctx.beginPath();
  ctx.arc(cx, ringCy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = lineW;
  ctx.stroke();

  const shown = Math.max(0, secondsLeft);
  const frac = holdSec > 0 ? Math.min(1, shown / holdSec) : 0;
  const grad = orangeGradient(ctx, cx - ringR, ringCy, cx + ringR, ringCy);
  if (frac > 0) {
    ctx.beginPath();
    ctx.arc(cx, ringCy, ringR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = grad;
    ctx.lineWidth = lineW;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  ctx.fillStyle = grad;
  ctx.font = canvasFont(700, timerSize);
  ctx.fillText(String(shown || 0), cx, ringCy);

  ctx.fillStyle = "#6b7280";
  ctx.font = canvasFont(500, holdLabelSize);
  ctx.fillText(`${holdSec}s`, cx, holdY);
}

function revealAlpha(progress, stepIndex, stepCount) {
  if (stepCount <= 1) return progress >= 0.02 ? 1 : 0;
  const start = stepIndex / stepCount;
  const end = (stepIndex + 0.85) / stepCount;
  if (progress < start) return 0;
  if (progress >= end) return 1;
  return (progress - start) / Math.max(0.001, end - start);
}

function drawMcqBoard(ctx, scene, progress, x, y, w, h) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);

  const padX = Math.round(w * 0.08);
  const padY = Math.round(h * 0.07);
  const innerW = w - padX * 2;
  const q = scene.questionText || scene.subtitle || "Question";
  const opts = Array.isArray(scene.questionOptions) ? scene.questionOptions : [];
  const isPredict = scene.questionKind === "predictOutput";
  const hint =
    scene.questionKind === "msq" || scene.predictSelectMode === "msq"
      ? "Select all that apply."
      : "Select one answer.";

  const fontQuestion = Math.max(18, Math.round(h * 0.046));
  const fontHint = Math.max(11, Math.round(h * 0.028));
  const fontOption = Math.max(14, Math.round(h * 0.034));
  const optionH = Math.max(42, Math.round(h * (isPredict ? 0.08 : 0.095)));
  const optionGap = Math.max(8, Math.round(h * 0.016));
  const markerSize = Math.max(14, Math.round(h * 0.028));

  let cy = y + padY;
  const steps = isPredict
    ? ["question", "code", "hint", "a", "b", "c", "d"]
    : ["question", "hint", "a", "b", "c", "d"];

  ctx.globalAlpha = revealAlpha(progress, 0, steps.length);
  ctx.fillStyle = "#111827";
  ctx.font = canvasFont(700, fontQuestion);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const line of wrapLines(ctx, q, innerW).slice(0, 3)) {
    ctx.fillText(line, x + padX, cy);
    cy += fontQuestion * 1.22;
  }
  ctx.globalAlpha = 1;

  if (isPredict && scene.questionCode) {
    cy += h * 0.02;
    ctx.globalAlpha = revealAlpha(progress, 1, steps.length);
    ctx.font = monoFont(500, Math.max(10, Math.round(h * 0.022)));
    ctx.fillStyle = "#334155";
    for (const line of String(scene.questionCode).split("\n").slice(0, 8)) {
      ctx.fillText(line.slice(0, 100), x + padX, cy);
      cy += Math.max(10, Math.round(h * 0.022)) * 1.35;
    }
    ctx.globalAlpha = 1;
  }

  cy += fontHint * 1.1;
  const hintIdx = isPredict ? 2 : 1;
  ctx.globalAlpha = revealAlpha(progress, hintIdx, steps.length);
  ctx.font = canvasFont(600, fontHint);
  ctx.fillStyle = "#6b7280";
  ctx.fillText(hint, x + padX, cy);
  cy += fontHint * 1.4 + optionGap;
  ctx.globalAlpha = 1;

  const optStart = isPredict ? 3 : 2;
  const optionLineH = fontOption * 1.35;
  const optionPadY = Math.max(8, fontOption * 0.35);
  const markerColW = optionH * 0.28 + markerSize + optionH * 0.25;
  const maxOptTextW = innerW - markerColW - Math.round(padX * 0.15);
  let optY = cy;

  opts.slice(0, 4).forEach((opt, i) => {
    const alpha = revealAlpha(progress, optStart + i, steps.length);
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;

    const label = `${String.fromCharCode(65 + i)}. ${opt}`;
    ctx.font = canvasFont(600, fontOption);
    const lines = wrapLines(ctx, label, maxOptTextW);
    const boxH = Math.max(optionH, lines.length * optionLineH + optionPadY * 2);
    const oy = optY;

    roundRect(ctx, x + padX, oy, innerW, boxH, boxH * 0.22);
    ctx.strokeStyle = OPTION_ACCENT;
    ctx.lineWidth = Math.max(1.5, boxH * 0.04);
    ctx.stroke();

    const mx = x + padX + optionH * 0.28;
    const my = oy + boxH / 2;
    if (scene.questionKind === "msq" || scene.predictSelectMode === "msq") {
      roundRect(ctx, mx, my - markerSize / 2, markerSize, markerSize, markerSize * 0.22);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(mx + markerSize / 2, my, markerSize / 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = "#111827";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const textX = mx + markerSize + optionH * 0.25;
    const blockH = lines.length * optionLineH;
    let textY = oy + (boxH - blockH) / 2 + fontOption * 0.08;
    for (const line of lines) {
      ctx.fillText(line, textX, textY);
      textY += optionLineH;
    }

    optY += boxH + optionGap;
    ctx.globalAlpha = 1;
  });
}

function drawCodingBoard(ctx, scene, progress, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(x, y, w, h);

  const leftW = Math.round(w * 0.42);
  const rightX = x + leftW;
  const rightW = w - leftW;
  const testsAlpha = codingRevealProgress(progress, "tests");
  const codeH = testsAlpha > 0 ? Math.round(h * (1.35 / 2.35)) : h;
  const testsY = y + codeH;
  const testsH = h - codeH;
  const pad = Math.max(8, Math.round(Math.min(w, h) * 0.018));
  const fontTitle = Math.max(12, Math.round(h * 0.032));
  const fontBody = Math.max(9, Math.round(h * 0.022));
  const fontUi = Math.max(8, Math.round(h * 0.018));
  const fontMono = Math.max(8, Math.round(h * 0.02));
  const headerH = Math.max(22, Math.round(h * 0.048));
  const title = scene.codingTitle || scene.subtitle || "Coding Problem";
  const question = scene.questionText || "";
  const starterCode = scene.codingStarterCode || scene.code || "";
  const testCases = Array.isArray(scene.codingTestCases) ? scene.codingTestCases : [];

  drawFadeGroup(ctx, codingRevealProgress(progress, "problem"), () => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, leftW, h);
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rightX, y);
    ctx.lineTo(rightX, y + h);
    ctx.stroke();

    let cy = y + pad;
    ctx.fillStyle = "#111827";
    ctx.font = sansFont(600, fontTitle);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    cy = wrapTextPreserveNewlines(ctx, title, x + pad, cy, leftW - pad * 2, fontTitle * 1.25, 3);
    cy += pad * 0.6;
    if (question.trim()) {
      ctx.fillStyle = "#374151";
      ctx.font = sansFont(400, fontBody);
      wrapTextPreserveNewlines(ctx, question, x + pad, cy, leftW - pad * 2, fontBody * 1.35, 16);
    }
  });

  drawFadeGroup(ctx, codingRevealProgress(progress, "code"), () => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rightX, y, rightW, codeH);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rightX, y, rightW, headerH);
    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rightX, y + headerH);
    ctx.lineTo(rightX + rightW, y + headerH);
    ctx.stroke();

    const badgePadX = Math.max(6, Math.round(pad * 0.7));
    const badgePadY = Math.max(3, Math.round(pad * 0.35));
    ctx.font = sansFont(500, fontUi);
    const badgeLabel = "Code";
    const badgeW = ctx.measureText(badgeLabel).width + badgePadX * 2;
    const badgeH = fontUi + badgePadY * 2;
    const badgeX = rightX + pad;
    const badgeY = y + (headerH - badgeH) / 2;
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 4);
    ctx.fillStyle = "#f9fafb";
    ctx.fill();
    ctx.strokeStyle = "#e5e7eb";
    ctx.stroke();
    ctx.fillStyle = "#374151";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeLabel, badgeX + badgePadX, badgeY + badgeH / 2);

    ctx.fillStyle = "#9ca3af";
    ctx.font = sansFont(400, fontUi);
    ctx.textAlign = "right";
    ctx.fillText("Auto", rightX + rightW - pad, y + headerH / 2);

    const editorY = y + headerH;
    const editorH = codeH - headerH;
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(rightX, editorY, rightW, editorH);

    const lines = String(starterCode).split("\n").slice(0, 18);
    const lineH = Math.max(12, Math.round(fontMono * 1.55));
    const gutterW = Math.max(22, Math.round(pad * 2.2));
    ctx.font = monoFont(400, fontMono);
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
      const ly = editorY + pad * 0.55 + i * lineH;
      if (ly + lineH > editorY + editorH) return;
      ctx.fillStyle = "#858585";
      ctx.textAlign = "right";
      ctx.fillText(String(i + 1), rightX + gutterW, ly);
      ctx.fillStyle = "#d4d4d4";
      ctx.textAlign = "left";
      ctx.fillText(line || " ", rightX + gutterW + pad * 0.55, ly);
    });
  });

  drawFadeGroup(ctx, testsAlpha, () => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rightX, testsY, rightW, testsH);
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.moveTo(rightX, testsY);
    ctx.lineTo(rightX + rightW, testsY);
    ctx.stroke();

    const rowH = Math.max(20, Math.round(h * 0.042));
    ctx.fillStyle = "#111827";
    ctx.font = sansFont(600, fontUi);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const testcaseLabel = "Testcase";
    ctx.fillText(testcaseLabel, rightX + pad, testsY + rowH / 2);
    const testcaseW = ctx.measureText(testcaseLabel).width;
    ctx.fillStyle = "#9ca3af";
    ctx.font = sansFont(400, fontUi);
    ctx.fillText("Test Result", rightX + pad + testcaseW + pad, testsY + rowH / 2);

    ctx.strokeStyle = "#f3f4f6";
    ctx.beginPath();
    ctx.moveTo(rightX, testsY + rowH);
    ctx.lineTo(rightX + rightW, testsY + rowH);
    ctx.stroke();

    const tests = testCases.filter((t) => String(t?.input || "").trim() || String(t?.output || "").trim());
    const tabs = tests.length ? tests : [{ label: "Case 1", input: "", output: "" }];
    let tabX = rightX + pad;
    const tabY = testsY + rowH + pad * 0.35;
    const tabH = Math.max(16, Math.round(fontUi * 1.7));
    tabs.slice(0, 3).forEach((t, i) => {
      const label = t.label || `Case ${i + 1}`;
      ctx.font = sansFont(i === 0 ? 500 : 400, fontUi);
      const tw = ctx.measureText(label).width + pad;
      if (i === 0) {
        roundRect(ctx, tabX, tabY, tw, tabH, 4);
        ctx.fillStyle = "#f3f4f6";
        ctx.fill();
      }
      ctx.fillStyle = i === 0 ? "#1f2937" : "#6b7280";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tabX + pad * 0.4, tabY + tabH / 2);
      tabX += tw + pad * 0.35;
    });

    ctx.strokeStyle = "#f3f4f6";
    ctx.beginPath();
    ctx.moveTo(rightX, tabY + tabH + pad * 0.35);
    ctx.lineTo(rightX + rightW, tabY + tabH + pad * 0.35);
    ctx.stroke();

    let by = tabY + tabH + pad * 0.7;
    const active = tabs[0];
    const boxMaxW = rightW - pad * 2;
    const drawIoBlock = (label, value) => {
      ctx.fillStyle = "#6b7280";
      ctx.font = sansFont(500, fontUi);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(label, rightX + pad, by);
      by += fontUi * 1.35;
      const valueLines = String(value).split("\n").slice(0, 4);
      const boxPad = Math.max(4, Math.round(pad * 0.45));
      const valueLineH = fontMono * 1.35;
      const boxH = boxPad * 2 + valueLines.length * valueLineH;
      roundRect(ctx, rightX + pad, by, boxMaxW, boxH, 4);
      ctx.fillStyle = "#f9fafb";
      ctx.fill();
      ctx.strokeStyle = "#e5e7eb";
      ctx.stroke();
      ctx.fillStyle = "#1f2937";
      ctx.font = monoFont(400, fontMono);
      valueLines.forEach((vl, vi) => {
        ctx.fillText(vl, rightX + pad + boxPad, by + boxPad + vi * valueLineH);
      });
      by += boxH + pad * 0.55;
    };

    if (active && (String(active.input || "").trim() || String(active.output || "").trim())) {
      if (String(active.input || "").trim()) drawIoBlock("Input =", active.input);
      if (String(active.output || "").trim()) drawIoBlock("Output =", active.output);
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.font = sansFont(400, fontUi);
      ctx.textBaseline = "top";
      ctx.fillText("Add test case inputs…", rightX + pad, by);
    }
  });

  ctx.restore();
}

function paintQuestion(ctx, scene, card, elapsedMs, speechMs) {
  const boardPad = Math.round(Math.min(card.w, card.h) * 0.04);
  const bx = card.x + boardPad;
  const by = card.y + boardPad;
  const bw = card.w - boardPad * 2;
  const bh = card.h - boardPad * 2;
  const tl = questionTimeline(elapsedMs, scene, speechMs);
  const isCoding = scene.questionKind === "coding";
  const introText =
    scene.questionIntroText?.trim() ||
    (isCoding ? CODING_INTRO_DEFAULT : INTRO_DEFAULT);
  const markText =
    scene.questionMarkText?.trim() ||
    (isCoding ? CODING_MARK_DEFAULT : MARK_DEFAULT);
  const countdownSec = scene.questionMarkCountdownSec ?? QUESTION_MARK_COUNTDOWN_SEC;
  const countdownMs = questionMarkCountdownMs(scene);

  if (tl.phase === "intro" || tl.phase === "intro-gap") {
    drawIntroScreen(ctx, bx, by, bw, bh, introText);
    return;
  }
  if (tl.phase === "mark") {
    const left = markCountdownSeconds(tl.markElapsedMs, countdownMs);
    drawMarkScreen(ctx, bx, by, bw, bh, left, countdownSec, markText);
    return;
  }
  // question + mark-gap: keep full board visible (Studio behavior)
  if (isCoding) {
    drawCodingBoard(ctx, scene, tl.progress, bx, by, bw, bh);
  } else {
    drawMcqBoard(ctx, scene, tl.progress, bx, by, bw, bh);
  }
}

function paintTemplate(ctx, scene, card, t01, elapsedMs, totalMs) {
  const kind = scene.templateKind || "text";
  const text = scene.templateText || scene.subtitle || "";
  const color = scene.templateColor || FIXED_TEMPLATE_COLOR;
  const fontSize = scene.templateFontSize || FIXED_TEMPLATE_FONT;
  const scale = card.h / 1080;
  const fontPx = Math.max(16, Math.round(fontSize * scale));

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(card.x, card.y, card.w, card.h);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (kind === "countdown") {
    const totalSec = Math.max(1, Math.round(scene.templateCountdownSec ?? 5));
    const remaining = Math.max(
      0,
      totalSec - Math.floor(Math.min(totalSec, (elapsedMs / 1000))),
    );
    if (text.trim()) {
      ctx.font = canvasFont(600, Math.max(18, Math.round(fontPx * 0.28)));
      ctx.fillText(text.trim(), card.x + card.w / 2, card.y + card.h * 0.28);
    }
    ctx.font = canvasFont(700, fontPx);
    ctx.fillText(String(remaining), card.x + card.w / 2, card.y + card.h * 0.55);
    return;
  }

  let visible = text;
  let showCaret = false;
  if (kind === "typing") {
    const shown = Math.floor(text.length * Math.min(1, t01 * 1.08));
    visible = text.slice(0, shown);
    showCaret = shown < text.length;
  }

  ctx.font = canvasFont(600, fontPx);
  const lines = wrapLines(ctx, visible || " ", card.w * 0.84);
  const lineH = fontPx * 1.3;
  let y = card.y + card.h / 2 - ((lines.length - 1) * lineH) / 2;
  for (const line of lines) {
    ctx.fillText(line, card.x + card.w / 2, y);
    y += lineH;
  }
  if (showCaret) {
    const last = lines[lines.length - 1] || "";
    const lastW = ctx.measureText(last).width;
    ctx.fillRect(
      card.x + card.w / 2 + lastW / 2 + fontPx * 0.08,
      y - lineH - fontPx * 0.45,
      Math.max(2, fontPx * 0.12),
      fontPx * 0.9,
    );
  }
}

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "class", "extends", "new", "import", "from", "export", "default", "async",
  "await", "try", "catch", "throw", "typeof", "instanceof", "in", "of",
  "true", "false", "null", "undefined", "this", "def", "self", "print",
  "lambda", "None", "True", "False", "elif", "pass", "yield", "with", "as",
  "interface", "type", "enum", "public", "private", "protected", "static",
]);

function tokenizeLine(line) {
  const tokens = [];
  const commentIdx = (() => {
    const s = line.search(/(^|[^:])\/\//);
    const h = line.indexOf("#");
    const candidates = [
      s === -1 ? Infinity : s + (line[s] === "/" ? 0 : 1),
      h === -1 ? Infinity : h,
    ];
    const m = Math.min(...candidates);
    return m === Infinity ? -1 : m;
  })();
  const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  const comment = commentIdx >= 0 ? line.slice(commentIdx) : "";
  const re =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b|[{}()[\];,.:=+\-*/%<>!?&|]+|\s+|.)/g;
  let m;
  while ((m = re.exec(codePart)) !== null) {
    const t = m[0];
    let kind = "txt";
    if (/^["'`]/.test(t)) kind = "str";
    else if (/^\d/.test(t)) kind = "num";
    else if (/^[A-Za-z_$]/.test(t)) {
      if (KEYWORDS.has(t)) kind = "kw";
      else if (/^\s*\(/.test(codePart.slice(re.lastIndex))) kind = "fn";
    } else if (/^[{}()[\];,.:=+\-*/%<>!?&|]/.test(t)) kind = "pun";
    tokens.push({ text: t, kind });
  }
  if (comment) tokens.push({ text: comment, kind: "com" });
  return tokens;
}

function tokenColor(kind) {
  switch (kind) {
    case "kw":
      return "#9333ea";
    case "str":
      return "#059669";
    case "num":
      return "#d97706";
    case "com":
      return "#94a3b8";
    case "fn":
      return "#0284c7";
    case "pun":
      return "#64748b";
    default:
      return "#1e293b";
  }
}

function drawHighlightedLine(ctx, line, x, baseline, fontSize) {
  ctx.font = monoFont(500, fontSize);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  let cx = x;
  for (const tok of tokenizeLine(line)) {
    ctx.fillStyle = tokenColor(tok.kind);
    ctx.fillText(tok.text, cx, baseline);
    cx += ctx.measureText(tok.text).width;
  }
}

/** Pre-wrap output lines for the console panel (matches Studio CodeScene). */
function wrapOutputDisplayLines(ctx, output, maxW) {
  const lines = [];
  for (const rawLine of String(output || "").replace(/\r\n/g, "\n").split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }
    let line = rawLine;
    while (line.length > 0) {
      if (ctx.measureText(line).width <= maxW) {
        lines.push(line);
        break;
      }
      let cut = line.length;
      while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxW) cut -= 1;
      let breakAt = cut;
      const chunk = line.slice(0, cut);
      const space = chunk.lastIndexOf(" ");
      if (space > 0 && space > cut * 0.4) breakAt = space;
      const piece = line.slice(0, breakAt).trimEnd() || line.slice(0, cut);
      lines.push(piece);
      line = line.slice(breakAt).trimStart();
    }
  }
  return lines;
}

function measureCodeOutputPanel(ctx, output, w, fontSize, showOutput) {
  if (!showOutput) {
    return { height: 0, wrappedLines: [], bodyH: 0, maxBodyH: 0, outLineH: 0, opad: 0 };
  }
  const opad = Math.round(fontSize * 0.9);
  const outLineH = Math.round(fontSize * 1.35);
  const labelBlockH = Math.round(opad * 1.55);
  // Studio preview caps console body at max-h-[140px] (~10em at 14px).
  const maxBodyH = Math.max(Math.round(fontSize * 4), Math.round((140 * fontSize) / 14));
  const maxW = w - opad * 2;
  ctx.font = monoFont(500, Math.round(fontSize * 0.85));
  const wrappedLines = wrapOutputDisplayLines(ctx, output, maxW);
  const naturalBodyH = Math.max(outLineH, wrappedLines.length * outLineH);
  const bodyH = Math.min(naturalBodyH, maxBodyH);
  const height = labelBlockH + bodyH + Math.round(opad * 0.55);
  return { height, wrappedLines, bodyH, maxBodyH, outLineH, opad, labelBlockH };
}

/** Keep the typing caret / latest lines in view (scrollIntoView nearest). */
function codeScrollForTyping(contentTotalH, contentH, caretLineIndex, lineH) {
  const caretBottom = (caretLineIndex + 1) * lineH;
  const scrollToBottom = Math.max(0, contentTotalH - Math.max(1, contentH));
  const scrollToCaret = Math.max(0, caretBottom - Math.max(1, contentH));
  return Math.min(scrollToBottom, scrollToCaret);
}

function paintCodeTyping(ctx, scene, card, elapsedMs) {
  const x = card.x;
  const y = card.y;
  const w = card.w;
  const h = card.h;
  const radius = Math.round(Math.min(w, h) * 0.03);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, radius);
  ctx.stroke();

  const language = scene.codeLanguage || "ts";
  const title = scene.subtitle || `example.${language}`;
  const cps = scene.codeTypingCps ?? DEFAULT_CODE_TYPING_CPS;
  const beats = resolveCodeTypingBeats({
    beats: scene.codeTypingBeats,
    code: scene.code || scene.codingStarterCode || "",
    output: scene.codeOutput,
    runDelayMs: scene.codeRunDelayMs,
    outputHoldMs: scene.codeOutputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS,
  });
  // Guarantee at least one beat so Run → output can play for flat code scenes.
  const safeBeats =
    beats.length > 0
      ? beats
      : [
          {
            id: "beat-0",
            code: scene.code || "",
            output: scene.codeOutput || "",
            outputHoldMs: DEFAULT_CODE_OUTPUT_HOLD_MS,
            runDelayMs: DEFAULT_CODE_RUN_DELAY_MS,
          },
        ];
  const timeline = buildCodeBeatTimeline(safeBeats, cps);
  const frame = resolveCodeBeatFrame(Math.max(0, elapsedMs), timeline, cps);
  // Always show Run for typing scenes (Studio shows it whenever beats exist).
  const hasRun = true;
  const phase = frame.runPhase || "idle";
  const showOutput = !!frame.output && String(frame.output).trim().length > 0;
  const output = frame.output || "";

  const titleBarH = Math.max(36, Math.round(h * 0.1));
  const fontSize = Math.max(11, Math.round(h * 0.034));
  const lineH = Math.round(fontSize * 1.75);
  const lineNumW = Math.round(fontSize * 2.2);
  const pad = Math.round(fontSize * 1.1);
  const contentTopPad = Math.round(fontSize * 0.35);

  const outputPanel = measureCodeOutputPanel(ctx, output, w, fontSize, showOutput);
  const outputH = outputPanel.height;

  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(x, y, w, titleBarH);
  ctx.strokeStyle = "#e2e8f0";
  ctx.beginPath();
  ctx.moveTo(x, y + titleBarH);
  ctx.lineTo(x + w, y + titleBarH);
  ctx.stroke();

  const dotR = Math.max(4, Math.round(titleBarH * 0.18));
  const dotY = y + titleBarH / 2;
  let dotX = x + Math.round(fontSize * 1.1);
  for (const color of ["#f87171", "#facc15", "#4ade80"]) {
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fill();
    dotX += dotR * 2 + Math.round(fontSize * 0.55);
  }

  const runBtnW = hasRun ? Math.round(fontSize * 4.2) : 0;
  const runPad = Math.round(fontSize * 0.7);
  const runBtnX = hasRun ? x + w - runPad - runBtnW : x + w;

  ctx.fillStyle = "#475569";
  ctx.font = canvasFont(400, Math.round(fontSize * 0.92));
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const titleX = dotX + Math.round(fontSize * 0.8);
  const maxTitleW = runBtnX - titleX - fontSize * 0.5;
  let shownTitle = title;
  while (shownTitle.length > 0 && ctx.measureText(shownTitle).width > maxTitleW) {
    shownTitle = shownTitle.slice(0, -1);
  }
  if (shownTitle.length < title.length && shownTitle.length > 1) {
    shownTitle = `${shownTitle.slice(0, -1)}…`;
  }
  ctx.fillText(shownTitle, titleX, dotY);

  if (hasRun) {
    const runBtnH = Math.round(titleBarH * 0.58);
    const runBtnY = y + (titleBarH - runBtnH) / 2;
    const fill =
      phase === "idle" ? "#e2e8f0" : phase === "pressing" ? "#047857" : "#10b981";
    const textCol = phase === "idle" ? "#94a3b8" : "#ffffff";
    const scale = phase === "pressing" ? 0.94 : 1;
    const bw = runBtnW * scale;
    const bh = runBtnH * scale;
    const bx = runBtnX + (runBtnW - bw) / 2;
    const by = runBtnY + (runBtnH - bh) / 2;
    roundRect(ctx, bx, by, bw, bh, Math.round(bh * 0.22));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = textCol;
    ctx.font = monoFont(600, Math.round(fontSize * 0.72));
    ctx.textAlign = "center";
    ctx.fillText("▶ Run", bx + bw / 2, by + bh / 2 + 0.5);
    ctx.textAlign = "left";
  }

  const contentX = x + pad;
  const contentY = y + titleBarH + pad + contentTopPad;
  const contentW = w - pad * 2;
  const contentH = h - titleBarH - outputH - pad * 2 - contentTopPad;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y + titleBarH, w, Math.max(1, h - titleBarH - outputH));
  ctx.clip();
  ctx.beginPath();
  ctx.rect(contentX, contentY - contentTopPad, contentW, Math.max(1, contentH + contentTopPad));
  ctx.clip();

  const codeText = frame.visibleCode || "";
  const lines = String(codeText).split("\n");
  const contentTotalH = lines.length * lineH;
  const caretLineIndex = Math.max(0, lines.length - 1);
  const scrollY = codeScrollForTyping(contentTotalH, contentH, caretLineIndex, lineH);
  ctx.translate(0, -scrollY);

  lines.forEach((line, i) => {
    const ly = contentY + i * lineH;
    const baseline = ly + Math.round(fontSize * 0.85);
    ctx.fillStyle = "#94a3b8";
    ctx.font = monoFont(500, fontSize);
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(String(i + 1), contentX + lineNumW - 8, baseline);
    drawHighlightedLine(ctx, line, contentX + lineNumW, baseline, fontSize);
  });

  if (frame.showCaret) {
    const lastLine = lines[lines.length - 1] || "";
    const caretY = contentY + (lines.length - 1) * lineH;
    ctx.font = monoFont(500, fontSize);
    const caretX =
      contentX +
      lineNumW +
      ctx.measureText(lastLine).width +
      Math.round(fontSize * 0.15);
    ctx.fillStyle = "#334155";
    ctx.fillRect(
      caretX,
      caretY + Math.round(fontSize * 0.15),
      Math.max(2, fontSize * 0.12),
      fontSize * 0.9,
    );
  }
  ctx.restore();

  if (outputH > 0) {
    const oy = y + h - outputH;
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(x, oy, w, outputH);
    ctx.strokeStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.moveTo(x, oy);
    ctx.lineTo(x + w, oy);
    ctx.stroke();
    const { opad, labelBlockH, wrappedLines, bodyH, maxBodyH, outLineH } = outputPanel;
    ctx.fillStyle = "#64748b";
    ctx.font = monoFont(500, Math.round(fontSize * 0.65));
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("OUTPUT", x + opad, oy + Math.round(opad * 0.55));
    if (showOutput && wrappedLines.length > 0) {
      const bodyY = oy + labelBlockH;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, bodyY, w, bodyH);
      ctx.clip();
      ctx.fillStyle = "#1e293b";
      ctx.font = monoFont(500, Math.round(fontSize * 0.85));
      const naturalBodyH = wrappedLines.length * outLineH;
      const outputScrollY = Math.max(0, naturalBodyH - maxBodyH);
      let ly = bodyY - outputScrollY;
      for (const raw of wrappedLines) {
        ctx.fillText(raw, x + opad, ly);
        ly += outLineH;
      }
      ctx.restore();
    }
  }
}

function paintImage(ctx, scene, card, t01, assets, durationMs) {
  const r = Math.min(28, card.w * 0.025);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, card.x, card.y, card.w, card.h, r);
  ctx.fill();
  ctx.save();
  roundRect(ctx, card.x, card.y, card.w, card.h, r);
  ctx.clip();

  const skipFullBackground = shouldSkipFullBackground(scene);
  const covers = scene.revealCovers || [];
  const bgImg = !skipFullBackground ? assets.bgImg : null;

  const aspect =
    scene.bgAspect ||
    (bgImg ? bgImg.width / Math.max(1, bgImg.height) : 1536 / 1024);
  const cr = card.w / card.h;
  let dw;
  let dh;
  if (aspect > cr) {
    dw = card.w;
    dh = card.w / aspect;
  } else {
    dh = card.h;
    dw = card.h * aspect;
  }
  const dx = card.x + (card.w - dw) / 2;
  const dy = card.y + (card.h - dh) / 2;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(dx, dy, dw, dh);

  if (covers.length > 0 && bgImg) {
    const iw = bgImg.width || 1;
    const ih = bgImg.height || 1;
    covers.forEach((c, i) => {
      const start = i / Math.max(1, covers.length);
      const end = (i + 0.7) / Math.max(1, covers.length);
      let alpha = 0;
      if (t01 >= end) alpha = 1;
      else if (t01 > start) alpha = (t01 - start) / Math.max(0.001, end - start);
      if (alpha <= 0) return;
      const box = c.bbox || c;
      ctx.globalAlpha = alpha;
      ctx.drawImage(
        bgImg,
        box.x * iw,
        box.y * ih,
        box.w * iw,
        box.h * ih,
        dx + box.x * dw,
        dy + box.y * dh,
        box.w * dw,
        box.h * dh,
      );
      ctx.globalAlpha = 1;
    });
  } else if (bgImg && !skipFullBackground) {
    drawContain(ctx, bgImg, dx, dy, dw, dh);
  }

  const speechMs = scene.durationMs > 0 ? scene.durationMs : durationMs;
  const revealWindow = Math.max(0.02, 450 / Math.max(1, speechMs));
  const useAspectBoard = skipFullBackground && !!scene.bgAspect;
  let layoutW = card.w;
  let layoutH = card.h;
  let originX = card.x;
  let originY = card.y;
  if (useAspectBoard) {
    layoutW = dw;
    layoutH = dh;
    originX = dx;
    originY = dy;
  }

  for (const el of scene.elements || []) {
    const appear = typeof el.appearAt === "number" ? el.appearAt : 0;
    if (t01 < appear) continue;
    const img = assets.elementImgs?.get(el.id);
    if (!img) continue;
    const p = Math.min(1, (t01 - appear) / revealWindow);
    const ease = 1 - Math.pow(1 - p, 3);

    const bboxPos = el.bbox
      ? {
          x: el.bbox.x + el.bbox.w / 2,
          y: el.bbox.y + el.bbox.h / 2,
          w: el.bbox.w,
          h: el.bbox.h,
        }
      : null;
    const pos = bboxPos ?? { x: el.x || 0.5, y: el.y || 0.5, w: el.w || 0.2, h: el.h };

    const boxW = layoutW * pos.w;
    const boxH = pos.h != null ? layoutH * pos.h : boxW;
    const iw = img.width || 1;
    const ih = img.height || 1;
    const ratio = ih / iw;
    const boxRatio = boxH / Math.max(1, boxW);
    let targetW;
    let targetH;
    if (ratio > boxRatio) {
      targetH = boxH;
      targetW = boxH / ratio;
    } else {
      targetW = boxW;
      targetH = boxW * ratio;
    }
    const cx = originX + pos.x * layoutW;
    const cy = originY + pos.y * layoutH;

    let scale = 1;
    let dxOff = 0;
    let dyOff = 0;
    switch (el.anim) {
      case "pop":
        scale = 0.6 + 0.4 * ease;
        break;
      case "slide-up":
        dyOff = (1 - ease) * 40;
        break;
      case "slide-left":
        dxOff = (1 - ease) * -60;
        break;
      case "slide-right":
        dxOff = (1 - ease) * 60;
        break;
      default:
        break;
    }

    ctx.save();
    ctx.globalAlpha = ease;
    ctx.globalCompositeOperation = "multiply";
    ctx.translate(cx + dxOff, cy + dyOff);
    ctx.scale(scale, scale);
    ctx.drawImage(img, -targetW / 2, -targetH / 2, targetW, targetH);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * @param {*} createCanvas from @napi-rs/canvas
 * @param {number} t01 speech progress 0..1 (images/templates/code)
 * @param {number} durationMs speech duration for non-question scenes
 * @param {{ sceneElapsedMs?: number, speechMs?: number }} opts
 */
export async function paintCanvasScene(
  createCanvas,
  scene,
  W,
  H,
  t01,
  assets,
  durationMs,
  opts = {},
) {
  loadCanvasFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  // Full-bleed orange loop (Studio-style) — baked into the frame so encode is local-only.
  if (assets?.bgLoopFrame) {
    const img = assets.bgLoopFrame;
    const ir = img.width / Math.max(1, img.height);
    const br = W / Math.max(1, H);
    let dw;
    let dh;
    if (ir > br) {
      dh = H;
      dw = H * ir;
    } else {
      dw = W;
      dh = W / ir;
    }
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = "#E8A35C";
    ctx.fillRect(0, 0, W, H);
  }

  const card = cardRect(W, H);
  const r = Math.min(28, card.w * 0.025);
  // Soft shadow white card
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = Math.round(H * 0.03);
  ctx.shadowOffsetY = Math.round(H * 0.012);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, card.x, card.y, card.w, card.h, r);
  ctx.fill();
  ctx.shadowColor = "transparent";

  const kind = scene.kind || "image";
  const speechElapsedMs = t01 * Math.max(1, durationMs);
  const sceneElapsedMs =
    opts.sceneElapsedMs != null ? opts.sceneElapsedMs : speechElapsedMs;
  const speechMs = opts.speechMs != null ? opts.speechMs : durationMs;

  if (kind === "question") {
    paintQuestion(ctx, scene, card, sceneElapsedMs, speechMs);
    return canvas;
  }

  const isCode =
    kind === "code" ||
    (kind === "template" && scene.templateKind === "codeTyping");
  if (isCode) {
    ctx.save();
    roundRect(ctx, card.x, card.y, card.w, card.h, r);
    ctx.clip();
    // Absolute scene clock — do not freeze at speechMs or Run/output never appear.
    paintCodeTyping(ctx, scene, card, sceneElapsedMs);
    ctx.restore();
    return canvas;
  }

  if (kind === "template") {
    ctx.save();
    roundRect(ctx, card.x, card.y, card.w, card.h, r);
    ctx.clip();
    paintTemplate(ctx, scene, card, t01, speechElapsedMs, durationMs);
    ctx.restore();
    return canvas;
  }

  // image (and unknown → image path)
  paintImage(ctx, scene, card, t01, assets, durationMs);
  return canvas;
}

export { isCropOnlyScene, shouldSkipFullBackground, questionPreMs, questionPostVisualMs };
