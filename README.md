# notion-workers

A collection of [Notion Workers](https://developers.notion.com) — small Node/TypeScript
programs hosted by Notion that add Tools, Syncs, or Webhooks to a Notion workspace.

Each subdirectory is a self-contained worker built from the `@notionhq/workers-template`.

## Workers

| Worker | What it does |
| --- | --- |
| [`worker-1-github-test/`](./worker-1-github-test) | GitHub integration worker (tool/sync experiments). |
| [`worker-1-google-calendar-test/`](./worker-1-google-calendar-test) | Google Calendar → Notion sync with OAuth. |

## Getting started

Each worker is independent. To work on one:

```bash
cd worker-1-google-calendar-test   # or worker-1-github-test
npm install
```

Then follow that worker's own `README.md` for build, auth, and run instructions.

## Secrets

No secrets are committed. Each worker reads credentials from a local, git-ignored
`.env` (e.g. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Copy the values your
teammate or the worker's README provides into a local `.env` before running.
Auth state (`workers.json`) and local editor config are git-ignored as well.
