# PimsRadio — plan de conception (v1, 2026-11-18)

> Automation de radio pour **FM, DAB+ et web**, pensée pour les **radios associatives**.
> Projet **indépendant et public** : <https://github.com/Julienpsqr/PimsRadio> — aucune dépendance à la suite PimsWork ni à `pims-kit`.
> Les radios installent l'outil **elles-mêmes, depuis ce dépôt**, le plus simplement possible (§4bis).

## 1. Vision

Une radio associative vit avec des bénévoles qui tournent, peu de technique et zéro budget. Elle a besoin d'un outil qui :

1. **ne coupe jamais** (une radio qui se tait perd ses auditeurs, et le CSA/ARCOM s'en soucie) ;
2. s'installe en une soirée et se comprend en dix minutes ;
3. fait **sortir le même programme** sur FM, DAB+ et web sans trois outils différents ;
4. **s'ouvre** : ajouter un flux (autre radio, programme réseau, direct extérieur) doit être aussi simple que d'ajouter un morceau ;
5. se pilote aussi par **un assistant IA via MCP**, pour qu'un bénévole puisse dire « mets une grille musicale mercredi 14-16 h, 40 % de chanson française » au lieu d'apprendre un logiciel.

Ambition à terme : devenir l'outil de référence des radios associatives (en France d'abord : CRAOL, Radio Campus, radios de la bande FM locale, radios DAB+ locales).

## 2. Ce que fait la concurrence, et où est la place

| Outil | Force | Limite pour une asso |
|---|---|---|
| AzuraCast | web radio clé en main, très populaire, libre | pensé web radio, pas de grille « radio de flux », pas de DAB/RDS, pas de conformité française |
| LibreTime (ex-Airtime) | planification de grille | vieillissant, installation lourde |
| Rivendell / mAirList / RadioDJ | automation de studio complète | Windows ou Linux « à l'ancienne », licences, pas d'IA, pas de web |
| Offres SaaS (type RadioKing) | simples | payantes, web seulement, enfermement |

**Créneau** : *automation complète FM + DAB+ + web*, libre ou auto-hébergeable, **conformité française intégrée**, **IA/MCP natif**, **ouvert aux flux externes**. Aucun concurrent ne coche les cinq.

À vérifier avant de s'engager : maturité actuelle d'AzuraCast sur la planification (ne pas réinventer ce qui existe — voir question Q1).

## 3. Principe d'architecture : deux plans séparés

Ne **pas** réécrire un moteur audio. Le moteur audio fiable existe : **Liquidsoap** (scripting radio, utilisé par de nombreuses radios, gère crossfade, fallback, entrées live, flux, normalisation). PimsRadio est le **cerveau** ; Liquidsoap est les **mains**.

```
                       ┌─────────────────────────── PLAN DE CONTRÔLE (Node, SQLite) ──────────────────────┐
 Bénévoles ─ Web UI ──▶│ Bibliothèque │ Grille │ Règles │ Flux │ Utilisateurs │ Journal │ Alertes      │
 Assistant IA ─ MCP ──▶│            API REST + MCP (mêmes services, mêmes droits)                        │
                       └───────────────┬────────────────────────────────────────────────┬────────────────┘
                          génère la file│(prochains N titres)            métadonnées ▲   │ état / santé
                                        ▼                                            │   ▼
                       ┌─────────────────────────── PLAN AUDIO (Liquidsoap + ffmpeg) ───────────────────┐
                       │ file de lecture ▸ crossfade ▸ loudness R128 ▸ compresseur ▸ priorités :         │
                       │   [1] DIRECT studio  [2] flux externe planifié  [3] file auto  [4] secours      │
                       │ détection de silence · enregistrement continu (aircheck) · reconnexion flux     │
                       └───────┬───────────────────────┬──────────────────────┬─────────────────────────┘
                               ▼                       ▼                      ▼
                        Icecast (web)          Sortie FM                Sortie DAB+
                        MP3/AAC/Opus           carte son / IP→émetteur   ODR-AudioEnc → EDI/ZMQ
                        + ICY metadata         + RDS (PS/RT)             + DLS / slideshow (PAD)
```

