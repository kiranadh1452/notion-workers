/**
 * Integration test for the GitHub Pull Requests syncs.
 *
 * Drives the worker's syncs directly with explicit state — `ntn workers exec`
 * does not forward `-d` to a sync's `state` arg, so we use `worker.run()` to
 * exercise pagination and cursor logic against the real GitHub API.
 *
 * Run with: npx tsx --env-file=.env test.ts
 */
import assert from "node:assert";
import worker from "./src/index.ts";

type SyncResult = {
	changes: Array<{ key: string; properties: Record<string, unknown> }>;
	hasMore: boolean;
	// The runtime surfaces the returned `nextState` under `nextUserContext`.
	nextUserContext?: { cursor?: string; page?: number };
};

async function run(key: string, state: unknown): Promise<SyncResult> {
	// The runtime reads sync state from `runtimeContext.state`, so wrap it.
	return (await worker.run(
		key,
		state === undefined ? undefined : { state },
		{ concreteOutput: true },
	)) as SyncResult;
}

async function main() {
	// --- Backfill: first page from undefined state ---------------------------
	const backfill = await run("pullRequestsBackfill", undefined);
	console.log(
		`backfill: ${backfill.changes.length} records, hasMore=${backfill.hasMore}`,
	);
	assert(backfill.changes.length > 0, "backfill should return PRs");
	const first = backfill.changes[0];
	assert(first.key, "record should have a key (PR number)");
	for (const prop of ["Title", "PR Number", "State", "URL", "Created"]) {
		assert(prop in first.properties, `record should populate "${prop}"`);
	}
	console.log("  sample keys:", backfill.changes.map((c) => c.key).join(", "));

	// --- Delta: first run seeds the cursor, returns no changes ---------------
	const deltaFirst = await run("pullRequestsDelta", undefined);
	console.log(
		`delta first-run: ${deltaFirst.changes.length} changes, cursor=${deltaFirst.nextUserContext?.cursor}`,
	);
	assert.equal(deltaFirst.changes.length, 0, "first delta run emits nothing");
	assert(deltaFirst.nextUserContext?.cursor, "first delta run sets a cursor");

	// --- Delta: backdated cursor should pick up all existing PRs -------------
	const deltaBack = await run("pullRequestsDelta", {
		cursor: "2020-01-01T00:00:00Z",
	});
	console.log(
		`delta backdated: ${deltaBack.changes.length} changes, hasMore=${deltaBack.hasMore}, nextCursor=${deltaBack.nextUserContext?.cursor}`,
	);
	assert(
		deltaBack.changes.length > 0,
		"backdated delta should re-pick up PRs",
	);
	assert(
		deltaBack.nextUserContext?.cursor && deltaBack.nextUserContext!.cursor > "2020",
		"delta cursor should advance forward",
	);

	// --- Delta: future cursor means caught up, nothing to do -----------------
	const deltaFuture = await run("pullRequestsDelta", {
		cursor: "2030-01-01T00:00:00Z",
	});
	console.log(
		`delta future: ${deltaFuture.changes.length} changes, hasMore=${deltaFuture.hasMore}`,
	);
	assert.equal(deltaFuture.changes.length, 0, "future cursor emits nothing");
	assert.equal(deltaFuture.hasMore, false, "future cursor completes cycle");

	console.log("\nAll tests passed.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
