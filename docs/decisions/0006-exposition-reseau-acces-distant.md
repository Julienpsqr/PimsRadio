# 0006 — Modèle d'exposition réseau et d'authentification de l'accès distant
**Date** 2026-11-18 · **Statut** acceptée (décision de Julien, mainteneur)

> EN summary: nothing is exposed to the Internet by default. Remote access is opt-in, through an optional HTTPS reverse proxy (disabled by default) and/or a documented VPN setup. TOTP two-factor authentication is mandatory for administrators as soon as remote access is enabled.

**Décision.**
1. **Par défaut, rien n'est exposé.** L'interface écoute sur 127.0.0.1. Le telnet du moteur, l'administration d'Icecast et le port d'entrée direct (harbor) ne sont jamais publiés hors de la machine ; le harbor ne l'est que si le direct à distance est activé explicitement. Un hôte non loopback est refusé sans variable explicite.
2. **L'accès distant est un choix de chaque radio :** un reverse proxy HTTPS optionnel fourni (type Caddy, licence à vérifier, **désactivé par défaut**) pour les radios qui ont une adresse publique, et un guide de déploiement derrière un VPN pour les autres.
3. **Double authentification TOTP obligatoire pour les administrateurs** dès que l'accès distant est actif, avec codes de récupération et réinitialisation en ligne de commande sur le serveur.
4. Aucun accès distant n'est ouvert tant que l'authentification durcie (comptes et rôles, limitation des essais, sessions sûres, CSRF, journal d'audit) et le TOTP ne sont pas livrés. Les actions sensibles exigent une confirmation renforcée à distance.
5. **L'antenne ne dépend jamais de l'interface ni de l'accès distant** (ADR 0001).

**Raison.** Une interface d'administration exposée peut mener à la prise de contrôle de l'antenne ; le choix par défaut doit être le plus sûr, et l'ouverture doit être un acte volontaire et protégé.

**Conséquences.** Entrées du backlog : 005, 020a à 020f, 014 (l'installateur ne publie rien par défaut). Dépendance éventuelle du proxy : licence à valider (règle 11 de CLAUDE.md).
