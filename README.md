# Impôts pro — Avis CFE / IFER & taxe foncière

Application dédiée à l'**espace professionnel impots.gouv.fr** pour un cabinet : récupération
automatique des **avis de CFE / IFER** et de **taxe foncière** des clients.

> ⚠️ **Semi-automatique** : à cause du **captcha** d'impots.gouv.fr, la connexion est **manuelle**.
> Une fenêtre de navigateur s'ouvre, **tu te connectes toi-même** (identifiants + captcha) **une fois
> par session**, puis le robot enchaîne tous les clients automatiquement.

## Lancement
1. Double-clic sur **`Démarrer.bat`** → http://localhost:3003
2. Laisser la fenêtre noire ouverte (serveur).

## Première utilisation
1. **Compte espace pro** : ajoute ton compte (e-mail) dans le panneau « Comptes espace pro impôts »
   (le mot de passe est facultatif — la connexion se fait à la main).
2. **Clients** : chaque client est identifié par son **SIREN** (9 chiffres). Tu peux les ajouter
   manuellement, par import CSV, ou via **« ↻ Synchroniser »** (le robot lit « tous mes dossiers »
   après ta connexion).
3. **« Récupérer »** (un client) ou **« Tout récupérer »** : une fenêtre s'ouvre, **tu te connectes**
   (captcha), puis le robot télécharge les avis **CFE + taxe foncière** dans `downloads/<client>/`.

## Fonctions
- Multi-comptes, recherche, tri, pagination, sélection multiple, export CSV, mode nuit.
- **Anti-doublon** : un avis déjà téléchargé (même référence) n'est pas repris.
- Mises à jour automatiques depuis GitHub.

## Parcours technique (connecteur `src/scraper-impots.js`)
`cfspro.impots.gouv.fr` (login manuel) → CONSULTER ▸ Avis CFE → saisie SIREN → CONSULTER →
ADELIE2 `avis_cfe.xhtml` (colonne « Télécharger l'avis ») + `avisTaxeFonciere.xhtml`
(icône PDF « Avis principal ») → téléchargement des PDF.

> Les données (comptes, clients, PDF) restent en local. Le mot de passe éventuel d'un compte est chiffré.
