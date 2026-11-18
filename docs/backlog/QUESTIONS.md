# Questions pour Julien

## Q1 (017b) Alertes SMS : intégrer un fournisseur payant ?
Un SMS passe par un service externe : coût à la charge de la radio, numéros de téléphone = données personnelles (RGPD), dépendance à un tiers.
- Option A (recommandée) : ne pas intégrer de fournisseur ; proposer ntfy (push), Telegram et e-mail vers la passerelle SMS de l'opérateur (adresse SMTP libre). Zéro dépendance, zéro coût côté projet.
- Option B : un connecteur SMS générique par webhook HTTP configuré par l'admin (le fournisseur est au choix de la radio, rien d'intégré) ; SSRF-safe, secret hors dépôt.
- Option C : fournisseur nommé intégré. Déconseillé (coût, RGPD, couplage).
Question : A, B ou C ?
**Réponse de Julien (2026-11-18) : A.** Aucun fournisseur SMS intégré.

## Q2 (017c) État de l'émetteur FM/DAB+
Que peut-on lire sur l'émetteur de la radio pilote ? (SNMP, interface web, contact sec, flux de retour/monitoring d'un récepteur, rien.) Sans cette réponse on ne conçoit rien. Option : reporter après 013 ; ou se limiter à un récepteur de contrôle (le flux public de 017a joue ce rôle pour le web seulement). Question : quelle radio pilote, quel émetteur, quelle interface ?

## Q4 (018b) Exports de déclaration aux sociétés de droits
Rien ci-dessous n'est supposé : sociétés concernées, formats, obligations et barèmes sont à vérifier auprès des sociétés et de la radio pilote.
- Quelle est la radio pilote (FM, DAB+, web, catégorie) et quelles sociétés de gestion des droits paie-t-elle ?
- Peux-tu obtenir un exemple de déclaration réelle (anonymisé) et la spécification officielle de chaque société, avec ses conditions de réutilisation (licence) ?
- Qui, à la radio, fait la déclaration aujourd'hui et sur quelles données (journal, playlists d'animateurs, décompte forfaitaire) ?
- Les titres de direct doivent-ils figurer dans la déclaration ? Saisie manuelle acceptable ?
Options : A (recommandée) livrer 012 + 018a maintenant (export générique CSV/JSON, rapport de complétude) et ne développer un exporteur de société qu'avec format officiel + pilote ; B exporteur « best effort » sans spécification (rejeté : risque de fausse déclaration) ; C reporter 018b après la phase pilote.
Question : A ou C, et peux-tu obtenir les documents ci-dessus ?

## Q3 (017a) Sonde externe : où l'héberger ?
Doit tourner hors de la machine de la radio. Option : documenter un déploiement sur un petit VPS/Raspberry d'un bénévole, ou un service de supervision gratuit tiers en simple complément. Veux-tu aussi une offre hébergée (cf. PLAN, offre associations) ?
**Réponse de Julien (2026-11-18) : chaque radio déploie la sonde elle-même.** Pas d'offre hébergée pour l'instant.

## Q5 (019) Sources de musique externes : lesquelles utilisent vraiment tes radios ?
Principe retenu (validateur) : le moteur ne lit que le disque local ; toute source externe est importée puis copiée dans un cache borné (019b) avant diffusion. V1 = dossier monté par le système (NAS NFS/SMB), 019a.
- Quels stockages utilisent aujourd'hui les radios : NAS local (NFS/SMB), Nextcloud/WebDAV, cloud (S3, Google Drive, Dropbox), serveur de bibliothèque musicale en ligne (Subsonic/Navidrome/Plex...), disque USB, autre ?
- Les fichiers sont-ils sous contrat/licence propre à la radio, ou fournis par un service tiers (pool de promo, webradio de musique libre) ? Quelle provenance/autorisation faut-il conserver par source ?
- Le serveur est-il sur le réseau local de la radio (adresse privée, donc SSRF-sensible) ou sur Internet ?
- Taille de la musique à garder en copie locale (pour dimensionner le cache) ?
Options : A (recommandée) livrer 019a + 019b seuls (dossier monté + cache) ; l'accès Nextcloud/S3/Drive se fait par un montage externe (rclone, davfs) hors PimsRadio. B ajouter ensuite un connecteur natif WebDAV (019c) si Nextcloud est répandu. C connecteurs multiples natifs (déconseillé : dépendances, secrets, SSRF).
Question : A ou B, et quels serveurs réels ?

## Réponses en attente (2026-11-18)
Julien n'a pas encore les informations pour Q2 (état de l'émetteur) ni Q4 (déclarations de droits). Ces deux idées (017c, 018b) sont **mises en attente** dans le backlog (statut `blocked`) et reprises quand une radio pilote pourra fournir : la liste des sociétés payées, un exemple de déclaration réelle anonymisé avec la spécification officielle, et ce que son émetteur expose.
