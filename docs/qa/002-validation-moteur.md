# QA 002 - Validation du moteur

**Verdict : FAIL** (1 bug majeur, 1 mineur ; le chemin nominal est entièrement vert).

Branche `feat/002-validation-moteur`, 2026-11-18, Docker 29.8.2 (OrbStack), arm64.

## Commandes (relancées par QA)

| Commande | Résultat |
|---|---|
| `npm test` (avant mes ajouts) | 36/36 verts |
| `npm test` (après mes ajouts) | 44 verts, 1 todo (bug QA-1), 0 échec |
| `npm run typecheck` | 0 erreur |
| `npm run test:engine` | exit 0, **14/14 critères OK en 153 s** (critères 1, 3 à 15) |
| Après le run : `docker ps -a`, `docker network ls`, `docker volume ls`, tmp | vides (seuls bridge/host/none) |

Le développeur disait vrai sur les chiffres.

## Critères d'acceptation

1. Script valide + test du test + chemin `"` `\` : OK (run réel, `--check` rc=0, script altéré rc=1).
2. Versions épinglées : OK (`compose.test.ts` ; mutation `latest` : échec détecté).
3. Icecast reçoit/diffuse : OK (audio/mpeg, ~88 ko en 5 s).
4. Secours si file vide : OK (440 Hz, 14/14 fenêtres).
5. Push telnet : OK (RID 2/3, présents dans `auto.queue` / `request.all`, 880 Hz 24 fenêtres, `exit` propre).
6. Retour au secours : OK.
7. Priorité direct > file > secours : OK (1320 / 880 / 440, aucune fenêtre silencieuse).
8. Mot de passe harbor : OK (sortie inchangée, rejet visible dans les logs de l'émetteur).
9. Fichier invalide (corrompu + inexistant, deux connexions telnet simultanées) : OK, conteneur `running`.
10. Jamais silencieux : OK (capture 109 s, 0 s sous -50 dBFS).
11. Reconnexion Icecast : OK (mount revenu en 0,5 s, Liquidsoap non redémarré).
12. Redémarrage moteur : OK (3,1 s).
13. Secours vide : OK (source listée, 114 ko en 6 s).
14. Nettoyage : OK sur succès, sur échec de port, sur SIGINT/SIGTERM pour conteneurs, volumes, dossier tmp et verrou ; **KO : le réseau reste dans un cas (bug QA-2)**.
15. Isolation : OK (3 ports en 127.0.0.1, ports de test différents du dev, aucun mot de passe de test dans la sortie : mots de passe `test-` + 24 hex aléatoires, masqués par `mask()`).
16. Analyseur : OK, avec mutations (voir plus bas).
17. Commande distincte de `npm test`, job CI nocturne/manuel : OK (`.github/workflows/engine.yml`).

## Zones non couvertes par le développeur, testées par QA

- **Docker inaccessible** (`DOCKER_HOST=tcp://127.0.0.1:1`) : exit **2**, "Docker unavailable". OK.
- **Port occupé** (18005 occupé par un autre processus) : exit **2**, message nommant le port, rien de créé. OK.
- **Instance déjà lancée** : un 2e `test:engine` pendant qu'un run tourne sort en exit 2 (port 18000 occupé), sans toucher aux conteneurs du 1er run (vérifié : le 1er continue puis nettoie normalement). Deux lancements simultanés : un seul démarre, l'autre exit 2. OK.
- **SIGINT / SIGTERM en cours de run** : exit 130, conteneurs, volumes, dossier tmp, verrou supprimés. **Sauf le réseau si l'émetteur direct est actif (QA-2).**
- **Mutation de l'analyseur** (puis `git checkout`) :
  - `isSilent` toujours faux : 3 tests échouent. Fréquence Goertzel décalée de 50 Hz : 3 échecs. Ratio de dominance ignoré : 1 échec. Seuil -50 vers -90 dBFS : 1 échec. Compose `latest` : 1 échec. Compose `0.0.0.0` : 1 échec.
  - `longestSilence` sans remise à zéro : **aucun test n'échouait** (mutant survivant) ; corrigé par mon test `analyze.qa.test.ts`.
