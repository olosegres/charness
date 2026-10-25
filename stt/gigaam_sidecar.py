#!/usr/bin/env python3
"""GigaAM v3 speech-recognition sidecar for Charness.

ONE process: it loads the model at start, binds 127.0.0.1 on an OS-chosen port and serves an OpenAI-compatible
`POST /v1/audio/transcriptions` plus `GET /health`. The bot starts it on demand, adopts it across hot reloads,
and it takes itself down when it has been idle (`--idle-minutes`) or when its owner process is gone.

Every voice is cut at the centre of each pause of at least 500 ms that Silero VAD finds (the model drops a whole
phrase that follows a long pause when it decodes several phrases in one pass); no audio is ever discarded, and a
piece longer than 25 s is cut again at its quietest 50 ms. The pieces are recognised in parallel on a pool of
threads that share ONE onnxruntime session, strictly in arrival order (a short voice never overtakes an earlier one).

It claims the bot's record before it loads the model (an exclusive create, so a second start of the same engine
exits instead of becoming an unrecorded orphan) and completes it with its port once it listens.

Exit codes: 0 clean (SIGTERM, idle, owner gone), 1 the model, the socket, the record or the ready file could not be set up, 2 bad usage
(including a missing token), 4 another live sidecar already holds the record. Everything it has to say goes to `--log-file`: it is externally parented, so its
stdio may point at a dead pipe.

Protocol and layout: `src/stt/README.md`.
"""

from __future__ import annotations

import argparse
import collections
import itertools
import contextlib
import datetime
import email.parser
import email.policy
import hmac
import http.server
import io
import json
import logging
import logging.handlers
import os
import select
import socket
import signal
import subprocess
import sys
import threading
import time
import traceback

import numpy as np

# Bumped with every change of the sidecar's behaviour; the bot hashes it into the adoption check.
SCRIPT_VERSION = "2"
MODEL_NAME = "gigaam-v3-e2e-rnnt"
MODEL_QUANTIZATION = "int8"
TOKEN_ENV_NAME = "CHARNESS_STT_SIDECAR_TOKEN"

EXIT_OK = 0
EXIT_SETUP_FAILED = 1
EXIT_USAGE = 2
# Another live sidecar already holds the bot's record: this process was a second start of the same engine.
EXIT_DUPLICATE = 4

MAX_CHUNK_SECONDS = 25.0
# The rate the model and the VAD work at: the upload is resampled to it once.
SPEECH_SAMPLE_RATE = 16000
VAD_MODEL_NAME = "silero"
# A gap this long between two stretches of speech the VAD detects ends a piece. Measured on real speech (919 phrases,
# pauses of 0.3-2 s): 11 phrases lost against 10 when decoding each phrase alone (39 in one pass), and it splits 56 of 356
# continuous sentences with no loss of accuracy (4.91 % -> 4.86 % WER).
MIN_PAUSE_MS = 500
VAD_SPEECH_PAD_MS = 100
# onnx-asr compares the raw gap with `min_silence_duration_ms + 2 * speech_pad_ms`: given this, a gap of
# `MIN_PAUSE_MS` is what ends a piece.
VAD_MIN_SILENCE_MS = MIN_PAUSE_MS - 2 * VAD_SPEECH_PAD_MS
# The upload is resampled to 16 kHz window by window: onnxruntime keeps the largest buffer a session ever needed, and
# a 5-minute voice resampled at once raised the peak by ~240 MB (profiled; 30 s windows: ~66 MB). The margin on each
# side is trimmed away again; with it the joined windows are identical to a one-pass resample on every sample, except
# that the last one may be dropped (the trims round, the model rounds up: at most 63 µs; measured at every supported
# rate). Both are whole seconds, so their length at 16 kHz is a whole number of samples for every supported rate.
RESAMPLE_WINDOW_SECONDS = 30
RESAMPLE_MARGIN_SECONDS = 1
# The install check's 1 s of silence is at Telegram's Opus rate, so it runs the resampler too, and a VAD that fails
# shows as pieces left at this rate (the fallback keeps the file's own rate).
CHECK_SAMPLE_RATE = 48000
SILENCE_SEARCH_SECONDS = 8.0
SILENCE_WINDOW_SECONDS = 0.05
# The encoder fails on fewer than ~25 ms of audio; a piece this short holds no word anyway.
MIN_CHUNK_SECONDS = 0.1
# The sample rates onnx-asr resamples to 16 kHz itself.
SUPPORTED_SAMPLE_RATES = (8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000)