**Règle d'or de robustesse** : si le plan de contrôle plante, **le plan audio continue** (il a déjà 30 à 60 min de file en avance et un dossier de secours). Le contrôle est remplaçable à chaud, l'antenne non.

### Pourquoi ce découpage

- **Autonome** : tout est dans ce dépôt (serveur, connexion, sauvegardes, MCP, interface). Dépendances externes minimales et choisies pour durer (voir §9).
- On réutilise ce qui est éprouvé pour l'audio et on investit sur ce qui différencie : grille, règles, conformité, MCP, UX bénévole.
- Le moteur reste échangeable (un jour GStreamer, ou autre) derrière une interface `AudioEngine`.

## 4. Sorties : FM, DAB+, web

Le moteur produit **un seul programme maître** ; les sorties sont des **adaptateurs**.

| Sortie | Réalité terrain | Ce que fait PimsRadio |
|---|---|---|
| **Web** | Icecast | flux MP3/AAC/Opus multi-qualités, métadonnées ICY, page lecteur embarquable, API « now playing » JSON |
| **FM** | l'émetteur est souvent distant (site de tour) | sortie carte son/AES **ou** flux IP vers un codec/émetteur ; envoi RDS (PS, RT, PI/PTY) vers l'encodeur RDS (UDP/série) |
| **DAB+** | en pratique l'asso **livre son audio à l'opérateur du multiplex**, elle n'opère pas le mux | encodage DAB+ (ODR-AudioEnc) avec DLS (texte dynamique) et diaporama (MOT slideshow) ; mode « simple » = flux AAC propre + métadonnées pour l'opérateur ; mode « avancé » = flux EDI/ZMQ pour qui opère son mux |

Les mêmes métadonnées (titre, artiste, émission, pochette, logo) alimentent **les trois** : un seul endroit à renseigner. Support **RadioDNS** envisagé plus tard (liens hybrides radio ↔ web).

> Hypothèse à confirmer avec toi (Q3) : ton cas réel — studio sur place ? émetteur distant ? multiplex tiers ?

## 5. Flux streaming (entrées) — fonction centrale

Un **flux** est une source de première classe, au même rang qu'un dossier de fichiers :

- **Types** : Icecast/Shoutcast (HTTP), HLS, SRT, RTMP audio plus tard ; entrée *live* poussée vers PimsRadio (un animateur se connecte depuis un logiciel type BUTT, ou depuis son navigateur — WebRTC en phase 3).
- **Usages** : relais d'un programme réseau (ex. flux national), reprise d'une autre asso en partage, direct extérieur (concert, reportage), flux de secours.
- **Dans la grille** : un créneau peut être « flux X de 18 h à 19 h » ; au bord du créneau, bascule avec **fondu** ; si le flux tombe, **bascule automatique** vers la file de secours puis retour auto quand il revient.
- **Santé** : sonde continue (reconnexion avec backoff, détection de silence/gel, latence), état visible dans l'UI.
- **Sécurité** : garde SSRF écrite dans le projet (refus des adresses privées/locales, redirections contrôlées), liste d'hôtes autorisés optionnelle, jamais de lecture de `file://` ni d'adresses privées sans accord explicite de l'admin.
- **Droits** : le formulaire d'ajout rappelle que relayer un flux suppose son autorisation ; champ « source / autorisation » conservé dans le journal.

## 6. MCP — l'innovation

Le serveur MCP expose **les mêmes services que l'UI**, avec les mêmes rôles (pas de passe-droit).

**Trois niveaux de risque**, pour qu'une IA ne puisse pas casser l'antenne :

| Niveau | Exemples | Règle |
|---|---|---|
| **Lecture** | `now_playing`, `list_schedule`, `search_library`, `stream_health`, `compliance_report` | libre |
| **Brouillon** | `draft_week_grid`, `propose_playlist`, `suggest_jingle_placement` | écrit en *brouillon*, rien à l'antenne |
| **Antenne** | `publish_grid`, `queue_track`, `switch_to_stream`, `skip` | validation humaine (ou rôle + jeton dédié), journal d'audit, limites de fréquence |

