# Third-party notices / Mentions de tiers

PimsRadio is AGPL-3.0-or-later. / PimsRadio est sous AGPL-3.0-or-later.

## Development dependencies / Dépendances de développement
(versions from package-lock.json)

| Package | Version | License |
|---|---|---|
| typescript | 5.9.3 | Apache-2.0 |
| @types/node | 22.20.5 | MIT |
| undici-types | 6.21.0 | MIT |

## External components (separate containers, not linked) / Composants externes (conteneurs séparés, non liés)
Images pinned in `deploy/docker-compose.dev.yml`. / Images épinglées dans `deploy/docker-compose.dev.yml`.

| Component | Image | License |
|---|---|---|
| Liquidsoap | savonet/liquidsoap:v2.4.6 | GPL (exact version: to verify / à vérifier) |
| Icecast | libretime/icecast:2.4.4 | GPL-2.0 (exact terms: to verify / à vérifier) |

## Update rule / Règle de mise à jour
EN: any new dependency, bundled asset or external component, or any code reused under a compatible license, is added here in the same commit (name, version, license, author notice). `npm run check:licenses` must pass.

FR : toute nouvelle dépendance, tout asset embarqué ou composant externe, et tout code réutilisé sous licence compatible, est ajouté ici dans le même commit (nom, version, licence, avis d'auteur). `npm run check:licenses` doit passer.