MAX_BODY_BYTES = 25 * 1024 * 1024
MAX_HEADER_LINE_BYTES = 8192
DEFAULT_MAX_SECONDS = 600.0
SOCKET_TIMEOUT_SECONDS = 120.0
REQUEST_QUEUE_SIZE = 16
IDLE_CHECK_SECONDS = 5.0
OWNER_CHECK_SECONDS = 2.0
PS_TIMEOUT_SECONDS = 3.0
SERVE_POLL_SECONDS = 0.5
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 1
FILE_MODE = 0o600
# The record's port while the model is still loading: the process is there, but nothing listens yet.
STARTING_PORT = 0
CLAIM_ATTEMPTS = 3
SECONDS_PER_MINUTE = 60.0
BEARER_PREFIX = "Bearer "
TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions"
# Once a voice is in line the sidecar answers an interim 102 naming the seconds of audio queued ahead of it, so the
# bot's timeout can count the wait in line (voices are recognised strictly in arrival order).
QUEUE_REPORT_STATUS = 102
QUEUED_AUDIO_SECONDS_HEADER = "X-Charness-Queued-Audio-Seconds"
# How often a waiting handler checks that its client is still connected.
CLIENT_CHECK_SECONDS = 0.5
HEALTH_PATH = "/health"
RESPONSE_FORMATS = ("json", "text")

logger = logging.getLogger("gigaam_sidecar")


class RequestError(Exception):
    """A failure that maps to an HTTP status and a message safe to show the client."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class RecognitionTimeout(Exception):
    """A request ran past `--max-seconds`."""


class ClientGone(Exception):
    """The client hung up while its voice waited (it timed out, or the bot moved on): nobody would read the text."""


# ──────────────────────────────── audio ────────────────────────────────


def split_at_silences(
    audio: np.ndarray,
    sample_rate: int,
    max_seconds: float = MAX_CHUNK_SECONDS,
    search_seconds: float = SILENCE_SEARCH_SECONDS,
    window_seconds: float = SILENCE_WINDOW_SECONDS,
) -> list[np.ndarray]:
    """Cut `audio` into pieces of at most `max_seconds`, each cut at the centre of the lowest-energy window
    inside the last `search_seconds` before the boundary — usually a pause between words. Audio that already
    fits is one piece. The pieces joined give back `audio` exactly."""
    window = max(1, int(window_seconds * sample_rate))
    max_samples = max_seconds * sample_rate
    pieces: list[np.ndarray] = []
    start = 0
    while len(audio) - start > max_samples:
        search_start = start + int((max_seconds - search_seconds) * sample_rate)
        search_end = start + int(max_seconds * sample_rate)
        frames = audio[search_start:search_end]
        frames = frames[: len(frames) // window * window].reshape(-1, window)
        quietest = int(np.argmin((frames ** 2).mean(axis=1)))
        cut = search_start + quietest * window + window // 2
        pieces.append(audio[start:cut])
        start = cut
    pieces.append(audio[start:])
    return pieces


def split_at_pauses(audio: np.ndarray, speech_segments: list[tuple[int, int]], sample_rate: int) -> list[np.ndarray]:
    """Cut `audio` at the centre of the gap between every two consecutive speech segments (sample offsets, in
    order), then cut any piece longer than `MAX_CHUNK_SECONDS` with `split_at_silences`. The segments only choose
    where to cut: the pieces joined give back `audio` exactly, so speech the detector missed is still recognised."""
    cuts = [0]
    for (_, previous_end), (next_start, _) in zip(speech_segments, speech_segments[1:]):
        cut = (previous_end + next_start) // 2
        if cuts[-1] < cut < len(audio):
            cuts.append(cut)
    cuts.append(len(audio))
    pieces: list[np.ndarray] = []
    for start, end in zip(cuts, cuts[1:]):
        pieces.extend(split_at_silences(audio[start:end], sample_rate))
    return pieces


def split_without_pauses(samples: np.ndarray, sample_rate: int) -> tuple[list[np.ndarray], int]:
    """The splitter without a VAD: only the 25 s cuts, at the file's own rate."""
    return split_at_silences(samples, sample_rate), sample_rate


def make_pause_splitter(resample, find_speech):
    """The request splitter: `resample(samples, rate)` to `SPEECH_SAMPLE_RATE`, then `find_speech(audio)` → speech
    segments, then `split_at_pauses`. Returns the pieces and their rate. A failing resample or VAD falls back to
    `split_without_pauses`: the voice is still transcribed, only cut the old way."""

    def split(samples: np.ndarray, sample_rate: int) -> tuple[list[np.ndarray], int]:
        try:
            audio = resample(samples, sample_rate)
            speech_segments = find_speech(audio)
        except Exception:
            logger.error("pause detection failed, cutting at %.0f s only: %s", MAX_CHUNK_SECONDS, traceback.format_exc())
            return split_without_pauses(samples, sample_rate)
        return split_at_pauses(audio, speech_segments, SPEECH_SAMPLE_RATE), SPEECH_SAMPLE_RATE

    return split


