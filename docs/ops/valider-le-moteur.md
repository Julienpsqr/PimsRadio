# Valider le moteur

`npm run test:engine` démarre Icecast et Liquidsoap dans Docker avec le script **généré** par PimsRadio, joue des sons de test synthétiques (sinusoïdes de 440, 880 et 1320 Hz produites par Liquidsoap lui-même, aucun téléchargement) et mesure ce qui sort réellement du flux. C'est distinct de `npm test` (rapide, sans Docker).

## Prérequis
- Docker (OrbStack, Docker Desktop ou Linux) joignable ; ffmpeg n'est **pas** nécessaire sur la machine.
- Ports libres sur 127.0.0.1 : 18000 (Icecast), 18005 (harbor), 11234 (telnet). Ils sont volontairement différents de ceux du compose de développement (8000, 8005, 1234).
- Durée : environ 5 minutes (hors téléchargement initial des images), limite globale de 8 minutes.

## Lancer
```
npm run test:engine
```
Codes de sortie : 0 tout est OK, 1 au moins un critère KO, 2 problème d'environnement (Docker absent, port occupé, autre exécution en cours).

## Lire le résumé
Une ligne par critère (1 à 15 : spec 002 ; 16 à 22 : spec 001, le vrai client `LiquidsoapEngine`) : `[OK]` / `[KO]`, le nom, les valeurs mesurées (par exemple `440 Hz in [3,10]s: 14/14 windows`) et le temps écoulé. Une fenêtre fait 500 ms ; elle est silencieuse sous -50 dBFS ; une fréquence est dominante si son énergie vaut au moins 10 fois celle des deux autres. Le script s'arrête et nettoie toujours (conteneurs, réseau, volumes, dossier temporaire), même en cas d'échec ou de Ctrl-C ; le critère 14 le vérifie.

Les mots de passe sont générés à chaque exécution (préfixe `test-`) et masqués dans toute sortie.

## Critères du client (spec 001)
16 push et file (`queuedSeconds` proche de la durée du titre en attente) ; 17 état (`fallback`, `auto` avec le bon titre, `direct`) et `next()` ; 18 `skip` ; 19 chemins (injections refusées sans effet, nom avec espaces et guillemets) ; 20 panne du moteur (`healthy()` faux en 5 s, `push` et `queuedSeconds` rejettent sans bloquer, retour en 20 s sans recréer le client) ; 21 redémarrage du plan de contrôle (un client neuf revoit la file via la bibliothèque, l'antenne n'est pas coupée) ; 22 deux clients simultanés. Le détail de la commande `pims.state` est dans `docs/ops/moteur-liquidsoap.md`.

## Si un critère est KO
1. Relire la ligne : la valeur mesurée dit ce qui s'est passé (mauvaise source, trou de silence, délai dépassé).
2. Les journaux Icecast et Liquidsoap sont affichés automatiquement en cas d'échec (mots de passe masqués).
3. Critère 1 (script invalide) : exécuter `npm run gen-engine` puis `docker run --rm -v "$PWD/engine/generated:/e:ro" savonet/liquidsoap:v2.4.6 --check /e/radio.liq`.
4. Un échec ne doit venir que d'un dépassement net des tolérances ; ne pas relancer en boucle, corriger le générateur (`src/engine/liquidsoap.ts`).

## Comportements mesurés à connaître
- Commandes telnet : `auto.push <chemin>` (renvoie le RID), `auto.queue` (liste uniquement les requêtes **en attente** : un fichier déjà en lecture n'y figure plus), `request.all` (toutes les requêtes), `auto.skip`, `request.metadata <rid>` (`initial_uri` = chemin d'origine), `uptime`, et `pims.state` (script généré). Chaque réponse se termine par une ligne `END`. Une commande inconnue répond `ERROR: unknown command`.
- **Sécurité du telnet** : dans le conteneur, le serveur telnet de Liquidsoap écoute sur 0.0.0.0 (nécessaire pour que Docker publie le port). Il n'a **aucune authentification** : sa seule protection est la publication sur 127.0.0.1 dans le compose. Ne jamais publier ce port sur une autre adresse (ni `0.0.0.0:`, ni une IP du réseau).
- La priorité est direct > file > secours ; le passage est immédiat (`track_sensitive=false`).
- Le pré-tampon harbor est réduit à 2 s (le défaut de 12 s retardait la bascule de plus de 10 s).
- Icecast redémarré : Liquidsoap se reconnecte seul. Liquidsoap redémarré : le flux revient depuis le secours en quelques secondes.
- **Limite documentée** : si le dossier de secours est vide et la file vide, le flux reste connecté mais le silence est attendu (`mksafe`). Garder toujours au moins un fichier dans `media/fallback`.
