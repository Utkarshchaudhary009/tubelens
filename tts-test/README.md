# tts-test — throwaway tunnel test server (NOT the real TTS model)

Minimal stdlib-only Python server that returns a generated WAV beep so we can
test **GitHub Runner → Cloudflare Tunnel → public curl** without any ML model.

## Endpoints

- `GET /health` → `{"ok": true}`
- `GET /speak/<text>` → `audio/wav` sine beep (freq derived from text hash).
  Optional query: `?freq=440&secs=1.5`

## Run locally

```bash
python3 tts-test/server.py            # listens on :8000 (PORT=8000 override)
curl -s http://localhost:8000/health
curl -o hello.wav http://localhost:8000/speak/hello && file hello.wav
```

No `pip install` needed (`requirements.txt` is intentionally empty).

## Tunnel test via GitHub Actions

1. GitHub → Actions → **tts-tunnel-test** → **Run workflow** (workflow_dispatch).
2. Watch the job log for:
   ```
   TUNNEL_URL=https://<random>.trycloudflare.com
   curl https://<random>.trycloudflare.com/health
   curl https://<random>.trycloudflare.com/speak/hello --output hello.wav
   ```
3. From your machine:
   ```bash
   curl https://<random>.trycloudflare.com/health
   curl https://<random>.trycloudflare.com/speak/hello --output hello.wav
   ```
4. Job stays alive ~30 min (or until you cancel it), then the tunnel URL expires.

> Free `trycloudflare.com` quick tunnel — no token, no account. URL changes every run.
