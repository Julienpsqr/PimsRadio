# 0002 — Node.js + TypeScript
**Date** 2026-11-18 · **Statut** acceptée

**Décision.** Le plan de contrôle est écrit en TypeScript sur Node.js (version LTS en vigueur ; cible Node 24 LTS à confirmer, minimum 22). SQLite pour la base.

**Alternatives écartées.** Rust : puissance inutile ici (l'audio est ailleurs), contribution plus difficile. Go : bon choix, mais moins connu du mainteneur. Python : plus lourd, dépendances plus fragiles.

**Raison.** Le mainteneur connaît la pile ; un maximum de contributeurs bénévoles la connaît ; le typage apporte de la fiabilité ; l'écosystème MCP est le plus mûr.

**Règles pour durer.** Peu de dépendances, toutes épinglées (lockfile) et mises à jour régulièrement ; dépendances nouvelles justifiées dans la PR ; pas d'outil de build exotique ; tests automatiques obligatoires ; à vérifier avant la v0.1 : le statut de `node:sqlite` (encore marqué expérimental dans certaines versions) sinon `better-sqlite3`.