def resample_in_windows(resample_once, samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """`resample_once(samples, rate)` → 16 kHz, applied to `RESAMPLE_WINDOW_SECONDS` windows that each read
    `RESAMPLE_MARGIN_SECONDS` beyond both ends; the margins are cut off the output again and the windows joined."""
    if sample_rate == SPEECH_SAMPLE_RATE:
        return samples
    ratio = SPEECH_SAMPLE_RATE / sample_rate
    window = RESAMPLE_WINDOW_SECONDS * sample_rate
    margin = RESAMPLE_MARGIN_SECONDS * sample_rate
    parts = []
    for start in range(0, len(samples), window):
        end = min(start + window, len(samples))
        read_from = max(0, start - margin)
        resampled = resample_once(samples[read_from : min(len(samples), end + margin)], sample_rate)
        keep_from = round((start - read_from) * ratio)
        parts.append(resampled[keep_from : keep_from + round((end - start) * ratio)])
    return np.concatenate(parts) if parts else samples[:0]


def make_model_pause_splitter(model, vad):
    """`make_pause_splitter` over the loaded model's own resampler and the Silero VAD."""

    def resample_once(samples: np.ndarray, sample_rate: int) -> np.ndarray:
        waveforms, lengths = model.resampler(samples[None], np.array([len(samples)], dtype=np.int64), sample_rate)
        return np.ascontiguousarray(waveforms[0][: int(lengths[0])], dtype=np.float32)

    def resample(samples: np.ndarray, sample_rate: int) -> np.ndarray:
        return resample_in_windows(resample_once, samples, sample_rate)

    def find_speech(audio: np.ndarray) -> list[tuple[int, int]]:
        (segments,) = vad.segment_batch(
            audio[None],
            np.array([len(audio)], dtype=np.int64),
            SPEECH_SAMPLE_RATE,
            min_silence_duration_ms=VAD_MIN_SILENCE_MS,
            speech_pad_ms=VAD_SPEECH_PAD_MS,
            # Never let the VAD cut a long stretch of speech itself: `split_at_pauses` caps the pieces at a quiet spot.
            max_speech_duration_s=len(audio) / SPEECH_SAMPLE_RATE + 1,
        )
        return [(int(start), int(end)) for start, end in segments]

    return make_pause_splitter(resample, find_speech)


def decode_audio(data: bytes) -> tuple[np.ndarray, int]:
    """Decode an uploaded file (Telegram sends OGG/Opus) to mono float32 samples and their sample rate."""
    import soundfile

    try:
        samples, sample_rate = soundfile.read(io.BytesIO(data), dtype="float32")
    except Exception as error:  # soundfile raises its own LibsndfileError / RuntimeError
        raise RequestError(400, "the audio file could not be decoded") from error
    if samples.ndim > 1:
        samples = samples.mean(axis=1, dtype=np.float32)
    if sample_rate not in SUPPORTED_SAMPLE_RATES:
        raise RequestError(400, f"unsupported sample rate {sample_rate}")
    return np.ascontiguousarray(samples, dtype=np.float32), int(sample_rate)


def make_recognizer(model):
    """The pool's recognise callback over a loaded model. A piece too short to hold a word is empty text, not
    an error: the encoder cannot take it."""

    def recognize(samples: np.ndarray, sample_rate: int) -> str:
        if len(samples) < MIN_CHUNK_SECONDS * sample_rate:
            return ""
        return model.recognize(samples, sample_rate=sample_rate)

    return recognize


# ──────────────────────────────── pool ────────────────────────────────


class PoolRequest:
    """One upload in the pool: its place in the arrival order, then its pieces once they are cut. Collects their
    texts in order and tells the waiting handler when all are in."""

    def __init__(self, on_finished):
        self.sample_rate = 0
        self._on_finished = on_finished
        self._chunks: list[np.ndarray] | None = None
        self._next_chunk = 0
        # The voice's length once decoded: what it counts for the requests behind it while it is still being cut.
        self._audio_seconds = 0.0
        self._texts: list[str | None] = []
        self._remaining = 0
        self._error: Exception | None = None
        self._lock = threading.Lock()
        self._finished = threading.Event()

    def is_finished(self) -> bool:
        return self._finished.is_set()

    def attach_chunks(self, chunks: list[np.ndarray], sample_rate: int) -> None:
        """The pieces are cut: from now on the pool hands them out. No pieces is empty text at once."""
        with self._lock:
            self.sample_rate = sample_rate
            self._texts = [None] * len(chunks)
            self._remaining = len(chunks)
            self._chunks = list(chunks)
            is_empty = not chunks
            if is_empty:
                self._finished.set()
        if is_empty:
            self._on_finished()

    def note_audio_seconds(self, seconds: float) -> None:
        self._audio_seconds = seconds

    def is_cut(self) -> bool:
        return self._chunks is not None

    def get_remaining_audio_seconds(self) -> float:
        """Audio still to recognise: the pieces not finished (the running ones included), or the decoded length while
        the voice is still being cut."""
        with self._lock:
            if self._finished.is_set():
                return 0.0
            if self._chunks is None:
                return self._audio_seconds
            samples = sum(len(chunk) for chunk, text in zip(self._chunks, self._texts) if text is None)
            return samples / self.sample_rate if self.sample_rate else 0.0

    def has_unclaimed_chunk(self) -> bool:
        return self._chunks is not None and self._next_chunk < len(self._chunks)

    def count_unclaimed_chunks(self) -> int:
        return len(self._chunks) - self._next_chunk if self._chunks is not None else 0

    def claim_next_chunk(self) -> tuple[int, np.ndarray]:
        """The next piece for a worker (the pool calls this under its own lock, so the pieces go out in order)."""
        index = self._next_chunk
        self._next_chunk += 1
        return index, self._chunks[index]

    def complete_chunk(self, index: int, text: str) -> None:
        with self._lock:
            if self._finished.is_set():
                return
            self._texts[index] = text
            self._remaining -= 1
            is_last = self._remaining == 0
            if is_last:
                self._finished.set()
        if is_last:
            self._on_finished()

    def fail(self, error: Exception) -> None:
        """Fail the whole request; the pool drops its pieces that were not handed out yet."""
        with self._lock:
            is_first_end = not self._finished.is_set()
            if is_first_end:
                self._error = error
                self._finished.set()
        if is_first_end:
            self._on_finished()

    def wait(self, timeout_seconds: float, is_abandoned=lambda: False) -> str:
        """The chunks' texts joined in order with single spaces; raises the first chunk error, `RecognitionTimeout`
        after `timeout_seconds`, or `ClientGone` once `is_abandoned()` says the client hung up (checked every
        `CLIENT_CHECK_SECONDS`); in both cases the pieces not handed out yet are dropped."""
        deadline = time.monotonic() + timeout_seconds
        while not self._finished.wait(max(0.0, min(CLIENT_CHECK_SECONDS, deadline - time.monotonic()))):
            if is_abandoned():
                self.fail(ClientGone())
            elif time.monotonic() >= deadline:
                self.fail(RecognitionTimeout())
        if self._error is not None:
            raise self._error
        return " ".join(text.strip() for text in self._texts if text and text.strip())


class RequestCancelled(Exception):
    """The upload never got its pieces (it could not be decoded): its place in the order is given up."""


class RecognitionPool:
    """W threads over the requests in strict arrival order (FIFO). A request takes its place when it arrives
    (`open_request`, before its audio is decoded and cut), so a voice that is quicker to cut never overtakes one that
    came earlier; the workers hand out the pieces of the first request with pieces left, in order, before any piece of
    the next one, and wait while a request ahead is still being cut. A request stays listed until it is finished, so
    the audio queued ahead of a voice counts the pieces still running too."""

    def __init__(self, recognize, workers: int):
        self._recognize = recognize
        self._workers = workers
        self._condition = threading.Condition()
        self._requests: collections.deque[PoolRequest] = collections.deque()
        self._is_stopping = False
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        for number in range(self._workers):
            thread = threading.Thread(target=self._work, name=f"stt-worker-{number}", daemon=True)
            thread.start()
            self._threads.append(thread)

    def stop(self) -> None:
        """The workers finish the piece they hold and leave; pieces not handed out yet are dropped."""
        with self._condition:
            self._is_stopping = True
            self._condition.notify_all()

    def queued_chunks(self) -> int:
        """Pieces waiting for a worker."""
        with self._condition:
            return sum(request.count_unclaimed_chunks() for request in self._requests if not request.is_finished())

    def get_audio_seconds_ahead(self, request: PoolRequest) -> float:
        """Seconds of audio that will be recognised before `request`: everything unfinished that arrived earlier."""
        with self._condition:
            ahead = itertools.takewhile(lambda listed: listed is not request, self._requests)
            return sum(listed.get_remaining_audio_seconds() for listed in ahead)

    def open_request(self) -> PoolRequest:
        """Take the next place in the arrival order; `submit` or `cancel` must follow."""
        with self._condition:
            request = PoolRequest(self._wake_workers)
            self._requests.append(request)
            return request

    def submit(self, request: PoolRequest, chunks: list[np.ndarray], sample_rate: int) -> None:
        request.attach_chunks(chunks, sample_rate)
        self._wake_workers()

    def cancel(self, request: PoolRequest) -> None:
        request.fail(RequestCancelled())

    def _wake_workers(self) -> None:
        with self._condition:
            self._condition.notify_all()

    def _take_next_chunk(self) -> tuple[PoolRequest, int, np.ndarray] | None:
        with self._condition:
            while not self._is_stopping:
                while self._requests and self._requests[0].is_finished():
                    self._requests.popleft()
                for listed in self._requests:
                    if listed.is_finished():
                        continue
                    if listed.has_unclaimed_chunk():
                        index, samples = listed.claim_next_chunk()
                        return listed, index, samples
                    if not listed.is_cut():
                        break  # still being cut: nothing behind it may go first
                self._condition.wait()
            return None

    def _work(self) -> None:
        while True:
            taken = self._take_next_chunk()
            if taken is None:
                return
            request, index, samples = taken
            if request.is_finished():
                continue
            try:
                text = self._recognize(samples, request.sample_rate)
            except Exception as error:  # one broken chunk fails its request only
                logger.error("chunk %d failed: %s", index, traceback.format_exc())
                request.fail(error)
                continue
            request.complete_chunk(index, text)


# ──────────────────────────────── HTTP ────────────────────────────────


def parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], bytes | None]:
    """The text fields and the `file` part of a multipart/form-data body (`cgi` is gone from Python 3.13)."""
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1", "replace")
    message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(header + body)
    if message.get_content_type() != "multipart/form-data" or not message.is_multipart():
        raise RequestError(400, "expected a multipart/form-data body")
    fields: dict[str, str] = {}
    file_bytes: bytes | None = None
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not isinstance(name, str):
            continue
        payload = part.get_payload(decode=True) or b""
        if name == "file":
            file_bytes = payload
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, file_bytes


