/** Port of Studio `src/lib/template-theme.ts`. */

export const TEMPLATE_THEMES = {
  orange: {
    accent: "#f67e00",
    stops: ["#ffb404", "#f67e00", "#e13900"],
    soft: "#fff7ed",
    softStrong: "#ffedd5",
    fallbackFill: "#E8A35C",
  },
  blue: {
    accent: "#0ea5e9",
    stops: ["#22d3ee", "#0ea5e9", "#2563eb"],
    soft: "#f0f9ff",
    softStrong: "#e0f2fe",
    fallbackFill: "#7ec8e3",
  },
};

export function resolveTemplateTheme(scene, jobTheme) {
  const raw = scene?.templateTheme ?? jobTheme ?? "orange";
  return raw === "blue" ? "blue" : "orange";
}

export function templatePalette(theme) {
  return TEMPLATE_THEMES[theme === "blue" ? "blue" : "orange"];
}

/** Scene templateColor wins unless empty or the default #111111. */
export function resolveTemplateColor(scene, theme) {
  const color = String(scene?.templateColor || "").trim();
  if (color && color.toLowerCase() !== "#111111") return color;
  return templatePalette(theme).accent;
}

export function canvasTemplateGradient(ctx, theme, x0, y0, x1, y1) {
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  const stops = templatePalette(theme).stops;
  gradient.addColorStop(0, stops[0]);
  gradient.addColorStop(0.5, stops[1]);
  gradient.addColorStop(1, stops[2]);
  return gradient;
}
