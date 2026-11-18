# Piloter Liquidsoap depuis PimsRadio

Le plan de contrôle pousse les morceaux dans Liquidsoap par un client telnet intégré (`LiquidsoapEngine`, spec 001, aucune dépendance npm). **L'audio n'en dépend jamais** : si le client ou le plan de contrôle s'arrête, Liquidsoap joue ce qui est déjà en file, puis le dossier de secours.

## Variables d'environnement
| Variable | Défaut | Rôle |
|---|---|---|
| `PIMSRADIO_ENGINE` | `fake` | `fake` (démo, aucun son) ou `liquidsoap`. Toute autre valeur : démarrage refusé. |
| `PIMSRADIO_LS_HOST` | `127.0.0.1` | Hôte du serveur telnet de Liquidsoap. |
| `PIMSRADIO_LS_PORT` | `1234` | Port telnet (entier 1 à 65535, sinon démarrage refusé). |
| `PIMSRADIO_MEDIA_ROOT` | `/media` | Dossier des médias vu par PimsRadio. |
| `PIMSRADIO_LS_MEDIA_ROOT` | identique | Le même dossier vu par Liquidsoap (volume Docker monté ailleurs). |
| `PIMSRADIO_LS_ALLOW_REMOTE` | absent | `1` pour autoriser un hôte telnet qui n'est pas en boucle locale (voir ci-dessous). |

Sans variable, PimsRadio démarre avec le faux moteur, comme avant. Une valeur invalide arrête le démarrage avec un message clair (erreur de configuration, pas une panne du moteur). Le démarrage ne dépend jamais de la disponibilité de Liquidsoap : la connexion se fait en tâche de fond.

## Telnet sans authentification
Le serveur telnet de Liquidsoap n'a **aucune authentification** : qui l'atteint peut tout faire. PimsRadio **refuse de démarrer** avec un hôte qui n'est pas 127.0.0.1 / ::1 / localhost, sauf si `PIMSRADIO_LS_ALLOW_REMOTE=1` (alors un avertissement est écrit). N'utilisez ce réglage que pour un réseau privé de confiance (par exemple le réseau interne d'un compose, où l'hôte est le nom du service `liquidsoap`) et ne publiez jamais ce port ailleurs que sur 127.0.0.1.

## Ce que fait le client
- Une connexion persistante, une commande à la fois, délai de 3 s par commande, 2 s pour se connecter. Reconnexion automatique (0,5 s, puis 1 s, 2 s... plafonné à 15 s). Pendant une coupure les appels échouent tout de suite, sans bloquer le planificateur.
- Seules les commandes `auto.push`, `auto.queue`, `request.metadata`, `auto.skip`, `uptime` et `pims.state` existent ; aucune ne peut arrêter ou reconfigurer le moteur.
- Les chemins sont validés avant envoi : absolus, sous `PIMSRADIO_MEDIA_ROOT`, sans `..`, sans caractère de contrôle ni saut de ligne, 4096 octets au plus. Un chemin invalide est refusé (jamais « nettoyé »). Espaces, guillemets, accents et `#` au milieu d'un nom sont acceptés.
- Un `push` n'est jamais rejoué automatiquement (risque de doublon). Si la réponse n'arrive pas, l'erreur indique que l'effet est incertain et le tour suivant relit la vraie file.
- `/api/health` reste en 200 et indique `engine: false` plus `engineDetail` (`connected`, `lastOkAt`, `lastError`) quand le moteur ne répond pas. « Sain » veut dire « Liquidsoap répond au contrôle », pas « le son sort ».
- Les morceaux en file qui ne sont pas dans la bibliothèque comptent pour 0 s dans l'avance ; le titre d'un morceau de secours est son nom de fichier.

## La commande `pims.state` (script généré)
Le script généré enregistre une commande en lecture seule, `pims.state`, qui répond par des lignes `clé=valeur` puis `END` : `source` (`direct` si l'entrée studio est prête, sinon `auto` si la file est prête, sinon `fallback`), `rid` et `filename` du morceau en cours (vides en direct), `uptime` (secondes depuis le démarrage du script, sert à détecter un redémarrage). Forme validée avec `--check` et sur Liquidsoap v2.4.6 par `npm run test:engine`. Le nom de fichier a ses sauts de ligne remplacés côté Liquidsoap, et le client ne lit que la première occurrence de chaque clé.

Écarts connus : `skip` n'agit que sur la file (`auto`), pas sur un direct ni sur le secours ; `startedAt` d'un titre est l'heure à laquelle PimsRadio l'a vu pour la première fois à l'antenne.
