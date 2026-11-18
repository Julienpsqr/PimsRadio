# PimsRadio — overview (English)

The full design plan is written in French in [../PLAN.md](../PLAN.md). This page summarises it; an English translation of the plan will follow once the first version stabilises.

## Idea
A community station needs a tool that **never goes silent**, that volunteers can install in an evening, that sends **one programme to FM, DAB+ and the web**, accepts **external streams** like any other source, and can be **driven by an AI assistant through MCP**.

## Architecture: two planes
- **Audio plane** — Liquidsoap (+ Icecast, ffmpeg, ODR for DAB+): playout, crossfades, loudness, live input, fallbacks, outputs. Keeps playing if the control plane is down.
- **Control plane** — this project (Node.js + TypeScript + SQLite): library, weekly grid, rotation rules, streams, users, logs/compliance, REST API and MCP. It only fills the engine's queue ahead of time and is never in the audio path.

## MCP safety levels
Read (free) · Draft (no effect on air) · On-air (human approval, audit log).

## Roadmap
0 Scoping · 1 Audio pipe (Liquidsoap + Icecast) · 2 Library, grid, UI · 3 Streams and live · 4 FM/DAB+ outputs · 5 MCP · 6 Compliance, installer, pilot station. Then podcasts, voice-tracking, multi-station.

See also: [decisions](../decisions/) (ADRs, French).
