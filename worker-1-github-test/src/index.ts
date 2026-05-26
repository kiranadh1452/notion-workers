import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

// Example agent tool that returns a greeting
// Delete this when you're ready to start building your own tools.
worker.tool("sayHello", {
	title: "Say Hello",
	description: "Returns a friendly greeting for the given name.",
	schema: j.object({
		name: j.string().describe("The name to greet."),
	}),
	execute: ({ name }) => `Hello, ${name}!`,
});

// ===========================================================================
// GitHub Pull Requests sync (backfill + delta)
// ===========================================================================
// Syncs pull requests from a single repo (process.env.GITHUB_REPO, "owner/name")
// into one managed Notion database. GitHub's /pulls endpoint supports sorting by
// `created` (stable, for backfill) and `updated` (for delta), so we use the
// recommended two-sync architecture:
//
//   - pullRequestsBackfill (replace, manual): pages the full dataset ordered by
//     created_at ascending. Replace mode's mark-and-sweep also cleans up drift.
//   - pullRequestsDelta (incremental, 15m): walks PRs ordered by updated_at
//     descending and stops once it reaches the previous high-water mark.
//
// Deletes: GitHub PRs are closed/merged, never deleted, so no delete markers are
// needed. The manual backfill catches any drift.
//
// To trigger a full re-backfill:
//   ntn workers sync state reset pullRequestsBackfill && ntn workers sync trigger pullRequestsBackfill

const REPO = process.env.GITHUB_REPO ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const BATCH_SIZE = 100;
// GitHub is fairly consistent, but never advance the delta cursor closer than
// 60s to "now": the incremental cursor never resets, so advancing past a PR
// that hasn't been indexed yet would drop it permanently.
const CONSISTENCY_BUFFER_MS = 60_000;

// One database shared by both syncs.
const pullRequests = worker.database("pullRequests", {
	type: "managed",
	initialTitle: "GitHub Pull Requests",
	primaryKeyProperty: "PR Number",
	schema: {
		properties: {
			Title: Schema.title(),
			"PR Number": Schema.richText(),
			State: Schema.select([{ name: "open" }, { name: "closed" }]),
			Merged: Schema.checkbox(),
			Draft: Schema.checkbox(),
			Author: Schema.richText(),
			URL: Schema.url(),
			"Base Branch": Schema.richText(),
			"Head Branch": Schema.richText(),
			// Labels and assignees are dynamic/unbounded, so they're stored as
			// comma-joined text rather than a fixed-option multi-select.
			Labels: Schema.richText(),
			Assignees: Schema.richText(),
			Milestone: Schema.richText(),
			Created: Schema.date(),
			Updated: Schema.date(),
			Closed: Schema.date(),
			"Merged At": Schema.date(),
		},
	},
});

// GitHub allows 5000 requests/hour for authenticated requests. ~1 req/sec keeps
// us well under both the primary and secondary rate limits. Shared by both syncs.
const githubPacer = worker.pacer("github", {
	allowedRequests: 60,
	intervalMs: 60_000,
});

// Shape of the fields we read from the GitHub /pulls list response.
interface GithubPullRequest {
	number: number;
	title: string;
	state: string; // "open" | "closed"
	draft: boolean;
	merged_at: string | null;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	html_url: string;
	body: string | null;
	user: { login: string } | null;
	base: { ref: string } | null;
	head: { ref: string } | null;
	labels: Array<{ name: string }>;
	assignees: Array<{ login: string }>;
	milestone: { title: string } | null;
}

// Fetch one page of pull requests. `sort`/`direction` differ between backfill
// (created/asc) and delta (updated/desc).
async function fetchPulls(opts: {
	sort: "created" | "updated";
	direction: "asc" | "desc";
	page: number;
}): Promise<GithubPullRequest[]> {
	const params = new URLSearchParams({
		state: "all",
		sort: opts.sort,
		direction: opts.direction,
		per_page: String(BATCH_SIZE),
		page: String(opts.page),
	});

	await githubPacer.wait();
	const response = await fetch(
		`https://api.github.com/repos/${REPO}/pulls?${params}`,
		{
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`GitHub API ${response.status} ${response.statusText} for ${REPO}: ${text}`,
		);
	}
	return (await response.json()) as GithubPullRequest[];
}

