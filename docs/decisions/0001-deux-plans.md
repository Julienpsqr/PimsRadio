# 0001 — Deux plans : contrôle et audio
**Date** 2026-11-18 · **Statut** acceptée

**Décision.** Le moteur audio est Liquidsoap (avec Icecast, ffmpeg, ODR pour le DAB+). PimsRadio est le plan de contrôle : bibliothèque, grille, règles, flux, utilisateurs, journal, API et MCP. L'audio ne dépend jamais du plan de contrôle pour continuer à jouer.

**Raison.** Ne pas réécrire un moteur audio éprouvé ; une radio qui se tait est le pire échec ; le moteur doit rester remplaçable derrière une interface `AudioEngine`.

**Conséquences.** Les scripts Liquidsoap sont générés, pas écrits à la main. Le plan de contrôle alimente la file avec 30 à 60 min d'avance. Docker est requis pour déployer.
