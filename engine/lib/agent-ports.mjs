/** Stable encode worker — what Studio used first. Do not steal this if it is busy. */
export const STABLE_PORT = 3850;
/** Isolated worker for the crash-proof agent (encode survives the Electron window). */
export const DEV_PORT = 3851;

export function defaultAgentPort() {
  const raw = Number(process.env.PORT || 0);
  if (raw > 0) return raw;
  return STABLE_PORT;
}

export function dataRootForPort(baseDataRoot, port) {
  if (port === STABLE_PORT) return baseDataRoot;
  return `${baseDataRoot}-${port}`;
}
