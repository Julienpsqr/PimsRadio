# QA 001 : client moteur Liquidsoap réel

**Verdict : PASS** (aucun bug bloquant ni majeur ; 3 remarques mineures et 3 trous de tests comblés).
Branche `feat/001-moteur-liquidsoap`, commit testé 5949517. Spec : `docs/specs/001-moteur-liquidsoap.md`.

## Commandes (relancées, pas crues sur parole)

| Commande | Résultat |
|---|---|
| `npm test` (avant mes tests) | 107/107 |
| `npm test` (avec mes tests) | 121/121, 0 échec |
| `npm run typecheck` | OK, 0 erreur |
| `npm run check:licenses` | 3 dépendances, toutes compatibles AGPL |
| `npm run test:engine` (Docker réel) | 21/21 en 241 s (critères 1 à 22 du harnais, dont 16 à 22 avec le vrai `LiquidsoapEngine`) |
| Nettoyage Docker | `docker ps -a`, réseaux, volumes : vides ; dossiers temporaires supprimés |

## Critères

Les critères 1 à 26 sont prouvés par des tests unitaires ; 27 à 33 par le harnais (numéros 16 à 22 du harnais).
Tous ✓. Détail des vérifications par mutation (modification manuelle du code dans une copie hors dépôt, restauration, `npm test`) :

| Mutation | Détectée ? |
|---|---|
| Caractères de contrôle retirés de la validation de chemin | oui (10, 13b) |
| Retrait du contrôle « chemin absolu » (préfixes `annotate:` etc.) | oui |
| Retrait du contrôle `..` | oui |
| Limite 4096 octets doublée | oui (11) |
| Retrait du contrôle « espace en fin » | oui (10) |
| Retrait du délai de commande | oui (le test 5 et le test moteur se bloquent : échec) |
| Retrait du plafond de réponse 1 Mio / ligne 64 Kio / reste partiel | oui (14) |
| Retrait de la sérialisation FIFO | **non** au départ (voir trou 1) ; oui avec QA 3b |
| Plafond de file 64 relevé | oui (4) |
| Retrait du rejet immédiat en `down` | oui (9, 16b, 17...) |
| `maybeApplied` forcé à faux | oui (6) |
| Backoff non remis à zéro | oui (8) |
| `END` détecté par `includes` | oui (2) |
| UTF-8 non strict | oui (14) |
| Code d'erreur `unreachable` changé | oui |
| Commande `pims.state` avec injection | oui (liste blanche) |
| `skip` sans test de source | oui (20) |
| Erreur `ERROR` de `auto.skip` ignorée | **non** au départ (trou 2) ; oui avec QA 20c |
| Regex RID relâchée | oui |
| `queuedSeconds` renvoyant 0 sur erreur | oui |
| `healthy()` qui rejette | oui |
| Plafond de 50 RID inconnus retiré | oui |
| Test racine médias retiré | oui |
| Livre de comptes non vidé à la reconnexion | **non** au départ (trou 3) ; oui avec QA 18b |
| Détection de régression d'uptime retirée | oui (18) |
| Cache de santé retiré | oui (21) |
| Validation du chemin du `pims.state` retirée | oui (19) |
| `Planner.tick` n'attrape plus les erreurs | oui |
| Refus d'hôte distant retiré, port > 65535 | oui |
| `engineDetail` retiré de l'API | oui |
| Octets après `END` acceptés | survit, mais mutant équivalent : un second garde (« unsolicited data » sans commande en vol) rejette quand même ; couvert par QA 14c |

## Trous de tests trouvés par mutation (comblés)

1. Sérialisation FIFO : le test 3 mettait les 5 appels en file pendant la connexion paresseuse, donc la garde « une seule commande en vol » pouvait disparaître sans échec. QA 3b fait la même chose sur une connexion établie.
2. Une réponse `ERROR` à `auto.skip` n'était pas testée (`skip` aurait pu annoncer `skipped: true`). QA 20c.
3. Le vidage du livre de comptes à la reconnexion (RID repartant de zéro) n'était pas testé : un RID périmé aurait donné une mauvaise durée. QA 18b.

## Bugs

Aucun bloquant, aucun majeur.

