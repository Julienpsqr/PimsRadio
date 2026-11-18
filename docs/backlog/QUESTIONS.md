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

## Q3 (017a) Sonde externe : où l'héberger ?
Doit tourner hors de la machine de la radio. Option : documenter un déploiement sur un petit VPS/Raspberry d'un bénévole, ou un service de supervision gratuit tiers en simple complément. Veux-tu aussi une offre hébergée (cf. PLAN, offre associations) ?
**Réponse de Julien (2026-11-18) : chaque radio déploie la sonde elle-même.** Pas d'offre hébergée pour l'instant.
