# atlas-server

Realtime voice backend for **ATLAS** — a HoloLens 2 AR system for spatially annotating labs and industrial equipment. The server brokers a hands-free voice assistant between the HoloLens app and the OpenAI Realtime API, stores projects and their annotated objects, and resolves *deictic references* ("What is **this**?") by aligning the live speech transcript against the user's pointing stream.

Built with [NestJS](https://nestjs.com/) (WebSockets via `ws`, RxJS for internal event wiring).

## Contents

- [The ATLAS system](#the-atlas-system)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Interfaces](#interfaces)
  - [WebSocket `/hololens`](#websocket-hololens)
  - [WebSocket `/monitor`](#websocket-monitor)
  - [Audio format](#audio-format)
  - [Message reference](#message-reference)
  - [REST API](#rest-api)
- [Projects & data model](#projects--data-model)
- [Session lifecycle](#session-lifecycle)
- [Assistant tools](#assistant-tools)
- [The deixis pipeline](#the-deixis-pipeline)
- [Audio & transcript pipeline](#audio--transcript-pipeline)
- [System prompt](#system-prompt)
- [Logging](#logging)
- [Project structure](#project-structure)
- [Development notes](#development-notes)

---

## The ATLAS system

This server is one of three repositories that make up ATLAS:

| Repository | Tech | Role |
|---|---|---|
| [`atlas-server`](https://github.com/mxweigand/atlas-server) (this repo) | NestJS / TypeScript | Voice broker, project/object storage, deixis resolution |
| [`atlas`](https://github.com/mxweigand/atlas) | Unity, MRTK3, UWP/ARM64 | HoloLens 2 app: models cuboid geometry in physical space, anchors it to QR codes, streams mic audio + pointing focus to the server, plays assistant speech |
| [`atlas-debug-client`](https://github.com/mxweigand/atlas-debug-client) | Angular | Browser debug UI: watches all server debug streams on `/monitor`, can emulate the HoloLens on `/hololens` (browser mic), manages projects via REST |

The end-to-end use case: a user wearing a HoloLens 2 walks through a lab or plant, points at annotated machines and asks questions in natural speech ("What is this?"). The HoloLens continuously reports which object the user is pointing at; the server figures out which object *"this"* referred to at the moment the word was spoken, fetches the stored annotation and answers with synthesized speech — hands-free, with no wake word.

## Architecture

```
   atlas (HoloLens 2, Unity)                     atlas-debug-client (Angular)
     │ ▲                                            │              │
     │ │ PCM16 TTS audio +                          │              │
     │ │ lifecycle / project events           debug streams     REST :3000
     │ │                                      (read-only)       projects / objects
     │ └───────────────┐                            │              │
     │ PCM16 mic audio │                            │              │
     │ focus_update    │                            │              │
     ▼                 │                            ▼              ▼
┌─────────────────── WS :8080 ──────────────────────────┐  ┌──── HTTP :3000 ────┐
│  TransportGateway                                     │  │ ProjectsController │
│   · /hololens — 1 exclusive slot (HoloLens OR debug)  │  └─────────┬──────────┘
│   · /monitor  — any number of read-only clients       │            │
└───────────────┬───────────────────────────────────────┘            │
                │                                                    ▼
        ┌───────┴────────┐        wires everything          ┌─────────────────┐
        │  BrokerService │ ◀──────────────────────────────▶ │ ProjectsService │
        └───────┬────────┘                                  │ (JSON files +   │
                │                                           │  active project)│
     ┌──────────┼─────────────────┐                         └─────────────────┘
     ▼          ▼                 ▼                                  ▲
┌──────────┐ ┌────────────────┐ ┌───────────────────────┐            │
│  Deixis  │ │ ToolsService   │ │     RealtimeService   │            │
│  Service │ │ resolve_deixis │ │ WS client to OpenAI,  │            │
│ (focus + │ │ get_object     │ │ VAD, TTS, live input  │            │
│  delta   │ │ update_object  │ │ transcription         │            │
│  buffers)│ │ wait_for_user  │ └───────────┬───────────┘            │
└──────────┘ └───────┬────────┘             │                        │
     ▲               └──────────────────────┼────────────────────────┘
     └──────── transcript deltas ───────────┤
                                            ▼
                          OpenAI Realtime API (gpt-realtime-2)
                          + input transcription (gpt-realtime-whisper)
```

**`BrokerService`** ([src/broker/broker.service.ts](src/broker/broker.service.ts)) is the central orchestrator. It contains no protocol parsing and no OpenAI specifics — it subscribes to the RxJS subjects of the other services and routes between them:

- HoloLens mic audio → OpenAI (plus rolling lookback buffer + per-turn clip recording)
- OpenAI TTS audio → `/hololens` client (plus per-response clip for monitors)
- OpenAI tool calls → `ToolsService.execute()` → result back to OpenAI
- Transcript deltas → `DeixisService` ring buffer + `/monitor` clients
- `focus_update` frames → `DeixisService` ring buffer + `/monitor` clients
- Project activation/deactivation → OpenAI session restart/teardown
- Object create/update/delete → broadcast to `/hololens` + `/monitor`

The other services know nothing about each other; all cross-wiring lives in the broker.

## Quick start

Prerequisites: Node.js (v20+ recommended), an OpenAI API key with Realtime API access.

```bash
npm install

# configure
cp .env.example .env        # then set OPENAI_API_KEY=sk-...

# run
npm run start:dev           # watch mode
npm run start:prod          # after npm run build
```

The server then listens on:

- **HTTP `:3000`** — REST API for projects/objects (CORS enabled for the debug client)
- **WS `:8080`** — realtime voice + debug streams (`/hololens`, `/monitor`)

Note: the server stays **idle** (no OpenAI connection, no billing) until a project is activated — see [Session lifecycle](#session-lifecycle). To talk to the assistant:

1. Put a project file into `data/projects/` (see [Projects & data model](#projects--data-model)) — sample files ship in this repo.
2. Connect a client to `/hololens` (HoloLens app or debug client).
3. `POST /projects/<id>/activate` — this opens the OpenAI session.
4. Speak. Voice activity detection is server-side (OpenAI VAD); there is no push-to-talk.

On a fresh Windows machine, allow inbound port 8080 in the firewall, or the HoloLens cannot connect.

## Configuration

All settings are environment variables (via `@nestjs/config`, see [src/config/configuration.ts](src/config/configuration.ts) and [.env.example](.env.example)). Only `OPENAI_API_KEY` is required.

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port (REST) |
| `WS_PORT` | `8080` | WebSocket port (`/hololens`, `/monitor`) |
| `PROJECTS_DATA_DIR` | `data/projects` | Directory with one JSON file per project |

### OpenAI

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required.** |
| `OPENAI_MODEL` | `gpt-realtime-2` | GA realtime model |
| `OPENAI_VOICE` | `marin` | TTS voice |
| `OPENAI_REASONING_EFFORT` | `low` | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |

### Voice activity detection (VAD)

| Variable | Default | Description |
|---|---|---|
| `VAD_TYPE` | `semantic_vad` | `semantic_vad` (utterance semantically complete?) or `server_vad` (silence-based) |
| `VAD_EAGERNESS` | `high` | semantic_vad only: `low` \| `medium` \| `high` \| `auto` |
| `VAD_SILENCE_MS` | `300` | server_vad only |
| `VAD_THRESHOLD` | `0.5` | server_vad only |
| `VAD_PREFIX_MS` | `300` | server_vad only |

`interrupt_response` is deliberately **off**: the HoloLens mic has no acoustic echo cancellation, so the assistant's own speaker output would bleed back in and self-interrupt. OpenAI-side noise reduction is set to `far_field`.

### OpenAI reconnect backoff

| Variable | Default |
|---|---|
| `RECONNECT_MAX_RETRIES` | `3` |
| `RECONNECT_INITIAL_DELAY_MS` | `1000` |
| `RECONNECT_BACKOFF_MULTIPLIER` | `2` |

### Input transcription & logging

| Variable | Default | Description |
|---|---|---|
| `INPUT_TRANSCRIPTION_LOGGING` | `true` | Log raw transcription events as JSONL |
| `INPUT_TRANSCRIPTION_LOG_DIR` | `logs` | Log directory |
| `INPUT_TRANSCRIPTION_LANGUAGE` | `de` | Language hint for `gpt-realtime-whisper` |

### Deixis & audio pipeline

| Variable | Default | Description |
|---|---|---|
| `DEIXIS_PIPELINE_LATENCY_MS` | `1000` | Empirically calibrated delay between a word being *spoken* and its transcript delta *arriving* at the server; subtracted from delta timestamps to estimate speak time |
| `DEIXIS_FOCUS_BUFFER_MS` | `30000` | Rolling window for pointing/focus samples |
| `DEIXIS_DELTA_BUFFER_MS` | `30000` | Rolling window for transcript deltas |
| `DEIXIS_AMBIGUITY_WINDOW_MS` | `200` | ± window around the estimated speak time; a focus change inside it makes the resolution ambiguous (sized to the ~100 ms spread of the calibrated latency) |
| `DEIXIS_STALE_THRESHOLD_MS` | `500` | Max age of the newest focus sample at/before speak time before it counts as a reporting gap (sized above the 250 ms client heartbeat, so one missed heartbeat is tolerated) |
| `AUDIO_LOOKBACK_MS` | `1500` | Rolling mic buffer prepended to each user-speech clip so the VAD-cut prefix (the "Wh" in "What is that one?") survives |

## Interfaces

### WebSocket `/hololens`

`ws://<host>:8080/hololens` — the **input channel**. Exactly **one** client at a time: the real HoloLens *or* the debug client emulating it. A second connection attempt is rejected (close code `1008`). Unknown paths are rejected the same way.

- **Binary frames in:** PCM16 mic audio (see [Audio format](#audio-format)) — forwarded to OpenAI
- **Text frames in:** JSON `hello` and `focus_update` messages
- **Binary frames out:** PCM16 assistant TTS audio
- **Text frames out:** lifecycle + project events (see [Message reference](#message-reference))

A client should send `hello` with its role (`hololens` or `debug`) right after connecting; until then the server assumes `debug`. The role is informational (surfaced to monitors via `mode_changed`) — behavior is identical.

When the `/hololens` socket drops (app closed, crash, network loss), the server **deactivates the active project and tears down the OpenAI session** so nothing keeps running (and billing) unattended.

### WebSocket `/monitor`

`ws://<host>:8080/monitor` — the **read-only debug view**, used by the debug client. Any number of clients. Sends nothing; receives everything sent to `/hololens` **plus** monitor-only debug streams: full user/assistant audio clips, live transcription deltas, final transcripts, rebroadcast focus updates, and topology (`mode_changed`).

On connect, a monitor immediately receives a `mode_changed` snapshot and a `project_activated` snapshot, so a late joiner sees the current state without waiting for the next change. (This snapshot is the *only* channel for active-project state — there is no REST endpoint that reports it.)

### Audio format

Defined in [src/protocol/audio.ts](src/protocol/audio.ts) — both directions, both clients:

| Property | Value |
|---|---|
| Encoding | PCM16 (signed 16-bit LE) |
| Sample rate | 24 000 Hz |
| Channels | 1 (mono) |
| Chunk size | 20 ms = 960 bytes |

Mismatches produce distorted audio; clients must resample (the HoloLens mic records at 48 kHz and downsamples to 24 kHz).

### Message reference

The wire protocol is defined in [src/protocol/messages.ts](src/protocol/messages.ts). **This file is the master copy** — clients follow it exactly (the debug client keeps a verbatim TypeScript copy under `src/app/protocol/`).

**Client → server** (text frames on `/hololens`):

| Type | Payload | Meaning |
|---|---|---|
| `hello` | `role: 'hololens' \| 'debug'` | Declare identity once after connect |
| `focus_update` | `wallclockMs, focusId \| null` | Continuous pointing stream: emitted on every focus change **plus** a ~250 ms heartbeat. `focusId` is the object id being pointed at, `null` when pointing at nothing. The client timestamp is kept for debugging only — the server re-stamps every sample with its own receive time (see [deixis pipeline](#the-deixis-pipeline)) |

**Server → client:**

| Type | `/hololens` | `/monitor` | Meaning |
|---|:---:|:---:|---|
| `speech_started` / `speech_ended` | ✓ | ✓ | OpenAI VAD detected start/end of user speech |
| `response_started` / `response_done` | ✓ | ✓ | Assistant response lifecycle (clients reset their playback queue on `response_started`) |
| `tool_call` | ✓ | ✓ | Announced before execution: `callId, name, args` |
| `tool_result` | ✓ | ✓ | After execution: `callId, name, result` |
| `error` | ✓ | ✓ | e.g. a tool failure |
| `project_activated` | ✓ | ✓ | `projectId` or `null` (deactivated). Also sent as join snapshot to monitors |
| `object_created` / `object_updated` / `object_deleted` | ✓ | ✓ | Object changed via tool or REST; keeps all clients in sync |
| `mode_changed` | | ✓ | Topology: who holds the `/hololens` slot (`hololens`/`debug`/`null`) + monitor count |
| `user_transcript` | | ✓ | Final transcript of a user turn (`itemId, transcript`) |
| `user_transcript_delta` | | ✓ | Streaming transcription fragment: `itemId, delta, wallclockMs, audioOffsetMs, spokenOffsetMs` |
| `assistant_transcript` | | ✓ | Final transcript of the assistant response |
| `user_speech` | | ✓ | Complete PCM16 clip (base64) of a user turn incl. lookback prefix: `itemId, audio, audioStartWallclockMs, playbackTrimMs` |
| `assistant_speech` | | ✓ | Complete PCM16 clip (base64) of an assistant response |
| `focus_update` | | ✓ | Rebroadcast of the pointing stream, re-stamped with server time |

### REST API

`http://<host>:3000` — implemented in [src/projects/projects.controller.ts](src/projects/projects.controller.ts). No auth (development). Used by the debug client (project management UI) and the HoloLens app (loading projects, authoring geometry).

| Method & path | Body | Returns | Description |
|---|---|---|---|
| `GET /projects` | — | `AtlasProject[]` | List all projects (id, name, summary) |
| `GET /projects/:id` | — | `{ project, objects }` | Full project file contents |
| `POST /projects/:id/activate` | `{ mode?: 'view' \| 'edit' }` | `{ project, objects }` | Activate a project and start the voice session. Missing/invalid mode defaults to `view`, so an old client can never accidentally get the mutating tool |
| `POST /projects/deactivate` | — | `{ active: null }` | Deactivate; tears the OpenAI session down |
| `POST /projects/:id/objects` | `{ geometry? }` | `AtlasObject` | Create an object (empty name/summary/content); used by the HoloLens when the user models a new cuboid |
| `PATCH /projects/:id/objects/:objectId` | `{ name?, summary?, content?, geometry? }` | `AtlasObject` | Patch fields; omitted fields stay untouched |
| `DELETE /projects/:id/objects/:objectId` | — | — | Delete an object |

All object mutations are also broadcast as WS events (`object_created` / `object_updated` / `object_deleted`).

## Projects & data model

A **project** is a named collection of annotated **objects** (machines, furniture, equipment). Storage is deliberately simple: **one JSON file per project** under `PROJECTS_DATA_DIR` (default `data/projects/`), read on demand, written atomically (temp file + rename), and hand-editable between activations.

```jsonc
// data/projects/my-lab.json  →  project id "my-lab" (derived from the filename)
{
  "project": {
    "name": "My Lab",
    "summary": "Optional one-liner injected into the system prompt."
  },
  "objects": [
    {
      "id": "1",                 // doubles as the focusId in the pointing stream
      "name": "Distillation column",
      "summary": "Short — goes verbatim into the system prompt.",
      "content": "Full description, fetched on demand via the get_object tool.",
      "geometry": {              // authored by the HoloLens, stored verbatim; null until authored
        "size":        { "x": 0.74, "y": 0.72, "z": 0.69 },   // meters
        "eulerAngles": { "x": 0.4, "y": 119.1, "z": 179.8 },  // degrees, world rotation at authoring time
        "anchors": [             // QR codes used to re-place the object in the world
          {
            "markerId": "QR1",   // decoded QR string
            "size": 0.068,       // printed edge length in meters
            "localPosition":    { "x": -0.27, "y": -0.37, "z": -0.50 },
            "localEulerAngles": { "x": 358.4, "y": 1.7,   "z": 179.6 }
          }
        ]
      }
    }
  ]
}
```

Key invariants (see [src/protocol/messages.ts](src/protocol/messages.ts) and [src/projects/projects.service.ts](src/projects/projects.service.ts)):

- **The filename is the project id.** The `id` is never stored inside the file, so the two cannot diverge. Ids must match `[a-z0-9_-]+` (case-insensitive).
- **Object `id` = `focusId`.** The id the HoloLens reports in `focus_update` is the same id the deixis resolver returns and the tools accept. New objects get the smallest free positive integer as a string.
- **Geometry is owned by the HoloLens.** It is authored via REST (Unity's `JsonUtility` vector format `{x,y,z}`) and stored verbatim; the server and the voice assistant never mutate it. The `update_object` tool can only touch `name`, `summary`, `content`.
- `summary` should stay short (~15 words) — it is injected into the system prompt for *every* object at session start. `content` is the long form, fetched on demand.

## Session lifecycle

The OpenAI Realtime session is coupled to project activation, not to server start:

```
idle (no OpenAI socket, no cost)
  │  POST /projects/:id/activate { mode }
  ▼
active session
  · system prompt rebuilt with the project overview (name, summary, one line per object)
  · tool set filtered by mode: 'view' hides update_object, 'edit' exposes it
  · project_activated broadcast to /hololens + /monitor
  │
  ├─ POST /projects/:id/activate (another id)  → session restarted with new prompt
  ├─ POST /projects/deactivate                 → session torn down, back to idle
  └─ /hololens socket drops (crash, app close) → auto-deactivate + teardown
```

The restart-on-activate exists because the GA Realtime API does not reliably allow replacing the system prompt mid-session. Within a session, the OpenAI connection auto-reconnects with exponential backoff on unexpected closes.

## Assistant tools

Registered in [src/tools/](src/tools/), executed server-side when the model calls them; every call and result is mirrored to `/hololens` and `/monitor` as `tool_call` / `tool_result` events.

| Tool | Available | Purpose |
|---|---|---|
| `resolve_deixis` | always | Map deictic phrases ("this", "that one", "over there") from the current turn to concrete object ids — see [below](#the-deixis-pipeline). Takes `references: [{ phrase, context }]`, all pointing references of the turn in one call |
| `get_object` | always | Fetch `name`/`summary`/`content` of one object in the active project (by `focusId`, usually from a `resolve_deixis` result) |
| `update_object` | **edit mode only** | Patch `name`/`summary`/`content` of an object ("Note that this is a wooden chair"); omitted fields stay untouched. Persists to the project file and broadcasts `object_updated` |
| `wait_for_user` | always | No-op escape hatch per OpenAI's prompting guide: gives the model a valid *non-speaking* action for silence, background noise, or speech not addressed to it, so it doesn't fill the gap with "I'm here!" filler |

New tools implement the small `Tool` interface ([src/tools/tool.interface.ts](src/tools/tool.interface.ts): `name`, `description`, JSON-schema `parameters`, `execute()`), get registered in `BrokerService.onModuleInit()`, and are announced to OpenAI automatically.

## The deixis pipeline

The core research feature. Problem: when the user says *"What is **that**?"* while sweeping their hand across several objects, the word *"that"* refers to whatever they pointed at **at the moment the word was spoken** — but the transcript of that word only arrives at the server ~1 s later. Naively pairing "current pointing target" with "current transcript" resolves against the wrong object.

Solution ([src/deixis/deixis.service.ts](src/deixis/deixis.service.ts)): keep two time-stamped rolling buffers and align them *backwards in time*.

```
pointing stream   ●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──▶
(focus_update,          obj "2" ▲          ▲ obj "3"
 ~250 ms heartbeat)             │          │
                                │      user says "that"       transcript delta "that"
mic audio         ────────█ "What is that one?" █─────────────────┐
                                │                                 │
                                │◀────── pipelineLatency ~1 s ───▶│ (measured)
                                                                  │
resolve_deixis:    spokenAt = delta.wallclockMs − DEIXIS_PIPELINE_LATENCY_MS
                   focusAt(spokenAt)  →  focusId "3"
```

1. **Focus buffer.** Every `focus_update` is recorded — stamped with the **server's** receive time, *not* the client's clock. (A real HoloLens has its own skewed clock; comparing client timestamps against the server-side transcript timeline is exactly what broke deixis on-device. The debug client happened to work because it runs on the same machine.)
2. **Delta buffer.** Every live transcription fragment from `gpt-realtime-whisper` is recorded with its arrival time.
3. **Resolution.** When the model calls `resolve_deixis` with `{ phrase, context }`, the resolver substring-matches the `context` (falling back to the `phrase`) in the per-turn concatenated deltas, newest turn first; locates the delta containing the phrase; computes `spokenAt = delta.wallclockMs − pipelineLatency`; and returns the focus sample active at that instant.
4. **Confidence.** Each resolution carries `high` / `medium` / `low`:
   - Hard gates: the context must match exactly and focus data must exist at all — otherwise `low`.
   - Two independent quality checks: **ambiguity** (the focus id changes within ±`DEIXIS_AMBIGUITY_WINDOW_MS` of the estimated speak time — a small latency error could flip the result) and **gap** (the newest focus sample at/before the speak time is older than `DEIXIS_STALE_THRESHOLD_MS` — the pointing stream had a reporting hole).
   - Neither fails → `high`, exactly one fails → `medium`, both → `low`.

The buffers are global rather than per-turn (pruning is purely time-based, 30 s), so a follow-up question can still resolve references from the tail of the previous turn.

The system prompt instructs the model to collect **all** pointing references of a turn into a single `resolve_deixis` call and to never expose the machinery — a failed resolution is voiced like a missed gesture ("Point at it again, I didn't quite catch that."), not like a system error.

## Audio & transcript pipeline

Details that make the monitor debugging (and deixis calibration) work, all orchestrated in [src/broker/broker.service.ts](src/broker/broker.service.ts):

- **Lookback buffer.** The server keeps a rolling `AUDIO_LOOKBACK_MS` (1.5 s) window of mic audio. VAD detects speech onset with a delay, so the first phoneme(s) would be cut off; when `speech_started` fires, the lookback is prepended to the recorded turn clip. That is why the "Wh" of "What is that one?" is audible in the monitor's playback.
- **`user_speech` keyed by `itemId`.** The finished clip is held after `speech_ended` until OpenAI materialises the conversation item (`conversation.item.added`) and thereby the `itemId` that all downstream events (deltas, final transcript) share — so monitors can group clip + deltas + transcript per turn.
- **Delta timing fields.** Each `user_transcript_delta` carries `audioOffsetMs` (arrival time relative to clip start) and `spokenOffsetMs` (`audioOffsetMs − pipelineLatency` — the estimated position *in the audio* where the word was spoken). The debug client uses `spokenOffsetMs` to highlight the currently-heard word during clip playback; `playbackTrimMs` on `user_speech` tells it how much lookback padding to skip.
- **Assistant clips.** All TTS audio between `response_started` and `response_done` is concatenated and sent to monitors as one `assistant_speech` blob.

## System prompt

Assembled per session in [src/openai/systemPrompt.ts](src/openai/systemPrompt.ts), following OpenAI's Realtime prompting guide (sectioned Markdown, each section exported separately for isolated tuning): role, personality, strict verbosity limits (hands-free!), German/English language mirroring, pacing, anti-repetition, no-closing-offers rule, per-tool usage guidance, unclear-audio handling, and silence/background-noise handling via `wait_for_user`.

When a project is active, a **project overview** section is appended: the project name/summary plus one line per object (`id — name: summary`). This is why object summaries must stay short — they ride along in every session. Changes to summaries made via `update_object` take effect in the prompt at the **next** session start (the session itself keeps its original prompt).

## Logging

- With `INPUT_TRANSCRIPTION_LOGGING=true` (default), the raw OpenAI transcription events (`…transcription.delta` / `…completed`, `speech_started` / `speech_stopped`, `error`) are appended to `logs/transcription-events-<timestamp>.jsonl` — one JSON line per event, stamped with server receive time. One file per server start. These logs were the basis for calibrating `DEIXIS_PIPELINE_LATENCY_MS`.
- NestJS console logging covers connections, topology changes, session lifecycle, tool calls, and OpenAI errors.

## Project structure

```
src/
├── main.ts                    # bootstrap: HTTP :3000, WS adapter, CORS
├── app.module.ts
├── config/configuration.ts    # all env vars + defaults (typed AppConfig)
├── broker/broker.service.ts   # central orchestrator — all cross-service wiring
├── transport/transport.gateway.ts  # WS :8080 — /hololens slot + /monitor set
├── openai/
│   ├── realtime.service.ts    # OpenAI Realtime WS client, session config, reconnect
│   └── systemPrompt.ts        # sectioned prompt + project overview injection
├── deixis/deixis.service.ts   # focus/delta ring buffers + resolver + confidence
├── projects/
│   ├── projects.controller.ts # REST surface
│   └── projects.service.ts    # JSON file registry, atomic writes, active project
├── protocol/                  # ★ master copy of the wire protocol
│   ├── messages.ts            # all message types + data model (AtlasObject, …)
│   └── audio.ts               # PCM16 / 24 kHz / mono / 20 ms
└── tools/
    ├── tool.interface.ts
    ├── tools.service.ts       # registry; filters update_object in view mode
    ├── deixis/resolve-deixis.tool.ts
    ├── objects/get-object.tool.ts
    ├── objects/update-object.tool.ts
    └── silence/wait-for-user.tool.ts
```

## Development notes

- **Scripts:** `npm run start:dev` (watch), `npm run build`, `npm run lint`, `npm run format`, `npm test` (unit), `npm run test:e2e`.
- **Protocol changes:** [src/protocol/](src/protocol/) is the single source of truth. The debug client keeps a copy under `atlas-debug-client/src/app/protocol/` — keep them in sync manually. The Unity app implements the protocol in C# (`Client.cs`, `MicrophoneStreamer.cs`, `AudioPlayer.cs`, `FocusReporter.cs`, `ProjectService.cs`).
- **Auth:** `TransportGateway.validateAuth()` is a stub that accepts everything — fine for local development, to be replaced (e.g. Microsoft Identity / OAuth) before any non-local deployment. The REST API is equally unauthenticated.
- **Debugging without a HoloLens:** run the debug client; it can hold the `/hololens` slot with the browser mic and simulate pointing, while additional browser tabs watch on `/monitor`.

---

## AI Usage Declaration

This project was developed with the assistance of [Claude Code](https://claude.com/claude-code) (Anthropic), using the Claude Opus 4.8 model.