def read_exact(stream, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise RequestError(400, "the request body ended early")
    return data


def read_chunked_body(stream, limit: int) -> bytes:
    """Decode `Transfer-Encoding: chunked` — Node's form-data uploads without a Content-Length."""
    body = bytearray()
    while True:
        size_line = stream.readline(MAX_HEADER_LINE_BYTES)
        try:
            size = int(size_line.split(b";", 1)[0].strip(), 16)
        except ValueError:
            raise RequestError(400, "malformed chunked body") from None
        if size == 0:
            break
        if len(body) + size > limit:
            raise RequestError(413, "the audio file is too large")
        body += read_exact(stream, size)
        read_exact(stream, 2)  # the CRLF that ends the chunk
    while stream.readline(MAX_HEADER_LINE_BYTES) not in (b"\r\n", b"\n", b""):
        pass  # trailers
    return bytes(body)


def read_request_body(handler: http.server.BaseHTTPRequestHandler, limit: int) -> bytes:
    if handler.headers.get("Transfer-Encoding", "").lower() == "chunked":
        return read_chunked_body(handler.rfile, limit)
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        raise RequestError(400, "malformed Content-Length") from None
    if length < 0:
        raise RequestError(400, "malformed Content-Length")
    if length > limit:
        raise RequestError(413, "the audio file is too large")
    return read_exact(handler.rfile, length)


class SidecarContext:
    """What the handlers and the monitors share."""

    def __init__(
        self,
        token: str,
        pool: RecognitionPool,
        split_audio,
        workers: int,
        idle_seconds: float,
        max_seconds: float,
        clock=time.monotonic,
    ):
        """`split_audio(samples, sample_rate)` → (pieces, their sample rate): `make_model_pause_splitter`, or
        `split_without_pauses` when the VAD could not be loaded."""
        self.token = token
        self.pool = pool
        self.split_audio = split_audio
        self.workers = workers
        self.idle_seconds = idle_seconds
        self.max_seconds = max_seconds
        self.clock = clock
        self.lock = threading.Lock()
        self.busy_requests = 0
        self.last_activity = clock()
        self.is_exiting = False

    def enter_request(self) -> bool:
        """Count a transcription in flight; false once the idle exit is decided (the client falls back)."""
        with self.lock:
            if self.is_exiting:
                return False
            self.busy_requests += 1
            return True

    def leave_request(self) -> None:
        with self.lock:
            self.busy_requests -= 1
            self.last_activity = self.clock()

    def is_idle(self) -> bool:
        """No transcription in flight, and none for `idle_seconds`. Never true when the idle exit is off (0)."""
        with self.lock:
            return self._is_idle_locked()

    def _is_idle_locked(self) -> bool:
        return self.idle_seconds > 0 and self.busy_requests == 0 and self.clock() - self.last_activity >= self.idle_seconds

    def decide_idle_exit(self, stop_accepting, resume_accepting) -> bool:
        """The idle exit's two-step decision. Stop taking connections first, then re-check under the lock: a request
        that slipped in meanwhile keeps the process alive (accepting resumes), otherwise the exit is final and any
        later request is refused with 503 so its client falls back. True when the process should exit."""
        if not self.is_idle():
            return False
        stop_accepting()
        with self.lock:
            self.is_exiting = self._is_idle_locked()
            is_exit_decided = self.is_exiting
        if not is_exit_decided:
            resume_accepting()
        return is_exit_decided


class SidecarServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = REQUEST_QUEUE_SIZE

    def __init__(self, address, context: SidecarContext):
        super().__init__(address, SidecarHandler)
        self.context = context


class SidecarHandler(http.server.BaseHTTPRequestHandler):
    server_version = "CharnessSttSidecar"
    protocol_version = "HTTP/1.1"
    timeout = SOCKET_TIMEOUT_SECONDS

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - the stdlib signature
        logger.info("%s %s", self.address_string(), format % args)

    def do_GET(self) -> None:
        if self.path != HEALTH_PATH:
            self._reply_error(404, "not found")
        elif not self._check_token():
            self._reply_error(401, "missing or wrong token")
        else:
            context = self.server.context
            self._reply_json(200, {
                "status": "ok",
                "busyRequests": context.busy_requests,
                "queuedChunks": context.pool.queued_chunks(),
                "workers": context.workers,
                "idleMinutes": context.idle_seconds / SECONDS_PER_MINUTE,
                "version": SCRIPT_VERSION,
                "pid": os.getpid(),
            })

    def do_POST(self) -> None:
        if self.path != TRANSCRIPTIONS_PATH:
            self._reply_error(404, "not found")
            return
        if not self._check_token():
            self._reply_error(401, "missing or wrong token")
            return
        context = self.server.context
        if not context.enter_request():
            self._reply_error(503, "the sidecar is shutting down")
            return
        try:
            self._transcribe(context)
        except RequestError as error:
            self._reply_error(error.status, error.message)
        except RecognitionTimeout:
            self._reply_error(504, "recognition took too long")
        except ClientGone:
            self.close_connection = True
        except Exception as error:
            logger.error("request failed: %s", traceback.format_exc())
            self._reply_error(500, f"recognition failed: {type(error).__name__}")
        finally:
            context.leave_request()

    def _check_token(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not header.startswith(BEARER_PREFIX):
            return False
        return hmac.compare_digest(header[len(BEARER_PREFIX):].encode(), self.server.context.token.encode())

    def _transcribe(self, context: SidecarContext) -> None:
        started = time.monotonic()
        body = read_request_body(self, MAX_BODY_BYTES)
        fields, file_bytes = parse_multipart(self.headers.get("Content-Type", ""), body)
        if not file_bytes:
            raise RequestError(400, "the file field is required")
        response_format = fields.get("response_format", "json")
        if response_format not in RESPONSE_FORMATS:
            raise RequestError(400, f"response_format must be one of {', '.join(RESPONSE_FORMATS)}")
        # The upload is in: its place in the arrival order is taken before the decoding and the cutting.
        request = context.pool.open_request()
        try:
            samples, sample_rate = decode_audio(file_bytes)
            audio_seconds = len(samples) / sample_rate
            request.note_audio_seconds(audio_seconds)
            chunks, chunk_sample_rate = context.split_audio(samples, sample_rate)
            # The pieces hold what is needed: the decoded file would only take memory while the voice waits.
            del samples, file_bytes, body
        except BaseException:
            context.pool.cancel(request)
            raise
        context.pool.submit(request, chunks, chunk_sample_rate)
        try:
            self._report_queue(context.pool.get_audio_seconds_ahead(request))
            text = request.wait(context.max_seconds, self._is_client_gone)
        except (ClientGone, OSError) as error:
            if isinstance(error, OSError):  # the interim report could not even be written: the client is gone
                request.fail(ClientGone())
            logger.info("the client left while %.1fs of audio waited; dropped", audio_seconds)
            raise ClientGone() from error
        logger.info(
            "transcribed %.1fs of audio in %d chunk(s), %.2fs", audio_seconds, len(chunks), time.monotonic() - started
        )
        if response_format == "text":
            self._reply(200, text.encode("utf-8"), "text/plain; charset=utf-8")
        else:
            self._reply_json(200, {"text": text})

    def _report_queue(self, seconds_ahead: float) -> None:
        """The interim 102: the voice is in line, with this much audio before it."""
        self.send_response_only(QUEUE_REPORT_STATUS)
        self.send_header(QUEUED_AUDIO_SECONDS_HEADER, f"{seconds_ahead:.1f}")
        self.end_headers()

    def _is_client_gone(self) -> bool:
        """The client closed its end (its request is fully read, so a readable socket with nothing to read is EOF)."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def _reply_json(self, status: int, payload: dict) -> None:
        self._reply(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _reply_error(self, status: int, message: str) -> None:
        self._reply_json(status, {"error": {"message": message}})

    def _reply(self, status: int, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        # One request per connection: an error may leave an unread body behind.
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True


# ──────────────────────────────── process ────────────────────────────────


def write_json_atomic(path: str, payload: dict) -> None:
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE), "w", encoding="utf-8") as stream:
        json.dump(payload, stream)
    os.replace(temporary, path)


def remove_record_if_owned(record_path: str, own_pid: int) -> bool:
    """Delete the bot's record of a sidecar only when it names THIS process — a newer generation's record
    stays. A missing or unreadable record is not an error."""
    try:
        with open(record_path, encoding="utf-8") as stream:
            record_pid = json.load(stream).get("pid")
        if record_pid != own_pid:
            return False
        os.unlink(record_path)
        return True
    except (OSError, ValueError, AttributeError):
        return False


def read_process_start_token(pid: int) -> str | None:
    """The token the bot records to tell a process from a reused pid: field 22 of `/proc/<pid>/stat` on Linux
    (None when gone or a zombie), elsewhere the `ps` text the bot reads (`lstart` + `command`)."""
    if not sys.platform.startswith("linux"):
        try:
            result = subprocess.run(
                ["ps", "-o", "lstart=", "-o", "command=", "-p", str(pid)],
                capture_output=True, text=True, timeout=PS_TIMEOUT_SECONDS, check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        return result.stdout.strip() or None
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as stream:
            stat = stream.read()
    except OSError:
        return None
    fields = stat[stat.rfind(")") + 1:].split()
    if not fields or fields[0] == "Z" or len(fields) < 20:
        return None
    return fields[19]


def build_record(args: argparse.Namespace, port: int, token: str, start_token: str) -> dict:
    """What the bot adopts this process from: the sidecar writes it ITSELF, so a bot worker that is replaced while it
    waits for the ready file leaves a process the next worker can find (the token is only in this process and in this
    file). `port` is STARTING_PORT until the server listens."""
    return {
        "pid": os.getpid(),
        "startToken": start_token,
        "port": port,
        "token": token,
        "configHash": args.config_hash,
        "ownerPid": args.owner_pid,
        "ownerStartToken": args.owner_start_token or "",
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


def read_record(record_path: str) -> dict | None:
    try:
        with open(record_path, encoding="utf-8") as stream:
            record = json.load(stream)
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def is_other_sidecar_alive(record: dict | None) -> bool:
    """The record names a process that is not this one and is still the process it was (the start token tells a
    reused pid)."""
    if record is None:
        return False
    pid = record.get("pid")
    if not isinstance(pid, int) or pid == os.getpid():
        return False
    return read_process_start_token(pid) == record.get("startToken")


def claim_record(args: argparse.Namespace, token: str, start_token: str) -> bool:
    """Take the bot's record BEFORE the slow model load, with an exclusive create (a hard link of a finished file, so
    a reader never sees half a record): of two sidecars started at once — a bot worker replaced mid-start asks again
    — only the first is ever recorded, and the second learns it here instead of becoming an unrecorded orphan.
    False: another live sidecar holds the record. A record of a dead process is replaced."""
    temporary = f"{args.record_file}.{os.getpid()}.claim"
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE), "w", encoding="utf-8") as stream:
        json.dump(build_record(args, STARTING_PORT, token, start_token), stream)
    try:
        for _ in range(CLAIM_ATTEMPTS):
            try:
                os.link(temporary, args.record_file)
                return True
            except FileExistsError:
                if is_other_sidecar_alive(read_record(args.record_file)):
                    return False
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(args.record_file)
        raise OSError(f"could not claim {args.record_file}")
    finally:
        with contextlib.suppress(OSError):
            os.unlink(temporary)


def publish_port(args: argparse.Namespace, port: int, token: str, start_token: str) -> bool:
    """Put the listening port into the record, while the record is still this process's (the bot may have stopped
    this start and taken it away)."""
    current = read_record(args.record_file)
    if current is None or current.get("pid") != os.getpid():
        return False
    write_json_atomic(args.record_file, build_record(args, port, token, start_token))
    return True


def is_owner_alive(owner_pid: int, owner_start_token: str | None) -> bool:
    try:
        os.kill(owner_pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass  # alive, but another user's
    if owner_start_token is None or not sys.platform.startswith("linux"):
        return True
    return read_process_start_token(owner_pid) == owner_start_token


def setup_logging(log_file: str) -> None:
    handler = logging.handlers.RotatingFileHandler(
        log_file, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    threading.excepthook = lambda args: logger.error(
        "thread %s crashed: %s", args.thread.name if args.thread else "?", "".join(traceback.format_exception(*args[:3]))
    )


def detach_stdio() -> None:
    """The parent may be gone and its pipes with it: point the standard streams at /dev/null."""
    devnull = os.open(os.devnull, os.O_RDWR)
    for descriptor in (0, 1, 2):
        os.dup2(devnull, descriptor)


def load_model(threads: int):
    import onnx_asr
    import onnxruntime

    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    return onnx_asr.load_model(MODEL_NAME, quantization=MODEL_QUANTIZATION, sess_options=options)


def load_vad():
    """Silero VAD on one thread: it runs once per request, in that request's handler thread."""
    import onnx_asr
    import onnxruntime

    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return onnx_asr.load_vad(VAD_MODEL_NAME, sess_options=options)


