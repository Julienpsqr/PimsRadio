# 001 — Moteur Liquidsoap réel (client telnet, file, état)

**Statut** : spécifié · **Priorité** : P0 · **Dépend de** : 002 (fait) · **Bloque** : 003, 006, 011

> **EN summary.** Implement `LiquidsoapEngine`, a dependency-free (`node:net`) telnet client that implements the `AudioEngine` interface (`push`, `queuedSeconds`, `healthy`) against the real Liquidsoap validated in spec 002, plus what the control room needs: current state (current title, active source auto/direct/stream/fallback), next title, `skip`. One persistent connection, strictly serialised commands, per-command and connect timeouts, automatic reconnection with capped exponential backoff, strict command construction (fixed command whitelist, file paths validated so no telnet command or Liquidsoap URI-protocol can be injected), bounded line and response sizes. `queuedSeconds()` is computed on the control side from durations we know, but the list of what is queued is always read from Liquidsoap (source of truth), which also makes restarts of the control plane duplicate-free. If the engine is unreachable, nothing throws into the planner loop or the HTTP server, and the health endpoint reflects it; audio never depends on this client (ADR 0001). No MCP tool here (antenna actions are item 011). No migration. Wired in `src/main.ts` by environment variables; `FakeEngine` stays the default for demos.

## Questions ouvertes

Aucune ne bloque. Voir la section finale.

## 1. Contexte et problème

L'interface `AudioEngine` (`src/engine/engine.ts`) n'a qu'une implémentation, `FakeEngine`. Le planificateur (`src/scheduler/planner.ts`) pousse des morceaux et lit `queuedSeconds()` ; l'API (`src/api/server.ts`) lit `healthy()`. Le harnais `npm run test:engine` (spec 002) a prouvé, avec Liquidsoap v2.4.6 et Icecast : `auto.push <chemin>` renvoie un RID, `auto.queue` liste les RID en attente, `auto.skip` passe au suivant, `request.all` liste tout, le secours joue si la file est vide, le direct (harbor) prend la priorité. Le telnet est publié sur 127.0.0.1 par le compose et n'a **aucune authentification**.

Qui : le planificateur (toutes les quelques dizaines de secondes), l'API de santé, et bientôt l'écran Antenne (006), la détection de silence (003) et le MCP (011). Quand : en continu, 24 h/24. Le risque principal est double : (a) un client qui plante ou se bloque et entraîne le plan de contrôle ; (b) un chemin de fichier venant de la bibliothèque (donc de contenu tiers : tags, noms de fichiers importés) qui injecte une commande telnet ou un protocole Liquidsoap.

## 2. Comportement attendu

### 2.1 Interface

L'interface `AudioEngine` garde ses trois méthodes (contrat inchangé : `push` et `queuedSeconds` rejettent avec une `EngineError` si le moteur est injoignable ; `healthy` ne rejette **jamais**). Une interface étendue `AirEngine extends AudioEngine` ajoute, pour l'antenne :

- `state()` : `{ source: "auto" | "direct" | "stream" | "fallback" | "unknown", current: NowPlaying | null }`, où `NowPlaying` = `{ title, artist, assetId | null, path, startedAt | null }` ;
- `next()` : `NowPlaying | null` (premier élément en attente de la file ; `null` si la file est vide, le prochain morceau de secours étant inconnu par construction) ;
- `queue()` : liste ordonnée des éléments en attente, avec durée connue ou `null` ;
- `skip()` : `{ skipped: boolean }`.

`FakeEngine` implémente aussi `AirEngine` (états simulables) pour les tests et la démo.

