# `src/stt/` — voice recognition

How a voice note becomes text: where the settings live, which engines are tried in which order, how long each
gets. User-facing setup is in [`SETUP.md` § Voice input](../../SETUP.md#voice-input).

| File | Role |
|------|------|
| `sttSettings.ts` | `stt.json`: types, strict validation, cached load, atomic save, the one-time env-key migration, the resolver (settings → the chain a voice walks), the timeout math, the `[STT]` log lines |
| `transcribeChain.ts` | `transcribeWithEngines`: walk the chain for one voice file |
| `sttInstall.ts` | The local engine's install: plan (uv / python3 venv), idempotent run with a lock and progress, `isGigaamInstalled` / `isGigaamInstalling`, remove |
| `sttInstallEntry.ts` | The detached install job the bot launches (not a user command): `node dist/stt/sttInstallEntry.js <dataDir> [--force]` |
| `sttSidecarOwner.ts` | The sidecar's lifecycle: `ensure` (adopt or spawn on demand, one shared attempt), the record, the spawn-storm guard, `stop`, the boot cleanup, the owner context |
| `sttAutoInstall.ts` | The install job manager: launch the detached job or attach to the running one, poll its progress file, report |
| `sttInstallReporter.ts`, `sttScreenPlan.ts` | The install progress as ONE edited message (or `[STT]` log lines), and the pure text of it |
| `sttConfigEdit.ts`, `sttScreenPlan.ts` | The `/stt` brain, without Telegram: the edits to `stt.json` (validated like a hand edit), the screens as data, the callback codec (`stt_<action>_<arg>_<revision>`, ≤ 64 bytes), the key/address input decision and `reduceSttAction` (tap → show / save / arm input / effect). The buttons and the typed-input hooks are `connectors/telegram/commands/stt.ts` |
| `sttRuntime.ts` | `stt.json` + the lifecycle facts resolved per call; the boot migration; the once-per-edit auto-install trigger |
| `../../stt/gigaam_sidecar.py` | The recognition process (Python), shipped in the package's `stt/` dir; `../../stt/test_gigaam_sidecar.py` are its unit tests |
| `../utils/transcribeAudio.ts` | The ONE HTTP primitive: a multipart `POST` to an OpenAI-compatible `/audio/transcriptions`, with classified failures and the retry schedule |

## `stt.json` — the one source of truth

`~/.config/charness/stt.json`, in the directory of the instance's REAL env file (`getSttConfigPath`): `ENV_FILE`
for an isolated instance, else the charness config dir's `.env` (a pre-rename config dir is kept). The env file's
symlink is resolved first — `.env` linked to a file on an encrypted volume puts `stt.json` beside the TARGET, so
the keys it holds stay with the other secrets; a dangling link keeps the directory it was named in. Settings AND
keys, mode 0600, written through a temp file and a rename. **No `STT_*` env variables exist.** The directory must be
writable and persistent (Docker: mount the config DIRECTORY, not only the env file): there is NO fallback to another
location — `init` probes it (`getSttConfigWriteBlock`) and logs `[STT] … cannot be written` once, and a `/stt` save that
fails says so naming the path. A writable directory can still be the container's OWN disk (only the env file was mounted):
in a container (`/.dockerenv`, `/run/.containerenv`) with the directory on the device of `/`, `init` logs `[STT] … is on this
container's own disk` once (`checkIsSttConfigOnContainerDisk`) — also in the fresh container that migrates the old env
keys again.

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
| `install.lock/` | a `mkdir` lock with an `owner` file (`pid` and start token). Held for as long as that process lives — a slow model download can take far longer than any timeout — so age never frees it; a lock with no owner file (its taker died between `mkdir` and the write) goes stale after a minute |
| `install.log` | child output of the install; a failure returns its last 20 lines |
| `install-progress.json` | JSON lines `{phase, detail, bytesDownloaded[, error, logTail]}` — `creatingEnvironment` → `installingPackages` → `downloadingModel` → `checking` → `done` / `failed`; truncated when a run takes the lock |

`runSttInstall` is idempotent (a current marker runs nothing; `force` rebuilds the venv but keeps the model cache),
runs the sidecar's `--check` as the verify step (loads the model, recognises a second of silence, checks libsndfile
can read OGG/Opus, prints the versions as JSON — so a broken download is caught at install time), and polls the size
of `hf/` every 2 s for the download progress. Heavy writes follow `TMPDIR`.

