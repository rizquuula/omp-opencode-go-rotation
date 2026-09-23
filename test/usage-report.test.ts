import test from "node:test";
import assert from "node:assert/strict";
import {
	collectUsageReports,
	createUsageCache,
	formatQuotaReport,
	formatUsageReport,
	USAGE_CACHE_TTL_MS,
	type FetchApi,
	type KeyUsageReport,
	type OpenCodeGoUsageWindow,
	type QuotaKeyState,
	type TimerApi,
	type UsageFetchResult,
	type UsageLookupTarget,
} from "../src/usage-report.ts";

function okUsage(keyName: string, windows: OpenCodeGoUsageWindow[]): UsageFetchResult {
	return { ok: true, keyName, usage: { windows } };
}

function failedUsage(keyName: string, message: string): UsageFetchResult {
	return { ok: false, keyName, message };
}

/** opencode-mrr: one active 5-hour window and one exhausted weekly window. */
const MRR_5_HOUR: OpenCodeGoUsageWindow = {
	name: "5-hour",
	status: "active",
	usagePercent: 70,
	used: 8.4,
	limit: 12,
	remaining: 3.6,
	resetInSec: 8_100,
};

const MRR_WEEKLY: OpenCodeGoUsageWindow = {
	name: "weekly",
	status: "rate-limited",
	usagePercent: 100,
	resetAt: "2026-08-19",
};

const RR_5_HOUR: OpenCodeGoUsageWindow = {
	name: "5-hour",
	status: "active",
	usagePercent: 41,
	used: 4.9,
	limit: 12,
	remaining: 7.1,
	resetInSec: 14_520,
};

test("formatUsageReport lists every key, marks the active one, and lines up the window columns", () => {
	const reports: KeyUsageReport[] = [
		{
			keyIndex: 0,
			keyName: "opencode-mrr",
			active: false,
			stateTag: "quota-blocked 2h 10m",
			result: okUsage("opencode-mrr", [MRR_5_HOUR, MRR_WEEKLY]),
		},
		{
			keyIndex: 1,
			keyName: "opencode-rr",
			active: true,
			result: okUsage("opencode-rr", [RR_5_HOUR]),
		},
	];

	assert.equal(
		formatUsageReport(reports),
		[
			"OpenCode Go usage · 2 keys · active: 2 opencode-rr",
			"  1. opencode-mrr  [quota-blocked 2h 10m]",
			"     5-hour   active        70% used  8.4/12 used  3.6 left  reset in 2h 15m",
			"     weekly   rate-limited  100% used                        reset 2026-08-19",
			"→ 2. opencode-rr",
			"     5-hour   active        41% used  4.9/12 used  7.1 left  reset in 4h 2m",
		].join("\n"),
	);
});

test("formatUsageReport renders an unavailable line for a key whose usage request failed", () => {
	const reports: KeyUsageReport[] = [
		{
			keyIndex: 0,
			keyName: "opencode-mrr",
			active: true,
			result: failedUsage("opencode-mrr", "Usage request timed out after 10s."),
		},
	];

	assert.equal(
		formatUsageReport(reports),
		[
			"OpenCode Go usage · 1 keys · active: 1 opencode-mrr",
			"→ 1. opencode-mrr",
			"     unavailable: Usage request timed out after 10s.",
		].join("\n"),
	);
});

test("formatUsageReport numbers each key by its configured index", () => {
	const reports: KeyUsageReport[] = [
		{
			keyIndex: 2,
			keyName: "opencode-rr",
			active: false,
			result: okUsage("opencode-rr", []),
		},
	];

	assert.equal(
		formatUsageReport(reports),
		[
			"OpenCode Go usage · 1 keys",
			"  3. opencode-rr",
			"     no usage windows returned",
		].join("\n"),
	);
});

test("formatUsageReport points at /opencode add when no keys are configured", () => {
	assert.equal(formatUsageReport([]), "No keys configured. Use /opencode add <name> <key>.");
});

