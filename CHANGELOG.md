# Changelog

## Unreleased
- Real engine client (spec 001): `LiquidsoapEngine`, a dependency-free telnet client (one serialised connection, timeouts, reconnection with backoff, command whitelist, validated paths) implementing `AudioEngine` plus `state`, `next`, `queue`, `skip`. New read-only `pims.state` command in the generated script. The planner and `/api/health` survive an engine outage (`engineDetail`). Configuration by `PIMSRADIO_ENGINE`, `PIMSRADIO_LS_HOST`, `PIMSRADIO_LS_PORT`, `PIMSRADIO_MEDIA_ROOT`, `PIMSRADIO_LS_MEDIA_ROOT`; a non-loopback telnet host is refused unless `PIMSRADIO_LS_ALLOW_REMOTE=1`. `npm run test:engine` gains criteria 16 to 22.
- Engine validation (spec 002): `npm run test:engine` runs the generated Liquidsoap script against real Icecast and Liquidsoap containers (pinned to Liquidsoap v2.4.6 and Icecast 2.4.4) and checks fallback, telnet push, priorities, reconnection, restart and cleanup.
- Engine script: shorter harbor pre-buffer (2 s) so live switching is fast.
- Dev compose: ports bound to 127.0.0.1, telnet published on localhost only, ports, passwords and paths overridable by environment variables.
