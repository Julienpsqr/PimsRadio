# Feuille de route / Roadmap

> **EN summary.** PimsRadio is built in milestones, audio reliability first. J0 foundations (done) → J1 reliable on-air chain → J2 control basics (accounts, library) → J3 interface → J4 live, streams, MCP → J5 installable beta (**v0.1 beta**: a complete web radio) → J6 stability proof (7-day soak test, one-month pilot = **v0.1 stable**) → later: FM/DAB+, remote access, AI. Durations are rough estimates. Details and status of each item: [docs/backlog/BACKLOG.md](backlog/BACKLOG.md).

Dernière mise à jour : 2026-11-18. Les numéros renvoient au [backlog](backlog/BACKLOG.md). Les durées sont **indicatives** (une personne assistée d'agents, boucle de développement régulière) ; ce qui dépend d'une vraie radio ou d'un test de plusieurs jours ne se compresse pas.

## J0 — Fondations · terminé
Dépôt public, licence AGPL-3.0, CI, garde-fous de licences, équipe d'agents, maquette, décisions d'architecture 0001 à 0007, socle du plan de contrôle (base, bibliothèque, grille, rotation, planificateur, API de santé).
- **002** Chaîne audio prouvée avec du vrai son (Liquidsoap + Icecast) : fait.
- **001** Client du moteur : validé par la QA et la revue, test de panne et fusion en cours.

## J1 — Une antenne fiable · P0 · ≈ 1 à 2 semaines
Objectif : une radio qui joue seule et qui prévient quand elle va mal.
- **022** Câblage du planificateur au démarrage.
- **003** Détection de silence et alertes (e-mail, ntfy, Telegram optionnel), anti-spam.
- **004** Enregistrement continu (aircheck) et rétention configurable.
- **Critère de sortie :** 24 h sans coupure en conditions simulées, une panne simulée déclenche une alerte reçue.

## J2 — Les bases du contrôle · ≈ 2 semaines
Objectif : savoir qui fait quoi et avoir de la musique à diffuser.
- **005 + 020a** Comptes, rôles, authentification durcie (mots de passe hachés, essais limités, sessions sûres, CSRF, journal d'audit).
- **020b** Exposition minimale (rien d'ouvert à Internet par défaut).
- **016** Interface FR/EN (fondation, avant le premier écran).
- **007** Import de la bibliothèque (étiquettes, durée, niveau sonore), **018a** métadonnées de droits.
- **019a + 019b** Dossier réseau monté et cache local (un serveur distant en panne ne coupe jamais l'antenne).

## J3 — L'interface · ≈ 2 à 3 semaines
Objectif : une radio pilotable par des bénévoles dans un navigateur, sur téléphone.
- **006** Écran Antenne. **008** Grille hebdomadaire, brouillon/publié. **012** Journal de diffusion fiable (ce qui a été réellement diffusé) et export CSV/JSON.
- Les écrans suivent la maquette et le design de [docs/design/maquette.html](design/maquette.html). Vraies captures dans le README à chaque écran.

## J4 — Direct, flux et assistant · ≈ 2 semaines
- **010** Entrée direct et bascule fondue. **009** Flux externes (ajout, test, santé, repli).
- **011** Serveur MCP (lecture, brouillon, antenne avec validation humaine, journal d'audit).
- **017a** Sonde externe indépendante (optionnelle, déployée par chaque radio).

## J5 — Installable · **v0.1 bêta** · ≈ 1 à 2 semaines
Objectif : une radio web complète qu'une association installe elle-même.
- **014** Installateur en une commande et assistant de première configuration. **015** Sauvegarde/restauration. Documentation FR/EN, `SECURITY.md`, référencement du dépôt.
- **Critère de sortie :** une personne non technicienne installe et fait jouer une radio en moins d'une heure.

## J6 — Preuve de stabilité · **v0.1 stable** · ≈ 1 à 2 mois de calendrier
- Test de survie de **7 jours** sans coupure (pannes réseau, disque, flux, redémarrages) : ne se raccourcit pas.
- **Pilote d'un mois** dans une vraie radio, installation faite par la radio, avec retours terrain.

## Après la v0.1 (ordre indicatif)
1. **013** Sorties FM/RDS et DAB+ : dépend d'une radio pilote (émetteur, opérateur de multiplex).
2. **020c–020f** Accès distant (proxy HTTPS optionnel, VPN documenté, double authentification obligatoire pour les admins, confirmations renforcées) : ADR 0006.
3. **019c** Connecteurs WebDAV, S3, HTTP.
4. **021a–e** Fonctions d'IA en brouillon, fournisseurs interchangeables : ADR 0007.
5. En attente d'informations d'une radio pilote : **017c** état de l'émetteur, **018b** exporteurs de déclarations de droits par société.
6. Podcasts, multi-radios, WebRTC dans le navigateur, mobile.

## Règle de priorité
Stabilité de l'antenne d'abord, puis simplicité d'installation, puis le reste. Toute idée nouvelle passe par le backlog et le validateur avant d'entrer dans un jalon ; elle ne retarde pas J1 à J5 sauf décision explicite du mainteneur.
