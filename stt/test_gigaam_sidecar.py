"""Unit tests of the sidecar's logic — no model, no network beyond loopback. Run with the sidecar's own
interpreter (it needs numpy):  <venv>/bin/python -I stt/test_gigaam_sidecar.py"""

import argparse
import contextlib
import http.client
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

import gigaam_sidecar as sidecar  # noqa: E402

# The sidecar logs failures it handles; without a handler Python would print them over the test output.
sidecar.logger.addHandler(logging.NullHandler())

SAMPLE_RATE = 16000
TEST_TOKEN = "test-token-0123456789"
BOUNDARY = "----formboundary7MA4YWxkTrZu0gW"


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


class PoolTest(unittest.TestCase):
    def test_a_short_request_overtakes_the_rest_of_a_long_one(self):
        gate = threading.Event()
        first_started = threading.Event()
        order = []

        def recognize(samples, sample_rate):
            order.append(int(samples[0]))
            first_started.set()
            gate.wait(5)
            return f"t{int(samples[0])}"

        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        long_chunks = [np.full(4, 100 + index, dtype=np.float32) for index in range(12)]
        long_request = pool.submit(long_chunks, SAMPLE_RATE)
        self.assertTrue(first_started.wait(5), "the single worker took the long request's first chunk")
        self.assertEqual(pool.queued_chunks(), 11)
        short_request = pool.submit([np.full(4, 1, dtype=np.float32)], SAMPLE_RATE)
        gate.set()
        self.assertEqual(short_request.wait(5), "t1")
        long_text = long_request.wait(5)
        pool.stop()

        self.assertEqual(order[0], 100)
        self.assertEqual(order[1], 1, "the short request ran before the long one's remaining chunks")
        self.assertEqual(order[2:], list(range(101, 112)), "the long request keeps its own order")
        self.assertEqual(long_text, " ".join(f"t{100 + index}" for index in range(12)))

    def test_equal_priorities_keep_arrival_order(self):
        order = []
        gate = threading.Event()
        started = threading.Event()

        def recognize(samples, sample_rate):
            order.append(int(samples[0]))
            started.set()
            gate.wait(5)
            return ""

        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        requests = [pool.submit([np.full(4, label, dtype=np.float32)], SAMPLE_RATE) for label in (1, 2, 3)]
        self.assertTrue(started.wait(5))
        gate.set()
        for request in requests:
            request.wait(5)
        pool.stop()
        self.assertEqual(order, [1, 2, 3])

    def test_a_failing_chunk_fails_its_request_only(self):
        def recognize(samples, sample_rate):
            if samples[0] == 666:
                raise ValueError("broken chunk")
            return "ok"

        pool = sidecar.RecognitionPool(recognize, workers=2)
        pool.start()
        broken = pool.submit([np.full(4, 666, dtype=np.float32), np.full(4, 1, dtype=np.float32)], SAMPLE_RATE)
        fine = pool.submit([np.full(4, 2, dtype=np.float32)], SAMPLE_RATE)
        with self.assertRaises(ValueError):
            broken.wait(5)
        self.assertEqual(fine.wait(5), "ok")
        pool.stop()

    def test_a_timeout_drops_the_pending_chunks(self):
        gate = threading.Event()
        calls = []

        def recognize(samples, sample_rate):
            calls.append(1)
            gate.wait(5)
            return "late"

        pool = sidecar.RecognitionPool(recognize, workers=1)
        pool.start()
        request = pool.submit([np.zeros(4, dtype=np.float32) for _ in range(5)], SAMPLE_RATE)
        with self.assertRaises(sidecar.RecognitionTimeout):
            request.wait(0.1)
        gate.set()
        pool.stop()
        for thread in pool._threads:
            thread.join(5)
        self.assertEqual(len(calls), 1, "only the chunk already running was recognised")

    def test_texts_are_joined_with_single_spaces_and_empty_ones_dropped(self):
        request = sidecar.PoolRequest(4, SAMPLE_RATE)
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


class HttpTest(unittest.TestCase):
    """The real handler over loopback with a fake recognizer."""

    @classmethod
    def setUpClass(cls):
        cls.texts = []
        cls.delay = threading.Event()

        def recognize(samples, sample_rate):
            if cls.delay.is_set():
                threading.Event().wait(2)
            return "привет мир"

        cls.pool = sidecar.RecognitionPool(recognize, workers=2)
        cls.pool.start()
        cls.context = sidecar.SidecarContext(TEST_TOKEN, cls.pool, 2, 900.0, 600.0)
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
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        all_headers = dict(headers or {})
        if token is not None:
            all_headers["Authorization"] = f"Bearer {token}"
        connection.request(method, path, body=body, headers=all_headers)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, payload

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
        self.assertEqual(health["pid"], os.getpid())

    def test_a_transcription_returns_json_text_in_utf8(self):
        body = self.make_upload()
        status, payload = self.request("POST", sidecar.TRANSCRIPTIONS_PATH, body, self.multipart_headers())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload.decode("utf-8")), {"text": "привет мир"})

    def test_the_text_format_is_plain_text(self):
        wav = io.BytesIO()
        import soundfile

        soundfile.write(wav, tone(1.0), SAMPLE_RATE, format="WAV", subtype="PCM_16")
        body = build_multipart(wav.getvalue(), {"response_format": "text"})
        status, payload = self.request("POST", sidecar.TRANSCRIPTIONS_PATH, body, self.multipart_headers())
        self.assertEqual((status, payload.decode("utf-8")), (200, "привет мир"))

    def test_a_chunked_upload_like_nodes_is_accepted(self):
        body = self.make_upload()
        pieces = [body[index:index + 700] for index in range(0, len(body), 700)]
        raw = b"".join(f"{len(piece):x}\r\n".encode() + piece + b"\r\n" for piece in pieces) + b"0\r\n\r\n"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest("POST", sidecar.TRANSCRIPTIONS_PATH)
        connection.putheader("Authorization", f"Bearer {TEST_TOKEN}")
        connection.putheader("Content-Type", f"multipart/form-data; boundary={BOUNDARY}")
        connection.putheader("Transfer-Encoding", "chunked")
        connection.endheaders()
        connection.send(raw)
        response = connection.getresponse()
        self.assertEqual((response.status, json.loads(response.read())), (200, {"text": "привет мир"}))
        connection.close()

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
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest("POST", sidecar.TRANSCRIPTIONS_PATH)
        connection.putheader("Authorization", f"Bearer {TEST_TOKEN}")
        connection.putheader("Content-Type", f"multipart/form-data; boundary={BOUNDARY}")
        connection.putheader("Content-Length", str(sidecar.MAX_BODY_BYTES + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        connection.close()

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
        self.context = sidecar.SidecarContext(TEST_TOKEN, None, 2, 60.0, 600.0, clock=lambda: self.now[0])

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
