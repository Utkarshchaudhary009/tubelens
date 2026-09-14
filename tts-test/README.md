# tts-test — throwaway tunnel test server (NOT the real TTS model)

Minimal stdlib-only Python server that returns a generated WAV beep so we can
test **GitHub Runner → Cloudflare Tunnel → public curl** without any ML model.

## Endpoints

- `GET /health` → `{"ok": true}`
- `GET /speak/<text>` → `audio/wav` sine beep (freq derived from text hash).
  Optional query: `?freq=440&secs=1.5`
- `GET /transcript/<videoId>` (also `/transcript?videoId=xxx` or `?url=<watch url>`)
  → `{"videoId", "transcript": [{"text", "start", "duration"}], "cached": false}`
  via `youtube-transcript-api`. Errors: 400 on missing/invalid id,
  404/502 with `{error, hint}` when captions are disabled/unavailable.

## Run locally

```bash
python3 tts-test/server.py            # listens on :8000 (PORT=8000 override)
curl -s http://localhost:8000/health
curl -o hello.wav http://localhost:8000/speak/hello && file hello.wav
curl -s http://localhost:8000/transcript/dQw4w9WgXcQ | head -c 500
```

`pip install -r tts-test/requirements.txt` adds `youtube-transcript-api`
for `/transcript` (no GPU needed).

## Tunnel test via GitHub Actions

1. GitHub → Actions → **tts-tunnel-test** → **Run workflow** (workflow_dispatch).
2. Watch the job log for:
   ```
   TUNNEL_URL=https://<random>.trycloudflare.com
   curl https://<random>.trycloudflare.com/health
   curl https://<random>.trycloudflare.com/speak/hello --output hello.wav
   curl https://<random>.trycloudflare.com/transcript/dQw4w9WgXcQ
   ```
3. From your machine:
    ```bash
    curl https://<random>.trycloudflare.com/health
    curl https://<random>.trycloudflare.com/speak/hello --output hello.wav
    curl https://<random>.trycloudflare.com/transcript/dQw4w9WgXcQ
    ```
4. Job stays alive ~30 min (or until you cancel it), then the tunnel URL expires.

> Free `trycloudflare.com` quick tunnel — no token, no account. URL changes every run.
