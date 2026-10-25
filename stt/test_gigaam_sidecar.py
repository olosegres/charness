"""Unit tests of the sidecar's logic — no model, no network beyond loopback. Run with the sidecar's own
interpreter (it needs numpy, soundfile and av):  <venv>/bin/python -I stt/test_gigaam_sidecar.py"""

import argparse
import contextlib
import functools
import io
import json
import logging
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import av  # noqa: E402
import numpy as np  # noqa: E402
import soundfile  # noqa: E402

import gigaam_sidecar as sidecar  # noqa: E402

# The sidecar logs failures it handles; without a handler Python would print them over the test output.
sidecar.logger.addHandler(logging.NullHandler())

SAMPLE_RATE = 16000
TEST_TOKEN = "test-token-0123456789"
BOUNDARY = "----formboundary7MA4YWxkTrZu0gW"
# The rate the HTTP tests' halving splitter reports, so the fake recognizer can tell its pieces apart.
HALVING_SPLITTER_RATE = 8000


def build_multipart(file_bytes: bytes, fields: dict | None = None) -> bytes:
    """A body shaped like the one Node's form-data sends: CRLF lines, a file part with a content type."""
    parts = []
    for name, value in (fields or {}).items():
        parts.append(
            f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    parts.append(
        f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="voice.ogg"\r\n'
        f"Content-Type: audio/ogg\r\n\r\n".encode() + file_bytes + b"\r\n"
    )
    parts.append(f"--{BOUNDARY}--\r\n".encode())
    return b"".join(parts)


class RawResponse:
    """A response read off a raw socket: the interim 1xx ones the sidecar sends first, then the final one."""

    def __init__(self, status: int, headers: dict, body: bytes, interim: list):
        self.status = status
        self.headers = headers
        self.body = body
        self.interim = interim


def parse_header_block(block: bytes) -> tuple[int, dict]:
    lines = block.decode("latin-1").split("\r\n")
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return int(lines[0].split(" ")[1]), headers


def read_raw_response(sock) -> RawResponse:
    """Read until the server closes (every sidecar response closes the connection) and split off the 1xx ones."""
    data = b""
    while True:
        received = sock.recv(65536)
        if not received:
            break
        data += received
    interim = []
    while True:
        block, _, data = data.partition(b"\r\n\r\n")
        status, headers = parse_header_block(block)
        if 100 <= status < 200:
            interim.append((status, headers))
            continue
        return RawResponse(status, headers, data, interim)


def send_raw_request(port: int, method: str, path: str, headers: dict, body: bytes = b"", is_chunked: bool = False):
    """A connected socket that has sent the request; with `is_chunked` the body is sent the way Node's form-data does."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    all_headers = {"Host": "127.0.0.1", **headers}
    if is_chunked:
        all_headers["Transfer-Encoding"] = "chunked"
        pieces = [body[index:index + 700] for index in range(0, len(body), 700)]
        body = b"".join(f"{len(piece):x}\r\n".encode() + piece + b"\r\n" for piece in pieces) + b"0\r\n\r\n"
    elif "Content-Length" not in all_headers:
        all_headers["Content-Length"] = str(len(body))
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{name}: {value}\r\n" for name, value in all_headers.items()) + "\r\n"
    sock.sendall(head.encode("latin-1") + body)
    return sock


def raw_request(port: int, method: str, path: str, headers: dict, body: bytes = b"", is_chunked: bool = False) -> RawResponse:
    sock = send_raw_request(port, method, path, headers, body, is_chunked)
    try:
        return read_raw_response(sock)
    finally:
        sock.close()


def read_interim_queue_report(sock) -> float:
    """Read up to the end of the sidecar's interim 102 and return the queued seconds it reports."""
    data = b""
    while b"\r\n\r\n" not in data:
        received = sock.recv(1)
        if not received:
            raise AssertionError("the connection closed before the interim response")
        data += received
    status, headers = parse_header_block(data[:-4])
    assert status == sidecar.QUEUE_REPORT_STATUS, status
    return float(headers[sidecar.QUEUED_AUDIO_SECONDS_HEADER.lower()])


def wav_upload(seconds: float) -> bytes:
    import soundfile

    wav = io.BytesIO()
    soundfile.write(wav, tone(seconds), SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return build_multipart(wav.getvalue())


def upload_headers() -> dict:
    return {"Authorization": f"Bearer {TEST_TOKEN}", "Content-Type": f"multipart/form-data; boundary={BOUNDARY}"}


def split_one_piece_per_second(samples, sample_rate):
    """A splitter for the handler tests: one piece per second of audio, labelled with the voice's length in seconds."""
    seconds = len(samples) // sample_rate
    return [np.full(sample_rate, seconds, dtype=np.float32) for _ in range(seconds)], sample_rate


def tone(seconds: float, amplitude: float = 0.5) -> np.ndarray:
    time_axis = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (amplitude * np.sin(2 * np.pi * 220 * time_axis)).astype(np.float32)


class SplitAtSilencesTest(unittest.TestCase):
    def test_audio_that_fits_is_one_chunk(self):
        for seconds in (0.0, 1.0, 25.0):
            audio = tone(seconds)
            pieces = sidecar.split_at_silences(audio, SAMPLE_RATE)
            self.assertEqual(len(pieces), 1, f"{seconds}s")
            self.assertEqual(len(pieces[0]), len(audio))

    def test_the_cut_lands_in_a_silent_gap(self):
        audio = tone(40.0)
        gap_start, gap_end = int(21.0 * SAMPLE_RATE), int(21.3 * SAMPLE_RATE)
        audio[gap_start:gap_end] = 0.0
        pieces = sidecar.split_at_silences(audio, SAMPLE_RATE)
        self.assertEqual(len(pieces), 2)
        self.assertTrue(gap_start <= len(pieces[0]) <= gap_end, f"cut at {len(pieces[0]) / SAMPLE_RATE:.2f}s")
        self.assertTrue(np.array_equal(np.concatenate(pieces), audio))

    def test_a_pure_tone_still_gives_pieces_of_at_most_25_seconds_that_add_up(self):
        audio = tone(130.0)
        pieces = sidecar.split_at_silences(audio, SAMPLE_RATE)
        self.assertGreater(len(pieces), 5)
        for piece in pieces:
            self.assertLessEqual(len(piece), 25 * SAMPLE_RATE)
        self.assertTrue(np.array_equal(np.concatenate(pieces), audio))

    def test_cuts_stay_inside_the_last_eight_seconds_before_each_boundary(self):
        pieces = sidecar.split_at_silences(tone(90.0), SAMPLE_RATE)
        for piece in pieces[:-1]:
            self.assertGreaterEqual(len(piece), 17 * SAMPLE_RATE)

    def test_works_at_the_native_rate_of_opus(self):
        sample_rate = 48000
        audio = np.zeros(int(60.5 * sample_rate), dtype=np.float32) + 0.1
        pieces = sidecar.split_at_silences(audio, sample_rate)
        for piece in pieces:
            self.assertLessEqual(len(piece), 25 * sample_rate)
        self.assertEqual(sum(len(piece) for piece in pieces), len(audio))


class SplitAtPausesTest(unittest.TestCase):
    def test_every_cut_lands_at_the_centre_of_a_pause_and_the_pieces_add_up(self):
        audio = tone(10.0)
        segments = [(int(0.5 * SAMPLE_RATE), int(2.5 * SAMPLE_RATE)), (int(3.5 * SAMPLE_RATE), int(6.0 * SAMPLE_RATE)),
                    (int(6.8 * SAMPLE_RATE), int(9.0 * SAMPLE_RATE))]
        pieces = sidecar.split_at_pauses(audio, segments, SAMPLE_RATE)
        self.assertEqual([len(piece) for piece in pieces[:-1]], [int(3.0 * SAMPLE_RATE), int(3.4 * SAMPLE_RATE)])
        self.assertTrue(np.array_equal(np.concatenate(pieces), audio), "no sample is dropped, not even the pauses")

    def test_audio_before_the_first_and_after_the_last_speech_is_kept(self):
        audio = tone(6.0)
        pieces = sidecar.split_at_pauses(audio, [(int(2.0 * SAMPLE_RATE), int(3.0 * SAMPLE_RATE))], SAMPLE_RATE)
        self.assertEqual(len(pieces), 1)
        self.assertEqual(len(pieces[0]), len(audio))

    def test_no_speech_found_is_one_piece_of_the_whole_audio(self):
        audio = tone(4.0)
        pieces = sidecar.split_at_pauses(audio, [], SAMPLE_RATE)
        self.assertEqual(len(pieces), 1)
        self.assertTrue(np.array_equal(pieces[0], audio))

    def test_a_piece_longer_than_the_model_takes_is_cut_again_at_most_every_25_seconds(self):
        audio = tone(70.0)
        segments = [(0, int(60.0 * SAMPLE_RATE)), (int(61.0 * SAMPLE_RATE), int(70.0 * SAMPLE_RATE))]
        pieces = sidecar.split_at_pauses(audio, segments, SAMPLE_RATE)
        self.assertGreaterEqual(len(pieces), 4)
        for piece in pieces:
            self.assertLessEqual(len(piece), sidecar.MAX_CHUNK_SECONDS * SAMPLE_RATE)
        self.assertTrue(np.array_equal(np.concatenate(pieces), audio))


class PauseSplitterTest(unittest.TestCase):
    def test_the_audio_is_resampled_once_and_cut_where_speech_detection_finds_pauses(self):
        calls = []

        def resample(samples, sample_rate):
            calls.append(("resample", len(samples), sample_rate))
            return samples[::3].copy()

        def find_speech(audio):
            calls.append(("speech", len(audio)))
            return [(0, SAMPLE_RATE), (2 * SAMPLE_RATE, 3 * SAMPLE_RATE)]

        split = sidecar.make_pause_splitter(resample, find_speech)
        pieces, sample_rate = split(np.zeros(3 * 3 * SAMPLE_RATE, dtype=np.float32), 48000)
        self.assertEqual(sample_rate, sidecar.SPEECH_SAMPLE_RATE)
        self.assertEqual([len(piece) for piece in pieces], [int(1.5 * SAMPLE_RATE), int(1.5 * SAMPLE_RATE)])
        self.assertEqual(calls, [("resample", 9 * SAMPLE_RATE, 48000), ("speech", 3 * SAMPLE_RATE)])

    def test_a_failing_speech_detection_falls_back_to_the_25_second_cuts_of_the_original_audio(self):
        def find_speech(audio):
            raise RuntimeError("vad broke")

        split = sidecar.make_pause_splitter(lambda samples, sample_rate: samples, find_speech)
        audio = tone(30.0)
        pieces, sample_rate = split(audio, SAMPLE_RATE)
        self.assertEqual(sample_rate, SAMPLE_RATE)
        self.assertEqual(len(pieces), 2)
        self.assertTrue(np.array_equal(np.concatenate(pieces), audio))

    def test_the_model_splitter_resamples_with_the_model_and_asks_the_vad_for_gaps_of_min_pause_ms(self):
        calls = {}

        class FakeModel:
            def resampler(self, waveforms, lengths, sample_rate):
                calls["resample"] = (waveforms.shape, list(lengths), sample_rate)
                return waveforms[:, ::3], lengths // 3

        class FakeVad:
            def segment_batch(self, waveforms, lengths, sample_rate, **options):
                calls["vad"] = (waveforms.shape, list(lengths), sample_rate, options)
                return iter([iter([(np.int64(0), np.int64(SAMPLE_RATE)), (np.int64(2 * SAMPLE_RATE), np.int64(3 * SAMPLE_RATE))])])

        split = sidecar.make_model_pause_splitter(FakeModel(), FakeVad())
        pieces, sample_rate = split(np.zeros(9 * SAMPLE_RATE, dtype=np.float32), 48000)
        self.assertEqual(sample_rate, sidecar.SPEECH_SAMPLE_RATE)
        self.assertEqual([len(piece) for piece in pieces], [int(1.5 * SAMPLE_RATE), int(1.5 * SAMPLE_RATE)], "cut at the gap's centre, in samples")
        self.assertEqual(calls["resample"], ((1, 9 * SAMPLE_RATE), [9 * SAMPLE_RATE], 48000))
        shape, lengths, vad_rate, options = calls["vad"]
        self.assertEqual((shape, lengths, vad_rate), ((1, 3 * SAMPLE_RATE), [3 * SAMPLE_RATE], 16000))
        self.assertEqual(
            options["min_silence_duration_ms"] + 2 * options["speech_pad_ms"],
            sidecar.MIN_PAUSE_MS,
            "onnx-asr adds both pads to the silence it is given: the gap that ends a piece is MIN_PAUSE_MS",
        )
        self.assertGreater(options["max_speech_duration_s"], 3, "the VAD never cuts speech by its own length limit")

    def test_windowed_resampling_joins_into_the_one_pass_result(self):
        calls = []

        def decimate(samples, sample_rate):
            # A stand-in that, like a real resampler, needs the samples around each output: a 3-tap average, then ::3.
            calls.append(len(samples))
            smoothed = np.convolve(samples, np.ones(3, dtype=np.float32) / 3, mode="same")
            return smoothed[::3].astype(np.float32)

        rng = np.random.default_rng(1)
        audio = rng.standard_normal(int(75.3 * 48000)).astype(np.float32)
        windowed = sidecar.resample_in_windows(decimate, audio, 48000)
        one_pass = decimate(audio, 48000)
        self.assertEqual(len(windowed), len(one_pass))
        self.assertTrue(np.allclose(windowed, one_pass, atol=1e-6), "the margins hide every window edge")
        self.assertEqual(len(calls), 1 + 3, "three windows of at most 30 s (plus the one-pass reference)")
        self.assertLessEqual(max(calls[:3]), (sidecar.RESAMPLE_WINDOW_SECONDS + 2 * sidecar.RESAMPLE_MARGIN_SECONDS) * 48000)

    def test_every_supported_rate_trims_the_margins_off_at_a_whole_16_khz_sample(self):
        for sample_rate in sidecar.SUPPORTED_SAMPLE_RATES:
            for seconds in (sidecar.RESAMPLE_WINDOW_SECONDS, sidecar.RESAMPLE_MARGIN_SECONDS):
                samples = seconds * sample_rate
                self.assertEqual(samples, int(samples), f"{seconds} s at {sample_rate} Hz")
                self.assertEqual(samples * sidecar.SPEECH_SAMPLE_RATE % sample_rate, 0, f"{seconds} s at {sample_rate} Hz")

    def test_audio_already_at_16_khz_is_not_resampled(self):
        audio = tone(40.0)
        self.assertIs(sidecar.resample_in_windows(lambda samples, sample_rate: self.fail("resampled"), audio, SAMPLE_RATE), audio)

    def test_without_speech_detection_the_audio_is_cut_only_at_25_seconds(self):
        audio = tone(10.0)
        pieces, sample_rate = sidecar.split_without_pauses(audio, 48000)
        self.assertEqual((len(pieces), sample_rate), (1, 48000))


class FakeLoadedModel:
    """What `run_check` and `create_audio_splitter` need of the onnx-asr model: its resampler and `recognize`."""

    def resampler(self, waveforms, lengths, sample_rate):
        return waveforms[:, ::3], lengths // 3

    def recognize(self, samples, sample_rate):
        return ""


class FakeNoSpeechVad:
    def segment_batch(self, waveforms, lengths, sample_rate, **options):
        return iter([iter([])])


class SetupTest(unittest.TestCase):
    def test_a_vad_that_cannot_be_loaded_leaves_the_25_second_cuts(self):
        def load_vad_model():
            raise FileNotFoundError("silero_vad.onnx is not in the model cache")

        with self.assertLogs(sidecar.logger, level="ERROR") as logs:
            split = sidecar.create_audio_splitter(FakeLoadedModel(), load_vad_model)
        self.assertIs(split, sidecar.split_without_pauses)
        self.assertIn("the VAD could not be loaded", logs.output[0])

    def test_a_loaded_vad_gives_the_pause_cuts(self):
        split = sidecar.create_audio_splitter(FakeLoadedModel(), FakeNoSpeechVad)
        pieces, sample_rate = split(np.zeros(48000, dtype=np.float32), 48000)
        self.assertEqual((len(pieces), sample_rate), (1, sidecar.SPEECH_SAMPLE_RATE))

    def test_the_install_check_fails_when_the_pause_detection_does_not_work(self):
        class BrokenVad:
            def segment_batch(self, waveforms, lengths, sample_rate, **options):
                raise RuntimeError("the VAD session is broken")

        output = io.StringIO()
        with unittest.mock.patch.object(sidecar, "load_model", lambda threads: FakeLoadedModel()), \
                unittest.mock.patch.object(sidecar, "load_vad", BrokenVad), \
                self.assertLogs(sidecar.logger, level="ERROR"), \
                contextlib.redirect_stdout(output):
            exit_code = sidecar.run_check(argparse.Namespace(threads=1))
        report = json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual(exit_code, sidecar.EXIT_SETUP_FAILED)
        self.assertFalse(report["ok"])
        self.assertIn("pause detection failed", report["error"])


    def test_the_install_check_fails_naming_an_ffmpeg_decoder_the_av_package_lacks(self):
        self.assertTrue(sidecar.check_ffmpeg_decoder("aac"))
        self.assertFalse(sidecar.check_ffmpeg_decoder("no-such-decoder"))
        output = io.StringIO()
        with unittest.mock.patch.object(sidecar, "load_model", lambda threads: FakeLoadedModel()), \
                unittest.mock.patch.object(sidecar, "load_vad", lambda: FakeNoSpeechVad()), \
                unittest.mock.patch.object(sidecar, "FFMPEG_REQUIRED_DECODERS", ("aac", "no-such-decoder")), \
                contextlib.redirect_stdout(output):
            exit_code = sidecar.run_check(argparse.Namespace(threads=1))
        report = json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual(exit_code, sidecar.EXIT_SETUP_FAILED)
        self.assertFalse(report["ok"])
        self.assertIn("no-such-decoder", report["error"])
        self.assertNotIn("aac", report["error"])


class MultipartTest(unittest.TestCase):
    def test_binary_file_survives_and_fields_are_text(self):
        # Every byte value, CR/LF runs and a trailing CRLF inside the payload: none may be eaten.
        payload = bytes(range(256)) * 40 + b"\r\n\r\n\r\x00\n"
        body = build_multipart(payload, {"model": "whisper-1", "language": "ru", "response_format": "text"})
        fields, file_bytes = sidecar.parse_multipart(f"multipart/form-data; boundary={BOUNDARY}", body)
        self.assertEqual(file_bytes, payload)
        self.assertEqual(fields, {"model": "whisper-1", "language": "ru", "response_format": "text"})

    def test_a_missing_file_part_gives_none(self):
        body = f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="model"\r\n\r\nx\r\n--{BOUNDARY}--\r\n'.encode()
        _, file_bytes = sidecar.parse_multipart(f"multipart/form-data; boundary={BOUNDARY}", body)
        self.assertIsNone(file_bytes)

    def test_other_content_types_are_a_400(self):
        with self.assertRaises(sidecar.RequestError) as caught:
            sidecar.parse_multipart("application/json", b"{}")
        self.assertEqual(caught.exception.status, 400)


class ChunkedBodyTest(unittest.TestCase):
    @staticmethod
    def encode(pieces: list[bytes]) -> bytes:
        return b"".join(f"{len(piece):x};ext=1\r\n".encode() + piece + b"\r\n" for piece in pieces) + b"0\r\nX-Trailer: 1\r\n\r\n"

    def test_chunks_are_joined_and_trailers_skipped(self):
        stream = io.BytesIO(self.encode([b"hello ", b"chunked ", b"world"]) + b"NEXT")
        self.assertEqual(sidecar.read_chunked_body(stream, 100), b"hello chunked world")
        self.assertEqual(stream.read(), b"NEXT", "nothing after the body is consumed")

    def test_over_the_limit_is_a_413(self):
        with self.assertRaises(sidecar.RequestError) as caught:
            sidecar.read_chunked_body(io.BytesIO(self.encode([b"x" * 60, b"y" * 60])), 100)
        self.assertEqual(caught.exception.status, 413)

    def test_a_truncated_or_malformed_body_is_a_400(self):
        for raw in (b"", b"zz\r\nabc\r\n0\r\n\r\n", b"5\r\nab"):
            with self.assertRaises(sidecar.RequestError) as caught:
                sidecar.read_chunked_body(io.BytesIO(raw), 100)
            self.assertEqual(caught.exception.status, 400, raw)


class RecognizerTest(unittest.TestCase):
    def test_a_piece_too_short_for_a_word_is_empty_text_without_calling_the_model(self):
        calls = []

        class FakeModel:
            def recognize(self, samples, sample_rate):
                calls.append(len(samples))
                return "text"

        recognize = sidecar.make_recognizer(FakeModel())
        self.assertEqual(recognize(np.zeros(100, dtype=np.float32), SAMPLE_RATE), "")
        self.assertEqual(calls, [])
        self.assertEqual(recognize(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE), "text")
        self.assertEqual(calls, [SAMPLE_RATE])


# ──────────────────────────── audio formats ────────────────────────────
#
# A 40 s clip of eight 5 s stretches, each at its own pitch: the length shows a lost tail, the pitches show the audio
# is the right audio in the right order. Every fixture is encoded here (av for M4A/MP3, libsndfile for OGG), so no
# binary sits in the repo, and once per run (the bytes are immutable).

CLIP_SECONDS = 40
CLIP_STRETCHES = 8
PITCH_TOLERANCE_HZ = 25.0
LENGTH_TOLERANCE_SECONDS = 0.3
# A loud noisy head makes the first MP3 frames the biggest ones: a decoder that sizes the file from them is far off.
NOISY_HEAD_SECONDS = 2
VBR_QUALITY = 9
# libmp3lame's `global_quality` unit (FF_QP2LAMBDA): the VBR quality `-q:a N` is N of them.
FF_QP2LAMBDA = 118
MP3_LENGTH_TAGS = (b"Xing", b"Info", b"VBRI")


def get_stretch_pitch(index: int) -> float:
    return 300.0 + 150.0 * index


def make_pitch_clip(sample_rate: int, noisy_head_seconds: int = 0, seconds: int = CLIP_SECONDS, first_stretch: int = 0) -> np.ndarray:
    """`seconds` of audio in 5 s stretches of rising pitch (stretch `first_stretch` onwards)."""
    stretch_samples = 5 * sample_rate
    stretches = []
    for index in range(first_stretch, first_stretch + seconds // 5):
        time_axis = np.arange(stretch_samples) / sample_rate
        stretches.append(0.4 * np.sin(2 * np.pi * get_stretch_pitch(index) * time_axis))
    clip = np.concatenate(stretches).astype(np.float32)
    if noisy_head_seconds:
        clip[: noisy_head_seconds * sample_rate] = np.random.default_rng(1).uniform(-0.5, 0.5, noisy_head_seconds * sample_rate)
    return clip


def get_dominant_pitch(samples: np.ndarray, sample_rate: int) -> float:
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
    return float(np.argmax(spectrum) * sample_rate / len(samples))


def encode_with_av(samples: np.ndarray, sample_rate: int, codec: str, container_format: str, channels: int = 1,
                   container_options: dict | None = None, vbr_quality: int | None = None) -> bytes:
    layout = "stereo" if channels == 2 else "mono"
    buffer = io.BytesIO()
    with av.open(buffer, "w", format=container_format, options=container_options or {}) as container:
        stream = container.add_stream(codec, rate=sample_rate, layout=layout)
        if vbr_quality is not None:
            stream.codec_context.flags |= av.codec.context.Flags.qscale
            stream.codec_context.global_quality = vbr_quality * FF_QP2LAMBDA
        pcm = (samples * 32767).astype(np.int16)
        frame = av.AudioFrame.from_ndarray(np.stack([pcm] * channels), format="s16p", layout=layout)
        frame.sample_rate = sample_rate
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    return buffer.getvalue()


def encode_with_soundfile(samples: np.ndarray, sample_rate: int, subtype: str) -> bytes:
    buffer = io.BytesIO()
    soundfile.write(buffer, samples, sample_rate, format="OGG", subtype=subtype)
    return buffer.getvalue()


@functools.cache
def make_m4a() -> bytes:
    """AAC in an MP4 the way a phone recorder writes it: 44.1 kHz stereo, the index at the end of the file."""
    return encode_with_av(make_pitch_clip(44100), 44100, "aac", "mp4", channels=2)


@functools.cache
def make_mp3_without_length_header() -> bytes:
    """A variable-bitrate MP3 with no Xing / Info / VBRI frame (a stream cut out of a longer file looks the same)."""
    data = encode_with_av(make_pitch_clip(44100, NOISY_HEAD_SECONDS), 44100, "libmp3lame", "mp3",
                          container_options={"write_xing": "0"}, vbr_quality=VBR_QUALITY)
    assert not any(tag in data for tag in MP3_LENGTH_TAGS), "the fixture has a length header"
    return data


@functools.cache
def make_chained_ogg(subtypes: tuple[str, str], sample_rates: tuple[int, int] = (16000, 16000)) -> bytes:
    """Two OGG streams one after the other (`cat a.ogg b.ogg`), each half of the clip."""
    halves = (make_pitch_clip(sample_rates[0], seconds=CLIP_SECONDS // 2), make_pitch_clip(sample_rates[1], seconds=CLIP_SECONDS // 2, first_stretch=CLIP_STRETCHES // 2))
    return b"".join(encode_with_soundfile(half, rate, subtype) for half, rate, subtype in zip(halves, sample_rates, subtypes))


def decode_upload(data: bytes):
    return sidecar.decode_audio(sidecar.inspect_audio(data))


def read_upload_seconds(data: bytes) -> float:
    return sidecar.read_audio_seconds(sidecar.inspect_audio(data))


AUDIO_KINDS = {
    "an M4A (AAC)": make_m4a,
    "an MP3 without a length header": make_mp3_without_length_header,
    "a chained OGG/Opus": lambda: make_chained_ogg(("OPUS", "OPUS")),
    "a chained OGG/Vorbis": lambda: make_chained_ogg(("VORBIS", "VORBIS")),
    "a chained OGG whose parts differ in sample rate": lambda: make_chained_ogg(("OPUS", "VORBIS"), (48000, 22050)),
}


class FakeFfmpegContainer:
    """What `decode_ffmpeg_stream` uses of an opened container: the audio streams and the decoded frames."""

    def __init__(self, frames):
        self.streams = types.SimpleNamespace(audio=[object()])
        self._frames = frames

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        return False

    def decode(self, audio):
        return iter(self._frames)


def make_tone_frames(sample_rate: int, layout: str, pitch: float, seconds: float = 2.0, frame_seconds: float = 0.25) -> list:
    """Decoded-looking frames (planar float, the way ffmpeg's decoders hand them over) of one steady tone."""
    channels = 2 if layout == "stereo" else 1
    time_axis = np.arange(int(seconds * sample_rate)) / sample_rate
    tone = (0.4 * np.sin(2 * np.pi * pitch * time_axis)).astype(np.float32)
    frames = []
    for start in range(0, len(tone), int(frame_seconds * sample_rate)):
        frame = av.AudioFrame.from_ndarray(np.stack([tone[start : start + int(frame_seconds * sample_rate)]] * channels), format="fltp", layout=layout)
        frame.sample_rate = sample_rate
        frames.append(frame)
    return frames


class FfmpegPartsTest(unittest.TestCase):
    """ffmpeg's frames can change their rate or layout in the middle of a file; each part is resampled by its own setup.
    (ffmpeg's MP3 decoder itself refuses a rate change inside one file, so the frames are made here.)"""

    PART_SECONDS = 2.0
    PARTS = {
        "a stereo part and a mono part at other rates": [(44100, "stereo", 440.0), (48000, "mono", 700.0)],
        "a part that needs no conversion, then a 44.1 kHz one": [(16000, "mono", 440.0), (44100, "mono", 700.0)],
        "the same rate, mono and then stereo": [(44100, "mono", 440.0), (44100, "stereo", 700.0)],
        "three parts": [(22050, "mono", 440.0), (48000, "stereo", 700.0), (16000, "mono", 1000.0)],
    }

    def test_every_part_is_decoded_at_its_own_rate_and_layout(self):
        for name, parts in self.PARTS.items():
            with self.subTest(name):
                frames = [frame for rate, layout, pitch in parts for frame in make_tone_frames(rate, layout, pitch, self.PART_SECONDS)]
                with unittest.mock.patch.object(sidecar, "open_ffmpeg_container", lambda data: FakeFfmpegContainer(frames)):
                    samples, sample_rate = sidecar.decode_with_ffmpeg([b"parts"])
                self.assertEqual(sample_rate, sidecar.SPEECH_SAMPLE_RATE)
                self.assertAlmostEqual(len(samples) / sample_rate, self.PART_SECONDS * len(parts), delta=0.1)
                part_samples = int(self.PART_SECONDS * sample_rate)
                for index, (_, _, pitch) in enumerate(parts):
                    middle = samples[index * part_samples + part_samples // 4 : index * part_samples + part_samples * 3 // 4]
                    self.assertAlmostEqual(get_dominant_pitch(middle, sample_rate), pitch, delta=PITCH_TOLERANCE_HZ, msg=f"part {index}")

    def test_joined_mp3s_of_other_rates_are_never_decoded_wrong(self):
        """ffmpeg's MP3 decoder refuses the second part (a 400, and the next engine answers); were it to decode it, the
        audio must be whole and at the right pitch. What may not happen is a transcript of garbage."""
        first = encode_with_av(make_pitch_clip(44100, seconds=10), 44100, "libmp3lame", "mp3")
        second = encode_with_av(make_pitch_clip(48000, seconds=10, first_stretch=2), 48000, "libmp3lame", "mp3")
        try:
            samples, sample_rate = decode_upload(first + second)
        except sidecar.RequestError as error:
            self.assertEqual(error.status, 400)
            return
        self.assertAlmostEqual(len(samples) / sample_rate, 20.0, delta=LENGTH_TOLERANCE_SECONDS)
        for index in range(4):
            start = index * 5 * sample_rate + 5 * sample_rate // 2
            pitch = get_dominant_pitch(samples[start : start + 5 * sample_rate // 2], sample_rate)
            self.assertAlmostEqual(pitch, get_stretch_pitch(index), delta=PITCH_TOLERANCE_HZ, msg=f"stretch {index}")


class AudioFormatsTest(unittest.TestCase):
    """A 40 s file of each kind libsndfile loses, refuses or cannot size is decoded whole."""

    def assert_whole_clip(self, samples: np.ndarray, sample_rate: int) -> None:
        self.assertAlmostEqual(len(samples) / sample_rate, CLIP_SECONDS, delta=LENGTH_TOLERANCE_SECONDS)
        stretch_samples = 5 * sample_rate
        for index in range(CLIP_STRETCHES):
            start = index * stretch_samples + stretch_samples // 2  # the stretch's middle half: clear of the codec's edges
            pitch = get_dominant_pitch(samples[start : start + stretch_samples // 2], sample_rate)
            if index == 0:
                continue  # the MP3 fixture's first stretch starts with noise
            self.assertAlmostEqual(pitch, get_stretch_pitch(index), delta=PITCH_TOLERANCE_HZ, msg=f"stretch {index}")

    def test_the_whole_40_second_file_is_decoded(self):
        for kind, make in AUDIO_KINDS.items():
            with self.subTest(kind):
                samples, sample_rate = decode_upload(make())
                self.assertIn(sample_rate, sidecar.SUPPORTED_SAMPLE_RATES)
                self.assert_whole_clip(samples, sample_rate)

    def test_the_length_read_before_the_decode_is_the_whole_length(self):
        for kind, make in AUDIO_KINDS.items():
            with self.subTest(kind):
                self.assertAlmostEqual(read_upload_seconds(make()), CLIP_SECONDS, delta=LENGTH_TOLERANCE_SECONDS)

    def test_a_normal_mp3_is_decoded_whole_too(self):
        data = encode_with_av(make_pitch_clip(44100), 44100, "libmp3lame", "mp3", channels=2)
        samples, sample_rate = decode_upload(data)
        self.assert_whole_clip(samples, sample_rate)
        self.assertAlmostEqual(read_upload_seconds(data), CLIP_SECONDS, delta=LENGTH_TOLERANCE_SECONDS)

    def test_what_libsndfile_reads_exactly_does_not_go_through_ffmpeg(self):
        clip = make_pitch_clip(16000)
        kinds = {
            "WAV": soundfile.write,
            "FLAC": soundfile.write,
        }
        uploads = []
        for format_name in kinds:
            buffer = io.BytesIO()
            soundfile.write(buffer, clip, 16000, format=format_name)
            uploads.append((format_name, buffer.getvalue()))
        uploads.append(("OGG/Opus", encode_with_soundfile(make_pitch_clip(48000), 48000, "OPUS")))
        uploads.append(("OGG/Vorbis", encode_with_soundfile(clip, 16000, "VORBIS")))
        with unittest.mock.patch.object(sidecar, "decode_with_ffmpeg", side_effect=AssertionError("went through ffmpeg")):
            for name, data in uploads:
                with self.subTest(name):
                    samples, sample_rate = decode_upload(data)
                    self.assertAlmostEqual(len(samples) / sample_rate, CLIP_SECONDS, delta=LENGTH_TOLERANCE_SECONDS)
                    self.assertAlmostEqual(read_upload_seconds(data), CLIP_SECONDS, delta=LENGTH_TOLERANCE_SECONDS)

    def test_what_ffmpeg_cannot_turn_into_sound_is_a_400(self):
        video = io.BytesIO()
        with av.open(video, "w", format="mp4") as container:
            stream = container.add_stream("mpeg4", rate=10)
            stream.width, stream.height, stream.pix_fmt = 64, 64, "yuv420p"
            frame = av.VideoFrame.from_ndarray(np.zeros((64, 64, 3), dtype=np.uint8), format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)
            for packet in stream.encode(None):
                container.mux(packet)
        uploads = (
            ("a video without sound", video.getvalue()),
            ("an AMR file that opens and holds no frames", b"#!AMR\n"),
            ("garbage", os.urandom(4096)),
            ("a truncated M4A", make_m4a()[:200]),
        )
        for name, data in uploads:
            with self.subTest(name):
                with self.assertRaises(sidecar.RequestError) as caught:
                    decode_upload(data)
                self.assertEqual(caught.exception.status, 400)
                self.assertEqual(read_upload_seconds(data), 0.0)


OGG_FIRST_PAGE = 0x02
OGG_CONTINUED_PAGE = 0x00


def make_ogg_page(flags: int, payload: bytes = b"packet") -> bytes:
    """A page with a valid header and an unchecked checksum: the walk reads only the header and the lace values."""
    return b"OggS" + bytes([0, flags]) + bytes(8) + bytes(4) + bytes(4) + bytes(4) + bytes([1, len(payload)]) + payload


# A text file in SDP form: with ffmpeg's default protocols it opens an RTP socket and waits 20 s for packets.
SDP_TEXT = b"v=0\no=- 0 0 IN IP4 127.0.0.1\ns=x\nc=IN IP4 127.0.0.1\nt=0 0\nm=audio 40123 RTP/AVP 0\n"
SDP_REFUSAL_BUDGET_SECONDS = 3.0


class InspectAudioTest(unittest.TestCase):
    def test_what_libsndfile_reads_whole_keeps_its_header_length_and_the_rest_goes_to_ffmpeg(self):
        clip = make_pitch_clip(16000, seconds=10)
        libsndfile_uploads = {}
        for format_name in ("WAV", "FLAC"):
            buffer = io.BytesIO()
            soundfile.write(buffer, clip, 16000, format=format_name)
            libsndfile_uploads[format_name] = buffer.getvalue()
        libsndfile_uploads["OGG/Opus"] = encode_with_soundfile(make_pitch_clip(48000, seconds=10), 48000, "OPUS")
        libsndfile_uploads["OGG/Vorbis"] = encode_with_soundfile(clip, 16000, "VORBIS")
        for name, data in libsndfile_uploads.items():
            with self.subTest(name):
                upload = sidecar.inspect_audio(data)
                self.assertAlmostEqual(upload.header_seconds, 10.0, delta=LENGTH_TOLERANCE_SECONDS)
                self.assertEqual(upload.streams, [data])
        for kind, make in AUDIO_KINDS.items():
            with self.subTest(kind):
                self.assertIsNone(sidecar.inspect_audio(make()).header_seconds)
        self.assertIsNone(sidecar.inspect_audio(b"not audio at all").header_seconds)

    def test_the_streams_of_a_chained_ogg_are_split_once_for_both_readers(self):
        upload = sidecar.inspect_audio(make_chained_ogg(("OPUS", "OPUS")))
        self.assertEqual(len(upload.streams), 2)
        self.assertEqual(b"".join(upload.streams), upload.data)
        self.assertEqual(len(sidecar.inspect_audio(make_m4a()).streams), 1)


class FfmpegContainmentTest(unittest.TestCase):
    def test_an_upload_cannot_make_ffmpeg_open_a_network_socket(self):
        started = time.monotonic()
        self.assertEqual(read_upload_seconds(SDP_TEXT), 0.0)
        with self.assertRaises(sidecar.RequestError) as caught:
            decode_upload(SDP_TEXT)
        self.assertEqual(caught.exception.status, 400)
        self.assertLess(time.monotonic() - started, SDP_REFUSAL_BUDGET_SECONDS, "ffmpeg waited on a socket the upload named")


class OggStreamsTest(unittest.TestCase):
    def test_chained_streams_are_found_and_split_at_their_first_pages(self):
        stream = make_ogg_page(OGG_FIRST_PAGE) + make_ogg_page(OGG_CONTINUED_PAGE) + make_ogg_page(OGG_CONTINUED_PAGE)
        self.assertEqual(sidecar.find_ogg_stream_starts(stream), [0])
        self.assertEqual(sidecar.split_ogg_streams(stream), [stream])
        chain = stream * 3
        self.assertEqual(sidecar.find_ogg_stream_starts(chain), [0, len(stream), 2 * len(stream)])
        self.assertEqual(sidecar.split_ogg_streams(chain), [stream] * 3)

    def test_real_files_are_counted_the_same_way(self):
        single = encode_with_soundfile(make_pitch_clip(16000, seconds=10), 16000, "VORBIS")
        self.assertEqual(len(sidecar.find_ogg_stream_starts(single)), 1)
        self.assertEqual(len(sidecar.find_ogg_stream_starts(single + single)), 2)

    def test_streams_multiplexed_side_by_side_open_with_several_first_pages_and_count_once(self):
        opening = make_ogg_page(OGG_FIRST_PAGE) + make_ogg_page(OGG_FIRST_PAGE)
        grouped = opening + make_ogg_page(OGG_CONTINUED_PAGE)
        self.assertEqual(sidecar.find_ogg_stream_starts(grouped), [0])
        self.assertEqual(sidecar.find_ogg_stream_starts(grouped + grouped), [0, len(grouped)])

    def test_a_packet_that_holds_the_capture_pattern_is_not_a_page(self):
        stream = make_ogg_page(OGG_FIRST_PAGE) + make_ogg_page(OGG_CONTINUED_PAGE, b"..OggS" + bytes([0, OGG_FIRST_PAGE]) + b"..")
        self.assertEqual(sidecar.find_ogg_stream_starts(stream), [0])

    def test_a_cut_damaged_or_foreign_file_does_not_raise(self):
        stream = make_ogg_page(OGG_FIRST_PAGE) + make_ogg_page(OGG_CONTINUED_PAGE)
        for name, data, expected in (
            ("empty", b"", []),
            ("foreign", b"RIFF" + bytes(100), []),
            ("a header cut short", stream[:20], []),
            ("lace values cut short", stream[:27], []),
            ("a payload cut short", stream[:30], [0]),
            ("a second stream cut in its payload", stream + stream[:-3], [0, len(stream)]),
            ("junk after the pages", stream + b"junk", [0]),
        ):
            with self.subTest(name):
                self.assertEqual(sidecar.find_ogg_stream_starts(data), expected)
        self.assertEqual(sidecar.split_ogg_streams(b"not ogg"), [b"not ogg"])


def submit_now(pool, chunks, sample_rate=SAMPLE_RATE):
    """A request whose pieces are ready the moment it arrives."""
    request = pool.open_request()
    pool.submit(request, chunks, sample_rate)
    return request


def label_chunk(label):
    return np.full(4, label, dtype=np.float32)


class GatedRecognizer:
    """Records the label of every piece it is given and holds each one until the gate opens."""

    def __init__(self):
        self.order = []
        self.started = threading.Event()
        self.gate = threading.Event()

    def __call__(self, samples, sample_rate):
        self.order.append(int(samples[0]))
        self.started.set()
        self.gate.wait(5)
        return f"t{int(samples[0])}"


class PoolTest(unittest.TestCase):
    def test_a_short_request_waits_for_every_piece_of_a_long_one_that_arrived_before_it(self):
        recognize = GatedRecognizer()
        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        long_request = submit_now(pool, [label_chunk(100 + index) for index in range(12)])
        self.assertTrue(recognize.started.wait(5), "the single worker took the long request's first piece")
        self.assertEqual(pool.queued_chunks(), 11)
        short_request = submit_now(pool, [label_chunk(1)])
        self.assertEqual(pool.queued_chunks(), 12)
        recognize.gate.set()
        long_text = long_request.wait(5)
        self.assertEqual(short_request.wait(5), "t1")
        pool.stop()

        self.assertEqual(recognize.order, list(range(100, 112)) + [1], "arrival order: the short request runs last")
        self.assertEqual(long_text, " ".join(f"t{100 + index}" for index in range(12)))

    def test_an_earlier_request_still_cutting_its_audio_keeps_its_place(self):
        recognize = GatedRecognizer()
        recognize.gate.set()
        pool = sidecar.RecognitionPool(recognize, workers=2)
        pool.start()
        slow_to_cut = pool.open_request()
        quick = submit_now(pool, [label_chunk(2)])
        self.assertFalse(quick.is_finished(), "nothing runs while the request that arrived first still prepares")
        self.assertEqual(recognize.order, [])
        pool.submit(slow_to_cut, [label_chunk(10), label_chunk(11)], SAMPLE_RATE)
        self.assertEqual(slow_to_cut.wait(5), "t10 t11")
        self.assertEqual(quick.wait(5), "t2")
        pool.stop()
        self.assertEqual(recognize.order[:2], [10, 11], "the earlier request's pieces are handed out first")
        self.assertEqual(recognize.order[2], 2)

    def test_a_request_cancelled_before_its_pieces_frees_the_requests_behind_it(self):
        recognize = GatedRecognizer()
        recognize.gate.set()
        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        undecodable = pool.open_request()
        behind = submit_now(pool, [label_chunk(3)])
        pool.cancel(undecodable)
        self.assertEqual(behind.wait(5), "t3")
        pool.stop()
        self.assertEqual(recognize.order, [3])

    def test_requests_run_in_arrival_order(self):
        recognize = GatedRecognizer()
        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        requests = [submit_now(pool, [label_chunk(label)]) for label in (1, 2, 3)]
        self.assertTrue(recognize.started.wait(5))
        recognize.gate.set()
        for request in requests:
            request.wait(5)
        pool.stop()
        self.assertEqual(recognize.order, [1, 2, 3])

    def test_a_failing_chunk_fails_its_request_only(self):
        def recognize(samples, sample_rate):
            if samples[0] == 666:
                raise ValueError("broken chunk")
            return "ok"

        pool = sidecar.RecognitionPool(recognize, workers=2)
        pool.start()
        broken = submit_now(pool, [label_chunk(666), label_chunk(1)])
        fine = submit_now(pool, [label_chunk(2)])
        with self.assertRaises(ValueError):
            broken.wait(5)
        self.assertEqual(fine.wait(5), "ok")
        pool.stop()

    def test_a_timeout_drops_the_pending_chunks_and_the_next_request_runs(self):
        recognize = GatedRecognizer()
        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        request = submit_now(pool, [label_chunk(5) for _ in range(5)])
        behind = submit_now(pool, [label_chunk(6)])
        with self.assertRaises(sidecar.RecognitionTimeout):
            request.wait(0.1)
        recognize.gate.set()
        self.assertEqual(behind.wait(5), "t6")
        pool.stop()
        for thread in pool._threads:
            thread.join(5)
        self.assertEqual(recognize.order, [5, 6], "only the piece already running was recognised")

    def test_a_request_is_told_the_audio_queued_ahead_of_it_and_nothing_behind_it(self):
        recognize = GatedRecognizer()
        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        running = submit_now(pool, [label_chunk(1) for _ in range(3)])
        self.assertTrue(recognize.started.wait(5))
        still_cutting = pool.open_request()
        still_cutting.note_audio_seconds(7.5)
        own = submit_now(pool, [label_chunk(2)])
        behind = submit_now(pool, [label_chunk(3) for _ in range(5)])
        piece_seconds = 4 / SAMPLE_RATE
        self.assertAlmostEqual(pool.get_audio_seconds_ahead(running), 0.0)
        self.assertAlmostEqual(pool.get_audio_seconds_ahead(own), 3 * piece_seconds + 7.5, msg="the running piece counts too")
        self.assertAlmostEqual(pool.get_audio_seconds_ahead(behind), 3 * piece_seconds + 7.5 + piece_seconds)
        pool.cancel(still_cutting)
        recognize.gate.set()
        for request in (running, own, behind):
            request.wait(5)
        self.assertAlmostEqual(pool.get_audio_seconds_ahead(behind), 0.0, msg="finished requests are not ahead")
        pool.stop()

    def test_a_waiting_request_whose_client_left_is_dropped(self):
        recognize = GatedRecognizer()
        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        running = submit_now(pool, [label_chunk(1)])
        self.assertTrue(recognize.started.wait(5))
        abandoned = submit_now(pool, [label_chunk(2) for _ in range(3)])
        with self.assertRaises(sidecar.ClientGone):
            abandoned.wait(5, is_abandoned=lambda: True)
        self.assertTrue(abandoned.is_finished())
        self.assertEqual(pool.queued_chunks(), 0, "its pieces are no longer waiting")
        recognize.gate.set()
        running.wait(5)
        after = submit_now(pool, [label_chunk(3)])
        self.assertEqual(after.wait(5), "t3")
        pool.stop()
        self.assertEqual(recognize.order, [1, 3], "no piece of the abandoned request was recognised")

    def test_a_voice_is_told_the_length_of_an_earlier_one_whose_length_is_still_being_read(self):
        pool = sidecar.RecognitionPool(lambda samples, sample_rate: "", workers=1)
        earlier = pool.open_request()
        later = pool.open_request()
        pool.submit(later, [label_chunk(1)], SAMPLE_RATE)
        threading.Timer(0.2, earlier.note_audio_seconds, args=(40.0,)).start()
        started = time.monotonic()
        pool.wait_until_sized_ahead(later, 5.0)
        self.assertGreaterEqual(time.monotonic() - started, 0.15, "it waited for the length")
        self.assertAlmostEqual(pool.get_audio_seconds_ahead(later), 40.0)

    def test_the_wait_for_a_length_ends_when_the_earlier_voice_ends_or_after_the_timeout(self):
        pool = sidecar.RecognitionPool(lambda samples, sample_rate: "", workers=1)
        cancelled = pool.open_request()
        silent = pool.open_request()
        later = pool.open_request()
        threading.Timer(0.1, pool.cancel, args=(cancelled,)).start()
        started = time.monotonic()
        pool.wait_until_sized_ahead(later, 0.5)
        self.assertGreaterEqual(time.monotonic() - started, 0.45, "the second earlier voice never gets a length: the wait gives up")
        self.assertAlmostEqual(pool.get_audio_seconds_ahead(later), 0.0)
        self.assertFalse(silent.is_finished())

    def test_a_voice_with_nobody_ahead_does_not_wait(self):
        pool = sidecar.RecognitionPool(lambda samples, sample_rate: "", workers=1)
        only = pool.open_request()
        started = time.monotonic()
        pool.wait_until_sized_ahead(only, 5.0)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_a_request_with_no_pieces_is_empty_text_at_once(self):
        pool = sidecar.RecognitionPool(GatedRecognizer(), workers=1)
        pool.start()
        self.assertEqual(submit_now(pool, []).wait(1), "")
        pool.stop()

    def test_texts_are_joined_with_single_spaces_and_empty_ones_dropped(self):
        pool = sidecar.RecognitionPool(GatedRecognizer(), workers=1)
        request = pool.open_request()
        request.attach_chunks([label_chunk(index) for index in range(4)], SAMPLE_RATE)
        for index, text in enumerate(["  one ", "", "two", " three  "]):
            request.complete_chunk(index, text)
        self.assertEqual(request.wait(1), "one two three")


class RecordTest(unittest.TestCase):
    def test_the_record_goes_only_when_it_names_this_process(self):
        with tempfile.TemporaryDirectory() as directory:
            record = os.path.join(directory, "sidecar.json")
            with open(record, "w") as stream:
                json.dump({"pid": 4242, "port": 1}, stream)
            self.assertFalse(sidecar.remove_record_if_owned(record, 99), "another generation's record stays")
            self.assertTrue(os.path.exists(record))
            self.assertTrue(sidecar.remove_record_if_owned(record, 4242))
            self.assertFalse(os.path.exists(record))
            self.assertFalse(sidecar.remove_record_if_owned(record, 4242), "a missing record is not an error")
            with open(record, "w") as stream:
                stream.write("not json")
            self.assertFalse(sidecar.remove_record_if_owned(record, 4242), "a corrupt record is left alone")
            self.assertTrue(os.path.exists(record))

    def test_json_files_are_written_whole_and_owner_only(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = os.path.join(directory, "ready.json")
            sidecar.write_json_atomic(ready, {"pid": 1, "port": 2, "version": "1"})
            with open(ready) as stream:
                self.assertEqual(json.load(stream), {"pid": 1, "port": 2, "version": "1"})
            self.assertEqual(os.stat(ready).st_mode & 0o777, 0o600)
            self.assertEqual(os.listdir(directory), ["ready.json"])


class OwnRecordTest(unittest.TestCase):
    """The sidecar writes the record the bot adopts it from — so a bot worker replaced while it waits for the ready
    file leaves a process the next worker can find."""

    def make_args(self, **overrides):
        values = dict(config_hash="abc123", owner_pid=4242, owner_start_token="777")
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_the_record_names_everything_the_bot_checks_before_it_adopts(self):
        record = sidecar.build_record(self.make_args(), 40123, "secret-token", "start-token-1")
        self.assertEqual(
            {key: record[key] for key in ("pid", "startToken", "port", "token", "configHash", "ownerPid", "ownerStartToken")},
            {
                "pid": os.getpid(), "startToken": "start-token-1", "port": 40123, "token": "secret-token",
                "configHash": "abc123", "ownerPid": 4242, "ownerStartToken": "777",
            },
        )
        self.assertTrue(record["startedAt"].endswith("+00:00"), record["startedAt"])

    def test_an_owner_without_a_start_token_is_an_empty_string_not_a_missing_field(self):
        record = sidecar.build_record(self.make_args(owner_start_token=None), 1, "t", "s")
        self.assertEqual(record["ownerStartToken"], "")

    def test_the_record_is_written_owner_only_and_removable_by_the_idle_exit_rule(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "sidecar.json")
            sidecar.write_json_atomic(path, sidecar.build_record(self.make_args(), 1, "t", "s"))
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertTrue(sidecar.remove_record_if_owned(path, os.getpid()))

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux reads /proc")
    def test_the_own_start_token_is_the_one_the_bot_reads(self):
        self.assertEqual(sidecar.read_process_start_token(os.getpid()), sidecar.read_process_start_token(os.getpid()))
        self.assertIsNotNone(sidecar.read_process_start_token(os.getpid()))

    def test_elsewhere_the_token_is_the_ps_text_the_bot_reads(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="  Fri Oct 16 12:00:00 2026 python gigaam_sidecar.py\n")
        with unittest.mock.patch.object(sys, "platform", "darwin"), unittest.mock.patch("subprocess.run", return_value=completed) as run:
            self.assertEqual(sidecar.read_process_start_token(123), "Fri Oct 16 12:00:00 2026 python gigaam_sidecar.py")
        self.assertEqual(run.call_args.args[0], ["ps", "-o", "lstart=", "-o", "command=", "-p", "123"])
        with unittest.mock.patch.object(sys, "platform", "darwin"), unittest.mock.patch("subprocess.run", side_effect=OSError("no ps")):
            self.assertIsNone(sidecar.read_process_start_token(123))


@unittest.skipUnless(sys.platform.startswith("linux"), "the start token is read from /proc")
class RecordClaimTest(unittest.TestCase):
    """Two sidecars started at once — a bot worker replaced mid-start asks again — must not both be recorded: the
    record is claimed with an exclusive create BEFORE the model loads, and completed with the port after."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.record_path = os.path.join(self.directory.name, "sidecar.json")
        self.args = argparse.Namespace(config_hash="abc123", owner_pid=4242, owner_start_token="777", record_file=self.record_path)
        self.own_start_token = sidecar.read_process_start_token(os.getpid())

    def start_other_sidecar_record(self, **overrides):
        """A record naming a live process that is not this one (a sleeping child stands in for the other sidecar)."""
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(lambda: (child.kill(), child.wait()))
        record = {"pid": child.pid, "startToken": sidecar.read_process_start_token(child.pid), "port": 0, "token": "other-token"}
        record.update(overrides)
        with open(self.record_path, "w", encoding="utf-8") as stream:
            json.dump(record, stream)
        return child

    def read_record_file(self):
        with open(self.record_path, encoding="utf-8") as stream:
            return json.load(stream)

    def test_the_claim_writes_a_starting_record_owner_only_and_leaves_no_temporary_file(self):
        self.assertTrue(sidecar.claim_record(self.args, "secret-token", self.own_start_token))
        record = self.read_record_file()
        self.assertEqual((record["pid"], record["port"], record["token"], record["configHash"]), (os.getpid(), sidecar.STARTING_PORT, "secret-token", "abc123"))
        self.assertEqual(os.stat(self.record_path).st_mode & 0o777, 0o600)
        self.assertEqual(os.listdir(self.directory.name), ["sidecar.json"])

    def test_another_live_sidecar_keeps_the_record_and_this_start_learns_it(self):
        child = self.start_other_sidecar_record()
        self.assertFalse(sidecar.claim_record(self.args, "secret-token", self.own_start_token))
        self.assertEqual(self.read_record_file()["pid"], child.pid, "the first sidecar's record is untouched")
        self.assertEqual(os.listdir(self.directory.name), ["sidecar.json"], "the losing start leaves nothing behind")

    def test_the_record_of_a_dead_process_a_reused_pid_or_garbage_is_replaced(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        with open(self.record_path, "w", encoding="utf-8") as stream:
            json.dump({"pid": dead.pid, "startToken": "1"}, stream)
        self.assertTrue(sidecar.claim_record(self.args, "t1", self.own_start_token))
        self.assertEqual(self.read_record_file()["pid"], os.getpid())

        child = self.start_other_sidecar_record(startToken="not-the-start-token-of-that-pid")
        self.assertTrue(sidecar.claim_record(self.args, "t2", self.own_start_token), "a live pid with another start time is a reused pid")
        self.assertEqual(self.read_record_file()["token"], "t2")
        self.assertIsNone(child.poll(), "the unrelated process is left alone")

        with open(self.record_path, "w", encoding="utf-8") as stream:
            stream.write("{ not json")
        self.assertTrue(sidecar.claim_record(self.args, "t3", self.own_start_token))
        self.assertEqual(self.read_record_file()["token"], "t3")

    def test_the_port_completes_the_own_record_and_only_the_own_record(self):
        self.assertTrue(sidecar.claim_record(self.args, "secret-token", self.own_start_token))
        self.assertTrue(sidecar.publish_port(self.args, 40123, "secret-token", self.own_start_token))
        self.assertEqual(self.read_record_file()["port"], 40123)

        child = self.start_other_sidecar_record()
        self.assertFalse(sidecar.publish_port(self.args, 40124, "secret-token", self.own_start_token), "a record the bot gave to another start is not overwritten")
        self.assertEqual(self.read_record_file()["pid"], child.pid)

        os.unlink(self.record_path)
        self.assertFalse(sidecar.publish_port(self.args, 40125, "secret-token", self.own_start_token), "a record taken away is not recreated")
        self.assertFalse(os.path.exists(self.record_path))


@unittest.skipUnless(sys.platform.startswith("linux"), "the start token is read from /proc")
class OwnerTest(unittest.TestCase):
    def test_start_token_matches_the_bots_field_22(self):
        token = sidecar.read_process_start_token(os.getpid())
        self.assertIsNotNone(token)
        with open(f"/proc/{os.getpid()}/stat") as stream:
            stat = stream.read()
        self.assertEqual(token, stat[stat.rfind(")") + 1:].split()[19])

    def test_owner_liveness_needs_the_pid_and_the_token(self):
        own_token = sidecar.read_process_start_token(os.getpid())
        self.assertTrue(sidecar.is_owner_alive(os.getpid(), own_token))
        self.assertTrue(sidecar.is_owner_alive(os.getpid(), None))
        self.assertFalse(sidecar.is_owner_alive(os.getpid(), "1"), "a reused pid has another start time")

    def test_a_dead_owner_is_gone(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        token = sidecar.read_process_start_token(child.pid)
        self.assertTrue(sidecar.is_owner_alive(child.pid, token))
        child.kill()
        child.wait()
        self.assertFalse(sidecar.is_owner_alive(child.pid, token))


class HttpArrivalOrderTest(unittest.TestCase):
    """The real handler: a voice takes its place when its upload is in, before it is cut."""

    def test_a_voice_that_is_quicker_to_cut_does_not_overtake_one_that_arrived_first(self):
        first_is_cutting = threading.Event()
        release_first = threading.Event()
        recognised = []

        def split_audio(samples, sample_rate):
            if len(samples) == 2 * SAMPLE_RATE:
                first_is_cutting.set()
                release_first.wait(5)
            return [samples], sample_rate

        def recognize(samples, sample_rate):
            recognised.append(len(samples) // SAMPLE_RATE)
            return f"{len(samples) // SAMPLE_RATE}s"

        pool = sidecar.RecognitionPool(recognize, workers=2)
        pool.start()
        server = sidecar.SidecarServer(("127.0.0.1", 0), sidecar.SidecarContext(TEST_TOKEN, pool, split_audio, 2, 900.0, 600.0))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        replies = {}

        def post(seconds):
            response = raw_request(server.server_address[1], "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(seconds))
            replies[seconds] = json.loads(response.body)["text"]

        try:
            first = threading.Thread(target=post, args=(2.0,))
            first.start()
            self.assertTrue(first_is_cutting.wait(5), "the first voice is being cut")
            second = threading.Thread(target=post, args=(1.0,))
            second.start()
            second.join(1.0)
            self.assertTrue(second.is_alive(), "the second voice waits while the first one is still being cut")
            self.assertEqual(recognised, [])
            release_first.set()
            first.join(10)
            second.join(10)
            self.assertEqual(replies, {2.0: "2s", 1.0: "1s"})
            self.assertEqual(recognised, [2, 1])
        finally:
            release_first.set()
            server.shutdown()
            server.server_close()
            pool.stop()


class HttpQueueTest(unittest.TestCase):
    """The real handler with a gated recognizer: what a waiting voice is told, and what happens when it is abandoned."""

    def setUp(self):
        self.recognize = GatedRecognizer()
        self.pool = sidecar.RecognitionPool(self.recognize, workers=1)
        self.pool.start()
        self.server = sidecar.SidecarServer(
            ("127.0.0.1", 0), sidecar.SidecarContext(TEST_TOKEN, self.pool, split_one_piece_per_second, 1, 900.0, 600.0)
        )
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.recognize.gate.set()
        self.server.shutdown()
        self.server.server_close()
        self.pool.stop()

    def test_the_interim_response_reports_the_seconds_of_audio_queued_ahead(self):
        first = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(3.0))
        self.assertAlmostEqual(read_interim_queue_report(first), 0.0, msg="nothing is ahead of the first voice")
        self.assertTrue(self.recognize.started.wait(5))
        second = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(2.0))
        self.assertAlmostEqual(read_interim_queue_report(second), 3.0, msg="all three seconds of the first voice, its running piece included")
        self.recognize.gate.set()
        first_reply, second_reply = read_raw_response(first), read_raw_response(second)
        first.close()
        second.close()
        self.assertEqual((first_reply.status, json.loads(first_reply.body)["text"]), (200, "t3 t3 t3"))
        self.assertEqual((second_reply.status, json.loads(second_reply.body)["text"]), (200, "t2 t2"))

    def hold_the_decoding_of(self, seconds, tolerance_seconds=0.0):
        """Patch the decoder so that the voice of `seconds` blocks until the returned event is set."""
        release = threading.Event()
        decode = sidecar.decode_audio

        def held_decode(upload):
            samples, sample_rate = decode(upload)
            if abs(len(samples) - seconds * sample_rate) <= tolerance_seconds * sample_rate:
                release.wait(5)
            return samples, sample_rate

        patcher = unittest.mock.patch.object(sidecar, "decode_audio", held_decode)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(release.set)
        return release

    def wait_for_cutting_requests(self, count):
        deadline = time.monotonic() + 5
        while self.pool.count_cutting_requests() < count:
            self.assertLess(time.monotonic(), deadline, "the voice never got in line")
            time.sleep(0.01)

    def test_a_voice_behind_one_still_being_decoded_is_told_its_whole_length(self):
        release_first = self.hold_the_decoding_of(3)
        first = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(3.0))
        self.wait_for_cutting_requests(1)
        second = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(2.0))
        self.assertAlmostEqual(
            read_interim_queue_report(second), 3.0, msg="the first voice's length is known from its header before it is decoded"
        )
        release_first.set()
        self.recognize.gate.set()
        self.assertEqual(json.loads(read_raw_response(first).body)["text"], "t3 t3 t3")
        self.assertEqual(json.loads(read_raw_response(second).body)["text"], "t2 t2")
        first.close()
        second.close()

    def test_a_voice_behind_a_chained_ogg_still_being_decoded_is_told_its_whole_length(self):
        chained = build_multipart(make_chained_ogg(("OPUS", "OPUS")))
        release_first = self.hold_the_decoding_of(CLIP_SECONDS, LENGTH_TOLERANCE_SECONDS)
        first = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), chained)
        self.wait_for_cutting_requests(1)
        second = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(2.0))
        self.assertAlmostEqual(
            read_interim_queue_report(second), CLIP_SECONDS, delta=LENGTH_TOLERANCE_SECONDS,
            msg="the chain's length is known from the file before it is decoded, not the first stream's half of it",
        )
        release_first.set()
        self.recognize.gate.set()
        read_raw_response(first)
        read_raw_response(second)
        first.close()
        second.close()

    def hold_the_first_length_read(self):
        """Patch the length read so that the first voice's blocks until the returned event is set."""
        release = threading.Event()
        reads = []
        read = sidecar.read_audio_seconds

        def held_read(upload):
            reads.append(upload)
            if len(reads) == 1:
                release.wait(5)
            return read(upload)

        patcher = unittest.mock.patch.object(sidecar, "read_audio_seconds", held_read)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(release.set)
        return release

    def test_a_voice_arriving_while_the_one_ahead_is_still_being_sized_waits_for_its_length(self):
        """A voice takes its place in line before its length is read; the handler of the next one waits for that length
        before it reports its queue, so the first report is not the 0 s of a length nobody has noted yet."""
        entered_the_wait = threading.Event()
        wait = self.pool.wait_until_sized_ahead

        def spied_wait(request, timeout_seconds):
            entered_the_wait.set()
            wait(request, timeout_seconds)

        patcher = unittest.mock.patch.object(self.pool, "wait_until_sized_ahead", spied_wait)
        patcher.start()
        self.addCleanup(patcher.stop)
        release_first_read = self.hold_the_first_length_read()
        first = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(3.0))
        self.wait_for_cutting_requests(1)
        second = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(2.0))
        self.assertTrue(entered_the_wait.wait(5), "the second voice reported its queue without waiting for the first one's length")
        release_first_read.set()
        self.assertAlmostEqual(read_interim_queue_report(second), 3.0, msg="the first voice's length, noted while the second one waited")
        self.recognize.gate.set()
        read_raw_response(first)
        read_raw_response(second)
        first.close()
        second.close()

    def test_a_waiting_voice_is_told_again_when_the_queue_ahead_turns_out_longer(self):
        release_first = self.hold_the_decoding_of(3)
        patcher = unittest.mock.patch.object(sidecar, "read_audio_seconds", lambda upload: 0.0)
        patcher.start()
        self.addCleanup(patcher.stop)
        first = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(3.0))
        self.wait_for_cutting_requests(1)
        second = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(2.0))
        self.assertAlmostEqual(read_interim_queue_report(second), 0.0, msg="a length the header did not give is not known yet")
        release_first.set()
        self.assertAlmostEqual(read_interim_queue_report(second), 3.0, msg="once decoded, the longer queue is reported again")
        self.recognize.gate.set()
        self.assertEqual(json.loads(read_raw_response(second).body)["text"], "t2 t2")
        read_raw_response(first)
        first.close()
        second.close()

    def test_a_voice_whose_client_hung_up_is_dropped_and_its_pieces_are_never_recognised(self):
        first = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(1.0))
        self.assertTrue(self.recognize.started.wait(5))
        abandoned = send_raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(4.0))
        read_interim_queue_report(abandoned)
        self.assertEqual(self.pool.queued_chunks(), 4)
        abandoned.close()
        deadline = time.monotonic() + 5
        while self.pool.queued_chunks() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.pool.queued_chunks(), 0, "the hung-up voice left the queue while the first one still runs")
        self.recognize.gate.set()
        self.assertEqual(read_raw_response(first).status, 200)
        first.close()
        self.assertEqual(self.recognize.order, [1])


class HttpAudioFormatsTest(unittest.TestCase):
    """The real handler and the real decoder over loopback, with a recognizer that answers each piece's length: the
    reply covers the whole file for every kind of upload."""

    @classmethod
    def setUpClass(cls):
        cls.pool = sidecar.RecognitionPool(lambda samples, sample_rate: f"{len(samples) / sample_rate:.2f}", workers=2)
        cls.pool.start()
        cls.server = sidecar.SidecarServer(
            ("127.0.0.1", 0), sidecar.SidecarContext(TEST_TOKEN, cls.pool, sidecar.split_without_pauses, 2, 900.0, 600.0)
        )
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.pool.stop()

    def count_calls(self, owner, name):
        real = getattr(owner, name)
        calls = []

        def counted(*arguments, **options):
            calls.append(name)
            return real(*arguments, **options)

        patcher = unittest.mock.patch.object(owner, name, counted)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def test_an_upload_is_inspected_once_however_many_steps_read_it(self):
        """The route (libsndfile or ffmpeg) is decided once per upload and handed to the length read and the decode."""
        info_calls = self.count_calls(soundfile, "info")
        walk_calls = self.count_calls(sidecar, "find_ogg_stream_starts")
        split_calls = self.count_calls(sidecar, "split_ogg_streams")
        wav = io.BytesIO()
        soundfile.write(wav, make_pitch_clip(16000, seconds=10), 16000, format="WAV")
        uploads = {"a WAV": wav.getvalue(), **{kind: make() for kind, make in AUDIO_KINDS.items()}}
        for kind, data in uploads.items():
            with self.subTest(kind):
                for calls in (info_calls, walk_calls, split_calls):
                    calls.clear()
                response = raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), build_multipart(data))
                self.assertEqual(response.status, 200, response.body)
                self.assertEqual(len(info_calls), 1, "libsndfile was asked about the file more than once")
                self.assertLessEqual(len(walk_calls), 1, "the Ogg pages were walked more than once")
                self.assertLessEqual(len(split_calls), 1, "the file was split into streams more than once")

    def test_a_40_second_file_of_each_kind_is_recognised_to_its_last_second(self):
        for kind, make in AUDIO_KINDS.items():
            with self.subTest(kind):
                response = raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), build_multipart(make()))
                self.assertEqual(response.status, 200, response.body)
                recognised_seconds = sum(float(piece) for piece in json.loads(response.body)["text"].split())
                self.assertAlmostEqual(recognised_seconds, CLIP_SECONDS, delta=LENGTH_TOLERANCE_SECONDS)


