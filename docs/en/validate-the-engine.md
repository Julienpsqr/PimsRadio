# Validating the engine

`npm run test:engine` starts Icecast and Liquidsoap in Docker with the script **generated** by PimsRadio, plays synthetic test sounds (440, 880 and 1320 Hz sine tones produced by Liquidsoap itself, nothing downloaded) and measures what actually comes out of the stream. It is separate from `npm test` (fast, no Docker).

## Requirements
- Docker (OrbStack, Docker Desktop or Linux) reachable; ffmpeg is **not** needed on the host.
- Free ports on 127.0.0.1: 18000 (Icecast), 18005 (harbor), 11234 (telnet). They deliberately differ from the dev compose ports (8000, 8005, 1234).
- Duration: about 2.5 minutes (after the first image pull).

## Run
```
npm run test:engine
```
Exit codes: 0 all OK, 1 at least one criterion KO, 2 environment problem (Docker missing, port busy, another run active).

## Reading the summary
One line per criterion of spec 002: `[OK]` / `[KO]`, the name, the measured values (for example `440 Hz in [3,10]s: 14/14 windows`) and elapsed time. A window is 500 ms; it is silent below -50 dBFS; a frequency is dominant if its energy is at least 10 times that of the other two. The script always tears down (containers, network, volumes, temp dir), even on failure or Ctrl-C; criterion 14 verifies it.

Passwords are random per run (`test-` prefix) and masked in all output.

## If a criterion is KO
1. Read the line: the measured value tells what happened (wrong source, silence gap, delay exceeded).
2. Icecast and Liquidsoap logs are printed automatically on failure (passwords masked).
3. Criterion 1 (invalid script): run `npm run gen-engine` then `docker run --rm -v "$PWD/engine/generated:/e:ro" savonet/liquidsoap:v2.4.6 --check /e/radio.liq`.
4. A failure should only come from a clear tolerance overrun; do not rerun in a loop, fix the generator (`src/engine/liquidsoap.ts`).

## Measured behaviour worth knowing
- Telnet commands: `auto.push <path>` (returns the RID), `auto.queue` (lists **waiting** requests only: a file already playing is no longer listed), `request.all` (every request), `auto.skip`. Each answer ends with an `END` line.
- Priority is live > queue > fallback; switching is immediate (`track_sensitive=false`).
- The harbor pre-buffer is reduced to 2 s (the 12 s default delayed switching by more than 10 s).
- Icecast restarted: Liquidsoap reconnects by itself. Liquidsoap restarted: the stream returns from the fallback within seconds.
- **Documented limit**: with an empty fallback folder and an empty queue the stream stays connected but silence is expected (`mksafe`). Always keep at least one file in `media/fallback`.
