# Backlog

Statuts : `idea` → `accepted` | `rejected` | `escalated` → `specced` → `in-progress` → `in-review` → `done` ; ou `blocked`.
Priorités : P0 stabilité audio · P1 cœur produit · P2 confort · P3 plus tard.

| N° | Titre | Statut | Prio | Notes |
|---|---|---|---|---|
| 001 | Moteur Liquidsoap réel (client telnet, file, état) derrière `AudioEngine` | in-progress | P0 | Validé en bout en bout avec Liquidsoap réel (harnais de l'élément 002, Docker OK) ; client telnet à écrire |
| 002 | Validation du compose et du script Liquidsoap (Icecast + Liquidsoap + secours) | done | P0 | QA PASS (ronde 2), revue APPROVE. Reste à suivre : fiabilité réelle (disque plein, endurance, amd64), job CI nocturne jamais exécuté sur GitHub |
| 003 | Détection de silence et alertes (e-mail / ntfy) | accepted | P0 | Dépend de 001. Périmètre précisé (2026-11-18) : détection locale silence/flux coupé/secours actif ; canaux e-mail + ntfy (Telegram optionnel) ; anti-spam obligatoire : dédoublonnage (une alerte par incident, message de rétablissement), délai anti-rebond, rappel puis escalade vers un 2e destinataire, accusé de réception ; coordonnées des destinataires stockées côté serveur uniquement, chiffrées ou à accès admin, jamais dans les logs, l'export, les sauvegardes en clair ni les sorties MCP ; secrets SMTP/ntfy hors dépôt ; envoi sortant en tâche isolée (une panne d'envoi n'affecte jamais l'audio) ; dernier recours audible quand le secours est vide (question ouverte de la spec 002) |
| 004 | Enregistrement continu (aircheck) + rétention configurable | accepted | P0 | Dépend de 001/002 ; durée par défaut à vérifier côté réglementation |
| 005 | Authentification locale et rôles (admin, programmateur, animateur, technicien) | accepted | P1 | Sécurité : revue stricte |
| 006 | Écran Antenne (en cours, suivant, voyant EN DIRECT/AUTO/SECOURS) | accepted | P1 | Dépend de 001, 005 ; données de démo possibles |
| 007 | Bibliothèque : import de fichiers, tags, durée, loudness | accepted | P1 | Peut exiger ffprobe (Docker) |
| 008 | Grille hebdomadaire visuelle + publication brouillon/publié | accepted | P1 | |
| 009 | Flux externes : ajout, test, santé, planification, bascule de secours | accepted | P1 | SSRF-safe obligatoire |
| 010 | Entrée direct (harbor) + bascule fondue direct/auto | accepted | P1 | |
| 011 | Serveur MCP (niveaux lecture / brouillon / antenne confirmée) + audit | accepted | P1 | |
| 012 | Journal de diffusion + export de relevé | accepted | P1 | Conformité : à valider avec une vraie radio |
| 013 | Sortie FM/RDS et DAB+ (ODR) | accepted | P2 | Cas typique : livraison IP à l'opérateur ; Docker requis |
| 014 | Installateur `install.sh` + assistant de première configuration | accepted | P1 | |
| 015 | Sauvegarde / restauration (fichier unique) | accepted | P1 | |
| 016 | Internationalisation FR/EN de l'interface | accepted | P1 | À mettre en place dès le premier écran |
| 017 | Supervision et alertes (idée de Julien, 2026-11-18) : scindée en 017a/017b/017c ; le silence et les alertes e-mail/ntfy restent dans 003 | accepted | P0 | Découpage : 003 = détection locale (silence, flux coupé, source de secours active) + canaux e-mail, ntfy, Telegram optionnel + anti-spam. 017a/b/c ci-dessous. Aucun doublon : 017 ne réimplémente rien de 003 |
| 017a | Sonde externe indépendante : petit programme autonome (sans base ni UI PimsRadio) qui écoute le flux public depuis une AUTRE machine et alerte (ntfy/e-mail) sur coupure, silence ou gel | accepted | P1 | Décidé par Julien (2026-11-18) : chaque radio déploie la sonde elle-même (conteneur optionnel sur une autre machine), pas d'offre hébergée. Dans le périmètre (un serveur tombé ne peut pas s'alerter). Livré à part, optionnel, aucune dépendance du moteur audio (ADR 0001), réutilise l'analyseur d'002 et les canaux de 003. Doc : peut aussi tourner chez un bénévole ou un service tiers gratuit. Dépend de 003 |
| 017b | Alertes SMS intégrées (passerelle payante native dans le produit) | rejected | P2 | Décidé par Julien (2026-11-18) : option A, aucun fournisseur SMS intégré ; ntfy, Telegram, e-mail vers la passerelle SMS de l'opérateur (couvert par 003). Rouvrir seulement sur demande. Détail : Sans escalade et déjà couvert par 003 : ntfy (push mobile), Telegram, e-mail vers passerelle SMS de l'opérateur configurée par l'admin (simple adresse SMTP). Escalade seulement pour un fournisseur SMS payant nommé (coût, RGPD, dépendance) |
| 017c | État de l'émetteur FM/DAB+ (porteuse, puissance, SNMP/flux de retour) | escalated | P2 | Voir QUESTIONS.md Q2. Dépend de ce que l'émetteur expose, à clarifier avec la radio pilote ; rattaché à 013 ; ne bloque rien |