test("formatQuotaReport describes a blocked key and an available key, and names the earliest reset", () => {
	const states: QuotaKeyState[] = [
		{
			keyIndex: 0,
			keyName: "opencode-mrr",
			active: true,
			blockedForSec: 7_800,
			rateLimitedWindows: ["weekly"],
		},
		{ keyIndex: 1, keyName: "opencode-rr", active: false, rateLimitedWindows: [] },
	];

	assert.equal(
		formatQuotaReport(states),
		[
			"OpenCode Go quota · 2 keys",
			"→ 1. opencode-mrr  quota-blocked, resets in 2h 10m; weekly rate-limited",
			"  2. opencode-rr   available",
			"earliest reset in 2h 10m (opencode-mrr)",
		].join("\n"),
	);
});

test("formatQuotaReport describes a key that is cooling down after a transient limit", () => {
	const states: QuotaKeyState[] = [
		{ keyIndex: 0, keyName: "opencode-mrr", active: false, coolingForSec: 600, rateLimitedWindows: [] },
	];

	assert.equal(
		formatQuotaReport(states),
		[
			"OpenCode Go quota · 1 keys",
			"  1. opencode-mrr  cooldown, ready in 10m",
			"earliest reset: none",
		].join("\n"),
	);
});

test("formatQuotaReport lists every rate-limited window of a key that is otherwise available", () => {
	const states: QuotaKeyState[] = [
		{
			keyIndex: 0,
			keyName: "opencode-mrr",
			active: true,
			rateLimitedWindows: ["5-hour", "weekly"],
		},
	];

	assert.equal(
		formatQuotaReport(states),
		[
			"OpenCode Go quota · 1 keys",
			"→ 1. opencode-mrr  available; 5-hour, weekly rate-limited",
			"earliest reset: none",
		].join("\n"),
	);
});

test("formatQuotaReport reports the earliest reset among the blocked keys", () => {
	const states: QuotaKeyState[] = [
		{ keyIndex: 0, keyName: "opencode-mrr", active: true, blockedForSec: 7_200, rateLimitedWindows: [] },
		{ keyIndex: 1, keyName: "opencode-rr", active: false, blockedForSec: 600, rateLimitedWindows: [] },
	];

	assert.equal(
		formatQuotaReport(states),
		[
			"OpenCode Go quota · 2 keys",
			"→ 1. opencode-mrr  quota-blocked, resets in 2h",
			"  2. opencode-rr   quota-blocked, resets in 10m",
			"earliest reset in 10m (opencode-rr)",
		].join("\n"),
	);
});

test("formatQuotaReport points at /opencode add when no keys are configured", () => {
	assert.equal(formatQuotaReport([]), "No keys configured. Use /opencode add <name> <key>.");
});

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const TARGETS: UsageLookupTarget[] = [
	{ keyIndex: 0, keyName: "opencode-mrr", bearerToken: "token-mrr" },
	{ keyIndex: 1, keyName: "opencode-rr", bearerToken: "token-rr" },
];

class FakeTimers implements TimerApi {
	private nextId = 1;
	private timers = new Map<number, { callback: () => void; ms: number }>();

	setTimeout = (callback: () => void, ms: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { callback, ms });
		return id;
	};

	clearTimeout = (id: number): void => {
		this.timers.delete(id);
	};

	fireAll(): void {
		const entries = [...this.timers.values()];
		this.timers.clear();
		for (const entry of entries) entry.callback();
	}

	get delays(): number[] {
		return [...this.timers.values()].map((entry) => entry.ms);
	}

	get size(): number {
		return this.timers.size;
	}
}

interface RecordedRequest {
	readonly url: string;
	readonly method: string;
	readonly authorization: string | undefined;
}

function recordingFetch(respond: (authorization: string | undefined) => { ok: boolean; status: number; body: unknown }): { fetchApi: FetchApi; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetchApi: FetchApi = async (url, init) => {
		const authorization = init.headers.Authorization;
		requests.push({ url, method: init.method, authorization });
		const response = respond(authorization);
		return { ok: response.ok, status: response.status, json: async () => response.body };
	};
	return { fetchApi, requests };
}

