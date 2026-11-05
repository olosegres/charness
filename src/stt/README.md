# `src/stt/` — voice recognition

How a voice note becomes text: where the settings live, which engines are tried in which order, how long each
gets. User-facing setup is in [`SETUP.md` § Voice input](../../SETUP.md#voice-input).

| File | Role |
|------|------|
| `sttSettings.ts` | `stt.json`: types, strict validation, the load and save over the shared [`configDirFile.ts`](../configDirFile.ts), the one-time env-key migration, the resolver (settings → the chain a voice walks), the timeout math, the `[STT]` log lines |
| `transcribeChain.ts` | `transcribeWithEngines`: walk the chain for one voice file (a non-last engine gets a start budget); `warmUpFirstEngine`: start the local engine when a voice would reach it first, and hand that ask to the voice |
| `sttInstall.ts` | The local engine's install: plan (uv / python3 venv), idempotent run with a lock and progress, `isGigaamInstalled` / `isGigaamInstalling`, remove |
| `sttInstallEntry.ts` | The detached install job the bot launches (not a user command): `node dist/stt/sttInstallEntry.js <dataDir> [--force]` |
| `sttSidecarOwner.ts` | The sidecar's lifecycle: `ensure` (adopt or spawn on demand, one shared attempt), the record, the spawn-storm guard, `stop`, the boot cleanup, the owner context |
| `sttAutoInstall.ts` | The install job manager: launch the detached job or attach to the running one, poll its progress file, report |
| `sttInstallReporter.ts`, `sttScreenPlan.ts` | The install progress as ONE edited message (or `[STT]` log lines), and the pure text of it |
| `sttConfigEdit.ts`, `sttScreenPlan.ts` | The `/stt` brain, without Telegram: the edits to `stt.json` (validated like a hand edit), the screens as data, the callback codec (`stt_<action>_<arg>_<revision>`, ≤ 64 bytes), the key/address input decision and `reduceSttAction` (tap → show / save / arm input / effect). The buttons and the typed-input hooks are `connectors/telegram/commands/stt.ts` |
| `sttRuntime.ts` | `stt.json` + the lifecycle facts resolved per call; the boot migration; the once-per-edit auto-install trigger |
| `../../stt/gigaam_sidecar.py` | The recognition process (Python), shipped in the package's `stt/` dir; `../../stt/test_gigaam_sidecar.py` are its unit tests (numpy, soundfile and av only, no model), run in `yarn test` by `sttSidecarPython.test.ts` through `uv` or a `python3` that has all three |
| `../utils/transcribeAudio.ts` | The ONE HTTP primitive: a multipart `POST` to an OpenAI-compatible `/audio/transcriptions`, with classified failures and the retry schedule |
| `../voiceProgressNote.ts` | The silent «transcribing…» note of a voice that waits for its text: pure timing over a post and a delete port (§ Warm-up, «What the topic shows meanwhile») |

## `stt.json` — the one source of truth

`~/.config/charness/stt.json`, in the directory of the instance's REAL env file (`getSttConfigPath` → `getConfigDirFilePath`, shared with `settings.json`): `ENV_FILE`
for an isolated instance, else the charness config dir's `.env` (a pre-rename config dir is kept). The env file's
symlink is resolved first — `.env` linked to a file on an encrypted volume puts `stt.json` beside the TARGET, so
the keys it holds stay with the other secrets; a dangling link keeps the directory it was named in. Settings AND
keys, mode 0600, written through a temp file and a rename. **No `STT_*` env variables exist.** The directory must be
writable and persistent (Docker: mount the config DIRECTORY, not only the env file): there is NO fallback to another
location — `init` probes it (`getConfigFileWriteBlock`) and logs `[STT] … cannot be written` once, and a `/stt` save that
fails says so naming the path. A writable directory can still be the container's OWN disk (only the env file was mounted):
in a container (`/.dockerenv`, `/run/.containerenv`) with the directory on the device of `/`, `init` logs `[STT] … is on this
container's own disk` once (`checkIsConfigFileOnContainerDisk`) — also in the fresh container that migrates the old env
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
- **Only what differs from the defaults is stored** (`createStoredConfig`): the `gigaam` block carries `idleMinutes` /
  `workers` / `threads` only when they are not the defaults (60 min, 4, absent), and is left out when empty. A default
  written to the file looks like a choice and would keep the setup on an old default for good; absent, it follows the
  current default. **The file gets no new key:** every released build reads it with a strict schema, so a key it does not
  know turns voice off on that build — after a rollback (the bot's own boot rollback included) or a downgrade. What this
  build writes passes the released schema (`sttSettings.test.ts` holds a copy of it).
- **Migration of the old idle default** (`migrateSttStoredDefaults`, boot, `sttRuntime.init`): an earlier build saved the
  whole `gigaam` block — `idleMinutes: 15`, then the default and not anyone's choice. A stored 15 is dropped (the engine
  follows the current default; said once in the log, any other stored value is kept) when **the marker file
  `stt.defaults-migrated` beside `stt.json` is absent** (this directory has not been migrated; every save writes the marker
  first, so a fresh install's 15 is a choice) **or the file stores a default** (`workers: 4` or `idleMinutes: 60`: this
  layout never does, so an earlier build wrote it — the sequence rollback → an older build's `/stt` save → update is
  migrated again). A 15 picked on this layout is stored without a default next to it and stays. The one case no content can
  tell apart is an earlier build's 15 beside a workers count changed on purpose: once the marker is there it stays — and
  the same rule drops a 15 written BY HAND next to an explicit `workers: 4` (or `idleMinutes: 60`), which `SETUP.md` tells
  the editor to avoid. Order: the migration writes the FILE first and the marker after (a rewrite that fails or is cut short
  leaves no marker that claims otherwise); a `/stt` save writes the marker first. A file that needs nothing is not touched
  (no marker yet → only the marker is written, and a directory that cannot take it is no failure: it is reported once at
  boot by the storage check); a missing, unreadable or invalid file is left alone, with no marker. The marker is a file
  older builds never read.
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
`transcribeAudio`. `getEndpoint()` of the local engine can take long (it WAITS for a process that is still loading its
model, § Lifecycle) and is outside the engine's request timeout, which starts after it. How long a voice waits for it
depends on the engine's place in the chain:

- the **last** engine is waited for as long as its start lives (up to the start ceiling, 120 s) — nothing is left to fall
  back to;
- a **non-last** engine gets a **start budget of 15 s** (`nonLastEngineStartBudgetMs`): a start still going after it makes
  the voice move to the next engine (`[transcribe] gigaam failed (gigaam was still starting after 15 s; it keeps starting
  for the next voice); falling back to …`). The start is NOT cancelled — it is the shared one, so the next voice (and its
  warm-up) finds the engine loaded, or still loading, instead of beginning from zero.

**Warm-up.** The moment a voice note ARRIVES (the voice handler, after the gate, before the download and the topic's voice
queue) `warmUpFirstEngine` asks the local engine for its endpoint when it is the FIRST engine of the chain, and returns that
ask (`WarmedEndpoint`, the engine's id + the promise). The voice's job hands it to `transcribeWithEngines`, which waits for
it. A warm-up that FAILED is the voice's outcome too, used INSTEAD of asking the engine again: a voice starts the engine
once, so it can never count as two failed starts for the spawn-storm guard. One that SUCCEEDED only says the engine is up:
the job then asks the engine ITSELF — a plain ask that runs the engine's full rules, the health check and the silence
limit that replaces a wedged process (the warm-up is lenient on purpose and must not stand in for it; with another engine
behind the local one nothing else would ever reach that limit). A retry of the last engine asks afresh; an ask of another
engine than the warmed one is ignored. The warm-up is for a COLD or LOADING engine only (`ensure(settings, { isWarmUp: true })`): a voice note that
arrives behind a long recognition in the same topic finds a sidecar that is busy and late with `/health`, and a warm-up
that judged that silence would count toward `unansweredAdoptionLimit` and could get the live sidecar replaced in the middle
of the earlier voice. So a warm-up takes a listening, matching process as it is — no `/health`, no count, no replacement —
and starts or waits for a start like any ask. A failed warm-up leaves one line, `[STT] warm-up start of gigaam failed: <reason>`, because the job may end
(a failed download) without ever asking. A hosted engine in front starts nothing: the local one may never be reached.

**What the topic shows meanwhile.** A warm engine answers within a couple of seconds and the topic shows nothing before the 🎤 echo.
When the text is not there `voiceProgressNoteDelayMs` (3 s) after the voice ARRIVED — the wait in the topic's voice queue behind an
earlier voice counts, so that voice gets its note too — the bot posts a SILENT, unpaced «🎙 Transcribing the voice message…» note
(`voice.transcribing`; the only «transcribing» state there is: no typing action). One note per voice, so several voices waiting in a
topic show several notes, each deleted by its own text. The warm-up adds none. `src/voiceProgressNote.ts` is the pure timing over three
ports (post, remember, delete), wired in `bot.ts`:

- **The note is gone BEFORE the answer.** When the chain returns — text or failure — the job AWAITS `VoiceProgressNote.finish()` before it
  posts the 🎤 echo or the failure notice (also on a failed download and on an unexpected error; the queue chain's `finally` is the
  backstop for a job that never ran). The delete is unpaced, so it never queues behind agent output. The wait is BOUNDED
  (`voiceProgressNoteCleanupBudgetMs`, 1.5 s): a stalled cosmetic send or delete (a 429 wait, a dead connection) cannot hold the
  transcript back; what the bound cut short ends in the background. A send that has not started yet (waiting out a 429) is cancelled
  (`AbortSignal`); one already on the wire cannot be called back, so a note that LANDS after the text is deleted at once and is never
  registered as live.
- **A shutdown stops the notes.** `cleanupTimers` calls `shutDown()` on the registry first thing: every armed note stops (timer cleared,
  unstarted send cancelled), one on screen is deleted, one being sent is waited for (bounded) and its message deleted when it lands; a
  voice that arrives during the drain of the last updates gets an inert note. The sweep waits for that before it collects ids, so
  nothing can fire or register an id after the sweep and the last state flush.
- **A restart.** The note's id sits in the thread's transient-message set beside the «working…» status frames
  (`voiceProgressNoteIds`, persisted in `state.json`), so a graceful stop (a hot reload) deletes a note whose voice job dies with the
  process and the next boot deletes one a kill left behind (`reconcileTransientFrames`). The voice itself is not re-run after a restart —
  that is unchanged.
- **A delete that hits a bad moment is not forgotten** — for the note AND for the status / thinking / sub-agent frames that share the set.
  The shutdown sweep and the boot reconciliation delete through one helper (`deleteTransientMessages`): a failure a later try can fix
  (no answer from Telegram, a 429, a 5xx — `checkIsRetryableTelegramError`) keeps its id in the persisted set, and the next boot parks
  it in the thread's `undeletedMessageIds` (persisted with the live ids, retried by the next sweep and the next boot); a final answer
  (already gone, too old to delete, the bot lost its right) settles the id, so nothing that can never work is retried for ever. Before,
  the sweep cleared the persisted set whatever happened and the reconciliation re-synced it to the live ids at once, so one failed
  delete left the message in the topic with no record of it. The sweep rewrites the set only after its deletes settled, so a sweep cut
  short by its time bound leaves the complete record.

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
more time. The local engine recognises voices strictly in arrival order, so a voice may wait in line: the sidecar
names the seconds of audio queued ahead of it in an interim `102` (`X-Charness-Queued-Audio-Seconds`), and from then
on the timeout is `getEngineTimeoutMs(timeout, durationSeconds, queuedAudioSeconds)` — the queue budgeted at the same
rate as the voice (9 s behind 300 s → 87.25 s). Any other engine sends no such header and keeps the plain budget.

## The local engine: one sidecar process

GigaAM v3 E2E-RNN-T (int8) runs in our own Python process on `onnx-asr`, started on demand, exposing an
OpenAI-compatible endpoint on `127.0.0.1` only. Nothing is shared with the operator's Python: a private venv and a
private Hugging Face cache live under `<DATA_DIR>/stt`.

### Install layout (`<DATA_DIR>/stt`)

| Path | What |
|------|------|
| `venv/` | the private environment (`uv venv --python ">=3.10"`, else `python3 -m venv`) with the pinned `onnx-asr[cpu,hub]==0.12.0 soundfile==0.14.0 av==17.1.0` (`av` is ffmpeg's libraries in a wheel, ~35 MB to download, ~100 MB on disk; 17.1.0 is the last release for Python 3.10) |
| `hf/` | `HF_HOME` — the model files (216 MiB for int8) and the Silero VAD (2.3 MB); the running sidecar is offline (`HF_HUB_OFFLINE=1`) |
| `uv-cache/` | uv's cache, kept here so it stays off the root fs and is removed with the install (wheels are hard-linked, not doubled) |
| `installed.json` | the marker `{ scriptVersion, pins, installedAt }`; "installed" means the marker matches this build AND `venv/bin/python` exists |
| `install.lock/` | a `mkdir` lock with an `owner` file (`pid` and start token). Held for as long as that process lives — a slow model download can take far longer than any timeout — so age never frees it; a lock with no owner file (its taker died between `mkdir` and the write) goes stale after a minute |
| `install.log` | child output of the install; a failure returns its last 20 lines |
| `install-progress.json` | JSON lines `{phase, detail, bytesDownloaded[, error, logTail]}` — `creatingEnvironment` → `installingPackages` → `downloadingModel` → `checking` → `done` / `failed`; truncated when a run takes the lock |

`runSttInstall` is idempotent (a current marker runs nothing; `force` rebuilds the venv but keeps the model cache),
runs the sidecar's `--check` as the verify step (loads the model and the VAD, recognises a second of 48 kHz silence through
the pause splitter — so the resampler and the VAD run too — checks libsndfile
can read OGG/Opus and `av` has the AAC, MP3, Vorbis and Opus decoders, prints the versions as JSON — so a broken download is caught at install time), and polls the size
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
- `GET /health` (Bearer token, else 401) → `{status, busyRequests, queuedChunks, cuttingRequests, workers, idleMinutes, version, pid}` (`cuttingRequests`:
  voices in line that are still being decoded and cut). A
  health call is not activity: opening a status screen never keeps the process alive.
- `POST /v1/audio/transcriptions`, multipart (`email.parser`, not `cgi`; Node's chunked, Content-Length-less uploads are
  decoded). Fields: `file` (required), `model` / `language` (accepted, ignored), `response_format` `json` (default) or
  `text`. Replies `{"text": …}` in UTF-8, or errors `{"error": {"message": …}}`: 400 (bad body, undecodable audio,
  unsupported sample rate), 401, 404, 413 (body over 25 MB), 500, 503 (the idle exit is decided), 504 (over
  `--max-seconds`; that request's queued chunks are dropped). Every response closes the connection. Once the voice is
  cut and in line, BEFORE the final response, an interim `102` carries `X-Charness-Queued-Audio-Seconds: <s>` (one
  decimal): the audio still to recognise ahead of it — the unfinished pieces of every earlier request, the running ones
  included, or, for one still being decoded and cut, its length read from the file's header the moment it arrived
  (`read_audio_seconds`, a few milliseconds — a 5-minute decode takes seconds, and a voice sent meanwhile was once told
  "0 s ahead" and timed out). A voice takes its place before its own length is read, so a newcomer first waits (at most
  `SIZING_WAIT_SECONDS`, 2 s) until every voice ahead of it has its length noted. Every 0.5 s while the voice waits, the
  handler sends another `102` when the queue ahead has grown by more than 1 s — a safeguard for a voice ahead whose
  length was still unknown when this one was reported (the wait timed out; a file whose length cannot be read is refused
  before it is cut) — and checks that its
  client is still connected; a client that hung up (it timed out, the bot moved on) — or a report that cannot be
  written — gets its request dropped: no piece not yet handed out is recognised, nothing is answered, and the log says
  `the client left`. An `OSError` of the recognition itself is the sidecar's own failure and answers 500.
- **Decoding — two decoders, by what the file is** (`inspect_audio` decides ONCE per upload — one `soundfile.info`, one walk of the Ogg pages —
  and hands the result to the length read and to `decode_audio`; the filename and the content type are ignored).
  `soundfile` (libsndfile) reads what it reads WHOLE: Telegram's OGG/Opus (the whole voice-note path, no ffmpeg
  involved), one OGG stream, WAV, FLAC. Everything else goes to ffmpeg through the `av` package, in-process on the
  uploaded bytes (no temporary file, no subprocess; an M4A with its index at the end needs a seekable input):
  - **M4A / AAC** (an MP4 with sound) — libsndfile cannot open it.
  - **MP3** always, even with a length header: libsndfile reads as many frames as the header says, and for an MP3 with
    no Xing / Info / VBRI frame that is an estimate — the file size over the FIRST frame's bitrate (a 40 s file whose
    first frame is 192 kbps and the rest 32 kbps is 160 KB: 160 KB × 8 / 192 kbps = 6.7 s) — so a variable-bitrate
    file with a loud start was read for 6.7 s of 40.
  - **Chained OGG** (two OGG files one after the other): libsndfile reads only the first stream, and a chained Vorbis
    reports a length of 5.7e14 s. `find_ogg_stream_starts` walks the Ogg page headers (never the packet bytes) for the
    first pages of the streams; `split_ogg_streams` cuts the file there and each stream is decoded on its own, so
    streams that differ in codec or in rate still make one voice (ffmpeg itself cannot demux a chain that changes codec).
  - A file neither can read, one with no audio stream, and one that decodes to nothing are a 400, as before.
  - The upload's bytes pick ffmpeg's demuxer, and a text file in SDP form makes it open an RTP socket and wait 20 s for
    packets (twice: the length read, then the decode), so every container is opened with ONLY the `crypto,data` protocols
    (`FFMPEG_PROTOCOL_WHITELIST`): a file is handed over as bytes and needs none, and such an upload is refused at once.
  The ffmpeg decoder returns mono float32 at 16 kHz (ffmpeg resamples; the channels are averaged as for libsndfile — ffmpeg's
  own downmix is 3 dB louder), so the `unsupported sample rate` refusal applies to the libsndfile path only. The `av` import happens on the
  first such file: a voice note never loads it. The upload's length for the queue comes from the same inspection: the
  libsndfile header for what it reads whole, otherwise the sum of the packets' durations (a demux without decoding,
  ~10 ms for 40 s, before the decode's own pass; the container's own duration is an estimate for exactly the files that
  need ffmpeg). The frames ffmpeg hands over may change their rate or layout inside a file: each run of equal frames has
  its own resampler (a resampler refuses a frame of another setup, and passes frames through untouched when its first one
  needed no conversion).
