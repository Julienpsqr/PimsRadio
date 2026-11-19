# Driving Liquidsoap from PimsRadio

The control plane pushes tracks into Liquidsoap through a built-in telnet client (`LiquidsoapEngine`, spec 001, no npm dependency). **Audio never depends on it**: if the client or the control plane stops, Liquidsoap plays what is already queued, then the fallback folder.

## Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `PIMSRADIO_ENGINE` | `fake` | `fake` (demo, no sound) or `liquidsoap`. Any other value: startup refused. |
| `PIMSRADIO_LS_HOST` | `127.0.0.1` | Host of the Liquidsoap telnet server. |
| `PIMSRADIO_LS_PORT` | `1234` | Telnet port (integer 1 to 65535, otherwise startup refused). |
| `PIMSRADIO_MEDIA_ROOT` | `/media` | Media folder as seen by PimsRadio. |
| `PIMSRADIO_LS_MEDIA_ROOT` | same | The same folder as seen by Liquidsoap (Docker volume mounted elsewhere). |
| `PIMSRADIO_LS_ALLOW_REMOTE` | unset | `1` to allow a telnet host that is not loopback (see below). |
| `PIMSRADIO_HOST` | `127.0.0.1` | Listen address of the HTTP interface (ADR 0006). A non-loopback host refuses to start unless `PIMSRADIO_ALLOW_REMOTE_UI=1`. |
| `PIMSRADIO_ALLOW_REMOTE_UI` | unset | `1` to allow a non-loopback listen address. Docker: inside the container set `PIMSRADIO_HOST=0.0.0.0` with this variable, and publish the port in the compose file as `127.0.0.1:8080:8080`. |

With no variable set PimsRadio starts with the fake engine, as before. An invalid value stops startup with a clear message (a configuration error, not an engine outage). Startup never depends on Liquidsoap being up: the connection is made in the background.

## Telnet has no authentication
The Liquidsoap telnet server has **no authentication**: anyone who reaches it can do anything. PimsRadio **refuses to start** with a host that is not 127.0.0.1 / ::1 / localhost unless `PIMSRADIO_LS_ALLOW_REMOTE=1` (a warning is then logged). Only use this on a trusted private network (for instance the internal network of a compose file, where the host is the `liquidsoap` service name) and never publish the port anywhere but 127.0.0.1.

## What the client does
- One persistent connection, one command at a time, 3 s per command, 2 s to connect. Automatic reconnection (0.5 s, then 1 s, 2 s... capped at 15 s). During an outage calls fail at once and never block the planner.
- Only `auto.push`, `auto.queue`, `request.metadata`, `auto.skip`, `uptime` and `pims.state` exist; none can stop or reconfigure the engine.
- Paths are validated before sending: absolute, under `PIMSRADIO_MEDIA_ROOT`, no `..`, no control or line-break character, at most 4096 bytes. An invalid path is refused (never "cleaned"). Spaces, quotes, accents and `#` inside a name are accepted.
- A `push` is never replayed automatically (duplicate risk). If no answer arrives the error says the outcome is unknown and the next tick re-reads the real queue.
- `/api/health` stays 200 and reports `engine: false` plus `engineDetail` (`connected`, `lastOkAt`, `lastError`) when the engine does not answer. "Healthy" means "Liquidsoap answers control", not "sound comes out".
- Queued tracks missing from the library count as 0 s of lead time; a fallback track's title is its file name.

## The `pims.state` command (generated script)
The generated script registers a read-only command, `pims.state`, answering `key=value` lines then `END`: `source` (`direct` if the studio input is ready, else `auto` if the queue is ready, else `fallback`), `rid` and `filename` of the track being played (empty when live), `uptime` (seconds since the script started, used to detect a restart). The form is validated with `--check` and on Liquidsoap v2.4.6 by `npm run test:engine`. Line breaks in the file name are replaced on the Liquidsoap side and the client only reads the first occurrence of each key.

Known limits: `skip` only acts on the queue (`auto`), not on a live feed nor on the fallback; a track's `startedAt` is the time PimsRadio first saw it on air.

## The planner (queue-filling loop)

At startup PimsRadio starts a background loop that fills the engine queue ahead of time (spec 022). It never blocks startup and cannot silence the radio: if it stops, the engine plays what is already queued, then its fallback folder.

| Variable | Default | Purpose |
|---|---|---|
| `PIMSRADIO_PLANNER_INTERVAL_S` | `30` | Seconds between two passes (5 to 300). |
| `PIMSRADIO_PLANNER_AHEAD_S` | `900` | Seconds of audio to keep queued (120 to 7200, at least twice the interval). |

An invalid value prevents startup with a clear message. The loop state is readable on `/api/health`, field `planner`: `running`, `stalled` (a pass lasts more than 60 s), `lastTickAt`, `lastOkAt`, `lastPushed`, `note` (fixed text, for instance engine unreachable or empty library) and `consecutiveFailures`. An unreachable engine is not a loop failure: it retries on the next pass.
