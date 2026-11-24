# quiz-runner : QCU générés par un agent, passés dans le navigateur

Un agent (Claude Code, ou tout client MCP) **crée un QCU** (une seule bonne réponse par question), un humain **le passe dans une page web**, puis l'agent **relit les réponses et corrige**.

```
Agent ──create_quiz──────▶ serveur ──▶ URL /q/<id> ──▶ l'humain répond (autosave)
Agent ◀──get_quiz_results── serveur ◀───────────────── réponses, confiance, commentaires, temps
```

Le serveur ne reçoit **jamais les bonnes réponses** : l'agent les garde et fait la correction lui-même. Impossible donc de tricher en lisant le code de la page.

Deux façons de lancer le serveur, sans build ni framework front (JS vanilla dans `public/`) :

- **stdio** (`src/stdio.ts`, recommandé) : c'est le client MCP (Claude Desktop, Claude Code) qui lance le process. Il parle MCP sur stdin/stdout et sert lui-même les pages du quiz sur `http://localhost:3000`. Rien à démarrer à la main.
- **HTTP** (`npm start`) : un process autonome qui sert l'API MCP (`POST /mcp`) et les pages. Utile pour un client MCP distant ou pour développer l'interface.

Les deux modes partagent la même base (`data.db` à la racine du projet). Si le port 3000 est déjà pris par une autre instance quiz-runner (une deuxième conversation, `npm start`…), le process stdio ne sert que le MCP et laisse l'autre afficher les pages ; il reprend le port dès qu'il se libère.

## Installer

Prérequis : Node ≥ 22.18 (le TypeScript s'exécute nativement).

```bash
npm install
```

Le message `ExperimentalWarning: SQLite` dans les logs est normal (module `node:sqlite` intégré à Node).

## Brancher Claude Code

Le fichier `.mcp.json` du dépôt déclare déjà `quiz-runner` en stdio pour Claude Code lancé dans ce dossier. Ailleurs :

```bash
claude mcp add quiz-runner -- node /chemin/vers/template-mcp-webapp/src/stdio.ts
```

## Brancher Claude Desktop (onglet Chat)

Quitte complètement Claude Desktop (⌘Q : l'app réécrit sa config et écraserait la modification), puis depuis le Terminal :

```bash
npm run desktop:install
```

Le script ajoute cette entrée à `~/Library/Application Support/Claude/claude_desktop_config.json` (avec une sauvegarde `.bak`) :

```json
{
  "mcpServers": {
    "quiz-runner": {
      "command": "/chemin/absolu/vers/node",
      "args": ["/chemin/vers/template-mcp-webapp/src/stdio.ts"]
    }
  }
}
```

Rouvre Claude Desktop : il lance quiz-runner tout seul et les outils apparaissent dans le menu des connecteurs d'une conversation. Un « custom connector » (Paramètres › Connecteurs) ne fonctionne pas avec `localhost` : il est appelé depuis le cloud d'Anthropic et exige une URL publique.

## Mode HTTP

```bash
npm start
```

Puis, pour un client MCP en HTTP :

```bash
claude mcp add --transport http quiz-runner http://localhost:3000/mcp
```

Exemple de consigne : *« Génère un QCU de 10 questions sur les bases de Kubernetes avec quiz-runner, 15 minutes, puis corrige-moi quand j'ai fini. »*

## Outils MCP

| Outil | Entrée | Sortie |
|---|---|---|
| `create_quiz` | `run_id` (unique), `name`, `time_limit_minutes?`, `questions[]` : `{ text, choices[] }` (2 à 26 propositions) | `quiz_id`, `run_id`, `url`, `question_count`, `time_limit_minutes`, `status` |
| `get_quiz_results` | `run_id` | `status`, `started_at`, `submitted_at`, `elapsed_seconds`, `overtime_seconds`, `answered_count`, `responses[]` : `{ number, selected, struck, bookmarked, confidence, comment }` |
| `close_quiz` | `run_id` | `status` : la page passe en lecture seule (sans effet si déjà validée) |

Les questions sont numérotées 1..N et les propositions lettrées A, B, C… dans l'ordre d'envoi. `status` vaut `open` (en cours, réponses sauvegardées au fil de l'eau), `submitted` (validé par l'humain) ou `closed` (fermé par l'agent). L'agent lit les résultats par **polling**.

## Interface (en anglais)

- Une question à la fois, grille de navigation (répondu / bookmarké / courante), boutons First / Previous / Next / Last.
- Sélection d'une réponse (re-clic pour désélectionner), **barré** d'une proposition (bouton, clic droit ou Maj+lettre, sans impact sur le résultat).
- **Bookmark**, **niveau de confiance** (Low / Medium / High), **commentaire** par question.
- **Timer** démarré à la première ouverture de la page : temps restant, orange en fin de temps, rouge avec le dépassement une fois le temps écoulé (non bloquant). Sans limite : temps écoulé.
- Chaque action est **sauvegardée immédiatement** (rechargement sans perte, nouvelle tentative en cas d'échec réseau).
- **Submit answers** : récapitulatif des questions sans réponse et bookmarkées, puis verrouillage de la copie.
- Clavier : ← → pour naviguer, A–Z pour répondre.

## Routes web

| Route | Rôle |
|---|---|
| `GET /q/:id` | page du quiz (démarre le timer à la 1re ouverture) |
| `PUT /q/:id/responses/:number` | patch partiel JSON : `selected`, `struck`, `bookmarked`, `confidence`, `comment` |
| `POST /q/:id/submit` | valide la copie (409 si déjà validée ou fermée) |

## Stockage

SQLite utilisé comme magasin de documents : une table `quizzes(id, run_id UNIQUE, doc)`, où `doc` est le JSON complet du quiz (questions + réponses). Chaque modification lit, modifie et réécrit le document dans une transaction.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `HOST` | `127.0.0.1` | Interface d'écoute (`0.0.0.0` pour exposer le serveur) |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base des URL renvoyées à l'agent |
| `DB_PATH` | `<projet>/data.db` | Fichier SQLite (partagé entre les modes stdio et HTTP) |

## Sécurité

**Aucune authentification.** L'ID du quiz (UUID v4) dans l'URL fait office de secret : toute personne qui a l'URL peut voir le quiz et y répondre. Le `run_id` n'est jamais exposé dans une URL. En mode HTTP, `/mcp` est ouvert à quiconque atteint le serveur (le mode stdio n'expose pas de MCP en HTTP). Par défaut le serveur n'écoute que sur `127.0.0.1`, avec la protection DNS rebinding du SDK MCP. Avant d'exposer le serveur (`HOST=0.0.0.0`), ajoute au minimum une authentification sur `/mcp`.

## Structure

```
src/server.ts    point d'entrée HTTP : config, Express, montage des routes et de public/
src/db.ts        stockage document (SQLite) : seule couche d'accès aux données
src/mcp.ts       les 3 outils MCP + handler Streamable HTTP stateless
src/stdio.ts     point d'entrée stdio : MCP sur stdin/stdout + pages du quiz
src/web.ts       page /q/:id et API JSON d'autosave / validation
public/quiz.js   interface du quiz (vanilla JS)
scripts/         installation dans Claude Desktop
public/quiz.css  styles (thème clair / sombre)
test/            test e2e (client MCP du SDK + fetch)
```

## Scripts

- `npm start` : lance le serveur en mode HTTP
- `npm run desktop:install` : déclare quiz-runner dans Claude Desktop (app fermée)
- `npm run dev` : relance automatiquement à chaque modification
- `npm run typecheck` : vérifie les types (`tsc`, sans émission)
- `npm test` : test de bout en bout sur une base temporaire
