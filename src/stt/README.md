# `src/stt/` — voice recognition

How a voice note becomes text: where the settings live, which engines are tried in which order, how long each
gets. User-facing setup is in [`SETUP.md` § Voice input](../../SETUP.md#voice-input).

| File | Role |
|------|------|
| `sttSettings.ts` | `stt.json`: types, strict validation, cached load, atomic save, the one-time env-key migration, the resolver (settings → the chain a voice walks), the timeout math, the `[STT]` log lines |
| `transcribeChain.ts` | `transcribeWithEngines`: walk the chain for one voice file |
| `sttInstall.ts` | The local engine's install: plan (uv / python3 venv), idempotent run with a lock and progress, `isGigaamInstalled` / `isGigaamInstalling`, remove |
| `sttInstallEntry.ts` | The detached install job the bot launches (not a user command): `node dist/stt/sttInstallEntry.js <dataDir> [--force]` |
| `../../stt/gigaam_sidecar.py` | The recognition process (Python), shipped in the package's `stt/` dir; `../../stt/test_gigaam_sidecar.py` are its unit tests |
| `../utils/transcribeAudio.ts` | The ONE HTTP primitive: a multipart `POST` to an OpenAI-compatible `/audio/transcriptions`, with classified failures and the retry schedule |

## `stt.json` — the one source of truth

`~/.config/charness/stt.json` (the directory of the loaded env file; `dirname(ENV_FILE)` for an isolated
instance; a pre-rename config dir is kept). Settings AND keys, mode 0600, written through a temp file and a
rename. **No `STT_*` env variables exist.**

- **Validation is strict and all-or-nothing** (zod, like `jira.json`): an unknown key, kind, duplicate id, a
  second local engine, an out-of-range number or a bad language is an error that names the field
  (`stt.json engines.1.timeout.baseSeconds: …`) and **never a value** — the file holds API keys. A JSON syntax
  error reports only its position (Node quotes the source text in its message, so that text is not used).
- **The cache key is the file stamp** (mtime, size, inode): one `stat` per voice, a hand edit or a `/stt`
  save is picked up by the next voice. A missing file is the empty settings. An invalid edit keeps the **last
  good** settings (`source: 'lastGood'`); if the file was never valid in this process there are none
  (`source: 'invalid'`) and the voice gate answers `voice.config_invalid`.
- **Workers** are clamped to {1, 2, 4, 8} (nearest, a tie goes to the smaller); `threads` is a hand-edit-only knob.
- **Migration** (`migrateLegacySttKeys`, boot only): no `stt.json` + `GROQ_API_KEY` / `OPENAI_API_KEY` in the
  environment → write the file with those engines (Groq `q1` first, then OpenAI `o1`). It is the ONLY reader of
  those variables; an existing file is never overwritten; the `[deprecated]` line is printed once per process.

## The chain

`resolveSttSettings(load, facts, { getGigaamEndpoint })` returns the available engines in file order, the
skipped ones with a reason, `needsAutoInstall` and the file's errors. An engine is skipped when it is disabled,
lacks its key or URL, or — for the local `gigaam` engine — is not installed / still installing / marked
unhealthy, the language is set to something other than `ru`, or there is no owner process to start it with.
Each resolved engine carries `getEndpoint()`: static engines answer at once; the local one starts its process
there and may reject.

`transcribeWithEngines` per engine: `getEndpoint()` (a rejection is that engine's failure), then
`transcribeAudio`.

- A **non-last** engine is tried **once** (`retryDelaysMs: []`); any failure — refused connection, timeout, 4xx,
  5xx, a rejected endpoint — moves to the next at once, logged only (`[transcribe] <engine> failed (…); falling
  back to <next>`).
- The **last** engine keeps the retry schedule (5 s, 15 s) and its `voice.retrying` notice.
- **Definitive failures end the walk**: an empty transcript (Groq hallucinates on silence, so another engine's
  text would not be more true), an empty or unreadable file.
- The result carries the answering engine's `name` (`groq`, `openai`, `gigaam`, `url:<host>`).

## Timeout proportional to the voice

`getEngineTimeoutMs(timeout, durationSeconds) = (baseSeconds + percentOfDuration/100 × durationSeconds) × 1000`,
default `{ 10, 25 }`: 30 s → 17.5 s, 5 min → 85 s; an unknown duration counts as 60 s. It is the socket
inactivity timer of the request. A long voice is never routed away from its engine for being long — it just gets
more time.

## The local engine: one sidecar process

GigaAM v3 E2E-RNN-T (int8) runs in our own Python process on `onnx-asr`, started on demand, exposing an
OpenAI-compatible endpoint on `127.0.0.1` only. Nothing is shared with the operator's Python: a private venv and a
private Hugging Face cache live under `<DATA_DIR>/stt`.

### Install layout (`<DATA_DIR>/stt`)

| Path | What |
|------|------|
| `venv/` | the private environment (`uv venv --python ">=3.10"`, else `python3 -m venv`) with the pinned `onnx-asr[cpu,hub]==0.12.0 soundfile==0.14.0` |
| `hf/` | `HF_HOME` — the model files (216 MiB for int8); the running sidecar is offline (`HF_HUB_OFFLINE=1`) |
| `uv-cache/` | uv's cache, kept here so it stays off the root fs and is removed with the install (wheels are hard-linked, not doubled) |
| `installed.json` | the marker `{ scriptVersion, pins, installedAt }`; "installed" means the marker matches this build AND `venv/bin/python` exists |
| `install.lock/` | a `mkdir` lock with an `owner` file; stale after 30 min or when the owner pid is dead |
| `install.log` | child output of the install; a failure returns its last 20 lines |
| `install-progress.json` | JSON lines `{phase, detail, bytesDownloaded[, error, logTail]}` — `creatingEnvironment` → `installingPackages` → `downloadingModel` → `checking` → `done` / `failed`; truncated when a run takes the lock |

`runSttInstall` is idempotent (a current marker runs nothing; `force` rebuilds the venv but keeps the model cache),
runs the sidecar's `--check` as the verify step (loads the model, recognises a second of silence, checks libsndfile
can read OGG/Opus, prints the versions as JSON — so a broken download is caught at install time), and polls the size
of `hf/` every 2 s for the download progress. Heavy writes follow `TMPDIR`.

### Sidecar protocol (`stt/gigaam_sidecar.py`)

`python -I gigaam_sidecar.py --ready-file F --record-file R --log-file L --owner-pid P [--owner-start-token S]
[--idle-minutes 15] [--workers 4] [--threads 2] [--max-seconds 600]`. The token comes from the env variable
`CHARNESS_STT_SIDECAR_TOKEN` (never an argument: `ps` shows arguments). `HF_HOME` and `HF_HUB_OFFLINE=1` come from the
env too.

- **Startup order:** load the model → start W pool threads → bind `127.0.0.1:0` → write the ready file `F` atomically
  (`{pid, port, version}`, mode 0600). A model or bind failure is logged and exits 1 without writing `F`.
- **Exit codes:** `0` clean (SIGTERM, idle, owner gone) · `1` model or socket setup failed · `2` bad usage (a missing
  token included).
- **Logs** go to `L` only (5 MB, one rotation); stdio is pointed at `/dev/null` because the process is externally
  parented. Transcripts are never logged — only audio length, chunk count and timing.
- `GET /health` (Bearer token, else 401) → `{status, busyRequests, queuedChunks, workers, idleMinutes, version, pid}`. A
  health call is not activity: opening a status screen never keeps the process alive.
- `POST /v1/audio/transcriptions`, multipart (`email.parser`, not `cgi`; Node's chunked, Content-Length-less uploads are
  decoded). Fields: `file` (required), `model` / `language` (accepted, ignored), `response_format` `json` (default) or
  `text`. Replies `{"text": …}` in UTF-8, or errors `{"error": {"message": …}}`: 400 (bad body, undecodable audio,
  unsupported sample rate), 401, 404, 413 (body over 25 MB), 500, 503 (the idle exit is decided), 504 (over
  `--max-seconds`; that request's queued chunks are dropped). Every response closes the connection.
- **Chunking:** audio is decoded with `soundfile` (libsndfile reads Telegram's OGG/Opus, no ffmpeg), downmixed to mono, and
  — when longer than 25 s — cut so every piece is ≤ 25 s, each cut at the centre of the quietest 50 ms window in the last
  8 s before the boundary. Pieces go to the model at the file's own sample rate (onnx-asr resamples 8–48 kHz to 16 kHz).
  A piece under 0.1 s is empty text: the encoder cannot take it.
- **Pool:** W threads over one `PriorityQueue` of `(chunk count of the request, arrival number, …)` — the shortest request
  first, FIFO among equals — each calling `model.recognize` on the ONE shared onnxruntime session (one model in memory).
  A failing chunk fails its request only. Texts are joined in order with single spaces.
- **Idle exit:** a timer checks every 5 s. With no transcription in flight for `--idle-minutes` (0 = never) it stops
  accepting, re-checks that nothing slipped in (if one did, it keeps serving), then deletes `R` **only if R names its own
  pid** (never another generation's), and exits 0. A request that arrives after the exit is decided gets 503 and the bot
  falls back; the next voice starts a fresh process.
- **Owner watchdog:** every 2 s `kill(owner, 0)`, and on Linux the owner's `/proc/<pid>/stat` field 22 must equal
  `--owner-start-token` (a reused pid is a different owner). When the owner is gone it deletes its own record and
  `_exit(0)` — a SIGKILLed bot or supervisor leaves no sidecar behind.
- **SIGTERM** closes the server and exits 0; removing `R` is the bot's job on a stop.

### Measured on a dev box (4 cores / 8 threads, no GPU, under load)

Cold start (spawn → ready file) ≈ 2–2.4 s; an 18 s voice ≈ 1.5 s; a 300 s voice ≈ 18.6 s with 4 workers × 2 threads,
peak RSS ≈ 780 MB; a short voice sent while a long one is queued is answered in ≈ 3.5 s.
