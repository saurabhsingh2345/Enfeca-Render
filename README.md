# Enfeca Render

Self-contained HD render stack for **Div Studio / Lovable**. One folder, one setup script — copy to any Mac, paste an API key, start rendering.

## What's inside

| Path | Role |
|------|------|
| `cloud/` | Queue UI on **http://127.0.0.1:3849** — claims jobs, reports progress, uploads MP4 |
| `engine/` | Local encode worker (ffmpeg + canvas) — same engine as Explainer Render Agent |
| `worker-3853/` / `worker-3854/` | Isolated job data per worker |
| `data/out/` | Finished MP4s on this Mac |
| `.env` | **Single config file** — API key, machine name, ports |

## New machine (5 minutes)

### Requirements

- **macOS** (Apple Silicon or Intel)
- **Node.js 18+** — `brew install node` or [nodejs.org](https://nodejs.org)
- **~500 MB** for dependencies + disk space for MP4 output
- **RENDER_API_KEY** from Lovable Secrets (Div Studio)

### Setup

1. Copy the entire **`Enfeca Render`** folder to the Mac (Desktop is fine).
2. In Terminal:

```bash
cd ~/Desktop/Enfeca\ Render
bash setup.sh
```

3. Edit `.env` and paste your key:

```bash
RENDER_API_KEY=your_key_from_lovable_secrets
RENDER_MACHINE=mac-d-macbook
AUTO_CLAIM=1
```

4. Install background services (starts on login):

```bash
bash scripts/install-services.sh
```

5. Open **http://127.0.0.1:3849** — confirm the API key and a **unique** `RENDER_MACHINE` (`mac-d-macbook` on this Mac, `mac-enfec’s-macbook-pro` on the other). Auto-claim is on: the Mac polls Studio every 12s, renders one claimed job, uploads, then asks again. No need to click Render.

That's it. No separate Explainer Render Agent install, no manual port wiring.

### Without LaunchAgents (dev / testing)

```bash
# Terminal 1 — cloud queue
npm start

# Terminal 2 & 3 — workers (or use install-services.sh instead)
PORT=3853 AGENT_ISOLATED=1 AGENT_DATA_ROOT=./worker-3853 node engine/server.mjs
PORT=3854 AGENT_ISOLATED=1 AGENT_DATA_ROOT=./worker-3854 node engine/server.mjs
```

## Lovable render API

All requests use `Authorization: Bearer <RENDER_API_KEY>`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/public/render/jobs` | Queue view |
| `POST` | `/api/public/render/claim` | `{"machine":"mac-d-macbook"}` — claim next job + payload |
| `POST` | `/api/public/render/:id/progress` | `{"progress":0.42,"stage":"encoding","machine":"mac-d-macbook"}` every 20–30s; stop if `abort: true` |
| `PUT` | `/api/public/render/:id/output` | Raw MP4 body |
| `POST` | `/api/public/render/:id/fail` | `{"error":"..."}` |

Legacy `/api/public/bundles` is used as fallback if new routes are unavailable.

## Useful commands

```bash
bash scripts/doctor.sh          # check Node, deps, ports, API key
bash scripts/restart-services.sh
bash scripts/stop-services.sh
```

Logs: `/tmp/enfeca-render/cloud.log`, `worker-3853.log`, `worker-3854.log`

## Ports

| Port | Service |
|------|---------|
| **3849** | Enfeca Render queue UI |
| **3853 / 3854** | HD encode workers |

Do not run the old **Div Studio HD Render** stack on the same ports at the same time.

## Troubleshooting

- **401 / download failed** — check `RENDER_API_KEY` in `.env` or the web UI.
- **Worker stuck** — `bash scripts/restart-services.sh`
- **Port in use** — change `PORT` / `AGENT_PORTS` in `.env` and re-run `install-services.sh`
