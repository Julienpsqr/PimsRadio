# 022 — Câblage du planificateur au démarrage

**Statut** : spécifié · **Priorité** : P0 · **Dépend de** : 001 (fait) · **Bloque** : 003, 006

> **EN summary.** Add `PlannerLoop`, a small dependency-free loop that calls `Planner.tick` periodically with the real engine, wired in `src/main.ts`. Ticks never overlap, never block startup, and never crash the process: any error is caught and logged (control characters stripped, length capped). A tick stuck longer than a limit is reported as `stalled` but is never doubled (no duplicate pushes). Graceful stop on SIGINT/SIGTERM (waits a bounded time for the running tick). The state (`lastTickAt`, `lastOkAt`, `lastPushed`, `note`, consecutive failures, `stalled`) is exposed read-only under `planner` in `/api/health`, with fixed fields only (no raw error text). Configuration: `PIMSRADIO_PLANNER_INTERVAL_S` (default 30, 5 to 300) and `PIMSRADIO_PLANNER_AHEAD_S` (default 900, 120 to 7200). Clock and timers are injected; no migration, no dependency. Audio never depends on this loop (ADR 0001): if it stops, the engine plays what is queued, then its fallback folder.

## Questions ouvertes

Aucune.

## 1. Contexte et problème

Le client du moteur (001) existe, mais rien n'appelle `Planner.tick` : en production, la file reste vide et seul le dossier de secours joue. Le plan de contrôle doit remplir la file en avance, régulièrement, sans jamais pouvoir faire taire la radio ni bloquer le démarrage (ADR 0001, règle 1).

## 2. Comportement attendu

1. **Boucle** : `PlannerLoop` appelle `tick(now())` puis, une fois le tick terminé, planifie le suivant après `intervalMs` (pas de `setInterval` : jamais deux ticks en parallèle). Le premier tick part en tâche de fond juste après le démarrage (délai 0) ; `start()` retourne immédiatement.
2. **Erreurs** : toute exception du tick (y compris non liée au moteur, par exemple la base) est attrapée, journalisée (message nettoyé des caractères de contrôle, limité à 200 caractères), comptée dans `consecutiveFailures`. La boucle continue. Un tick réussi remet le compteur à zéro. Une note du planificateur (moteur injoignable, bibliothèque vide) n'est pas un échec : elle est conservée telle quelle (`note`).
3. **Tick bloqué** : si un tick dure plus de `stallAfterMs` (défaut 60 s), l'état passe à `stalled: true` ; la boucle ne lance pas de second tick tant que le premier n'est pas terminé (évite les doublons de `push`). Le retour à la normale efface `stalled`.
4. **Arrêt propre** : `stop()` annule la minuterie, interdit tout nouveau tick et attend au plus `stopTimeoutMs` (défaut 5 s) la fin du tick en cours. Appelé sur SIGINT/SIGTERM avant la fermeture du moteur. Idempotent.
5. **État** : `status()` renvoie `{ running, stalled, lastTickAt, lastOkAt, lastPushed, note, consecutiveFailures }` (dates ISO 8601 UTC, `note` = chaîne fixe du planificateur ou `null`). `/api/health` l'expose sous `planner` seulement si la boucle est fournie ; aucun message d'erreur brut n'y figure.
6. **Configuration** : `PIMSRADIO_PLANNER_INTERVAL_S` entier de 5 à 300 (défaut 30) ; `PIMSRADIO_PLANNER_AHEAD_S` entier de 120 à 7200 (défaut 900, doit rester supérieur à deux fois l'intervalle). Valeur invalide : refus de démarrer avec un message clair (comme 001).
7. **Sécurité** : aucune entrée externe nouvelle ; aucun secret ; le journal ne contient que des chaînes nettoyées.

## 3. Critères d'acceptation (tests, horloge et minuteries injectées)

1. Le premier tick démarre sans bloquer `start()` ; les suivants espacés de `intervalMs`.
2. Pas de chevauchement : un tick lent retarde le suivant, jamais deux en même temps.
3. Une exception (non moteur) est attrapée, journalisée nettoyée, compte les échecs, la boucle continue ; un succès remet à zéro.
4. Une note du planificateur est conservée sans compter comme échec.
5. Tick bloqué : `stalled` vrai après `stallAfterMs`, aucun second tick ; faux après la fin.
6. `stop()` : plus aucun tick ensuite, attend le tick en cours (borné), idempotent ; `start()` après `stop()` refusé.
7. `/api/health` expose `planner` (champs fixes) et reste identique sans boucle.
8. Configuration : défauts, bornes, valeurs invalides refusées, cohérence cible/intervalle.
9. Intégration : `Planner` + `FakeEngine` avec la boucle remplit la file ; moteur coupé puis remis : la file se remplit au tick suivant sans redémarrage.