// Map a GitHub PR to a Notion upsert change. Shared by both syncs so the
// key + property shape stays identical (required when two syncs target one db).
function toUpsert(pr: GithubPullRequest) {
	return {
		type: "upsert" as const,
		key: String(pr.number),
		properties: {
			Title: Builder.title(pr.title),
			"PR Number": Builder.richText(String(pr.number)),
			State: Builder.select(pr.state),
			Merged: Builder.checkbox(pr.merged_at != null),
			Draft: Builder.checkbox(pr.draft),
			Author: Builder.richText(pr.user?.login ?? ""),
			URL: Builder.url(pr.html_url),
			"Base Branch": Builder.richText(pr.base?.ref ?? ""),
			"Head Branch": Builder.richText(pr.head?.ref ?? ""),
			Labels: Builder.richText(pr.labels.map((l) => l.name).join(", ")),
			Assignees: Builder.richText(
				pr.assignees.map((a) => a.login).join(", "),
			),
			Milestone: Builder.richText(pr.milestone?.title ?? ""),
			Created: Builder.dateTime(pr.created_at),
			Updated: Builder.dateTime(pr.updated_at),
			...(pr.closed_at ? { Closed: Builder.dateTime(pr.closed_at) } : {}),
			...(pr.merged_at
				? { "Merged At": Builder.dateTime(pr.merged_at) }
				: {}),
		},
		// Render the PR description (markdown) as the Notion page body.
		...(pr.body ? { pageContentMarkdown: pr.body } : {}),
	};
}

// Lexical comparison is valid for same-format UTC ("...Z") ISO 8601 strings.
const minIso = (a: string, b: string) => (a < b ? a : b);
const maxIso = (a: string, b: string) => (a > b ? a : b);

// ---------------------------------------------------------------------------
// Backfill sync: replace mode, manual schedule.
// ---------------------------------------------------------------------------
// Pages the full dataset ordered by created_at ascending. created_at never
// changes, so page-number pagination is stable across the cycle.

type BackfillState = { page: number };

worker.sync("pullRequestsBackfill", {
	database: pullRequests,
	mode: "replace",
	schedule: "manual",
	execute: async (state: BackfillState | undefined) => {
		const page = state?.page ?? 1;
		const prs = await fetchPulls({
			sort: "created",
			direction: "asc",
			page,
		});
		// A short page means we've reached the end of the dataset.
		const hasMore = prs.length === BATCH_SIZE;
		return {
			changes: prs.map(toUpsert),
			hasMore,
			nextState: hasMore ? { page: page + 1 } : undefined,
		};
	},
});

// ---------------------------------------------------------------------------
// Delta sync: incremental mode, every 15 minutes.
// ---------------------------------------------------------------------------
// Walks PRs ordered by updated_at descending. `cursor` is the high-water mark
// from the last completed cycle; within a cycle we page until we reach a PR at
// or below it. `pendingCursor` holds the newest updated_at seen this cycle
// (captured on page 1) and becomes the next cursor when the cycle completes.

type DeltaState = {
	cursor: string; // high-water updated_at from the last completed cycle
	page?: number; // within-cycle: next page to fetch
	pendingCursor?: string; // within-cycle: newest updated_at seen this cycle
};

worker.sync("pullRequestsDelta", {
	database: pullRequests,
	mode: "incremental",
	schedule: "15m",
	execute: async (state: DeltaState | undefined) => {
		// First run: start from "now" minus the buffer. The backfill seeds history;
		// the delta only needs to catch changes going forward.
		if (!state) {
			const startTs = new Date(
				Date.now() - CONSISTENCY_BUFFER_MS,
			).toISOString();
			return { changes: [], hasMore: false, nextState: { cursor: startTs } };
		}

		const page = state.page ?? 1;
		const prs = await fetchPulls({
			sort: "updated",
			direction: "desc",
			page,
		});

		// On page 1, the first PR is the most recently updated in the repo — that
		// becomes the candidate next cursor. Preserve it across pages of the cycle.
		const pendingCursor =
			state.pendingCursor ?? prs[0]?.updated_at ?? state.cursor;

		// Only PRs strictly newer than the previous high-water mark are new.
		const newPrs = prs.filter((pr) => pr.updated_at > state.cursor);

		const last = prs[prs.length - 1];
		// Done when this page ran past the cursor, or there are no more pages.
		const done =
			prs.length < BATCH_SIZE || (last != null && last.updated_at <= state.cursor);

		if (!done) {
			return {
				changes: newPrs.map(toUpsert),
				hasMore: true,
				nextState: { cursor: state.cursor, page: page + 1, pendingCursor },
			};
		}

		// Cycle complete: commit the new cursor, capped at the consistency buffer
		// and never moving backwards.
		const bufferTs = new Date(
			Date.now() - CONSISTENCY_BUFFER_MS,
		).toISOString();
		const committedCursor = maxIso(state.cursor, minIso(pendingCursor, bufferTs));

		return {
			changes: newPrs.map(toUpsert),
			hasMore: false,
			nextState: { cursor: committedCursor },
		};
	},
});
