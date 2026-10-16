# `src/stt/` — voice recognition

How a voice note becomes text: where the settings live, which engines are tried in which order, how long each
gets. User-facing setup is in [`SETUP.md` § Voice input](../../SETUP.md#voice-input).

| File | Role |
|------|------|
| `sttSettings.ts` | `stt.json`: types, strict validation, cached load, atomic save, the one-time env-key migration, the resolver (settings → the chain a voice walks), the timeout math, the `[STT]` log lines |
| `transcribeChain.ts` | `transcribeWithEngines`: walk the chain for one voice file |
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
