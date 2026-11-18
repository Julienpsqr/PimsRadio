# PimsRadio

**EN** — Open-source automation for community radio stations: FM, DAB+ and web, with a weekly programme grid, external streams, and an **MCP** server so an AI assistant can help run the station.
**FR** — Automation libre pour les **radios associatives** : FM, DAB+ et web, avec une grille de programmes, des flux externes et un serveur **MCP** pour piloter la radio avec un assistant IA.

> **Status / État : early development / développement initial.** Not installable yet / pas encore installable. Plan: [docs/PLAN.md](docs/PLAN.md) (FR) · [docs/en/OVERVIEW.md](docs/en/OVERVIEW.md) (EN) · Decisions: [docs/decisions](docs/decisions/).

## Goals / Objectifs
- **Never go silent / ne jamais se taire**: audio keeps playing even if the interface crashes / l'audio continue même si l'interface plante.
- **One-command install** and a browser setup wizard for non-technical volunteers / installation en une commande et assistant dans le navigateur.
- One programme to **FM, DAB+ and web** / un même programme vers FM, DAB+ et web.
- **External streams** schedulable in the grid, with automatic fallback / flux externes programmables, avec bascule de secours.
- **MCP**: free reading, harmless drafts, on-air actions need human approval / lecture libre, brouillons sans effet, antenne avec validation humaine.

## Tech / Technique
Node.js + TypeScript (control plane / plan de contrôle), Liquidsoap + Icecast (audio), SQLite. License / licence: **AGPL-3.0**.

## Develop / Développer
```bash
npm install
npm test          # build + 22 tests
npm run gen-engine  # generates the Liquidsoap script (engine/generated/radio.liq)
```
The audio engine needs Docker (see `deploy/docker-compose.dev.yml`, draft). / Le moteur audio demande Docker (brouillon).