def run_check(args: argparse.Namespace) -> int:
    """Load the model and the VAD, recognise 1 s of silence through the pause splitter and print the versions —
    the installer's verify step (it also fetches both while the network is allowed)."""
    from importlib import metadata
    import platform

    try:
        import soundfile

        model = load_model(args.threads)
        split = make_model_pause_splitter(model, load_vad())
        silence = np.zeros(CHECK_SAMPLE_RATE, dtype=np.float32)
        pieces, piece_sample_rate = split(silence, CHECK_SAMPLE_RATE)
        if piece_sample_rate != SPEECH_SAMPLE_RATE:
            raise RuntimeError("the pause detection failed (its traceback is above, on stderr)")
        recognize = make_recognizer(model)
        text = " ".join(recognize(piece, piece_sample_rate) for piece in pieces).strip()
        is_opus_readable = "OPUS" in soundfile.available_subtypes("OGG")
        if not is_opus_readable:
            raise RuntimeError("libsndfile cannot read OGG/Opus")
        report = {
            "ok": True,
            "scriptVersion": SCRIPT_VERSION,
            "model": MODEL_NAME,
            "python": platform.python_version(),
            "onnxAsr": metadata.version("onnx-asr"),
            "onnxruntime": metadata.version("onnxruntime"),
            "soundfile": metadata.version("soundfile"),
            "libsndfile": soundfile.__libsndfile_version__,
            "numpy": metadata.version("numpy"),
            "silenceText": text,
        }
        print(json.dumps(report))
        return EXIT_OK
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return EXIT_SETUP_FAILED


