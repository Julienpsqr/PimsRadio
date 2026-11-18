# PimsRadio

Automation libre pour les **radios associatives** : FM, DAB+ et web, avec une grille de programmes, des flux externes et un serveur **MCP** pour piloter la radio avec un assistant IA.

> **État : conception.** Pas encore de version installable. Suis l'avancement dans [docs/PLAN.md](docs/PLAN.md) et les choix dans [docs/decisions](docs/decisions/).

## Objectifs
- Une radio doit ne **jamais se taire** : l'audio continue même si l'interface plante.
- **Installation en une commande** et un assistant dans le navigateur, pour des bénévoles non techniciens.
- Un même programme vers **FM, DAB+ et web**.
- **Flux externes** programmables dans la grille, avec bascule de secours.
- **MCP** : lecture libre, brouillons sans effet, antenne avec validation humaine.

## Technique
Node.js + TypeScript (plan de contrôle), Liquidsoap + Icecast (audio), SQLite. Licence **AGPL-3.0**.
