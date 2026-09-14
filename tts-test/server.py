"""Minimal test-only TTS server (stdlib only, no ML, no heavy deps).

Endpoints:
  GET /health      -> {"ok": true}
  GET /speak/<text>[?voice=en&speed=175] -> WAV spoken via espeak-ng, Content-Type: audio/wav
  GET /transcript/<videoId> (or /transcript?videoId=xxx / ?url=<watch url>)
    -> {"videoId": ..., "transcript": [{"text", "start", "duration"}], "cached": false}

Synthesis: `espeak-ng --stdout -v <voice> -s <speed> "<text>"` if the
espeak-ng binary is present (offline, tiny apt package). Falls back to the
legacy sine-wave beep only when espeak-ng is missing or fails, so the tunnel
flow test still passes on machines without espeak.
Different beep texts produce slightly different tones so curl tests are audible.
Transcript fetching uses the `youtube-transcript-api` pip package
(no GPU needed, plain HTTP to YouTube timedtext).
Used only to validate GitHub Runner + Cloudflare Tunnel flow.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import shutil
import struct
import subprocess
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse, parse_qs

SAMPLE_RATE = 22050
ESPEAK_BIN = shutil.which("espeak-ng")

# Keep voice values conservative: letters, digits, +/_/- only (e.g. "en", "en-us").
_VOICE_RE = re.compile(r"^[A-Za-z0-9_+\-]+$")
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_WATCH_ID_RES = (
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"/(?:embed|shorts|live|v)/([A-Za-z0-9_-]{11})"),
)


def espeak_wav_bytes(text: str, voice: str = "en", speed: int = 175) -> bytes | None:
    """Synthesize real speech via espeak-ng. Returns None if unavailable/failed."""
    if not ESPEAK_BIN:
        return None
    try:
        proc = subprocess.run(
            [ESPEAK_BIN, "--stdout", "-v", voice, "-s", str(speed), text],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    wav = proc.stdout or b""
    # Basic sanity: must look like a WAV (RIFF....WAVE) and be non-trivial.
    if proc.returncode != 0 or len(wav) < 500 or not wav.startswith(b"RIFF"):
        return None
    return wav


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


def extract_video_id_from_url(url: str) -> str | None:
    """Pull an 11-char video id out of a youtube watch/share/embed URL."""
    url = (url or "").strip()
    if not url:
        return None
    if _VIDEO_ID_RE.match(url):
        return url
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
    except ValueError:
        return None
    qs = parse_qs(parsed.query)
    for candidate in qs.get("v", []):
        if _VIDEO_ID_RE.match(candidate.strip()):
            return candidate.strip()
    haystack = f"{parsed.netloc}{parsed.path}"
    for rx in _WATCH_ID_RES:
        m = rx.search(haystack)
        if m:
            return m.group(1)
    return None


def fetch_transcript(video_id: str) -> list[dict]:
    """Fetch captions via youtube-transcript-api, normalized to text/start/duration.

    Supports both the >=1.x instance API (YouTubeTranscriptApi().fetch) and
    the legacy static API (YouTubeTranscriptApi.get_transcript).
    Raises RuntimeError when the package is not installed.
    """
    try:
        from youtube_transcript_api import YouTubeTranscriptApi  # type: ignore
    except ImportError as e:
        raise RuntimeError("youtube-transcript-api is not installed") from e

    raw: object = None
    if hasattr(YouTubeTranscriptApi, "fetch"):
        # Some releases expose fetch as instance method, some as static.
        try:
            raw = YouTubeTranscriptApi().fetch(video_id, languages=["en"])  # type: ignore[attr-defined]
        except TypeError:
            raw = YouTubeTranscriptApi.fetch(video_id, languages=["en"])  # type: ignore[attr-defined]
    elif hasattr(YouTubeTranscriptApi, "get_transcript"):
        raw = YouTubeTranscriptApi.get_transcript(video_id, languages=["en"])  # type: ignore[attr-defined]
    else:  # pragma: no cover - defensive for unknown future API shapes
        raise RuntimeError("installed youtube-transcript-api has no fetch/get_transcript API")

    out: list[dict] = []
    for snippet in list(raw or []):  # type: ignore[arg-type]
        if isinstance(snippet, dict):
            text = str(snippet.get("text", ""))
            start = float(snippet.get("start", 0.0))
            duration = float(snippet.get("duration", 0.0))
        else:
            text = str(getattr(snippet, "text", ""))
            start = float(getattr(snippet, "start", 0.0))
            duration = float(getattr(snippet, "duration", 0.0))
        out.append({"text": text, "start": start, "duration": duration})
    return out


def transcript_error_status(exc: BaseException) -> int:
    """Map transcript failures to HTTP status: 404 when missing/disabled, else 502."""
    name = type(exc).__name__
    msg = str(exc).lower()
    if name in {
        "TranscriptsDisabled",
        "NoTranscriptFound",
        "NoTranscriptAvailable",
        "NotTranslatable",
        "TranslationLanguageNotAvailable",
        "VideoUnavailable",
        "VideoNotFound",
        "VideoUnplayable",
        "AgeRestricted",
    } or any(
        s in msg
        for s in (
            "transcript",
            "caption",
            "subtitle",
            "unavailable",
            "not found",
            "disabled",
            "age",
            "private",
            "deleted",
        )
    ):
        return 404
    return 502


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
                voice = qs["voice"][0] if "voice" in qs else "en"
                speed = int(qs["speed"][0]) if "speed" in qs else 175
                if freq is not None and not 50 <= freq <= 4000:
                    raise ValueError("freq must be 50-4000")
                if secs is not None and not 0.1 <= secs <= 10:
                    raise ValueError("secs must be 0.1-10")
                if not _VOICE_RE.match(voice) or len(voice) > 32:
                    raise ValueError("voice must match [A-Za-z0-9_+-]{1,32} (e.g. en, en-us)")
                if not 80 <= speed <= 450:
                    raise ValueError("speed must be 80-450 wpm")
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
                return
            wav = espeak_wav_bytes(text, voice=voice, speed=speed)
            engine = "espeak-ng"
            if wav is None:
                # Fallback: legacy sine beep (espeak-ng missing or failed).
                wav = tone_wav_bytes(text, freq=freq, secs=secs)
                engine = "beep-fallback"
            # Streamed in chunks so tunnel/proxy behavior matches real audio serving.
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.send_header("Content-Disposition", 'inline; filename="speak.wav"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-TTS-Engine", engine)
            self.end_headers()
            for i in range(0, len(wav), 8192):
                self.wfile.write(wav[i : i + 8192])
            return
        if parsed.path == "/transcript" or parsed.path.startswith("/transcript/"):
            qs = parse_qs(parsed.query)
            path_id = unquote(parsed.path[len("/transcript/"):]).strip() if parsed.path.startswith("/transcript/") else ""
            path_id = path_id.split("/")[0].strip()
            query_id = (qs.get("videoId", [""])[0] or "").strip()
            query_url = (qs.get("url", [""])[0] or "").strip()
            video_id = ""
            if path_id:
                video_id = path_id
            elif query_id:
                # Accept a raw id or a full URL passed as videoId for convenience.
                video_id = query_id if _VIDEO_ID_RE.match(query_id) else (extract_video_id_from_url(query_id) or query_id)
            elif query_url:
                video_id = extract_video_id_from_url(query_url) or ""
            if not video_id:
                self._send_json(400, {"error": "missing videoId", "hint": "try /transcript/dQw4w9WgXcQ or /transcript?videoId=dQw4w9WgXcQ"})
                return
            if not _VIDEO_ID_RE.match(video_id):
                self._send_json(400, {"error": f"invalid videoId {video_id!r}", "hint": "videoId must be 11 chars [A-Za-z0-9_-], e.g. dQw4w9WgXcQ, or pass a watch URL via ?url="})
                return
            try:
                transcript = fetch_transcript(video_id)
            except RuntimeError as e:
                self._send_json(502, {"error": str(e), "hint": "pip install -r tts-test/requirements.txt"})
                return
            except Exception as e:  # youtube-transcript-api raises many typed errors; map by name/message
                status = transcript_error_status(e)
                hint = "captions may be disabled, auto-generated only, age-restricted, private, or the video is unavailable"
                self._send_json(status, {"error": f"{type(e).__name__}: {e}", "hint": hint})
                return
            self._send_json(200, {"videoId": video_id, "transcript": transcript, "cached": False})
            return
        self._send_json(404, {"error": f"unknown path {parsed.path}, try /health or /speak/hello"})

    def do_HEAD(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/health", "/transcript") or path.startswith(("/speak/", "/transcript/")):
            self.send_response(200)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"tts-test server listening on :{port} (GET /health, GET /speak/<text>, GET /transcript/<videoId>)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