test("collectUsageReports asks every key with its own bearer and keeps the configured order", async () => {
	const { fetchApi, requests } = recordingFetch(() => ({
		ok: true,
		status: 200,
		body: { windows: [{ name: "5-hour", status: "active", percent: 12 }] },
	}));

	const reports = await collectUsageReports(TARGETS, 1, fetchApi);

	assert.deepEqual(
		reports.map((report) => [report.keyIndex, report.keyName, report.active]),
		[[0, "opencode-mrr", false], [1, "opencode-rr", true]],
	);
	assert.deepEqual(requests, [
		{ url: OPENCODE_GO_USAGE_URL, method: "GET", authorization: "Bearer token-mrr" },
		{ url: OPENCODE_GO_USAGE_URL, method: "GET", authorization: "Bearer token-rr" },
	]);
	assert.deepEqual(reports[0]?.result, {
		ok: true,
		keyName: "opencode-mrr",
		usage: { windows: [{ name: "5-hour", status: "active", usagePercent: 12 }] },
	});
	assert.deepEqual(reports[1]?.result, {
		ok: true,
		keyName: "opencode-rr",
		usage: { windows: [{ name: "5-hour", status: "active", usagePercent: 12 }] },
	});
});

test("collectUsageReports never copies key material into the report it renders", async () => {
	const { fetchApi } = recordingFetch(() => ({
		ok: true,
		status: 200,
		body: { windows: [{ name: "5-hour", status: "active" }] },
	}));

	const reports = await collectUsageReports(TARGETS, 0, fetchApi);
	const rendered = formatUsageReport(reports);

	assert.equal(rendered.includes("token"), false);
	assert.equal(JSON.stringify(reports).includes("token"), false);
});

test("collectUsageReports isolates a key whose usage request fails", async () => {
	const { fetchApi } = recordingFetch((authorization) => authorization === "Bearer token-mrr"
		? { ok: false, status: 500, body: {} }
		: { ok: true, status: 200, body: { usage: { "5-hour": { status: "active", percent: 12 } } } });

	const reports = await collectUsageReports(TARGETS, 0, fetchApi);

	assert.deepEqual(reports[0]?.result, {
		ok: false,
		keyName: "opencode-mrr",
		message: "Usage request failed with HTTP 500.",
	});
	assert.deepEqual(reports[1]?.result, {
		ok: true,
		keyName: "opencode-rr",
		usage: { windows: [{ name: "5-hour", status: "active", usagePercent: 12 }] },
	});
});

test("collectUsageReports gives each silent key its own 10 s window and starts them together", async () => {
	const timers = new FakeTimers();
	let requests = 0;
	const silentFetch: FetchApi = async () => {
		requests++;
		return new Promise<never>(() => {});
	};

	const pending = collectUsageReports(TARGETS, 0, silentFetch, timers);
	assert.deepEqual(timers.delays, [10_000, 10_000]);
	assert.equal(requests, 2);
	timers.fireAll();

	const reports = await pending;
	assert.deepEqual(reports.map((report) => report.result), [
		{ ok: false, keyName: "opencode-mrr", message: "Usage request timed out after 10s." },
		{ ok: false, keyName: "opencode-rr", message: "Usage request timed out after 10s." },
	]);
	assert.equal(timers.size, 0);
});

/** A clock the cache tests advance by hand, in milliseconds. */
class StepClock {
	time = 0;

	now = (): number => this.time;
}

const RR_TARGET: UsageLookupTarget = { keyIndex: 1, keyName: "opencode-rr", bearerToken: "token-rr" };

test("collectUsageReports reuses a reading collected inside the TTL and labels how old it is", async () => {
	const { fetchApi, requests } = recordingFetch(() => ({
		ok: true,
		status: 200,
		body: { windows: [{ name: "weekly", status: "active", percent: 12 }] },
	}));
	const clock = new StepClock();
	const cache = createUsageCache();

	const first = await collectUsageReports(TARGETS, 0, fetchApi, undefined, { cache, now: clock.now });
	assert.equal(requests.length, 2);
	assert.deepEqual(first.map((report) => report.ageSec), [undefined, undefined]);

	clock.time = 42_000;
	const second = await collectUsageReports(TARGETS, 0, fetchApi, undefined, { cache, now: clock.now });

	assert.equal(requests.length, 2);
	assert.deepEqual(second.map((report) => report.ageSec), [42, 42]);
	assert.deepEqual(second.map((report) => report.result), first.map((report) => report.result));
});