def run_serve(args: argparse.Namespace, token: str) -> int:
    setup_logging(args.log_file)
    detach_stdio()
    logger.info(
        "starting pid=%d workers=%d threads=%d idle=%ss owner=%d", os.getpid(), args.workers, args.threads, args.idle_seconds, args.owner_pid
    )
    start_token = read_process_start_token(os.getpid())
    if start_token is None:
        logger.error("could not read the own start token")
        return EXIT_SETUP_FAILED
    try:
        is_claimed = claim_record(args, token, start_token)
    except OSError:
        logger.error("could not write the record: %s", traceback.format_exc())
        return EXIT_SETUP_FAILED
    if not is_claimed:
        logger.info("another sidecar already holds the record; exiting")
        return EXIT_DUPLICATE
    loading_started = time.monotonic()
    try:
        model = load_model(args.threads)
    except Exception:
        logger.error("model load failed: %s", traceback.format_exc())
        return EXIT_SETUP_FAILED
    logger.info("model loaded in %.2fs", time.monotonic() - loading_started)
    try:
        split_audio = make_model_pause_splitter(model, load_vad())
    except Exception:
        logger.error("the VAD could not be loaded, cutting at %.0f s only: %s", MAX_CHUNK_SECONDS, traceback.format_exc())
        split_audio = split_without_pauses

    pool = RecognitionPool(make_recognizer(model), args.workers)
    pool.start()
    context = SidecarContext(token, pool, split_audio, args.workers, args.idle_seconds, args.max_seconds)
    try:
        server = SidecarServer(("127.0.0.1", 0), context)
    except OSError:
        logger.error("could not bind: %s", traceback.format_exc())
        return EXIT_SETUP_FAILED
    port = server.server_address[1]

    stop_event = threading.Event()
    exit_code = [EXIT_OK]
    is_serving = threading.Event()

    def start_serving() -> None:
        def serve() -> None:
            is_serving.set()
            try:
                server.serve_forever(poll_interval=SERVE_POLL_SECONDS)
            finally:
                is_serving.clear()

        threading.Thread(target=serve, name="stt-http", daemon=True).start()

    def request_exit(code: int) -> None:
        exit_code[0] = code
        stop_event.set()

    def monitor_idle() -> None:
        while not stop_event.wait(IDLE_CHECK_SECONDS):
            if not context.decide_idle_exit(server.shutdown, start_serving):
                continue
            logger.info("idle for %.0fs; exiting", context.idle_seconds)
            remove_record_if_owned(args.record_file, os.getpid())
            request_exit(EXIT_OK)
            return

    def monitor_owner() -> None:
        while not stop_event.wait(OWNER_CHECK_SECONDS):
            if is_owner_alive(args.owner_pid, args.owner_start_token):
                continue
            logger.info("owner %d is gone; exiting", args.owner_pid)
            remove_record_if_owned(args.record_file, os.getpid())
            logging.shutdown()
            os._exit(EXIT_OK)

    for handled in (signal.SIGTERM, signal.SIGINT):
        signal.signal(handled, lambda *_: request_exit(EXIT_OK))

    try:
        if not publish_port(args, port, token, start_token):
            logger.error("the record was taken away while the model loaded; exiting")
            return EXIT_SETUP_FAILED
        write_json_atomic(args.ready_file, {"pid": os.getpid(), "port": port, "version": SCRIPT_VERSION})
    except OSError:
        logger.error("could not write the record or the ready file: %s", traceback.format_exc())
        return EXIT_SETUP_FAILED
    logger.info("ready on 127.0.0.1:%d", port)
    start_serving()
    threading.Thread(target=monitor_owner, name="stt-owner", daemon=True).start()
    if args.idle_seconds > 0:
        threading.Thread(target=monitor_idle, name="stt-idle", daemon=True).start()

    while not stop_event.wait(1.0):
        pass
    if is_serving.is_set():
        server.shutdown()
    server.server_close()
    pool.stop()
    logger.info("stopped (exit %d)", exit_code[0])
    logging.shutdown()
    os._exit(exit_code[0])


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Charness GigaAM speech-recognition sidecar")
    parser.add_argument("--check", action="store_true", help="load the model, recognise 1 s of silence, print versions")
    parser.add_argument("--ready-file", help="written atomically with {pid, port, version} once the server listens")
    parser.add_argument("--record-file", help="claimed by this process before it loads the model, completed with the port once it listens (the bot adopts it from this file); deleted on an idle exit if it names this pid")
    parser.add_argument("--config-hash", help="the bot's hash of the knobs this process was started with, recorded as is")
    parser.add_argument("--log-file", help="where every log line goes")
    parser.add_argument("--owner-pid", type=int, help="exit within ~2 s of this process dying")
    parser.add_argument("--owner-start-token", help="the owner's /proc start time (field 22), to tell a reused pid")
    parser.add_argument("--idle-minutes", type=float, default=15.0, help="exit after this long with no request; 0 = never")
    parser.add_argument("--idle-seconds", type=float, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--threads", type=int, default=2, help="onnxruntime intra-op threads per worker")
    parser.add_argument("--max-seconds", type=float, default=DEFAULT_MAX_SECONDS, help="give up on one request after this long")
    args = parser.parse_args(argv)
    if not args.check:
        for name in ("ready_file", "record_file", "log_file", "owner_pid", "config_hash"):
            if getattr(args, name) is None:
                parser.error(f"--{name.replace('_', '-')} is required")
    if args.idle_seconds is None:
        args.idle_seconds = args.idle_minutes * SECONDS_PER_MINUTE
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.check:
        return run_check(args)
    token = os.environ.get(TOKEN_ENV_NAME)
    if not token:
        try:
            sys.stderr.write(f"{TOKEN_ENV_NAME} is required\n")
        except OSError:
            pass
        return EXIT_USAGE
    return run_serve(args, token)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
