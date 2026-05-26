import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

// ---------------------------------------------------------------------------
// OAuth — Google Calendar (user-managed)
// ---------------------------------------------------------------------------
// Notion-managed Google OAuth is a private alpha and isn't enabled for this
// account, so we use a user-managed OAuth app. Setup:
//   1. Create a project in Google Cloud Console, enable the Google Calendar API.
//   2. Create an OAuth 2.0 Client (type: Web application).
//   3. Put the client ID/secret in .env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
//   4. After deploy, run `ntn workers oauth show-redirect-url` and add that URL
//      as an authorized redirect URI on the Google Cloud OAuth client.
const googleAuth = worker.oauth("googleAuth", {
	name: "google-calendar",
	authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenEndpoint: "https://oauth2.googleapis.com/token",
	// calendar.readonly: read events from all the user's calendars.
	scope: "https://www.googleapis.com/auth/calendar.readonly",
	clientId: process.env.GOOGLE_CLIENT_ID ?? "",
	clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
	// access_type=offline + prompt=consent are required to receive a refresh
	// token, otherwise the access token can't be renewed after it expires.
	authorizationParams: { access_type: "offline", prompt: "consent" },
});

// ---------------------------------------------------------------------------
// Database — one row per event occurrence, shared across all calendars
// ---------------------------------------------------------------------------
// Because we sync MULTIPLE calendars, the same event id could in theory collide
// across calendars, so the primary key is composite: `${calendarId}::${eventId}`.
const calendarEvents = worker.database("calendarEvents", {
	type: "managed",
	initialTitle: "Calendar Events",
	primaryKeyProperty: "Event Key",
	schema: {
		properties: {
			Title: Schema.title(), // event summary — the main display field
			"Event Key": Schema.richText(), // primary key: calendarId::eventId
			"Event ID": Schema.richText(), // raw Google event id
			Calendar: Schema.richText(), // calendar display name
			"Calendar ID": Schema.richText(), // calendar id
			When: Schema.date(), // start/end as a date or datetime range
			"All Day": Schema.checkbox(),
			Status: Schema.select([
				{ name: "confirmed", color: "green" },
				{ name: "tentative", color: "yellow" },
				{ name: "cancelled", color: "red" },
			]),
			Location: Schema.richText(),
			Description: Schema.richText(),
			Organizer: Schema.richText(),
			Attendees: Schema.richText(), // comma-joined attendee emails
			"Meeting Link": Schema.url(), // hangout/Meet link
			"Event Link": Schema.url(), // htmlLink — opens the event in Google Calendar
			"Recurring Event ID": Schema.richText(), // set on recurring instances
			Created: Schema.date(),
			Updated: Schema.date(),
		},
	},
});

// ---------------------------------------------------------------------------
// Pacer — Google Calendar API
// ---------------------------------------------------------------------------
// Google's default per-user limit is ~500 queries / 100s (~5/s). Stay under it.
const calendarPacer = worker.pacer("googleCalendar", {
	allowedRequests: 5,
	intervalMs: 1000,
});

// Window: 30 days in the past to 30 days in the future. Recomputed every cycle
// so the window slides forward over time. ~100 events per page keeps the change
// batch small enough to not exceed per-execution limits.
const WINDOW_DAYS = 30;
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Calendar = { id: string; name: string };

// Replace-mode state is only within-cycle pagination. The resolved calendar
// list is captured at cycle start and carried through so calendar indices stay
// stable even if the user's calendar list changes mid-cycle.
type SyncState = {
	calendars: Calendar[];
	index: number; // which calendar we're currently paging through
	pageToken?: string; // page cursor within the current calendar
};

type GCalDateTime = { date?: string; dateTime?: string; timeZone?: string };
type GCalEvent = {
	id: string;
	status?: string; // confirmed | tentative | cancelled
	summary?: string;
	description?: string;
	location?: string;
	htmlLink?: string;
	hangoutLink?: string;
	created?: string;
	updated?: string;
	recurringEventId?: string;
	start?: GCalDateTime;
	end?: GCalDateTime;
	organizer?: { email?: string; displayName?: string };
	attendees?: Array<{ email?: string }>;
};

