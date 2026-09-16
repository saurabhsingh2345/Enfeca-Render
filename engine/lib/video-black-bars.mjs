/** Detect baked-in black/white matte padding around a video frame (Studio parity). */

const BlackLumaThreshold = 35;
const WhiteLumaThreshold = 235;
const RowColMatteFrac = 0.9;
const MaxScanFrac = 0.42;
const MinContentFrac = 0.35;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function matteKind(data, i) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (luma <= BlackLumaThreshold) return "black";
  if (luma >= WhiteLumaThreshold && chroma <= 18) return "white";
  return null;
}

function isMostlyMatteRow(data, width, y, x0, x1) {
  const row = y * width * 4;
  let black = 0;
  let white = 0;
  const count = Math.max(1, x1 - x0 + 1);
  for (let x = x0; x <= x1; x++) {
    const i = row + x * 4;
    const kind = matteKind(data, i);
    if (kind === "black") black += 1;
    if (kind === "white") white += 1;
  }
  return Math.max(black, white) / count >= RowColMatteFrac;
}

function isMostlyMatteCol(data, width, height, x, y0, y1) {
  let black = 0;
  let white = 0;
  const count = Math.max(1, y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) {
    const i = (y * width + x) * 4;
    const kind = matteKind(data, i);
    if (kind === "black") black += 1;
    if (kind === "white") white += 1;
  }
  return Math.max(black, white) / count >= RowColMatteFrac;
}

/**
 * Find content inside black letterboxing or white canvas padding.
 * Columns are removed first, then rows — handles white side pads + black top bar.
 */
export function detectVideoContentCropFromImageData(imageData) {
  const { width: w, height: h, data } = imageData;
  if (w < 8 || h < 8) return { x: 0, y: 0, w, h };

  const maxY = Math.floor(h * MaxScanFrac);
  const maxX = Math.floor(w * MaxScanFrac);

  let left = 0;
  while (left < maxX && isMostlyMatteCol(data, w, h, left, 0, h - 1)) {
    left += 1;
  }
  let right = w - 1;
  while (right > w - 1 - maxX && right > left && isMostlyMatteCol(data, w, h, right, 0, h - 1)) {
    right -= 1;
  }

  let top = 0;
  while (top < maxY && isMostlyMatteRow(data, w, top, left, right)) {
    top += 1;
  }
  let bottom = h - 1;
  while (bottom > h - 1 - maxY && bottom > top && isMostlyMatteRow(data, w, bottom, left, right)) {
    bottom -= 1;
  }

  let cw = right - left + 1;
  let ch = bottom - top + 1;

  if (cw < w * MinContentFrac || ch < h * MinContentFrac) {
    return { x: 0, y: 0, w, h };
  }

  const insetX = Math.min(4, Math.floor(cw * 0.01));
  const insetY = Math.min(4, Math.floor(ch * 0.01));
  if (left > 0) left = clamp(left + insetX, 0, w - 2);
  if (top > 0) top = clamp(top + insetY, 0, h - 2);
  if (right < w - 1) right = clamp(right - insetX, left + 1, w - 1);
  if (bottom < h - 1) bottom = clamp(bottom - insetY, top + 1, h - 1);
  cw = right - left + 1;
  ch = bottom - top + 1;

  return { x: left, y: top, w: cw, h: ch };
}

/** Map a downsampled canvas crop back to source pixel coordinates. */
export function detectVideoContentCropFromCanvas(canvas, sourceW, sourceH) {
  if (!sourceW || !sourceH) return { x: 0, y: 0, w: sourceW || 0, h: sourceH || 0 };
  const sw = canvas.width;
  const sh = canvas.height;
  if (sw < 8 || sh < 8) return { x: 0, y: 0, w: sourceW, h: sourceH };

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { x: 0, y: 0, w: sourceW, h: sourceH };

  const imageData = ctx.getImageData(0, 0, sw, sh);
  const sample = detectVideoContentCropFromImageData(imageData);

  return {
    x: Math.round((sample.x / sw) * sourceW),
    y: Math.round((sample.y / sh) * sourceH),
    w: Math.max(1, Math.round((sample.w / sw) * sourceW)),
    h: Math.max(1, Math.round((sample.h / sh) * sourceH)),
  };
}

export function isFullFrameCrop(crop, sourceW, sourceH) {
  return (
    crop.x <= 1 &&
    crop.y <= 1 &&
    crop.w >= sourceW - 2 &&
    crop.h >= sourceH - 2
  );
}
