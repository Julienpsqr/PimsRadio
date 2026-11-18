# Journal de l'orchestrateur

- 2026-11-18 · 002 Validation du moteur : done (2 rondes QA, revue APPROVE). Défauts trouvés par l'essai réel : pré-tampon du direct trop long (12 s), injection `#{...}` dans les valeurs du script, réseau Docker résiduel après interruption. Points reportés : durcissement telnet (014), épinglage des actions GitHub par empreinte, tests de panne réels (agent fiabilité).
- 2026-11-18 · Garde-fous licences (PR #3) : fusionné après 3 rondes de revue (défauts trouvés : parenthèses SPDX ignorées, dépassement de pile).

## PAUSE — 2026-11-18 (fin de session, limite d'usage atteinte)
**État exact à la reprise**
- `main` (GitHub) contient : 002 (PR #2), garde-fous de licences (PR #3), noms génériques (PR #1), README avec captures de la maquette (PR #4).
- **Élément 001 (client moteur Liquidsoap)** : branche `feat/001-moteur-liquidsoap`, poussée sur GitHub, **PAS de PR ouverte, PAS fusionnée**. QA : PASS (docs/qa/001-moteur-liquidsoap.md). Revue : APPROVE, puis APPROVE du suivi (commits c8269ae, 156fb22). 122 tests verts, typecheck et check:licenses OK, `npm run test:engine` 21/21 (Docker).
- **Test de fiabilité de 001 : FAIT** (rapport docs/qa/reliability/001-2026-11-18.md, commit e61b10c) : aucun bug bloquant du client ; moteur tué 5 fois : coupure auditeur max 1,14 s, reprise du client en ~2 s ; Icecast arrêté 181 s : le moteur joue, flux revenu en 3 s ; pas de fuite mémoire/sockets sur 5 min. Constats : **A** un moteur gelé coupe le son ~30 s et rien ne le détecte/relance (→ à traiter dans 003, watchdog) ; **B** secours vidé ou illisible = silence alors que `healthy()` vrai (→ nouvelle entrée 023, dernier recours audible) ; **C** un `healthy()` faux avec socket établie observé une fois, non reproduit (à surveiller). Disque plein : test partiel (94 %).
- **Reste à faire sur 001 :** ouvrir la PR (`gh pr create --base main --head feat/001-moteur-liquidsoap`), attendre la CI verte, `gh pr merge --squash --delete-branch`, puis `git switch main && git pull --ff-only && npm ci && npm test`, rafraîchir le tableau de bord. QA et revue sont déjà APPROVE ; le rapport de fiabilité n'a pas de point bloquant.
- La branche 001 contient aussi des commits de documentation sans rapport avec le client : backlog (idées 017 à 022), ADR 0006 (exposition réseau) et 0007 (modèles d'IA), QUESTIONS.md, docs/ROADMAP.md. Ils partiront avec le merge (squash).
- **Après 001 :** jalon J1 (docs/ROADMAP.md) : 022 (câbler le planificateur), 003 (silence et alertes), 004 (aircheck).
- À vérifier au retour : `docker ps -a`, `docker network ls`, `docker volume ls` (nettoyer tout reste du projet : préfixe `pimsradio`), `git status`, `git log --oneline main..HEAD`.
- Décisions et questions en attente : voir docs/backlog/QUESTIONS.md. En attente d'infos d'une radio pilote : état de l'émetteur (017c), exports de droits (018b).