// ---------------------------------------------------------------------------
// Sync — replace mode
// ---------------------------------------------------------------------------
// Replace mode re-fetches the whole window each cycle and mark-and-sweeps: any
// event not seen this cycle is deleted from Notion. That handles every deletion
// case for free — cancelled events, events that slid out of the window, and
// events removed upstream — without any cursor/syncToken bookkeeping.
worker.sync("calendarSync", {
	database: calendarEvents,
	mode: "replace",
	schedule: "30m",
	execute: async (state: SyncState | undefined) => {
		const token = await googleAuth.accessToken();

		// Resolve the calendar list once at the start of each cycle.
		const calendars = state?.calendars ?? (await resolveCalendars(token));
		const index = state?.index ?? 0;

		// All calendars processed — end the cycle.
		if (index >= calendars.length) {
			return { changes: [], hasMore: false };
		}

		const calendar = calendars[index];
		const { events, nextPageToken } = await listEvents(
			token,
			calendar.id,
			state?.pageToken,
		);

		// `showDeleted` defaults to false (we don't pass it), so cancelled events
		// won't appear here — replace mode deletes them via mark-and-sweep. Guard
		// anyway in case the API returns one.
		const changes = events
			.filter((e) => e.status !== "cancelled")
			.map((e) => toUpsert(calendar, e));

		if (nextPageToken) {
			// More pages in the current calendar.
			return {
				changes,
				hasMore: true,
				nextState: { calendars, index, pageToken: nextPageToken },
			};
		}

		// Current calendar exhausted — advance to the next one.
		const nextIndex = index + 1;
		const hasMore = nextIndex < calendars.length;
		return {
			changes,
			hasMore,
			nextState: hasMore
				? { calendars, index: nextIndex, pageToken: undefined }
				: undefined,
		};
	},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolve which calendars to sync. By default, every calendar in the user's
// calendar list. Set GOOGLE_CALENDAR_IDS (comma-separated calendar ids) to
// restrict to specific calendars.
async function resolveCalendars(token: string): Promise<Calendar[]> {
	await calendarPacer.wait();
	const res = await fetch(
		"https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250",
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) {
		throw new Error(
			`calendarList failed: ${res.status} ${await res.text()}`,
		);
	}
	const data = (await res.json()) as {
		items?: Array<{ id: string; summary?: string }>;
	};

	let calendars: Calendar[] = (data.items ?? []).map((c) => ({
		id: c.id,
		name: c.summary ?? c.id,
	}));

	const filter = process.env.GOOGLE_CALENDAR_IDS?.trim();
	if (filter) {
		const wanted = new Set(
			filter
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		);
		calendars = calendars.filter((c) => wanted.has(c.id));
	}

	// Deterministic order so calendar indices are stable within a cycle.
	return calendars.sort((a, b) => a.id.localeCompare(b.id));
}

async function listEvents(
	token: string,
	calendarId: string,
	pageToken: string | undefined,
): Promise<{ events: GCalEvent[]; nextPageToken?: string }> {
	const now = Date.now();
	const dayMs = 24 * 60 * 60 * 1000;
	const params = new URLSearchParams({
		singleEvents: "true", // expand recurring events into individual instances
		orderBy: "startTime", // requires singleEvents=true
		maxResults: String(PAGE_SIZE),
		timeMin: new Date(now - WINDOW_DAYS * dayMs).toISOString(),
		timeMax: new Date(now + WINDOW_DAYS * dayMs).toISOString(),
	});
	if (pageToken) params.set("pageToken", pageToken);

	await calendarPacer.wait();
	const res = await fetch(
		`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
			calendarId,
		)}/events?${params}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) {
		throw new Error(
			`events.list(${calendarId}) failed: ${res.status} ${await res.text()}`,
		);
	}
	const data = (await res.json()) as {
		items?: GCalEvent[];
		nextPageToken?: string;
	};
	return { events: data.items ?? [], nextPageToken: data.nextPageToken };
}

function toUpsert(calendar: Calendar, event: GCalEvent) {
	const key = `${calendar.id}::${event.id}`;
	const { when, allDay } = buildWhen(event);
	const attendees = (event.attendees ?? [])
		.map((a) => a.email)
		.filter((e): e is string => Boolean(e))
		.join(", ");

	return {
		type: "upsert" as const,
		key,
		properties: {
			Title: Builder.title(event.summary?.trim() || "(No title)"),
			"Event Key": Builder.richText(key),
			"Event ID": Builder.richText(event.id),
			Calendar: Builder.richText(calendar.name),
			"Calendar ID": Builder.richText(calendar.id),
			"All Day": Builder.checkbox(allDay),
			Status: Builder.select(normalizeStatus(event.status)),
			...(when ? { When: when } : {}),
			...(event.location
				? { Location: Builder.richText(truncate(event.location)) }
				: {}),
			...(event.description
				? { Description: Builder.richText(truncate(event.description)) }
				: {}),
			...(event.organizer?.email
				? { Organizer: Builder.richText(event.organizer.email) }
				: {}),
			...(attendees ? { Attendees: Builder.richText(truncate(attendees)) } : {}),
			...(event.hangoutLink
				? { "Meeting Link": Builder.url(event.hangoutLink) }
				: {}),
			...(event.htmlLink
				? { "Event Link": Builder.url(event.htmlLink) }
				: {}),
			...(event.recurringEventId
				? { "Recurring Event ID": Builder.richText(event.recurringEventId) }
				: {}),
			...(event.created ? { Created: Builder.dateTime(event.created) } : {}),
			...(event.updated ? { Updated: Builder.dateTime(event.updated) } : {}),
		},
	};
}

// Build the "When" value. Timed events have start.dateTime; all-day events have
// start.date. Google's all-day end.date is EXCLUSIVE (a one-day event ends the
// next day), so subtract a day for an inclusive Notion range.
function buildWhen(event: GCalEvent): {
	when: ReturnType<typeof Builder.dateRange> | undefined;
	allDay: boolean;
} {
	const start = event.start ?? {};
	const end = event.end ?? {};

	if (start.dateTime) {
		const endDt = end.dateTime ?? start.dateTime;
		return {
			when: Builder.dateTimeRange(start.dateTime, endDt, start.timeZone),
			allDay: false,
		};
	}

	if (start.date) {
		const endInclusive = end.date ? addDays(end.date, -1) : start.date;
		return { when: Builder.dateRange(start.date, endInclusive), allDay: true };
	}

	return { when: undefined, allDay: false };
}

function addDays(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function normalizeStatus(status: string | undefined): string {
	return status === "tentative" || status === "cancelled"
		? status
		: "confirmed";
}

// Notion rich text fields cap at 2000 characters per text segment.
function truncate(value: string, max = 2000): string {
	return value.length > max ? value.slice(0, max) : value;
}
