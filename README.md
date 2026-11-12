# Ask Human : template web app + serveur MCP

Template minimal pour qu'un agent (Claude Code, ou tout client MCP) **pose une question à un humain** et récupère ses réponses.

```
Agent ──ask_question──▶ serveur ──▶ URL /s/<id> ──▶ humain répond dans le navigateur
Agent ◀──get_answers─── serveur ◀──────────────────── réponses stockées (SQLite)
```

Un seul process Node sert à la fois l'API MCP (`POST /mcp`) et les pages web (`/s/:id`). Pas de build, pas de framework front.

## Démarrer

Prérequis : Node ≥ 22.18 (le TypeScript s'exécute nativement).

```bash
npm install
```

```bash
npm start
```

Le serveur écoute sur `http://localhost:3000`. Le message `ExperimentalWarning: SQLite` au démarrage est normal (module `node:sqlite` intégré à Node).

## Brancher Claude Code

Le fichier `.mcp.json` du dépôt déclare déjà le serveur pour Claude Code lancé dans ce dossier. Ailleurs :

```bash
claude mcp add --transport http ask-human http://localhost:3000/mcp
```

Exemple de consigne à l'agent : *« Demande à l'utilisateur via ask-human quelle base de données utiliser, puis attends sa réponse. »*

## Outils MCP

| Outil | Entrée | Sortie |
|---|---|---|
| `ask_question` | `question` (texte, 1 à 2 000 car.) | `session_id`, `url`, `status` |
| `get_answers` | `session_id` | `question`, `status`, `answers[]` (`id`, `text`, `created_at`) |
| `close_session` | `session_id` | `status: "closed"` : la page n'accepte plus de réponses |

L'agent lit les réponses par **polling** (`get_answers`), sans notification. Une session reçoit autant de réponses anonymes qu'on veut tant qu'elle est ouverte.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `HOST` | `127.0.0.1` | Interface d'écoute (`0.0.0.0` pour exposer le serveur) |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base des URL renvoyées à l'agent |
| `DB_PATH` | `./data.db` | Fichier SQLite |

## Sécurité

**Aucune authentification.** L'ID de session (UUID v4) fait office de secret : toute personne qui a l'URL peut lire la question et répondre. `/mcp` est ouvert à quiconque atteint le serveur. Par défaut le serveur n'écoute que sur `127.0.0.1`, avec la protection DNS rebinding du SDK MCP. Avant d'exposer le serveur (`HOST=0.0.0.0`), ajoute au minimum une authentification sur `/mcp`.

## Structure

```
src/server.ts   point d'entrée : config, Express, montage des routes
src/db.ts       SQLite (sessions, answers) : seule couche d'accès aux données
src/mcp.ts      les 3 outils MCP + handler Streamable HTTP stateless
src/web.ts      page /s/:id et formulaire de réponse (HTML rendu serveur)
test/           test e2e (client MCP du SDK + fetch)
```

## Scripts

- `npm start` : lance le serveur
- `npm run dev` : relance automatiquement à chaque modification
- `npm run typecheck` : vérifie les types (`tsc`, sans émission)
- `npm test` : test de bout en bout sur une base temporaire