class RecognitionOsErrorTest(unittest.TestCase):
    def test_an_os_error_of_the_recognition_itself_is_a_500_not_a_client_that_left(self):
        def recognize(samples, sample_rate):
            raise OSError("the model file could not be read")

        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        server = sidecar.SidecarServer(("127.0.0.1", 0), sidecar.SidecarContext(TEST_TOKEN, pool, split_one_piece_per_second, 1, 900.0, 600.0))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with self.assertLogs(sidecar.logger, level="ERROR"):
                response = raw_request(server.server_address[1], "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), wav_upload(1.0))
            self.assertEqual(response.status, 500, "the bot must hear of a failure of ours, not of a hang-up it did not do")
            self.assertIn("OSError", json.loads(response.body)["error"]["message"])
        finally:
            server.shutdown()
            server.server_close()
            pool.stop()


class QueueReportFailureTest(unittest.TestCase):
    def test_a_client_gone_before_the_interim_report_drops_the_voice(self):
        recognize = GatedRecognizer()
        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        running = submit_now(pool, [label_chunk(1)])
        self.assertTrue(recognize.started.wait(5))
        handler = sidecar.SidecarHandler.__new__(sidecar.SidecarHandler)
        handler.headers = {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"}
        body = wav_upload(2.0)
        handler.headers["Content-Length"] = str(len(body))
        handler.rfile = io.BytesIO(body)

        def broken_report(seconds_ahead):
            raise BrokenPipeError("the client is gone")

        handler._write_queue_report = broken_report
        context = sidecar.SidecarContext(TEST_TOKEN, pool, split_one_piece_per_second, 1, 900.0, 600.0)
        with self.assertRaises(sidecar.ClientGone):
            handler._transcribe(context)
        self.assertEqual(pool.queued_chunks(), 0, "the voice's pieces do not stay queued")
        recognize.gate.set()
        running.wait(5)
        pool.stop()
        self.assertEqual(recognize.order, [1])


class HttpTest(unittest.TestCase):
    """The real handler over loopback with a fake recognizer."""

    @classmethod
    def setUpClass(cls):
        cls.texts = []
        cls.delay = threading.Event()

        cls.split_requests = []

        def recognize(samples, sample_rate):
            if cls.delay.is_set():
                threading.Event().wait(2)
            if sample_rate == HALVING_SPLITTER_RATE:
                return f"кусок {len(samples)}@{sample_rate}"
            return "привет мир"

        def split_audio(samples, sample_rate):
            if not cls.split_requests:
                return sidecar.split_without_pauses(samples, sample_rate)
            cls.split_requests.pop()
            half = len(samples) // 2
            return [samples[:half], samples[half:]], HALVING_SPLITTER_RATE

        cls.split_audio = split_audio
        cls.pool = sidecar.RecognitionPool(recognize, workers=2)
        cls.pool.start()
        cls.context = sidecar.SidecarContext(TEST_TOKEN, cls.pool, cls.split_audio, 2, 900.0, 600.0)
        cls.server = sidecar.SidecarServer(("127.0.0.1", 0), cls.context)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.pool.stop()

    def request(self, method, path, body=None, headers=None, token=TEST_TOKEN):
        all_headers = dict(headers or {})
        if token is not None:
            all_headers["Authorization"] = f"Bearer {token}"
        response = raw_request(self.port, method, path, all_headers, body or b"")
        return response.status, response.body

    def make_upload(self):
        wav = io.BytesIO()
        import soundfile

        soundfile.write(wav, tone(1.0), SAMPLE_RATE, format="WAV", subtype="PCM_16")
        return build_multipart(wav.getvalue(), {"model": "whisper-1"})

    def multipart_headers(self, extra=None):
        return {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}", **(extra or {})}

    def test_health_needs_the_token_and_reports_the_pool(self):
        status, payload = self.request("GET", "/health", token=None)
        self.assertEqual(status, 401)
        self.assertIn("message", json.loads(payload)["error"])
        status, _ = self.request("GET", "/health", token="wrong")
        self.assertEqual(status, 401)
        status, payload = self.request("GET", "/health")
        self.assertEqual(status, 200)
        health = json.loads(payload)
        self.assertEqual((health["status"], health["workers"], health["idleMinutes"]), ("ok", 2, 15.0))
        self.assertEqual(health["queuedChunks"], 0)
        self.assertEqual(health["cuttingRequests"], 0)
        self.assertEqual(health["pid"], os.getpid())

    def test_a_transcription_returns_json_text_in_utf8(self):
        response = raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), self.make_upload())
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {"text": "привет мир"})
        self.assertEqual(
            [(status, headers[sidecar.QUEUED_AUDIO_SECONDS_HEADER.lower()]) for status, headers in response.interim],
            [(102, "0.0")],
            "the voice is first told that nothing is queued ahead of it",
        )

    def test_the_pieces_of_the_splitter_are_recognised_at_its_rate_and_joined_in_order(self):
        self.split_requests.append(True)
        status, payload = self.request("POST", sidecar.TRANSCRIPTIONS_PATH, self.make_upload(), self.multipart_headers())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload.decode("utf-8")), {"text": f"кусок {SAMPLE_RATE // 2}@{HALVING_SPLITTER_RATE} кусок {SAMPLE_RATE // 2}@{HALVING_SPLITTER_RATE}"})

    def test_the_text_format_is_plain_text(self):
        wav = io.BytesIO()
        import soundfile

        soundfile.write(wav, tone(1.0), SAMPLE_RATE, format="WAV", subtype="PCM_16")
        body = build_multipart(wav.getvalue(), {"response_format": "text"})
        status, payload = self.request("POST", sidecar.TRANSCRIPTIONS_PATH, body, self.multipart_headers())
        self.assertEqual((status, payload.decode("utf-8")), (200, "привет мир"))

    def test_a_chunked_upload_like_nodes_is_accepted(self):
        response = raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, upload_headers(), self.make_upload(), is_chunked=True)
        self.assertEqual((response.status, json.loads(response.body)), (200, {"text": "привет мир"}))

    def test_bad_requests_are_refused_with_json_errors(self):
        headers = self.multipart_headers()
        status, _ = self.request("POST", sidecar.TRANSCRIPTIONS_PATH, self.make_upload(), headers, token=None)
        self.assertEqual(status, 401)
        status, _ = self.request("POST", "/v1/other", self.make_upload(), headers)
        self.assertEqual(status, 404)
        status, _ = self.request("GET", "/v1/audio/transcriptions")
        self.assertEqual(status, 404)
        no_file = f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="model"\r\n\r\nx\r\n--{BOUNDARY}--\r\n'.encode()
        status, payload = self.request("POST", sidecar.TRANSCRIPTIONS_PATH, no_file, headers)
        self.assertEqual(status, 400)
        self.assertIn("file", json.loads(payload)["error"]["message"])
        bad_format = build_multipart(b"not audio", {"response_format": "srt"})
        status, _ = self.request("POST", sidecar.TRANSCRIPTIONS_PATH, bad_format, headers)
        self.assertEqual(status, 400)
        not_audio = build_multipart(b"definitely not an audio file", {})
        status, payload = self.request("POST", sidecar.TRANSCRIPTIONS_PATH, not_audio, headers)
        self.assertEqual(status, 400)
        self.assertIn("decoded", json.loads(payload)["error"]["message"])

    def test_a_body_over_the_limit_is_a_413_before_it_is_read(self):
        headers = {**upload_headers(), "Content-Length": str(sidecar.MAX_BODY_BYTES + 1)}
        self.assertEqual(raw_request(self.port, "POST", sidecar.TRANSCRIPTIONS_PATH, headers).status, 413)

    def test_busy_requests_counts_a_transcription_in_flight_and_refuses_after_the_exit_decision(self):
        self.delay.set()
        results = []
        thread = threading.Thread(
            target=lambda: results.append(
                self.request("POST", sidecar.TRANSCRIPTIONS_PATH, self.make_upload(), self.multipart_headers())[0]
            )
        )
        thread.start()
        deadline = 5.0
        while self.context.busy_requests == 0 and deadline > 0:
            threading.Event().wait(0.05)
            deadline -= 0.05
        status, payload = self.request("GET", "/health")
        self.assertEqual(json.loads(payload)["busyRequests"], 1)
        thread.join(10)
        self.delay.clear()
        self.assertEqual(results, [200])
        # The handler counts the request out just after the reply is on the wire.
        deadline = 5.0
        while self.context.busy_requests != 0 and deadline > 0:
            threading.Event().wait(0.05)
            deadline -= 0.05
        self.assertEqual(self.context.busy_requests, 0)

        self.context.is_exiting = True
        try:
            status, _ = self.request("POST", sidecar.TRANSCRIPTIONS_PATH, self.make_upload(), self.multipart_headers())
            self.assertEqual(status, 503, "after the idle exit is decided a late request is refused, so the bot falls back")
        finally:
            self.context.is_exiting = False


