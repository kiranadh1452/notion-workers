# How this code was generated

The worker code in this repository was **generated with the `/sync` command** —
an agent skill provided by Notion for the Claude Code CLI.

Each worker was scaffolded from Notion's `@notionhq/workers-template`, which ships
a set of Notion-authored agent skills under `.agents/skills/` (including `sync`,
`sync-guide`, `sync-validate`, and `auth-guide`). Running `/sync` in Claude Code
inside a worker directory drives those skills to generate the sync logic in
`src/index.ts` and related files.

In other words: the structure and sync code here are the output of Notion's
`/sync` Claude Code skill, not handwritten from scratch. Treat the generated code
as a starting point and review it before relying on it in production.

- Workers: [`worker-1-github-test/`](./worker-1-github-test), [`worker-2-google-calendar-test/`](./worker-2-google-calendar-test)
- Notion Workers (beta) docs: https://developers.notion.com
