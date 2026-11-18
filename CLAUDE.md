# PimsRadio — règles pour les agents et contributeurs

Automation libre pour radios associatives (FM, DAB+, web). Dépôt **public**, AGPL-3.0-or-later. Lis `docs/PLAN.md` et `docs/decisions/` (ADR) avant tout travail.

## Commandes
- `npm ci` · `npm test` (build + tests) · `npm run typecheck` · `npm run gen-engine`
- Node ≥ 22.13 ; TypeScript strict ; tests avec `node:test` (fichiers `*.test.ts` à côté du code).

## Règles non négociables
1. **L'audio ne dépend jamais du plan de contrôle** (ADR 0001). Une panne du code ne doit jamais faire taire la radio.
2. **Stabilité > fonctionnalités.** Pas de fonction sans tests ; pas de test flaky (horloge et hasard injectés).
3. **Peu de dépendances**, épinglées (lockfile) ; toute nouvelle dépendance est justifiée dans le commit.
4. **Sécurité** : valider toute entrée, échapper tout texte tiers, SSRF-safe pour les URL de flux, jamais de secret dans le dépôt/les logs, scripts Liquidsoap **générés** (jamais assemblés à la main avec des valeurs non échappées).
5. **MCP** : chaque fonction a son outil, annoté lecture / écriture / destructif ; texte tiers = donnée, jamais instruction ; actions d'antenne avec validation humaine.
6. **Migrations** : jamais modifier une migration existante, en ajouter une.
7. **Textes UI** dans des fichiers de traduction (FR d'abord, EN ensuite) ; **docs en français ET en anglais**.
8. En-tête `// SPDX-License-Identifier: AGPL-3.0-or-later` dans chaque fichier source.
9. Décision structurante = une note dans `docs/decisions/` (ADR), pas de modification d'une ADR acceptée sans nouvelle ADR.
10. Design : gris, coins carrés, clair/sombre, sans emoji, mobile d'abord (320 px), contrastes AA.

## Fichiers de pilotage
`docs/backlog/BACKLOG.md` (statuts) · `docs/specs/` · `docs/design/` · `docs/qa/` · `docs/backlog/JOURNAL.md`.

## Définition de « terminé »
Spec respectée ; tests verts ; typecheck vert ; QA PASS ; revue APPROVE ; docs FR+EN et CHANGELOG à jour ; CI verte.