### Sidecar protocol (`stt/gigaam_sidecar.py`)

`python -I gigaam_sidecar.py --ready-file F --record-file R --log-file L --owner-pid P --config-hash H
[--owner-start-token S] [--idle-minutes 15] [--workers 4] [--threads 2] [--max-seconds 600]`. The token comes from the env variable
`CHARNESS_STT_SIDECAR_TOKEN` (never an argument: `ps` shows arguments). `HF_HOME` and `HF_HUB_OFFLINE=1` come from the
env too.

- **Startup order:** claim ITS OWN record `R` (an exclusive create — a hard link of a finished file — with
  `{pid, startToken, port: 0, token, configHash, ownerPid, ownerStartToken, startedAt}`, mode 0600; the hash is the
  bot's, recorded as given) → load the model → start W pool threads → bind `127.0.0.1:0` → complete `R` with the port
  (only while it is still this process's) → write the ready file `F` (`{pid, port, version}`). The record exists from the
  first moment so that a bot worker replaced while it waits for `F` (a hot reload during the 2–6 s start, most of which
  is the model load) leaves a process the next worker finds and waits for, instead of an orphan nobody knows the token
  of; and because the claim is exclusive, of two sidecars started at once only the first is recorded — the second sees
  a live record of another process and exits `4`. A model, bind, record or ready-file failure is logged and exits 1
  without writing `F`.
- **Exit codes:** `0` clean (SIGTERM, idle, owner gone) · `1` model, socket, record or ready file could not be set up ·
  `2` bad usage (a missing token included) · `4` another live sidecar already holds the record (a duplicate start).
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

## Lifecycle: who starts, adopts and stops the sidecar

**On demand.** A voice whose chain reaches the local engine calls `ensure` (through the engine's `getEndpoint()`):

1. **Adopt** the recorded process when its pid + start token are current, the record's owner fields match the current
   owner, and the config hash matches. A record with `port: 0` is a start still loading its model: wait (up to the ready
   timeout) for the port instead of starting a second sidecar; a start that dies meanwhile is replaced at once, one that
   never listens is stopped and replaced. `GET /health` is asked with the recorded token (1 s, then once more patiently,
   5 s): a sidecar recognising a long voice with every core busy answers late, and killing it would drop another topic's
   in-flight recognition — so a SILENT live matching process is used anyway, and replaced only when it stays silent three
   `ensure`s in a row (it is wedged). `/stt` shows such a process as «running, busy», not «not running».
2. A recorded process that is dead, or alive but of another owner / config (or wedged), gets a guarded SIGTERM, 3 s, then
   SIGKILL, and its record is dropped.
3. **Spawn.** A fresh token (`crypto.randomBytes`) goes to the process through the env; the process is hosted by
   `startExternallyParentedProcess` (outside nodemon's tree, so a reload never kills it); the bot polls the ready file
   every 100 ms for up to 15 s, checks the record the sidecar wrote for itself (pid and token) and logs
   `[STT] sidecar started pid N port P in Xms (workers W)`. A spawn that leaves before it is ready because its claim
   lost to an earlier start (exit `4`, another live record) is NOT a failed start: the earlier sidecar is adopted
   (`[STT] … found another start already running and left; using that one`). A failed start removes the record it
   claimed.

**Environment.** The sidecar and the install job run third-party code, so they get a short allowlist
(`sttChildEnv.ts`: `PATH`, `HOME`, `TMPDIR`, the locale, proxy / CA settings, `HF_*` / `UV_*` / `PIP_*`) — never the bot's
Telegram token or the operator's other secrets. The sidecar's own token and the offline model cache are added explicitly.

Concurrent voices share ONE attempt (a module-level promise). Nothing starts at boot.

**The owner** is the long-lived process the sidecar dies with: in hot mode the `charness hot` supervisor, which exports
`CHARNESS_STT_OWNER_PID` + `CHARNESS_STT_OWNER_START_TOKEN` to its worker; in plain mode the bot process. A worker
without the variables (an older supervisor) has no owner context, the engine is skipped and `/stt` says to restart the
supervisor.

**No watchdog, no restart backoff.** A crash, a refusal or a timeout makes the CURRENT voice fall back; the NEXT voice's
`ensure` finds the dead (or non-answering) process and starts a new one. The only guard is the spawn-storm one: 3 failed
STARTS within 10 minutes mark the engine unhealthy for 5 (skipped in the chain; `resetSpawnGuard` is the "Try again now"
button). A request failure after a successful `ensure` is not a spawn failure.

**Who stops it.**

| Event | Stopped by |
|-------|-----------|
| `charness hot` supervisor shuts down (SIGINT/SIGTERM/HUP, or a watcher dies) | the supervisor: guarded stop of the recorded process, bounded at ~3 s, awaited before it exits |
| plain bot shuts down gracefully | `gracefulShutdown`'s `stopSidecars`, after `state.flush()` |
| hot WORKER reload | nobody — the next worker adopts it |
| owner SIGKILLed | the sidecar's own owner watchdog (≤ ~2 s) |
| idle for `idleMinutes` | the sidecar itself (deletes its own record) |
| the local engine disabled/removed, or `idleMinutes` / `workers` / `threads` changed | `applySettingsChange` right after the save (it never spawns) |
| boot finds a record of a dead process, or of another owner | `cleanupAtBoot` (a live record of the CURRENT owner is left for adoption) |

**Auto-install.** `stt.json` naming an enabled `gigaam` engine that is not installed starts the install job at boot and
whenever the file changes (once per change, never per voice). The job runs detached (`sttInstallEntry`); the bot polls
its progress file every 3 s and edits ONE message — in General of the paired group, or the message a reload left in
`state.json` (`sttInstallProgress`) — or writes `[STT] install:` lines when no group is paired. A failure is reported
once with the log tail and not retried.

**An install outlives the bot, so its END is one shared path.** The progress reporter only edits and remembers the
message (`{threadKey, messageId, shouldEnableOnDone}`; the flag is set by the `/stt` button, not by `stt.json`). The job
ends through `finishInstall` (`commands/stt.ts`) whoever is attached: *job done → put the local engine into the list (flag
set) → save → final edit with the buttons → forget the message* (a reload between the steps repeats an idempotent step).
At boot (`resumeInstallAtBoot`) a remembered message is attached to while its job still runs, and **settled at once when
the job ended while the bot was down** — "done" only while the engine is really installed, else «ended without a
result» with Retry. A full engine list or an unwritable `stt.json` ends in a message that says so, never «ready».

## `/stt` — the settings screen

Every tap is one of: show another screen, save a new `stt.json` (then `applySettingsChange`), arm a typed step, or run an
effect (install, remove files, reset the spawn guard, close). The callbacks bake in `computeSttRevision(settings)` — the
content hash of the effective settings — so a hand edit makes old keyboards answer «changed — refreshed» instead of
acting on a list that moved. An edit made from `/stt` while the file is invalid rewrites it from the last good settings.

Typed steps (a custom server's address, an API key) belong to the Telegram module: a plausible key is deleted from the
topic the moment it is accepted and never echoed or logged; the output trace records `[redacted: speech engine key]` (or, for the address step — it may carry a login —
`[redacted: speech engine address]`) for the message while that step is awaited. Install: «Enable local recognition» confirms the cost, then the install job edits ONE
message with its progress (remembered in `state.json` with the enable flag); on success the engine joins the list first. Details and the
registration contract: `connectors/telegram/commands/README.md` § `stt.ts`.
