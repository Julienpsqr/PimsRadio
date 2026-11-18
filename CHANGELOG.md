# Changelog

## Unreleased
- Engine validation (spec 002): `npm run test:engine` runs the generated Liquidsoap script against real Icecast and Liquidsoap containers (pinned to Liquidsoap v2.4.6 and Icecast 2.4.4) and checks fallback, telnet push, priorities, reconnection, restart and cleanup.
- Engine script: shorter harbor pre-buffer (2 s) so live switching is fast.
- Dev compose: ports bound to 127.0.0.1, telnet published on localhost only, ports, passwords and paths overridable by environment variables.
