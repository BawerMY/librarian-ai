# LibrarianAI

Ask your own books what you half-remember reading.

**[librarian.bawer-my.com](https://librarian.bawer-my.com)**

You build a shelf — public-domain titles in one click, your own copies by upload (EPUB or plain text; PDF isn't supported yet) — and then ask questions in plain language: *"where did I read that you can retreat into yourself rather than seeking out country villages?"* The answer comes back with chips you can click to open the exact passage it came from, with book, chapter and position.

## Grounded, not recalled

The model never answers from memory. It searches your library first, and every claim it makes carries a marker pointing at a passage it was actually given. Markers that resolve to nothing are stripped before you see them, so a chip is always something you can check. Ask about a book you don't own and it says so instead of inventing an answer.

Scope is enforced server-side, per user, on every search — your uploads are yours alone.

## How it works

Books are parsed, chunked and embedded locally with `bge-large` via Ollama; vectors live in Qdrant, everything else in Postgres. A separate worker process handles ingestion, so a 900KB EPUB never occupies a request. Chat runs through the AI SDK with retrieval as a tool, streaming an answer the server finishes writing even if you close the tab.

Next.js · Postgres + Drizzle · Qdrant · Ollama · OpenRouter · Auth.js

## Running it

```bash
pnpm install
cp .env.example .env.local      # Postgres, Qdrant, Ollama, OpenRouter, AUTH_SECRET
pnpm db:migrate
pnpm qdrant:bootstrap
pnpm dev                        # app
pnpm worker                     # ingestion, in a second terminal
```

Both processes are needed: the app serves and the worker indexes.

| | |
|---|---|
| `pnpm verify:chat` | grounding — searches before answering, citations resolve, refuses when it should |
| `pnpm verify:isolation` | one user cannot read another's books |
| `pnpm verify:index` | Qdrant and Postgres agree |
| `pnpm verify:limits` | upload and context limits hold |