- **Sécurité** : ports 127.0.0.1 OK ; mots de passe aléatoires et masqués OK ; injection dans le script : voir QA-1.

## Bugs

### QA-1 (majeur) - `lqString` n'échappe pas l'interpolation `#{...}` de Liquidsoap
- Reproduction : `lqString("a#{1+1}b")` renvoie `"a#{1+1}b"`. Dans Liquidsoap v2.4.6, `x = "a#{1+1}b"; print(x)` affiche `a2b` (vérifié dans le conteneur). Toute valeur de config (mot de passe, chemin, hôte, mount) contenant `#{expr}` est donc évaluée comme du code Liquidsoap (injection de code ; un mot de passe contenant `#{` est aussi silencieusement altéré, donc le harbor/Icecast refuse la connexion).
- Attendu (spec section 6, "aucune valeur non échappée injectée") : aucune séquence interprétée. Obtenu : interprétée.
- Piste : remplacer `#{` par `#{` (vérifié : donne un `{` littéral). `\#{` ne fonctionne pas (erreur "String is not terminated").
- Test : `src/engine/liquidsoap.qa.test.ts` (marqué `todo` pour garder la suite verte ; retirer `todo` à la correction). Gravité majeure car la source de ces valeurs sera l'UI/la config (items ultérieurs) ; aujourd'hui seul l'administrateur les fournit.

### QA-2 (majeur au sens de la spec, impact faible) - un réseau Docker reste après Ctrl-C pendant le direct
- Reproduction (2 fois sur 2) : lancer `node dist/tools/test-engine.js`, attendre ~62 s (émetteur `pimsradio-test-live-1` actif), `kill -INT` (ou `-TERM`). Exit 130, mais `docker network ls` montre `pimsradio-test_default`.
- Attendu (critère 14) : aucun réseau restant. Cause probable : `cleanup()` fait `compose down` avant de supprimer les conteneurs étiquetés `LABEL`, l'émetteur (hors compose, attaché au réseau) bloque la suppression du réseau.
- Correctif : supprimer les conteneurs étiquetés avant `compose down`, ou refaire `down` après. Atténuation existante : le pré-nettoyage du run suivant supprime ce réseau (vérifié par `docker network rm` manuel, pas par un run).

### QA-3 (mineur, non bloquant)
- Le détecteur n'a que trois bins : un signal à 500 Hz est déclaré "dominant 440". Acceptable car les sources de test ont des fréquences très distinctes, mais l'analyseur ne détecte pas une "mauvaise fréquence" quelconque.
- `settings.server.telnet.bind_addr := "0.0.0.0"` dans le script généré : correct dans le conteneur car publié en 127.0.0.1 par le compose, mais sans protection si quelqu'un publie le port autrement (sans authentification). À surveiller dans 014.

## Tests ajoutés (aucun code produit modifié)

- `src/tools/engine-test/analyze.qa.test.ts` : silences séparés (tue le mutant), mauvaise source jamais reconnue comme attendue, seuil -50 dBFS (-45 audible, -55 silencieux), marge de dominance x10, signal plus court qu'une fenêtre.
- `src/engine/liquidsoap.qa.test.ts` : valeurs hostiles contenues entre guillemets, nombres invalides rejetés, QA-1 (todo).

## Zones non couvertes

- Pannes audio réelles (disque plein, coupures réseau prolongées, endurance) : à confier à l'agent fiabilité.
- amd64 (tags vérifiés par le développeur, exécution testée uniquement sur arm64).
- Le job CI GitHub n'a pas été exécuté.
- Critère "aucun processus Node enfant" : non vérifié de façon spécifique (les exits 130 et 0 étaient propres).
- Variabilité de timing sur machine lente : un seul run complet lancé, pas de répétition.