- **Chunking — every voice is cut at its pauses.** Audio is downmixed to mono and resampled ONCE to 16 kHz with the model's own resampler (a file the ffmpeg decoder returned is already at 16 kHz). Silero VAD
  (`onnx_asr.load_vad("silero")`, one thread, in the request's handler thread) finds the speech; every gap of at least
  **500 ms** between two speech segments it detects is cut at its centre (`split_at_pauses`; onnx-asr adds both
  speech pads to the silence it is given, so it is asked for `500 − 2 × 100` ms). On the phrases it was tested with, a
  real silence of 0.3 s already shows as a ≥ 0.5 s gap and is cut. The VAD only chooses where to cut:
  the pieces cover the whole file, nothing it calls silence is dropped — it misses some real speech entirely. A piece
  over 25 s (the model's limit) is cut again at the centre of the quietest 50 ms window in the last 8 s before each
  25 s boundary (`split_at_silences`). A VAD that cannot be loaded or raises falls back to those 25 s cuts alone at the
  file's own rate, with one log line. A piece under 0.1 s is empty text: the encoder cannot take it. Why: GigaAM v3
  `e2e_rnnt` drops a whole phrase that follows a long pause (≈0.6–2 s) when it decodes several phrases in one pass —
  on 400 real-speech clips (919 phrases) one-pass decoding lost 39 phrases, the pause cuts 11 (decoding each phrase
  alone: 10), with no loss on continuous sentences. Short pieces are not merged back: GigaAM's own long-form recipe
  (merge VAD segments up to 15–22 s) would put a short voice back into one piece.
- **Pool — strict arrival order (FIFO).** A request takes its place when its upload has been read (`open_request`),
  BEFORE it is decoded and cut, so a voice that is quicker to cut never overtakes an earlier one. W threads hand out the
  pieces of the first unfinished request, in order, before any piece of the next request, and wait while that request
  is still being cut; one whose decoding fails gives its place up (`cancel`), and one whose client hung up is dropped.
  A request stays listed until it is finished, so the queue a newcomer is told about counts the running pieces too.
  Within one topic the bot already sends one voice at a time (`voiceQueue.ts`): this order matters BETWEEN topics,
  where a voice now waits for the ones sent before it (and its timeout counts that wait). Each piece goes to `model.recognize` on
  the ONE shared onnxruntime session (one model in memory). A failing piece fails its request only. Texts are joined in
  order with single spaces.
- **Idle exit:** the bot always passes `--idle-minutes` from `gigaam.idleMinutes` (default **60**; the script's own default of
  15 only matters when it is run by hand). A timer checks every 5 s. With no transcription in flight for `--idle-minutes` (0 = never) it stops
  accepting, re-checks that nothing slipped in (if one did, it keeps serving), then deletes `R` **only if R names its own
  pid** (never another generation's), and exits 0. A request that arrives after the exit is decided gets 503 and the bot
  falls back; the next voice starts a fresh process.
- **Owner watchdog:** every 2 s `kill(owner, 0)`, and on Linux the owner's `/proc/<pid>/stat` field 22 must equal
  `--owner-start-token` (a reused pid is a different owner). When the owner is gone it deletes its own record and
  `_exit(0)` — a SIGKILLed bot or supervisor leaves no sidecar behind.
- **SIGTERM** closes the server and exits 0; removing `R` is the bot's job on a stop.

### Measured on a dev box (4 cores / 8 threads, no GPU, under load)

Cold start (spawn → ready file) ≈ 2–2.4 s on an idle box — and well past 15 s at a load average of 22–50, where the model
load starves for CPU (a fixed 15 s wait once abandoned it twice in a row, so each retry began the load from zero); an 18 s voice ≈ 1.5 s; a 300 s voice ≈ 18.6 s with 4 workers × 2 threads.
With the pause cuts, at a load average of 3–5: a 300 s voice takes 14.1–15.8 s against 12.4–12.7 s for the 25 s cuts
alone (three runs each, alternating) — the cutting runs before the first piece reaches a worker, and the voice has 37
pieces instead of 14.
Peak RSS with the pause cuts: one 300 s voice ≈ 690 MB, two at once ≈ 886 MB (the 25 s cuts alone: ≈ 790–810 MB for
one). Profiled per step: resampling a 300 s voice to 16 kHz in one pass raised the peak by ≈ 240 MB, which
onnxruntime keeps, so it is resampled in 30 s windows (≈ 66 MB). Silero VAD itself costs ≈ 1–2 % of the voice's length.

## Lifecycle: who starts, adopts and stops the sidecar

**On demand.** A voice whose chain reaches the local engine calls `ensure` (through the engine's `getEndpoint()`):

1. **Adopt** the recorded process when its pid + start token are current, the record's owner fields match the current
   owner, and the config hash matches. A record with `port: 0` is a start still loading its model: wait for the port
   instead of starting a second sidecar — for as long as the process LIVES, up to the **start ceiling** (120 s, counted from
   the process's own `startedAt`, so a worker that arrives late does not give a wedged load a second ceiling); a start that
   dies meanwhile is replaced at once, one still not listening at its ceiling is stopped and the request FAILS with the
   ceiling text — no respawn for the same voice after a ceiling stop (it would begin the load from zero again). The 2 minutes
   are counted from THE PROCESS'S OWN start: a loading process is waited for at most that long, but an engine replaced after
   it DIED gets its own ceiling (so a request can wait up to about two of them). The stop counts as a failed start for the
   spawn-storm guard, and the NEXT voice starts a fresh process. `GET /health` is asked with the recorded token (1 s, then once more patiently,
   5 s): a sidecar recognising a long voice with every core busy answers late, and killing it would drop another topic's
   in-flight recognition — so a SILENT live matching process is used anyway, and replaced only when it stays silent three
   `ensure`s in a row (it is wedged). `/stt` shows such a process as «running, busy», not «not running».
2. A recorded process that is dead, or alive but of another owner / config (or wedged), gets a guarded SIGTERM, 3 s, then
   SIGKILL, and its record is dropped.
3. **Spawn.** A fresh token (`crypto.randomBytes`) goes to the process through the env; the process is hosted by
   `startExternallyParentedProcess` (outside nodemon's tree, so a reload never kills it); the bot polls the ready file
   every 100 ms — as long as the process lives, up to the **start ceiling** (120 s) — checks the record the sidecar wrote for
   itself (pid and token) and logs `[STT] sidecar started pid N port P in Xms (workers W)`. A load that passes 15 s logs
   `[STT] sidecar pid N is still loading its model after 15 s; waiting for it (up to 120 s)` once. **A start that lives is
   never abandoned early** (it was, at a fixed 15 s: each voice then killed the loading process and began the load from
   zero): a process that DIES ends the wait at once (`the local engine exited before it was ready`), one still loading at the
   ceiling is stopped and fails the voice with `the local engine was still loading its model after 120 s (see sidecar.log)`
   — what the user reads after "Failed to transcribe voice message". There is no CPU-progress probe: a live process is
   waited for, and the ceiling bounds a wedged one. The sidecar runs at the bot's own priority (nice 0), not niced down —
   a voice is interactive and a niced load starves exactly when the box is busy; this is unchanged. A spawn that leaves before it is ready because its claim
   lost to an earlier start (exit `4`, another live record) is NOT a failed start: the earlier sidecar is adopted
   (`[STT] … found another start already running and left; using that one`). A failed start removes the record it
   claimed.

**Environment.** The sidecar and the install job run third-party code, so they get a short allowlist
(`sttChildEnv.ts`: `PATH`, `HOME`, `TMPDIR`, the locale, proxy / CA settings, `HF_*` / `UV_*` / `PIP_*`) — never the bot's
Telegram token or the operator's other secrets. The sidecar's own token and the offline model cache are added explicitly.

Concurrent voices share ONE attempt (a module-level promise): a voice that arrives while the process is loading — and the
warm-up of the voice before it — waits for the SAME start, however late it comes within the ceiling. Nothing starts at boot:
a sidecar is held in memory only after someone used voice (60 minutes by default after the last voice, `gigaam.idleMinutes`)
or when a voice note arrives.

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
effect (install, remove files, reset the spawn guard, close). The screens: a MAIN screen with only what is about recognition as a whole
(the engine list — the local row carries its short state — Add engine, Language, Close), one CARD per engine (the common controls plus
the kind's own: a key, or for the local engine its status, RAM line, idle exit, workers, try again, install / progress, remove from
list, remove model files) and the pickers. Idle and workers exist only on the local card. The callbacks bake in `computeSttRevision(settings)` — the
content hash of the effective settings — so a hand edit makes old keyboards answer «changed — refreshed» instead of
acting on a list that moved. An edit made from `/stt` while the file is invalid rewrites it from the last good settings.

Typed steps (a custom server's address, an API key) belong to the Telegram module: a plausible key is deleted from the
topic the moment it is accepted and never echoed or logged; the output trace records `[redacted: speech engine key]` (or, for the address step — it may carry a login —
`[redacted: speech engine address]`) for the message while that step is awaited. Install: «Add engine → GigaAM (local)» confirms the cost when the model is not installed, then the install job edits ONE
message with its progress (remembered in `state.json` with the enable flag); on success the engine joins the list first and the message becomes its card. Details and the
registration contract: `connectors/telegram/commands/README.md` § `stt.ts`.