class IdleExitTest(unittest.TestCase):
    """The idle exit's decision, with a hand-turned clock and recording callbacks."""

    def setUp(self):
        self.now = [1000.0]
        self.calls = []
        self.context = sidecar.SidecarContext(TEST_TOKEN, None, sidecar.split_without_pauses, 2, 60.0, 600.0, clock=lambda: self.now[0])

    def decide(self, between=None):
        def stop_accepting():
            self.calls.append("stop")
            if between:
                between()

        return self.context.decide_idle_exit(stop_accepting, lambda: self.calls.append("resume"))

    def test_not_idle_long_enough_does_not_even_stop_accepting(self):
        self.now[0] += 59
        self.assertFalse(self.decide())
        self.assertEqual(self.calls, [])

    def test_idle_long_enough_stops_accepting_and_decides_to_exit(self):
        self.now[0] += 61
        self.assertTrue(self.decide())
        self.assertEqual(self.calls, ["stop"])
        self.assertTrue(self.context.is_exiting)
        self.assertFalse(self.context.enter_request(), "after the decision a late request is refused")

    def test_a_request_in_flight_is_never_idle(self):
        self.assertTrue(self.context.enter_request())
        self.now[0] += 3600
        self.assertFalse(self.decide())
        self.assertEqual(self.calls, [])

    def test_a_request_that_slips_in_while_accepting_stops_aborts_the_exit(self):
        self.now[0] += 61

        def request_arrives():
            self.assertTrue(self.context.enter_request())

        self.assertFalse(self.decide(between=request_arrives))
        self.assertEqual(self.calls, ["stop", "resume"])
        self.assertFalse(self.context.is_exiting)
        self.context.leave_request()
        self.assertTrue(self.context.enter_request(), "the sidecar keeps serving")

    def test_a_request_that_finishes_during_the_stop_also_resets_the_timer(self):
        self.now[0] += 61

        def request_comes_and_goes():
            self.context.enter_request()
            self.context.leave_request()

        self.assertFalse(self.decide(between=request_comes_and_goes))
        self.assertEqual(self.calls, ["stop", "resume"])

    def test_zero_means_never(self):
        self.context.idle_seconds = 0
        self.now[0] += 10 ** 6
        self.assertFalse(self.decide())
        self.assertEqual(self.calls, [])