- **B1 (mineur)** : `pathProblem` laisse passer les caractères bidirectionnels et de largeur nulle (U+202E, U+200B, U+FEFF). Un nom de fichier de secours inconnu de la bibliothèque s'affiche donc tel quel comme titre dans `state()`/`queue()`. Pas d'injection de commande possible ; risque d'affichage trompeur dans l'écran Antenne (006), qui devra échapper. Attendu : à signaler à 006 ou à filtrer.
- **B2 (mineur, dérive de spec)** : la spec §2.10 dit « avertissement mais accepté » pour un hôte non loopback ; le code refuse sauf `PIMSRADIO_LS_ALLOW_REMOTE=1` (choix documenté dans `docs/ops/moteur-liquidsoap.md`, cohérent avec la question ouverte 4 et l'ADR 0006). Mettre la spec à jour. Une variable présente mais vide (`PIMSRADIO_ENGINE=`) est refusée au lieu de valoir « fake » : acceptable, à connaître pour le compose.
- **B3 (mineur, latence)** : juste après un `push` sur une file vide, `state()` peut répondre `fallback` pendant quelques millisecondes (la file n'est pas encore prête côté Liquidsoap), observé sur le vrai moteur. Idem juste après `skip`. Sans conséquence audio ; l'appelant (011) ne doit pas déduire un fait d'un seul `state()` immédiat.

## Tests exploratoires

- `node dist/main.js` sur base temporaire, `/api/health` à chaque mode : fake (200, `engine: true`) ; liquidsoap avec moteur absent (200, `engine: false`, `engineDetail.lastError = "unreachable"`, 5 ms) ; hôte `10.1.2.3` sans `ALLOW_REMOTE` : arrêt rc=1 avec message ; avec `ALLOW_REMOTE=1` : démarre avec avertissement, health répond en 0,5 s (délai de connexion, borné). Refus propres de : port 0, 65536, vide, `1e3` ; hôte vide, `0.0.0.0`, `localhost.evil.com` ; moteur vide ou `Liquidsoap` ; racine médias vide ou relative ; `ALLOW_REMOTE=yes`.
- Moteur absent, 300 requêtes `/api/health` simultanées pendant 60 s : 8 reconnexions seulement (0,5 s puis x2 jusqu'à 15 s), aucune tempête, serveur toujours à 200.
- Moteur Liquidsoap réel seul (conteneur jetable, sans Icecast) : push de fichiers nommés `été ça`, `日本語 🎵`, `a"b`, `#x{y}`, `back\slash` : tous acceptés et joués ; un fichier avec tabulation est refusé `invalid_input`. Un client neuf (sans livre de comptes) relit la file et retrouve les 4 durées via la bibliothèque (80 s) : l'échappement des métadonnées Liquidsoap est bien réversible, y compris pour UTF-8. Sortie brute de `pims.state` vérifiée octet par octet (`key=value`, `\r\n`, `END`). `request.metadata abc` renvoie une erreur bien gérée comme `protocol`/inconnu.
- Pannes audio du moteur (kill/restart de Liquidsoap, Icecast tombé) : le harnais les passe (critères 11, 12, 20 : `healthy()` faux en 0,0 s, retour 2,0 s après redémarrage sans recréer le client, jamais de silence). Je n'ai pas refait de scénario de panne disque plein.

## Tests ajoutés

`src/engine/liquidsoap-engine.qa.test.ts` (14 tests, +14 au total) : QA 3b (FIFO connexion établie), 14c (réponses concaténées / END au milieu), 14d (goutte à goutte octet par octet), 14e (goutte à goutte sans fin : timeout, `maybeApplied`), 20c (ERROR de skip), 15b (réponses push invalides : deux lignes, `7;exit`, `-1`, `1e3`, trop long, `0x1`), 18b (livre vidé à la reconnexion), 9b (100 appels simultanés push/queue/state), 4b (100 appels : exactement 64 servis, 36 `busy`, chacun reçoit sa réponse), 19c (valeurs hostiles dans `pims.state` : U+2028, CR, `..`, `annotate:`, 5000 octets, NUL, clé forgée), 19d (rid absurde), 21b (`healthy()` ne rejette jamais malgré garbage et résolveur qui lève), 2b (CR isolé conservé comme donnée), 24c (`close()` avec commandes en vol et en file).

## Zones non couvertes

- Disque plein, Icecast mort longtemps, kill répété du conteneur pendant des commandes en vol sur le vrai moteur : à confier à l'agent fiabilité (le harnais ne teste qu'un redémarrage).
- Heure d'été : le client n'utilise que des durées relatives ; non testé spécifiquement.
- `Planner.tick` sur le vrai moteur en panne : couvert seulement par moteur simulé (planner.test.ts), pas de boucle de planification câblée (hors périmètre).
- Boucle SIGTERM de `main.ts` en mode liquidsoap vérifiée (exit 0) ; en mode fake, pas de gestionnaire (comportement antérieur, exit 143).
