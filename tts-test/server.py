"""High-concurrency test-only TTS server (FastAPI + uvicorn, no ML, no heavy deps).

Endpoints (compatible with the original stdlib server):
  GET /health      -> {"ok": true}
  GET /speak/<text>[?voice=en&speed=175] -> WAV spoken via espeak-ng, Content-Type: audio/wav
  GET /transcript/<videoId> (or /transcript?videoId=xxx / ?url=<watch url>)
    -> {"videoId": ..., "transcript": [{"text", "start", "duration"}], "cached": false}

Concurrency design (goal: 100+ parallel with least latency):
  - FastAPI async handlers on uvicorn with ``--workers $(nproc)`` (one event
    loop per CPU; see ``tts-test/requirements.txt`` and the workflow).
  - espeak-ng runs as an async subprocess (never blocks the loop).
  - Blocking work (youtube-transcript-api, sine-beep fallback synthesis) runs
    in a shared 100-thread pool so parallel upstream fetches overlap.
  - In-memory LRU transcript cache (500 entries, 10 min TTL) + Cache-Control.
  - Gzip is applied to JSON only (never WAV — gzipping audio wastes CPU at
    100x parallel); uvicorn keeps HTTP keep-alive on by default.
  - All query/path validation happens BEFORE any I/O (early 400).
  - Upstream calls fail fast after 8s (asyncio.wait_for).
  - Every response carries X-Request-Id; when per-worker in-flight caps are
    hit the server returns 429 + Retry-After instead of hanging.

Used only to validate GitHub Runner + Cloudflare Tunnel flow.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import gzip
import hashlib
import io
import math
import os
import re
import shutil
import struct
import subprocess
import uuid
import wave
from collections import OrderedDict
from typing import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

SAMPLE_RATE = 22050
ESPEAK_BIN = shutil.which("espeak-ng")

# Fail-fast budget for any upstream work (espeak subprocess, transcript fetch).
UPSTREAM_TIMEOUT_S = 8.0

# In-flight caps per worker process. Total capacity ~= workers x cap, so with
# --workers $(nproc) this comfortably covers 100+ parallel clients. When a cap
# is hit we return 429 + Retry-After instead of queueing (graceful overload).
SPEAK_MAX_INFLIGHT = int(os.getenv("TTS_MAX_SYNTH", "80"))
TRANSCRIPT_MAX_INFLIGHT = int(os.getenv("TTS_MAX_TRANSCRIPT", "100"))

# Transcript LRU cache: 500 entries, 10 min TTL (per worker process).
CACHE_MAX_ENTRIES = int(os.getenv("TTS_CACHE_SIZE", "500"))
CACHE_TTL_S = float(os.getenv("TTS_CACHE_TTL", "600"))

RETRY_AFTER_S = "2"

# Keep voice values conservative: letters, digits, +/_/- only (e.g. "en", "en-us").
_VOICE_RE = re.compile(r"^[A-Za-z0-9_+\-]+$")
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_WATCH_ID_RES = (
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"/(?:embed|shorts|live|v)/([A-Za-z0-9_-]{11})"),
)

# Longest text we will synthesize (early 400 beyond this, before any I/O).
MAX_TEXT_LEN = 500

# Shared pool for blocking calls (transcript HTTP, fallback beep synthesis).
# Sized for 100+ parallel clients; the loop itself never blocks.
_EXEC = concurrent.futures.ThreadPoolExecutor(max_workers=100, thread_name_prefix="tts")

app = FastAPI(title="tts-test", version="2.0")


# ---------------------------------------------------------------------------
# In-memory LRU transcript cache (per worker process)
# ---------------------------------------------------------------------------
_cache: OrderedDict[str, tuple[float, list[dict]]] = OrderedDict()
_cache_lock = asyncio.Lock()
_speak_inflight = 0
_transcript_inflight = 0
_inflight_lock = asyncio.Lock()


async def _cache_get(video_id: str) -> list[dict] | None:
    now = asyncio.get_running_loop().time()
    async with _cache_lock:
        hit = _cache.get(video_id)
        if hit is None:
            return None
        expires_at, transcript = hit
        if expires_at < now:
            _cache.pop(video_id, None)
            return None
        _cache.move_to_end(video_id)
        return transcript


async def _cache_put(video_id: str, transcript: list[dict]) -> None:
    now = asyncio.get_running_loop().time()
    async with _cache_lock:
        _cache[video_id] = (now + CACHE_TTL_S, transcript)
        _cache.move_to_end(video_id)
        while len(_cache) > CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)


class _Overloaded(Exception):
    """Raised when an in-flight cap is hit (maps to 429 + Retry-After)."""


async def _guarded(kind: str) -> Callable[[], Awaitable[None]]:
    """Reserve one in-flight slot; raise _Overloaded instead of queueing.

    Returns a ``release`` coroutine to call in a ``finally`` block.
    """
    global _speak_inflight, _transcript_inflight
    async with _inflight_lock:
        if kind == "speak":
            if _speak_inflight >= SPEAK_MAX_INFLIGHT:
                raise _Overloaded()
            _speak_inflight += 1
        else:
            if _transcript_inflight >= TRANSCRIPT_MAX_INFLIGHT:
                raise _Overloaded()
            _transcript_inflight += 1

    async def release() -> None:
        global _speak_inflight, _transcript_inflight
        async with _inflight_lock:
            if kind == "speak":
                _speak_inflight -= 1
            else:
                _transcript_inflight -= 1

    return release


# ---------------------------------------------------------------------------
# Speech synthesis helpers
# ---------------------------------------------------------------------------
def espeak_wav_bytes(text: str, voice: str = "en", speed: int = 175) -> bytes | None:
    """Sync espeak-ng synthesis (kept for compatibility; async path preferred)."""
    if not ESPEAK_BIN:
        return None
    try:
        proc = subprocess.run(
            [ESPEAK_BIN, "--stdout", "-v", voice, "-s", str(speed), text],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=UPSTREAM_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    wav = proc.stdout or b""
    if proc.returncode != 0 or len(wav) < 500 or not wav.startswith(b"RIFF"):
        return None
    return wav


async def espeak_wav_async(text: str, voice: str = "en", speed: int = 175) -> bytes | None:
    """Synthesize via espeak-ng without blocking the event loop (8s fail-fast)."""
    if not ESPEAK_BIN:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            ESPEAK_BIN, "--stdout", "-v", voice, "-s", str(speed), text,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=UPSTREAM_TIMEOUT_S)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return None
    except OSError:
        return None
    wav = out or b""
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


# ---------------------------------------------------------------------------
# Transcript helpers
# ---------------------------------------------------------------------------
def extract_video_id_from_url(url: str) -> str | None:
    """Pull an 11-char video id out of a youtube watch/share/embed URL."""
    url = (url or "").strip()
    if not url:
        return None
    if _VIDEO_ID_RE.match(url):
        return url
    try:
        from urllib.parse import parse_qs, urlparse

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


# ---------------------------------------------------------------------------
# Middleware: X-Request-Id + JSON-only gzip (never gzip WAV audio)
# ---------------------------------------------------------------------------
@app.middleware("http")
async def request_id_and_gzip(request: Request, call_next):  # type: ignore[no-untyped-def]
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    # Gzip JSON bodies only: WAVs are already large/CPU-heavy and gain nothing.
    ctype = response.headers.get("content-type", "")
    if ctype.startswith("application/json") and "content-encoding" not in response.headers:
        accept = request.headers.get("accept-encoding", "")
        if "gzip" in accept:
            # Response bodies are small JSON; read fully (avoids streaming cost).
            body = b""
            async for chunk in response.body_iterator:  # type: ignore[attr-defined]
                if isinstance(chunk, str):
                    chunk = chunk.encode()
                body += chunk
            if len(body) >= 500:
                gz = gzip.compress(body, compresslevel=5)
                headers = dict(response.headers)
                headers["content-encoding"] = "gzip"
                headers["content-length"] = str(len(gz))
                return Response(
                    content=gz,
                    status_code=response.status_code,
                    headers=headers,
                    media_type="application/json",
                )
    return response


@app.exception_handler(_Overloaded)
async def overloaded_handler(_: Request, exc: _Overloaded) -> JSONResponse:  # type: ignore[override]
    return JSONResponse(
        {"error": "server overloaded, retry shortly", "hint": "threadpool saturated; back off and retry"},
        status_code=429,
        headers={"Retry-After": RETRY_AFTER_S},
    )


@app.exception_handler(Exception)
async def unhandled_handler(_: Request, exc: Exception) -> JSONResponse:  # type: ignore[override]
    # Never leak stack traces; keep the envelope stable.
    return JSONResponse(
        {"error": f"{type(exc).__name__}: {exc}", "hint": "unexpected failure; retry shortly"},
        status_code=500,
    )


def _json(status: int, obj: dict, extra: dict | None = None) -> JSONResponse:
    headers = {"Cache-Control": "no-store"}
    if extra:
        headers.update(extra)
    return JSONResponse(obj, status_code=status, headers=headers)


# ---------------------------------------------------------------------------
# Routes (all validation happens BEFORE any I/O -> early 400)
# ---------------------------------------------------------------------------
@app.api_route("/health", methods=["GET", "HEAD"])
async def health() -> JSONResponse:
    return _json(200, {"ok": True})


def _validate_speak_params(
    text: str, voice: str, speed_raw: str, freq_raw: str | None, secs_raw: str | None
) -> tuple[str | None, float | None, float | None, str | None, int | None, JSONResponse | None]:
    """Validate /speak inputs. Returns (text, freq, secs, voice, speed, error)."""
    if not text:
        return None, None, None, None, None, _json(400, {"error": "empty text, try /speak/hello"})
    if len(text) > MAX_TEXT_LEN:
        return None, None, None, None, None, _json(
            400, {"error": f"text too long ({len(text)} chars, max {MAX_TEXT_LEN})"}
        )
    try:
        freq = float(freq_raw) if freq_raw is not None else None
        secs = float(secs_raw) if secs_raw is not None else None
        speed = int(speed_raw)
        if freq is not None and not 50 <= freq <= 4000:
            raise ValueError("freq must be 50-4000")
        if secs is not None and not 0.1 <= secs <= 10:
            raise ValueError("secs must be 0.1-10")
        if not _VOICE_RE.match(voice) or len(voice) > 32:
            raise ValueError("voice must match [A-Za-z0-9_+-]{1,32} (e.g. en, en-us)")
        if not 80 <= speed <= 450:
            raise ValueError("speed must be 80-450 wpm")
    except ValueError as e:
        return None, None, None, None, None, _json(400, {"error": str(e)})
    return text, freq, secs, voice, speed, None


async def _speak(text: str, request: Request) -> Response:
    from urllib.parse import unquote

    text = unquote(text).strip()
    qp = request.query_params
    text_v, freq, secs, voice, speed, err = _validate_speak_params(
        text,
        qp.get("voice", "en"),
        qp.get("speed", "175"),
        qp.get("freq"),
        qp.get("secs"),
    )
    if err is not None or text_v is None or voice is None or speed is None:
        return err or _json(400, {"error": "invalid request"})

    release = await _guarded("speak")
    try:
        loop = asyncio.get_running_loop()
        wav = await espeak_wav_async(text_v, voice=voice, speed=speed)
        engine = "espeak-ng"
        if wav is None:
            # Fallback beep in the thread pool so the loop never blocks on
            # CPU-bound sample synthesis.
            wav = await asyncio.wait_for(
                loop.run_in_executor(_EXEC, lambda: tone_wav_bytes(text_v, freq=freq, secs=secs)),
                timeout=UPSTREAM_TIMEOUT_S,
            )
            engine = "beep-fallback"
    except asyncio.TimeoutError:
        return _json(502, {"error": "synthesis timed out", "hint": "espeak-ng took >8s; retry shortly"})
    finally:
        await release()

    # Deterministic output for the same inputs -> publicly cacheable.
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "Content-Disposition": 'inline; filename="speak.wav"',
            "Cache-Control": "public, max-age=3600",
            "X-TTS-Engine": engine,
        },
    )


@app.api_route("/speak", methods=["GET", "HEAD"])
async def speak_empty() -> JSONResponse:
    return _json(400, {"error": "empty text, try /speak/hello"})


@app.api_route("/speak/{text:path}", methods=["GET", "HEAD"])
async def speak(text: str, request: Request) -> Response:
    return await _speak(text, request)


def _resolve_video_id(path_id: str, request: Request) -> tuple[str, JSONResponse | None]:
    from urllib.parse import unquote

    path_id = unquote(path_id or "").strip().split("/")[0].strip()
    qp = request.query_params
    query_id = (qp.get("videoId", "") or "").strip()
    query_url = (qp.get("url", "") or "").strip()
    video_id = ""
    if path_id:
        video_id = path_id
    elif query_id:
        video_id = query_id if _VIDEO_ID_RE.match(query_id) else (extract_video_id_from_url(query_id) or query_id)
    elif query_url:
        video_id = extract_video_id_from_url(query_url) or ""
    if not video_id:
        return "", _json(
            400,
            {
                "error": "missing videoId",
                "hint": "try /transcript/dQw4w9WgXcQ or /transcript?videoId=dQw4w9WgXcQ",
            },
        )
    if not _VIDEO_ID_RE.match(video_id):
        return "", _json(
            400,
            {
                "error": f"invalid videoId {video_id!r}",
                "hint": "videoId must be 11 chars [A-Za-z0-9_-], e.g. dQw4w9WgXcQ, or pass a watch URL via ?url=",
            },
        )
    return video_id, None


async def _transcript(video_id: str, request: Request) -> JSONResponse:
    video_id, err = _resolve_video_id(video_id, request)
    if err is not None or not video_id:
        return err or _json(400, {"error": "invalid request"})

    release = await _guarded("transcript")
    try:
        cached = await _cache_get(video_id)
        if cached is not None:
            return _json(
                200,
                {"videoId": video_id, "transcript": cached, "cached": True},
                {"Cache-Control": "public, max-age=600, stale-while-revalidate=60", "X-Cache": "HIT"},
            )
        loop = asyncio.get_running_loop()
        try:
            transcript = await asyncio.wait_for(
                loop.run_in_executor(_EXEC, lambda: fetch_transcript(video_id)),
                timeout=UPSTREAM_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            return _json(
                504,
                {
                    "error": "transcript upstream timed out",
                    "hint": "YouTube timedtext took >8s; retry shortly",
                },
            )
        await _cache_put(video_id, transcript)
        return _json(
            200,
            {"videoId": video_id, "transcript": transcript, "cached": False},
            {"Cache-Control": "public, max-age=600, stale-while-revalidate=60", "X-Cache": "MISS"},
        )
    except RuntimeError as e:
        return _json(502, {"error": str(e), "hint": "pip install -r tts-test/requirements.txt"})
    except Exception as e:  # youtube-transcript-api raises many typed errors; map by name/message
        status = transcript_error_status(e)
        hint = "captions may be disabled, auto-generated only, age-restricted, private, or the video is unavailable"
        return _json(status, {"error": f"{type(e).__name__}: {e}", "hint": hint})
    finally:
        await release()


@app.api_route("/transcript", methods=["GET", "HEAD"])
async def transcript_qs(request: Request) -> JSONResponse:
    return await _transcript("", request)


@app.api_route("/transcript/{video_id:path}", methods=["GET", "HEAD"])
async def transcript_path(video_id: str, request: Request) -> JSONResponse:
    return await _transcript(video_id, request)


@app.api_route("/{path:path}", methods=["GET", "HEAD"])
async def unknown(path: str) -> JSONResponse:
    return _json(404, {"error": f"unknown path /{path}, try /health or /speak/hello"})


def main() -> None:
    import multiprocessing

    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    workers = int(os.environ.get("TTS_WORKERS", "") or multiprocessing.cpu_count())
    print(
        f"tts-test server listening on :{port} "
        f"(GET /health, GET /speak/<text>, GET /transcript/<videoId>, workers={workers})",
        flush=True,
    )
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=port,
        workers=workers,
        loop="uvloop",
        http="httptools",
        timeout_keep_alive=30,
    )


if __name__ == "__main__":
    main()