class MainTest(unittest.TestCase):
    def test_serving_without_a_token_exits_with_usage_code(self):
        environment = {key: value for key, value in os.environ.items() if key != sidecar.TOKEN_ENV_NAME}
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [
                    sys.executable, "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gigaam_sidecar.py"),
                    "--ready-file", os.path.join(directory, "r"), "--record-file", os.path.join(directory, "s"),
                    "--log-file", os.path.join(directory, "l"), "--owner-pid", str(os.getpid()), "--config-hash", "h",
                ],
                env=environment, capture_output=True, text=True, timeout=30,
            )
        self.assertEqual(result.returncode, 2)
        self.assertIn(sidecar.TOKEN_ENV_NAME, result.stderr)

    def test_missing_required_arguments_exit_with_usage_code(self):
        with contextlib.redirect_stderr(io.StringIO()) as usage, self.assertRaises(SystemExit) as caught:
            sidecar.parse_args(["--workers", "2"])
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("--ready-file is required", usage.getvalue())

    def test_the_hidden_idle_seconds_wins_over_idle_minutes(self):
        required = ["--ready-file", "r", "--record-file", "s", "--log-file", "l", "--owner-pid", "1", "--config-hash", "h"]
        self.assertEqual(sidecar.parse_args(required + ["--idle-minutes", "5"]).idle_seconds, 300.0)
        self.assertEqual(sidecar.parse_args(required + ["--idle-minutes", "5", "--idle-seconds", "3"]).idle_seconds, 3.0)
        self.assertEqual(sidecar.parse_args(required + ["--idle-minutes", "0"]).idle_seconds, 0.0)


if __name__ == "__main__":
    unittest.main()
