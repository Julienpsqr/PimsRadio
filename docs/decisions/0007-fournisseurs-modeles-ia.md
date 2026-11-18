# 0007 — Fournisseurs de modèles d'IA et protection des données
**Date** 2026-11-18 · **Statut** acceptée (décisions de Julien, mainteneur)

> EN summary: PimsRadio can call several AI model providers through a minimal `ModelProvider` interface (OpenAI-compatible adapter first, which also covers OpenRouter and local servers; native Anthropic adapter later if needed). No online AI is active by default, nothing is sent without explicit admin consent, and a low monthly cost cap applies. The audio path never depends on a model.

**Décision.**
1. **Interface minimale `ModelProvider`** avec un premier adaptateur « compatible OpenAI » (OpenAI, OpenRouter, et les serveurs locaux type Ollama ou LM Studio qui parlent ce protocole), écrit avec le `fetch` natif de Node, sans SDK tiers. Adaptateur Anthropic natif plus tard, si le besoin est constaté.
2. **Premières fonctions : aide en brouillon uniquement** (aide à la grille, résumés, suggestions de métadonnées). Jamais à l'antenne, aucune donnée personnelle. Assistant dans l'interface, voice-tracking et transcription : hors première version.
3. **Services en ligne d'abord.** Le modèle local fonctionne grâce à l'adaptateur compatible OpenAI (URL locale déclarée par l'admin) mais n'est pas une priorité de test ni de documentation en v1 ; l'option « modèle local uniquement » viendra avec la politique de données.
4. **Rien ne part sans accord explicite.** Aucune IA en ligne active par défaut ; l'admin saisit la clé, voit la liste de ce qui sera envoyé (titres et métadonnées de bibliothèque ; jamais d'adresses d'auditeurs, de coordonnées ni d'identifiants) et confirme.
5. **Plafond de coût bas par défaut**, réglable par l'admin, compteur d'usage visible, blocage automatique au dépassement, limites de débit.
6. **Clés d'API** chiffrées au repos, saisies par l'admin seul, jamais dans les logs, erreurs, exports, sauvegardes en clair ni sorties MCP ; rotation possible.
7. **Sécurité :** tout texte tiers (métadonnées de flux, noms de flux, étiquettes de fichiers) est une donnée délimitée, jamais une instruction ; sortie du modèle validée par schéma ; le modèle n'agit qu'avec les mêmes services, rôles et confirmations que le MCP ; aucun appel de modèle dans le planificateur ni le chemin audio ; SSRF : URL publique par défaut, adresses privées seulement pour un fournisseur marqué « local » par l'admin.
8. **Licences :** aucune SDK ni code tiers sans validation (règle 11 de CLAUDE.md) ; jamais de poids de modèle embarqués.

**Raison.** Les radios associatives ont peu de budget et des contraintes de vie privée ; l'IA doit rester optionnelle, sûre par défaut et sans conséquence sur l'antenne.

**Conséquences.** Entrées du backlog : 021a à 021e. Distinct du MCP (011).