test("collectUsageReports refetches once a cached reading reaches the TTL", async () => {
	const { fetchApi, requests } = recordingFetch(() => ({
		ok: true,
		status: 200,
		body: { windows: [{ name: "weekly", status: "active", percent: 12 }] },
	}));
	const clock = new StepClock();
	const cache = createUsageCache();

	await collectUsageReports(TARGETS, 0, fetchApi, undefined, { cache, now: clock.now });
	clock.time = USAGE_CACHE_TTL_MS;
	const refreshed = await collectUsageReports(TARGETS, 0, fetchApi, undefined, { cache, now: clock.now });

	assert.equal(requests.length, 4);
	assert.deepEqual(refreshed.map((report) => report.ageSec), [undefined, undefined]);
});

test("collectUsageReports treats a replaced bearer at the same index as a different key", async () => {
	const { fetchApi, requests } = recordingFetch(() => ({
		ok: true,
		status: 200,
		body: { windows: [{ name: "weekly", status: "active", percent: 12 }] },
	}));
	const clock = new StepClock();
	const cache = createUsageCache();

	await collectUsageReports(TARGETS, 0, fetchApi, undefined, { cache, now: clock.now });
	const rotated: UsageLookupTarget[] = [
		{ keyIndex: 0, keyName: "opencode-mrr", bearerToken: "token-mrr-rotated" },
		RR_TARGET,
	];
	const second = await collectUsageReports(rotated, 0, fetchApi, undefined, { cache, now: clock.now });

	assert.deepEqual(requests.map((request) => request.authorization), [
		"Bearer token-mrr",
		"Bearer token-rr",
		"Bearer token-mrr-rotated",
	]);
	assert.equal(second[0]?.ageSec, undefined);
	assert.equal(second[1]?.ageSec, 0);
});

test("createUsageCache keeps an entry until its TTL and ignores it after that", () => {
	const cache = createUsageCache();
	const result = okUsage("opencode-mrr", []);
	cache.set("slot", { result, storedAt: 0 });

	assert.deepEqual(cache.get("slot", USAGE_CACHE_TTL_MS - 1)?.result, result);
	assert.deepEqual(cache.get("slot", 0), { result, storedAt: 0 });
	assert.equal(cache.get("slot", USAGE_CACHE_TTL_MS), undefined);
	assert.equal(cache.get("missing", 0), undefined);
});

test("formatUsageReport labels its header with the age of the oldest reused reading", () => {
	const reports: KeyUsageReport[] = [
		{ keyIndex: 0, keyName: "opencode-mrr", active: true, ageSec: 42, result: okUsage("opencode-mrr", [MRR_5_HOUR]) },
		{ keyIndex: 1, keyName: "opencode-rr", active: false, ageSec: 7, result: okUsage("opencode-rr", [RR_5_HOUR]) },
	];

	assert.equal(
		formatUsageReport(reports).split("\n")[0],
		"OpenCode Go usage · 2 keys · active: 1 opencode-mrr · cached 42s ago",
	);
});

test("formatUsageReport labels nothing when every reading is fresh", () => {
	const reports: KeyUsageReport[] = [
		{ keyIndex: 0, keyName: "opencode-mrr", active: true, result: okUsage("opencode-mrr", [MRR_5_HOUR]) },
		{ keyIndex: 1, keyName: "opencode-rr", active: false, result: okUsage("opencode-rr", [RR_5_HOUR]) },
	];

	assert.equal(
		formatUsageReport(reports).split("\n")[0],
		"OpenCode Go usage · 2 keys · active: 1 opencode-mrr",
	);
});
