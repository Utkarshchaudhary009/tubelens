"""Minimal test-only TTS placeholder server (stdlib only, no ML, no heavy deps).

Endpoints:
  GET /health      -> {"ok": true}
  GET /speak/<text> -> WAV sine-wave beep, Content-Type: audio/wav

The WAV is generated on-the-fly in memory (no model, no espeak).
Different texts produce slightly different tones so curl tests are audible.
Used only to validate GitHub Runner + Cloudflare Tunnel flow.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import struct
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse, parse_qs

SAMPLE_RATE = 22050


def tone_wav_bytes(text: str, freq: float | None = None, secs: float | None = None) -> bytes:
    """Generate a mono 16-bit WAV sine beep. Freq derived from text hash if omitted."""
    if freq is None:
        digest = hashlib.md5(text.encode("utf-8")).digest()
        # Map hash to 300–800 Hz so different texts sound different.
        freq = 300 + (int.from_bytes(digest[:2], "little") % 500)
    if secs is None:
        # 0.15s per char, clamped to 0.5–5s, so "/speak/hello" ~= 0.75s.
        secs = min(5.0, max(0.5, len(text) * 0.15))
    n = int(SAMPLE_RATE * secs)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        frames = bytearray()
        for i in range(n):
            # Sine with short fade in/out to avoid clicks.
            t = i / SAMPLE_RATE
            env = min(1.0, i / (SAMPLE_RATE * 0.02), (n - i) / (SAMPLE_RATE * 0.05))
            s = int(16000 * env * math.sin(2 * math.pi * freq * t))
            frames += struct.pack("<h", s)
        w.writeframes(bytes(frames))
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "tts-test/1.0"

    def log_message(self, fmt: str, *args: object) -> None:  # quieter single-line logs
        print(f"{self.address_string()} - {self.command} {self.path} - {fmt % args}", flush=True)

    def _send_json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (stdlib handler naming)
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(200, {"ok": True})
            return
        if parsed.path.startswith("/speak/"):
            text = unquote(parsed.path[len("/speak/"):]).strip()
            if not text:
                self._send_json(400, {"error": "empty text, try /speak/hello"})
                return
            qs = parse_qs(parsed.query)
            try:
                freq = float(qs["freq"][0]) if "freq" in qs else None
                secs = float(qs["secs"][0]) if "secs" in qs else None
                if freq is not None and not 50 <= freq <= 4000:
                    raise ValueError("freq must be 50-4000")
                if secs is not None and not 0.1 <= secs <= 10:
                    raise ValueError("secs must be 0.1-10")
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
                return
            wav = tone_wav_bytes(text, freq=freq, secs=secs)
            # Streamed in chunks so tunnel/proxy behavior matches real audio serving.
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.send_header("Content-Disposition", 'inline; filename="speak.wav"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            for i in range(0, len(wav), 8192):
                self.wfile.write(wav[i : i + 8192])
            return
        self._send_json(404, {"error": f"unknown path {parsed.path}, try /health or /speak/hello"})

    def do_HEAD(self) -> None:  # noqa: N802
        if urlparse(self.path).path in ("/health",) or urlparse(self.path).path.startswith("/speak/"):
            self.send_response(200)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"tts-test server listening on :{port} (GET /health, GET /speak/<text>)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
