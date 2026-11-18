# Backlog

Statuts : `idea` → `accepted` | `rejected` | `escalated` → `specced` → `in-progress` → `in-review` → `done` ; ou `blocked`.
Priorités : P0 stabilité audio · P1 cœur produit · P2 confort · P3 plus tard.

| N° | Titre | Statut | Prio | Notes |
|---|---|---|---|---|
| 001 | Moteur Liquidsoap réel (client telnet, file, état) derrière `AudioEngine` | in-progress | P0 | Validé en bout en bout avec Liquidsoap réel (harnais de l'élément 002, Docker OK) ; client telnet à écrire |
| 002 | Validation du compose et du script Liquidsoap (Icecast + Liquidsoap + secours) | done | P0 | QA PASS (ronde 2), revue APPROVE. Reste à suivre : fiabilité réelle (disque plein, endurance, amd64), job CI nocturne jamais exécuté sur GitHub |
| 003 | Détection de silence et alertes (e-mail / ntfy) | accepted | P0 | Dépend de 001 |
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