Outils prévus (v0.1) : `now_playing`, `search_library`, `add_to_library` (depuis URL/fichier), `list_streams`, `add_stream`, `test_stream`, `list_schedule`, `draft_schedule_slot`, `publish_schedule`, `queue_track`, `skip_current`, `get_log`, `export_compliance`, `stream_health`.
Ressources : grille de la semaine, charte d'antenne (règles), journal du jour. Prompts : « construis ma grille », « prépare le bilan mensuel ».

**Cas d'usage qui font la différence** :
- « Ajoute le flux de Radio X le dimanche 10-12 h, avec repli sur la playlist Jazz. »
- « Il y a eu un trou hier à 3 h ? » → l'IA lit le journal + les alertes.
- « Prépare le relevé SACEM du mois. »
- Plus tard : voice-tracking (annonces générées en TTS à partir du titre diffusé), transcription et chapitrage des émissions pour les podcasts, résumé quotidien pour la page web.

Le serveur MCP utilise le SDK officiel MCP (transport HTTP avec jeton, et stdio pour un usage local) ; jetons propres à PimsRadio, à durée limitée, liés à un rôle.

## 7. Périmètre du MVP « version basique mais complète » (v0.1)

**Inclus** — de quoi faire tourner une vraie antenne :

1. **Bibliothèque** : dépôt de fichiers (glisser-déposer / dossier surveillé), lecture des tags, **analyse de loudness** à l'import, catégories (musique, jingle, habillage, sponsor/pub, émission, parole), recherche.
2. **Grille hebdomadaire** : créneaux typés — *rotation musicale* (règles), *playlist*, *émission enregistrée (rediffusion)*, *flux externe*, *direct*. Horloge type (jingle toutes les N chansons, pub, météo). Calendrier visuel simple.
3. **Rotation musicale** : séparation artiste/titre, ratios par catégorie (ex. 40 % chanson francophone, nouveautés), jamais deux fois le même titre sous X h.
4. **Moteur Liquidsoap** : file, fondus, normalisation R128, priorités direct > flux > auto > secours, **dossier de secours** toujours prêt.
5. **Direct** : entrée studio (carte son) ou flux poussé par l'animateur ; bouton « passer en direct / rendre l'antenne » avec fondu.
6. **Sorties** : **Icecast (web)** complet ; **FM** (carte son / flux vers émetteur) ; **DAB+** via adaptateur ODR (livraison à l'opérateur + DLS). RDS en mode simple.
7. **Métadonnées** unifiées : ICY, RDS PS/RT, DLS, API JSON « now playing ».
8. **Flux entrants** (§5) : ajout, test, planification, bascule de secours.
9. **Exploitation** : détection de silence, alertes (e-mail, ntfy, Telegram), enregistrement continu *aircheck* (rétention configurable, **90 jours par défaut** — durée à vérifier selon le cadre réglementaire de ta radio), **journal de diffusion** exportable.
10. **Conformité** : export de relevé de diffusion pour SACEM/SPRE, suivi des quotas (ex. chanson francophone) selon la convention de la radio — **à valider avec une radio réelle**.
11. **Utilisateurs & rôles** : admin, programmateur, animateur, technicien ; comptes locaux (mots de passe hachés, limitation des essais), sans service externe.
12. **MCP** (§6) niveaux lecture + brouillon + antenne confirmée.
13. **Sauvegarde / restauration** intégrées (export/import d'un fichier unique : base + réglages) et **installation en une commande** (§4bis).

**Exclu de la v0.1** (voulu, pour livrer) : publicité facturée, multi-radios (multi-tenant), podcasts auto, application mobile, voice-tracking, WebRTC navigateur, opération d'un multiplex DAB complet.

## 4bis. Installation « le plus facile possible » (objectif n°1 du projet public)

Cible : **un bénévole non technicien met en route une radio en moins d'une heure.**

1. **Une seule commande**, sur n'importe quel Linux avec Docker (mini-PC, serveur, VPS) :
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Julienpsqr/PimsRadio/main/install.sh | bash
   ```
   (le script vérifie Docker, télécharge `docker-compose.yml`, génère les secrets, lance tout ; lisible avant exécution, jamais de `sudo` caché.)
2. **Assistant de première configuration dans le navigateur** : nom de la radio, fuseau, compte admin, dossier de musique, sortie web ; FM/DAB+ activables plus tard. Un morceau joue au bout de 5 minutes grâce à un **jeu de démonstration** libre de droits (jingle + quelques titres).
3. **Images Docker publiées** (GitHub Container Registry), versionnées ; mise à jour = `docker compose pull && docker compose up -d` (ou bouton « mettre à jour » + avertissement avant coupure).
4. Options de déploiement documentées : Docker Compose (référence), mini-PC/Raspberry Pi 5 (image arm64), VPS, Portainer/Coolify (compose fourni), puis plus tard un **kit « radio en une soirée »** (image disque préconfigurée).
5. **Docs en français et anglais**, pas-à-pas illustré, vidéo courte, page « dépannage » (pas de son ? flux KO ?), page « matériel conseillé ».
6. Diagnostic intégré : page « santé du système » qui dit en clair ce qui ne va pas et comment le corriger.

## 4ter. Projet public : règles du dépôt

- **Licence** : AGPL-3.0 proposée (même famille que Liquidsoap, Icecast et ODR, qu'on orchestre ; protège contre un SaaS fermé qui reprendrait le code). Alternative : GPL-3.0 (moins contraignante pour qui héberge). À trancher (Q5).
- Aucun secret, aucune adresse privée ni donnée de Julien dans le dépôt ; configuration par variables d'environnement et fichier `.env` généré.
- `README` (présentation + installation 5 lignes), `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY` (signalement de faille), modèles d'issues, `docs/` multilingue.
- **CI GitHub Actions** : tests, lint, construction d'images multi-architecture, publication sur les tags `vX.Y.Z` (versionnage sémantique, changelog).
- **Interface internationalisable dès le départ** (français d'abord, anglais ensuite, fichiers de traduction ouverts aux contributions).
- Rappels juridiques visibles : la radio reste responsable de ses droits de diffusion ; l'outil ne les confère pas.

## 4quater. Design de l'interface (inspiré de PimsWork, copié et non partagé)

On reprend **l'esprit** des apps PimsWork en copiant les *principes* et les *tokens CSS* dans `app/public/` : le projet reste 100 % autonome (pas d'import, pas de sous-module).

- **Gris, coins carrés, sobre** : échelle de gris, aucun `border-radius`, aucun emoji (icônes SVG maison). La couleur n'est jamais seule porteuse d'information ; seules les étiquettes d'état ont une teinte très désaturée (ok / erreur), toujours doublée d'un texte ou d'une icône. Pour une radio : le voyant **EN DIRECT / AUTO / SECOURS** est un bloc de texte lisible de loin, pas juste une couleur.
- **Thèmes clair et sombre** via variables CSS (le sombre est important : studio peu éclairé).
- **Mobile d'abord (320 px)**, barre de navigation en bas sur téléphone, barre latérale sur ordinateur ; cibles tactiles ≥ 44 px, contrastes AA, focus visible, `prefers-reduced-motion`.
- **Facile pour des bénévoles** : peu de bruit, blocs volumineux repliables (état mémorisé), états vides chaleureux qui disent quoi faire, aucune fonction en doublon, vocabulaire de radio plutôt que d'informatique.
- **Écrans principaux** : *Antenne* (en cours, suivant, bouton direct, santé des sorties) · *Grille* (semaine visuelle, glisser-déposer) · *Bibliothèque* · *Flux* · *Journal & conformité* · *Réglages*. Un mode **« plein écran studio »** très lisible pour l'animateur.
- **Textes** dans des fichiers de traduction uniques (français d'abord, anglais ensuite) — jamais en dur dans le code.
- **Règles MCP reprises** : chaque fonction de l'interface a son outil MCP, annoté lecture / écriture / destructif, avec tests ; tout texte venant d'un tiers (nom de flux, métadonnées ICY, titres importés) est traité comme une **donnée, jamais une instruction**, et échappé avant affichage.

## 8. Modèle de données (esquisse)

```
station(id, nom, fuseau, config_sorties)
asset(id, type[musique|jingle|habillage|sponsor|emission|parole], fichier, titre, artiste, album,
      duree, loudness, bpm?, langue, tags, droits, date_ajout)
playlist(id, nom, regles_json) · playlist_item(playlist_id, asset_id, ordre)
stream_source(id, nom, url, type, autorisation, sante, dernier_ok)
slot(id, station_id, jour/horaire ou date, type[rotation|playlist|rediffusion|flux|direct],
     ref_id, repli_ref, priorite, brouillon|publie)
rule(id, scope, definition_json)             -- quotas, séparation, horloge
play_log(ts_debut, ts_fin, asset_id|stream_id, origine[auto|direct|flux|secours], slot_id, utilisateur)
alert(id, ts, niveau, type, detail, acquitte_par)
user(id, role, …)  token_mcp(id, user_id, niveau, expire)  audit(ts, qui, quoi, via[ui|mcp])
```

## 9. Structure du dépôt et pile technique

**Pile** (à confirmer, voir Q10) : Node.js 22 LTS, SQLite (module intégré `node:sqlite`, aucun serveur de base à installer), HTTP natif ou un framework léger unique, SDK MCP officiel, interface web sans étape de compilation lourde (composants légers + CSS propre). Liquidsoap 2.x, Icecast 2.4+/2.5, ffmpeg, ODR-AudioEnc/DabMux en conteneurs. **Pas de `pims-kit`**, pas de dépôt tiers privé.

```
PimsRadio/
  install.sh  docker-compose.yml  .env.example
  LICENSE  README.md  CONTRIBUTING.md  SECURITY.md  CHANGELOG.md
  app/                         (plan de contrôle, un seul paquet Node)
    src/  api/ auth/ scheduler/ library/ streams/ outputs/ compliance/ backup/ mcp/ i18n/
    public/                    (interface web)
    test/
  engine/                      (plan audio : templates .liq, interface AudioEngine)
  docker/                      (Dockerfiles : app, liquidsoap, icecast, odr)
  demo/                        (musique de démonstration libre de droits)
  docs/  PLAN.md  INSTALL.md  ARCHITECTURE.md  MCP.md  fr/  en/
  .github/  workflows/  ISSUE_TEMPLATE/
```

Le **planificateur** tourne en avance (N prochains titres, toutes les minutes) et pousse dans la file Liquidsoap ; il n'est **jamais** dans le chemin critique de la lecture audio.

## 10. Feuille de route

- [ ] **Phase 0 — Cadrage (1 semaine)** : valider ce plan, répondre aux questions (§14), interviewer 2-3 radios associatives, trancher Q1 (construire vs étendre AzuraCast) et la licence ; poser dans le dépôt LICENSE, README, CI de base.
- [ ] **Phase 1 — Tuyau audio (2-3 sem.)** : `docker-compose.yml` Liquidsoap + Icecast + `install.sh` minimal ; lecture d'un dossier avec fondus et R128 ; secours ; sortie web ; `now_playing`. *Critère : tourne 7 jours sans coupure.*
- [ ] **Phase 2 — Cerveau (3-4 sem.)** : bibliothèque, grille, rotation, API, UI, utilisateurs, journal.
- [ ] **Phase 3 — Flux + direct (2 sem.)** : flux entrants, bascule, entrée live, santé, alertes.
- [ ] **Phase 4 — FM/DAB+ (2-3 sem.)** : sortie carte son/IP, RDS, ODR + DLS/slideshow ; essai sur un vrai émetteur / opérateur.
- [ ] **Phase 5 — MCP (1-2 sem.)** : outils lecture/brouillon/antenne, audit, essai avec Claude.
- [ ] **Phase 6 — Conformité, assistant d'installation & pilote (2-4 sem.)** : exports SACEM/ARCOM, aircheck, assistant de première configuration, docs FR/EN, **pilote de 1 mois dans une radio réelle** (installation faite par la radio elle-même, chronométrée).
- [ ] **v0.1 publiée.** Ensuite : podcasts auto, voice-tracking, WebRTC, mobile, multi-radios, place de marché de jingles/habillages, mutualisation entre radios (partage de contenus, programmes réseau).

(Durées indicatives, une personne assistée de Claude Code.)

## 11. Qualité et robustesse

- **Test de survie** : 7 jours continus, coupures simulées (réseau, disque plein, flux tombé, plan de contrôle tué) — l'antenne ne doit jamais être muette plus de quelques secondes.
- **Chaîne de secours à 4 étages** : file auto → playlist de secours → dossier de dernier recours → boucle générique.
- Tests automatisés sur la planification (grille, règles, bascules) avec horloge simulée ; test de bout en bout sur un Icecast réel.
- **Mise à jour sans coupure** : le plan de contrôle se redémarre sans toucher l'audio.
- Sauvegarde nocturne de la base et de la grille ; restauration documentée.

## 12. Modèle de diffusion (pour devenir « incontournable »)

- **Cœur libre et public** (voir §4ter) : adoption, confiance, contributions des radios et de la communauté.
- **Offre hébergée** pour associations (tout-en-un, mises à jour, supervision) et **support/formation** : revenu simple et honnête.
- **Effet réseau** : partage de jingles, habillages et programmes entre radios, catalogue d'émissions mutualisé, flux de secours communs.
- **Canaux** : fédérations (CRAOL, Radio Campus…), forums de radios libres, démonstrations en festival/ateliers.
- **Documentation en français**, vidéo d'installation de 10 minutes, kit « radio en une soirée » (mini-PC préconfiguré).

## 13. Risques

| Risque | Parade |
|---|---|
| Fiabilité 24/7 | deux plans séparés, secours, test de survie |
| Droits (SACEM/SPRE, flux relayés) | journal + exports, rappel des autorisations, pas d'avis juridique : à faire valider |
| DAB+ très variable selon opérateur | adaptateur simple d'abord, avancé ensuite ; pilote avec un opérateur réel |
| Surface d'attaque (flux publics, MCP) | garde SSRF du kit, niveaux MCP, audit, jetons à durée limitée |
| Dépendance à Liquidsoap | interface `AudioEngine`, scripts générés (pas écrits à la main) |
| Seul·e à porter le projet public | rester petit, documenté, contributions bienvenues, pilote précoce |
| Installation trop dure pour des bénévoles | §4bis : une commande, assistant navigateur, test chronométré avec une vraie radio |
| Failles dans un outil exposé sur Internet | auth solide, mises à jour faciles, `SECURITY.md`, ports minimaux, HTTPS recommandé (reverse proxy fourni) |

## 14. Questions ouvertes

- ~~**Q1.**~~ **Décidé le 2026-11-18** : de zéro, sur Liquidsoap (pas d'extension d'AzuraCast).
- ~~**Q2.** Nom~~ : **PimsRadio**, dépôt public indépendant (décidé le 2026-11-18).
- **Q3.** Ton terrain : une radio précise en tête ? Studio sur place ? Émetteur FM distant ? DAB+ via multiplex tiers ? (détermine l'ordre des sorties)
- **Q4.** Matériel de référence pour les radios : mini-PC Linux, Raspberry Pi, VPS ? (impacte images arm64 et docs)
- ~~**Q5.**~~ **Décidé le 2026-11-18** : licence **AGPL-3.0**.
- **Q6.** IA : MCP seulement, ou aussi des fonctions IA intégrées (TTS, transcription) avec quels fournisseurs ? (coût, souveraineté)
- **Q7.** Un seul studio/une station par installation en v0.1 (recommandé), ou multi-radios dès le début ?
- **Q8.** Qui valide la conformité réglementaire (quotas, conservation, déclarations) pour ta radio cible ?
- **Q9.** Langues de l'interface : français seul en v0.1, anglais tout de suite après ?
- ~~**Q10.**~~ **Décidé le 2026-11-18** : Node.js + TypeScript (voir `docs/decisions/0002`).

## 15. Prochaines actions proposées

1. Tu réponds à Q1, Q3, Q5, Q10 (même brièvement).
2. Je pose les fondations du dépôt (LICENSE, README, CI) puis **la Phase 1 : le tuyau audio** — c'est le plus risqué, donc le premier à prouver.
3. En parallèle, tu contactes 1-2 radios associatives pour un pilote et des retours d'usage.