`EngineError` : erreur typée avec un code (`unreachable`, `timeout`, `disconnected`, `protocol`, `invalid_input`, `busy`) et un indicateur `maybeApplied` (vrai si la commande a pu être exécutée côté Liquidsoap alors que la réponse n'est pas arrivée).

### 2.2 Connexion

1. Au démarrage du plan de contrôle, **aucune connexion bloquante** : le client est créé, la connexion est ouverte paresseusement (premier appel) ou en tâche de fond. Le démarrage de `main.ts` ne dépend jamais de la disponibilité du moteur.
2. Une seule connexion TCP persistante vers hôte:port, délai de connexion 2 s. Liquidsoap n'envoie pas de bannière ; la connexion est considérée utilisable dès l'ouverture TCP.
3. Si la connexion échoue ou tombe : état `down`, reconnexion automatique avec backoff exponentiel (départ 0,5 s, facteur 2, plafond 15 s, gigue ±20 % ; horloge, minuteries et hasard injectés). Un appel arrivant pendant `down` échoue **immédiatement** (`unreachable`) sans attendre la prochaine tentative ; seule la boucle de reconnexion ouvre le socket (pas de tempête de connexions). Une connexion réussie remet le backoff à zéro.
4. `close()` ferme proprement (`exit`, puis destruction) et arrête les minuteries (indispensable pour que les tests se terminent).

### 2.3 Protocole et sérialisation

- Les commandes sont envoyées **une à la fois** (file FIFO interne) : on envoie la suivante seulement après la réponse complète (ou l'échec) de la précédente. File d'attente interne bornée (64) : au-delà, rejet `busy` immédiat.
- Réponse = lignes jusqu'à une ligne exactement `END` (fin de ligne `\n` ou `\r\n` acceptée). Les lignes sont décodées en UTF-8. `exit` est répondu par `Bye!` puis fermeture.
- Délai d'attente par commande : 3 s (injectable) à partir de l'envoi ; connexion 2 s ; sonde `healthy` 2 s.
- Toute situation douteuse **détruit le socket** (jamais de réutilisation d'une connexion dont la synchronisation est incertaine) : timeout, réponse dépassant 1 Mio ou une ligne dépassant 64 Kio, octets invalides, déconnexion en cours de réponse. Les commandes en attente derrière sont rejetées avec `disconnected` ; la reconnexion suit le §2.2.
- Réponse tronquée (connexion fermée avant `END`) : rejet `disconnected`, `maybeApplied` vrai pour une commande d'écriture (`push`, `skip`), jamais de résultat partiel retourné comme valide.
- Aucune méthode générique « envoyer une ligne brute » n'est exposée. Seules ces commandes existent, construites par le client : push, liste de la file, métadonnées d'une requête, skip, sonde de vie, état d'antenne (voir §2.6).

### 2.4 `push(asset)` et sécurité des chemins

1. Le chemin de l'asset (vu par le plan de contrôle) est traduit en chemin vu par Liquidsoap par une paire de racines configurables (racine médias côté contrôle → racine médias côté moteur ; identité par défaut). Un chemin hors de la racine médias est refusé (`invalid_input`), sans toucher au réseau.
2. Validation **avant** envoi, tout manquement rejette en `invalid_input` sans envoyer quoi que ce soit : chemin absolu commençant par `/` (ce qui exclut tout préfixe de protocole Liquidsoap comme `annotate:`, `process:`, `http:`, `say:`), longueur ≤ 4096 octets UTF-8, aucun caractère de contrôle (U+0000 à U+001F, U+007F, U+0080 à U+009F), ni U+2028/U+2029, pas de `..` comme segment, pas d'espace en tête ou en queue. Les retours chariot, `\n`, NUL sont donc rejetés et non « nettoyés » (on ne modifie pas silencieusement un chemin : un morceau mal nommé est une erreur visible, pas un autre fichier).
3. Les guillemets, espaces internes, accents et `#` au milieu d'un chemin sont **légitimes** et doivent fonctionner : l'argument de `push` est transmis tel quel jusqu'à la fin de ligne (le test e2e prouve qu'un fichier réel dont le nom contient des espaces et un guillemet est joué ; si Liquidsoap v2.4.6 l'interprète mal, le client rejette ces caractères et le comportement est documenté, décision de l'implémenteur justifiée par le test).
4. Réponse attendue : un entier (RID) seul. Autre chose (message d'erreur, texte vide) = `protocol`, et `push` ne renvoie pas de succès. Un fichier inexistant ou corrompu : Liquidsoap répond quand même avec un RID puis retire la requête (spec 002, critère 9) ; le client ne le détecte pas à l'envoi. La conséquence (un trou nul) est couverte par le secours ; la détection est affaire de 003.
5. Le client note en mémoire `RID → { assetId, path, durationS }` (livre de comptes local).
6. **Pas de nouvelle tentative automatique** d'un `push` en cas de `timeout`/`disconnected` (risque de doublon). L'erreur porte `maybeApplied`. Au prochain `queuedSeconds()` la file réelle est relue, donc l'effet éventuel est vu.

### 2.5 `queuedSeconds()` : choix et justification

**Décision : calcul côté contrôle à partir des durées connues, mais sur la liste de requêtes lue chez Liquidsoap (hybride).** Les durées de la bibliothèque sont connues et fiables, alors que le moteur ne donne pas de durée restante fiable pour une requête non encore lue (métadonnée `duration` absente tant que le fichier n'est pas résolu). En revanche, la **liste** des éléments en attente doit venir de Liquidsoap : c'est la seule vérité après un redémarrage de l'un ou l'autre plan.

Algorithme :
1. Lire la file d'attente (RID en attente uniquement : le morceau en cours **n'est pas compté**, conformément au contrat « devant ce qui joue »).
2. Pour chaque RID : durée issue du livre de comptes local ; sinon, lire les métadonnées de la requête, en extraire le chemin du fichier (traduit en chemin côté contrôle), le résoudre en asset via un résolveur injecté (`chemin → Asset | undefined`, branché sur la bibliothèque) et mémoriser ; sinon, **durée inconnue**.
3. Somme des durées connues. Les éléments à durée inconnue comptent 0 s (choix prudent côté antenne : le planificateur poussera un morceau de trop plutôt que de laisser la file se vider) et sont signalés dans `queue()` (`durationS: null`) et dans le journal technique, sans secret.
4. Si le moteur est injoignable : rejet `EngineError` (jamais `0`, qui ferait croire à une file vide et déclencherait un empilement de morceaux au retour du moteur).
5. Le cache RID → asset est invalidé quand la sonde de vie montre que Liquidsoap a redémarré (durée de fonctionnement qui régresse) : les RID repartent de zéro.

Coût : une commande pour la file, plus une par RID encore inconnu (une seule fois par RID). Au plus un appel `queuedSeconds` en cours à la fois (les appels concurrents partagent le même résultat).

### 2.6 État d'antenne : ce que le moteur doit exposer

Le script généré actuel ne permet pas de savoir de façon fiable quelle source est active (`request.on_air` liste aussi les titres du secours). **Le générateur (`src/engine/liquidsoap.ts`) est modifié** pour enregistrer une commande serveur dédiée (nom proposé `pims.state`) qui répond, avant `END`, par des lignes `clé=valeur` : `source` (`direct` si le harbor est prêt, sinon `auto` si la file est prête, sinon `fallback` ; la valeur `stream` est réservée à l'élément 009 et n'est pas émise tant qu'il n'existe pas), `rid` et `filename` du morceau en cours, et la durée de fonctionnement du moteur (pour détecter un redémarrage, §2.5). La syntaxe exacte est à valider avec `--check` et le harnais ; toute valeur renvoyée est traitée par le client comme **donnée non fiable** (validation de la forme, longueur bornée, jamais interprétée).

- `state()` : une commande `pims.state` ; le titre est obtenu en résolvant `filename` via le même résolveur de la bibliothèque (sinon, pour un morceau de secours inconnu : titre = nom de fichier sans extension, `assetId` nul). Source inconnue ou réponse illisible : `unknown`, pas d'exception sauf moteur injoignable.
- `next()` : premier RID de la file, résolu comme en §2.5.
- `skip()` : envoie `auto.skip` **seulement si** `state().source` vaut `auto` ; sinon renvoie `{ skipped: false }` sans commande (passer un titre de secours ou un direct n'est pas l'objet ici ; couper un direct est l'élément 010). Le résultat est consigné par l'appelant (journal d'audit : 011).

### 2.7 `healthy()`

Vrai si une sonde de vie (commande légère `uptime`, délai 2 s) a abouti. Résultat mémorisé 2 s pour que l'API de santé ne martèle pas le moteur ; ne rejette jamais, ne dépasse jamais 2 s. « Sain » signifie « Liquidsoap répond au contrôle », pas « le son sort » (détection de silence : 003).

### 2.8 Planificateur et API quand le moteur est en panne

- `Planner.tick` attrape les `EngineError` venant du moteur et retourne `{ pushed, note: "engine unreachable: ..." }` : il ne lève pas, ne bloque pas plus longtemps que les délais ci-dessus, et ne crée **aucune** ligne `play_log` pour un `push` en échec. La boucle qui l'appelle (hors périmètre) peut donc continuer et réessayer au tick suivant.
- Un `push` à issue incertaine (`maybeApplied`) : le tick s'arrête là pour ce tour ; au tick suivant la file réelle est relue (§2.5), ce qui évite le doublon. Le morceau éventuellement présent sans ligne `play_log` est une limite connue (voir §4).
- `/api/health` renvoie `engine: false` sans erreur HTTP quand le moteur est injoignable, et reste en 200. Il ajoute un champ `engineDetail` : `{ connected: boolean, lastOkAt: string | null, lastError: code | null }` (jamais de message brut contenant des chemins ou des secrets).

### 2.9 Redémarrage du plan de contrôle : pas de doublons

Cas : la file de Liquidsoap contient déjà des titres quand le plan de contrôle démarre (il a été redémarré, mais pas le moteur).
- `queuedSeconds()` lit la file réelle (§2.5) et résout les titres par chemin vers la bibliothèque : le planificateur voit l'avance réelle et **ne repousse pas** ce qui est déjà en file. Aucun état persistant côté contrôle n'est requis pour cela.
- Les titres inconnus de la bibliothèque (chemin non résolu) comptent 0 s ; le planificateur peut en pousser plus, jamais moins. Écart toléré et signalé.
- Les titres en file à ce moment ont déjà une ligne `play_log` (écrite au moment du `push`, prévue à `at`) : pas de ré-insertion. Le planificateur n'insère rien pour des titres qu'il n'a pas poussés.
- Cas inverse : Liquidsoap redémarré, plan de contrôle non redémarré : la file réelle est vide (elle n'est pas persistante), `queuedSeconds()` revient à 0, le planificateur remplit à nouveau ; les lignes `play_log` « fantômes » des titres perdus sont une limite connue, à traiter avec le journal de diffusion (012).

### 2.10 Configuration et branchement (`src/main.ts`)

Variables d'environnement :
- `PIMSRADIO_ENGINE` : `fake` (défaut) ou `liquidsoap` ;
- `PIMSRADIO_LS_HOST` (défaut `127.0.0.1`), `PIMSRADIO_LS_PORT` (défaut `1234`) ;
- `PIMSRADIO_MEDIA_ROOT` (racine côté contrôle) et `PIMSRADIO_LS_MEDIA_ROOT` (même racine vue par le moteur ; défaut = identique).

Valeurs invalides (port non entier ou hors 1-65535, hôte vide, valeur de `PIMSRADIO_ENGINE` inconnue) : arrêt immédiat au démarrage avec un message clair (c'est une erreur de configuration, pas une panne du moteur). Hôte non loopback : avertissement dans le journal (« telnet sans authentification : ne doit jamais traverser un réseau non fiable »), mais accepté, car en compose le plan de contrôle joint le moteur par le nom du service. Sans configuration, `main.ts` se comporte comme aujourd'hui (FakeEngine, démo).

## 3. Critères d'acceptation

### Tests unitaires avec un faux serveur telnet (`node:net`, port éphémère sur 127.0.0.1, sans Docker, dans `npm test`)

Le faux serveur est scriptable : réponses par commande, retards, silence, coupure, envoi par morceaux, octets invalides.

1. **Push nominal.** Given un faux serveur qui répond `7\nEND` à `auto.push /media/a.mp3`, When `push(asset)`, Then le serveur a reçu exactement une ligne `auto.push /media/a.mp3\n` et la promesse se résout ; le RID 7 est associé à l'asset.
2. **Lecture jusqu'à END.** Given une réponse livrée en plusieurs fragments (coupés au milieu d'une ligne, au milieu de `END`, avec `\r\n`), When une commande est lancée, Then la réponse est reconstituée entière et seule la ligne exacte `END` termine ; une ligne contenant `END` dans une phrase ne termine pas.
3. **Sérialisation.** Given 5 appels simultanés, When le serveur compte les commandes reçues, Then il n'en reçoit jamais une avant d'avoir répondu à la précédente, et chaque appelant reçoit sa propre réponse, dans l'ordre.
4. **Borne de file interne.** Given 64 commandes en attente, When la 65e arrive, Then elle est rejetée `busy` immédiatement.
5. **Serveur muet.** Given un serveur qui accepte mais ne répond pas, When une commande est envoyée, Then elle rejette `timeout` à 3 s (horloge injectée), le socket est détruit, la commande suivante en file rejette `disconnected`, et la reconnexion est planifiée.
6. **Réponse tronquée.** Given une connexion fermée avant `END` après une réponse partielle, When `queuedSeconds()`, Then rejet `disconnected` (aucune somme partielle) ; pour `push`, l'erreur porte `maybeApplied = true`.
7. **Déconnexion pendant une commande** : la commande en cours et celles en attente sont rejetées, aucune ne reste pendante, aucune promesse n'est résolue deux fois.
8. **Reconnexion avec backoff.** Given un serveur arrêté, When le client échoue, Then les tentatives ont lieu à 0,5 s, 1 s, 2 s... plafonné à 15 s (±20 %, hasard injecté déterministe) ; When le serveur revient, Then la connexion est rétablie, le backoff est remis à zéro et la commande suivante réussit. Pendant `down`, un appel rejette `unreachable` sans ouvrir de socket.
9. **Pas de tempête.** Given 100 appels pendant `down`, Then 0 connexion supplémentaire est ouverte.
10. **Chemins hostiles.** Given des chemins contenant `\n`, `\r`, `\r\n`, NUL, U+0085, U+2028, `..`, un préfixe `annotate:`/`process:`/`http:`, un chemin relatif, une espace en tête, Then chacun rejette `invalid_input`, et le faux serveur n'a reçu **aucun octet**.
11. **Chemin très long.** Given un chemin de 4097 octets UTF-8 (et un de 1 Mio), Then `invalid_input` sans envoi ; un chemin de 4096 octets est accepté.
12. **Caractères légitimes.** Given des chemins avec espaces internes, guillemets `"`, apostrophes, accents, emoji, `#`, `{`, Then ils sont envoyés tels quels sur une seule ligne terminée par un seul `\n`.
13. **Chemin hors racine.** Given un chemin hors de `PIMSRADIO_MEDIA_ROOT`, Then `invalid_input` ; la traduction de racine est vérifiée (chemin contrôle → chemin moteur).
14. **Réponse hostile.** Given un serveur qui renvoie 2 Mio sans `END`, ou une ligne de 100 Kio, ou des octets UTF-8 invalides, Then `protocol`, socket détruit, mémoire bornée (pas de croissance au-delà des limites).
15. **Réponse de push invalide.** Given `Error: ...\nEND` ou une réponse vide, Then `protocol`, pas de succès, pas d'entrée dans le livre de comptes.
16. **`queuedSeconds`.** Given une file `[3, 4]` dont les deux RID sont dans le livre de comptes (30 s et 45 s), Then 75 s. Given un RID inconnu dont les métadonnées pointent vers un asset connu, Then sa durée est ajoutée et mémorisée (la seconde lecture n'envoie pas de commande de métadonnées). Given un RID non résolu, Then il compte 0 et `queue()` l'indique. Given une file vide, Then 0. Le titre en cours n'est pas compté.
17. **Redémarrage du contrôle sans doublon.** Given un nouveau client (livre de comptes vide) face à un faux serveur dont la file contient 3 RID de chemins connus de la bibliothèque, Then `queuedSeconds()` retourne la somme des 3 durées, et un `Planner.tick` avec une cible inférieure à cette somme ne pousse rien.
18. **Redémarrage du moteur.** Given une durée de fonctionnement qui régresse, Then le cache RID → asset est vidé.
19. **État.** Given des réponses `pims.state` pour `direct`, `auto`, `fallback`, une source inconnue, un morceau de secours inconnu, Then `state()` renvoie la source correcte, le titre résolu ou le nom de fichier, et `unknown` pour toute réponse illisible (sans exception).
20. **Skip.** Given source `auto`, Then `auto.skip` est envoyé et `skipped: true` ; Given source `direct` ou `fallback`, Then aucune commande de skip n'est envoyée, `skipped: false`.
21. **Santé.** Given moteur joignable, `healthy()` vrai ; Given muet, faux en ≤ 2 s ; Given injoignable, faux ; dans tous les cas sans rejet. Deux appels en moins de 2 s n'envoient qu'une sonde.
22. **Planificateur résilient.** Given un moteur dont `queuedSeconds` ou `push` rejettent, Then `Planner.tick` retourne une note sans lever, n'écrit aucune ligne `play_log` pour un push en échec, et un tick suivant (moteur revenu) fonctionne.
23. **API.** Given un moteur injoignable, Then `GET /api/health` répond 200 avec `engine: false` et un `engineDetail` sans chemin ni message brut ; moteur joignable : `engine: true`.
24. **Fermeture.** `close()` termine toutes les minuteries et sockets ; le processus de test se termine sans handle ouvert.
25. **Configuration.** Given des variables absentes, `main.ts` utilise FakeEngine ; Given `PIMSRADIO_ENGINE=liquidsoap` avec port invalide, démarrage refusé avec message ; hôte non loopback : avertissement. La logique de lecture de config est une fonction pure testée sans lancer le serveur.
26. **Générateur.** Given la config de test, Then le script généré contient l'enregistrement de la commande d'état, passe `--check` (test e2e) et le contrôle existant des valeurs hostiles reste vert.

### Test de bout en bout (Docker, dans `npm run test:engine`, nouveaux critères 18 et suivants du harnais, qui utilise désormais le vrai `LiquidsoapEngine` au lieu du `net.Socket` brut)

27. **E2E push et file.** Given la pile de test, When `push` d'un fichier à 880 Hz puis `queuedSeconds()`, Then le RID est numérique, `queuedSeconds()` ≈ durée connue du fichier (tolérance de 1 s), et 880 Hz domine à l'antenne (mesure du harnais).
28. **E2E état.** Given file vide, Then `state().source = fallback` ; Given un titre de la file en cours, Then `auto` avec le bon titre ; Given le direct actif, Then `direct` ; `next()` renvoie le 2e titre poussé.
29. **E2E skip.** Given un long titre en cours, When `skip()`, Then `skipped: true` et la source de son change (cohérent avec le critère 7 de la spec 002).
30. **E2E chemins.** Given un fichier réel dont le nom contient espaces et guillemet : il est joué, ou le client le rejette avec `invalid_input` (§2.4 point 3) ; dans les deux cas Liquidsoap reste `running` et aucun commande injectée n'est exécutée (un chemin `/media/x.mp3\nrequest.all` n'a produit aucun effet).
31. **E2E panne moteur.** Given `docker compose restart liquidsoap` (ou arrêt), Then `healthy()` devient faux en ≤ 5 s, les `push` rejettent sans bloquer, `queuedSeconds()` rejette ; au retour du moteur, `healthy()` redevient vrai en ≤ 20 s sans redémarrer le client, et le flux reste non silencieux (secours) pendant toute la panne du client.
32. **E2E redémarrage du contrôle.** Given 2 titres poussés, When on détruit le client et qu'on en crée un neuf, Then `queuedSeconds()` du neuf client voit les 2 titres (≈ somme des durées) via la bibliothèque injectée, et l'antenne n'a pas été interrompue.
33. **E2E concurrence.** Given deux clients simultanés poussant chacun un fichier, Then les deux RID sont distincts et les deux fichiers sont joués.

## 4. Cas limites

- **Moteur en panne** : §2.2, §2.8, critères 5 à 9, 21 à 23, 31. Jamais de `0` retourné à la place d'une erreur.
- **Base vide** : si la bibliothèque est vide, `push` n'est jamais appelé ; `queue()` résout tout en « inconnu » ; le planificateur note « no music in library » et le secours joue. Un résolveur qui lève une exception est traité comme « non résolu » (jamais d'échec de `queuedSeconds` à cause de la base).
- **Fuseau / heure d'été** : le client n'utilise que des durées relatives et l'horloge injectée ; `startedAt` provient de l'horloge du contrôle (UTC, ISO 8601) et non des horodatages du moteur, dont le fuseau est ambigu. Aucun test ne dépend de l'heure locale.
- **Entrée invalide** : chemins (§2.4), réponses du moteur (§2.3, critères 14 et 15), configuration (§2.10).
- **Flux qui tombe** : un flux externe ou un direct qui tombe n'affecte pas le client ; la source est simplement lue par `state()`. Le basculement de secours des flux est l'élément 009.
- **Concurrence** : sérialisation (critère 3), appels simultanés de `queuedSeconds` fusionnés, deux clients (critère 33). Un `push` et un `skip` concurrents s'exécutent dans l'ordre d'arrivée ; aucune garantie d'atomicité vis-à-vis de l'avancement naturel du moteur (le titre peut avoir changé entre `state()` et `skip()` : `skip` n'est donc pas ciblé par RID dans cet élément ; question 2).
- **Push à issue incertaine** : le morceau peut être en file sans ligne `play_log` (timeout après exécution). Limite connue, minime, signalée au journal technique ; traitée par 012.
- **Doublon de chemin** : le client ne refuse pas deux `push` du même fichier (une répétition peut être voulue) ; l'anti-répétition est du ressort de la rotation.
- **Pic de longueur** : file très longue (centaines de RID) : au plus 1 commande de file + N commandes de métadonnées pour les RID inconnus, étalées (une à la fois) ; la borne de réponse 1 Mio protège. `queuedSeconds()` plafonne le nombre de RID inconnus résolus par appel (50) ; le reste compte 0 jusqu'à l'appel suivant.
- **Ports / hôte** : tous les tests unitaires sur 127.0.0.1, port éphémère.

## 5. Impact fiabilité

L'audio ne dépend pas de ce client : Liquidsoap lit la file, bascule sur le secours si elle est vide et reste sur Icecast que le client soit vivant ou non (ADR 0001, spec 002 critères 12 et 13). Une panne ou un blocage du client équivaut à « plus de nouveau morceau poussé » : la file en cours se vide, puis le secours joue. Pour que même une boucle du client ne puisse pas nuire au plan de contrôle : tous les appels ont un délai maximal, toutes les files internes sont bornées, aucune exception du client ne remonte hors du planificateur ou de l'API (critères 22, 23), la reconnexion ne boucle jamais sans pause. Le client ne contient **aucune** commande capable d'arrêter ou de reconfigurer le moteur (pas de `exit` du moteur, pas de `shutdown`, pas d'exécution de code) : la liste blanche est le dispositif de sécurité. Le script généré gagne une commande de lecture seule (`pims.state`) qui n'altère pas le chemin audio ; son ajout est validé par `--check` et par le test e2e de non-silence.

## 6. Sécurité, vie privée, MCP

- **Telnet sans authentification** : accessible seulement en 127.0.0.1 (compose dev) ou sur le réseau interne du compose. Le client refuse de construire une commande hors liste blanche (§2.3) et les chemins sont validés avant envoi (§2.4) : un fichier au nom piégé (`...\nrequest.all`, `annotate:`, `process:`) ne peut ni lancer une commande telnet ni un protocole de requête Liquidsoap. Rappel : un attaquant qui atteint ce port peut tout faire ; ne jamais le publier ailleurs (à rappeler dans la doc d'exploitation).
- Les chemins et titres venant de la bibliothèque ou des réponses du moteur sont des **données tierces** : jamais interprétés, bornés en longueur, échappés dans les journaux (caractères de contrôle remplacés), jamais renvoyés bruts à l'API santé.
- Aucun secret n'est géré par ce client (pas d'authentification), donc rien à masquer ; les journaux ne contiennent pas de contenu de fichier. Aucune donnée personnelle (les artistes et titres sont déjà dans la bibliothèque).
- Aucune nouvelle dépendance npm.
- **Droits MCP** : **aucun outil MCP n'est créé dans cet élément.** Les actions d'antenne (skip, plus tard insertion, bascule) sont exposées par l'élément 011 avec validation humaine (niveau antenne) ; `state()`, `next()`, `queue()`, `healthy()` sont conçus pour en faire les outils de niveau **lecture** « état du moteur » et « file à venir », et `skip()` un outil de niveau **antenne confirmée**. Ici, aucune de ces méthodes n'est invocable depuis l'extérieur autre que la lecture de `/api/health`.

## 7. Données

Aucune migration, aucune nouvelle table. Le livre de comptes RID → asset est en mémoire et reconstructible (§2.5, §2.9) ; l'unique persistance utile reste `play_log` (existant, inchangé).

## 8. UI

Aucun écran dans cet élément. L'écran Antenne (006) consommera `state()`, `next()` et le champ `engineDetail` ; il définira ses textes. Seul texte nouveau : les messages techniques de journal et d'erreur de démarrage (anglais technique). Documentation d'exploitation FR **et** EN à mettre à jour : variables d'environnement, rappel sur le telnet sans authentification, comportement en cas de panne du moteur, et ajout au guide « Valider le moteur » des nouveaux critères e2e.

## 9. Hors périmètre

- Outils MCP et journal d'audit (011) ; écran Antenne (006) ; détection de silence et alertes (003) ; aircheck (004).
- Entrée direct côté studio et fondu (010) ; flux externes et leur supervision (009) : seule la valeur `stream` de la source est réservée.
- Boucle de planification (minuterie qui appelle `Planner.tick`) et son démarrage dans `main.ts` : non câblée aujourd'hui, hors de cet élément ; la robustesse du `tick` face à un moteur en panne est en revanche dans le périmètre.
- Authentification ou chiffrement du telnet (le moteur n'en a pas ; on le confine au réseau local) ; durcissement du compose (014).
- Insertion de titre en tête de file, suppression ciblée d'un RID, `skip` ciblé par RID (pas de commande générique dans la liste blanche).
- Réécriture de `play_log` après perte de file (012).
- Remplacement du secours vide par un dernier recours audible (003/004).

## Questions ouvertes (non bloquantes)

1. **Commande `pims.state`** : la forme exacte (une commande ou plusieurs, utilisation de la liste des sources prêtes) est à fixer par l'implémenteur avec le harnais, car la syntaxe Liquidsoap v2.4.6 n'a pas pu être exécutée par l'agent de spécification. Alternative si c'est impossible : déduire la source avec `request.on_air` plus l'appartenance du RID à la file ; moins fiable pour `direct`.
2. **`skip` ciblé** : faut-il protéger contre la course (le titre a changé entre l'affichage et le clic) en passant le RID affiché ? Proposé : oui dans 011, avec une commande de comparaison côté client (`skip` seulement si le RID en cours est celui attendu).
3. **Durée des morceaux inconnus** : compter 0 (choix actuel, prudent) ou une durée moyenne de 3 min ? Proposé : 0 tant que 007 (import et durées) n'est pas fait.
4. **Hôte non loopback** : avertissement seul (choix actuel) ou refus sauf `PIMSRADIO_LS_ALLOW_REMOTE=1` ? Proposé : avertissement pour le dev, refus à l'installateur (014).
5. **Titre d'un morceau de secours** : nom de fichier (choix actuel) ou lecture des tags par le moteur ? Proposé : nom de fichier, tags en 007.
