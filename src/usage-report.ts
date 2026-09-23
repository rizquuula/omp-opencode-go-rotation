/**
 * Usage reporting for the OpenCode Go keys: parsing the usage endpoint payload, fetching it
 * per key, reusing recent readings, and rendering the multi-key `/opencode usage` and
 * `/opencode quota` reports.
 *
 * This module must stay free of host imports so it can be unit tested without the extension
 * runtime.
 */

import { createHash } from "node:crypto";

const NO_KEYS_MESSAGE = "No keys configured. Use /opencode add <name> <key>.";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_USAGE_TIMEOUT_MS = 10_000;

/** Fields that are padded to a fixed width so the report reads as a table. */
const NAME_COLUMN = 9;
const STATUS_COLUMN = 14;
/** The window table's numeric columns: the widest value in the template plus its two-space gap. */
const PERCENT_COLUMN = 10;
const USED_COLUMN = 13;
const REMAINING_COLUMN = 10;
const WINDOW_INDENT = "     ";

export type OpenCodeGoUsageWindowStatus = "active" | "rate-limited" | "unknown";

export interface OpenCodeGoUsageWindow {
	name?: string;
	status: OpenCodeGoUsageWindowStatus;
	usagePercent?: number;
	resetInSec?: number;
	used?: number;
	limit?: number;
	remaining?: number;
	resetAt?: string;
	startAt?: string;
	endAt?: string;
}

export interface OpenCodeGoUsageResponse {
	windows: OpenCodeGoUsageWindow[];
}

export type UsageFetchResult = {
	ok: true;
	keyName: string;
	usage: OpenCodeGoUsageResponse;
} | {
	ok: false;
	keyName?: string;
	message: string;
};

export interface TimerApi {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(timer: unknown): void;
}

export interface FetchResponseApi {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export type FetchApi = (url: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponseApi>;

/** A key whose usage can be looked up: its configured index, display name, and bearer token. */
export interface UsageLookupTarget {
	readonly keyIndex: number;
	readonly keyName: string;
	readonly bearerToken: string;
}

/** Canonical JSON-object guard for the whole package; never re-declare it at call sites. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

export function parseOpenCodeGoUsageWindow(value: unknown): OpenCodeGoUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const status: OpenCodeGoUsageWindowStatus = value.status === "ok" || value.status === "active"
		? "active"
		: value.status === "rate-limited" ? "rate-limited" : "unknown";
	const name = readString(value, ["name", "window", "period", "label"]);
	const usagePercent = readNumber(value, ["usagePercent", "usage_percent", "percent"]);
	const resetInSec = readNumber(value, ["resetInSec", "reset_in_sec", "resetSeconds", "reset_seconds"]);
	const used = readNumber(value, ["used", "usage", "usedTokens"]);
	const limit = readNumber(value, ["limit", "quota", "total"]);
	const remaining = readNumber(value, ["remaining", "remainingTokens"]);
	const resetAt = readString(value, ["resetAt", "reset_at", "resetsAt", "resets_at"]);
	const startAt = readString(value, ["startAt", "start_at", "startsAt", "starts_at"]);
	const endAt = readString(value, ["endAt", "end_at", "endsAt", "ends_at"]);
	return {
		status,
		...(name === undefined ? {} : { name }),
		...(usagePercent === undefined ? {} : { usagePercent }),
		...(resetInSec === undefined ? {} : { resetInSec }),
		...(used === undefined ? {} : { used }),
		...(limit === undefined ? {} : { limit }),
		...(remaining === undefined ? {} : { remaining }),
		...(resetAt === undefined ? {} : { resetAt }),
		...(startAt === undefined ? {} : { startAt }),
		...(endAt === undefined ? {} : { endAt }),
	};
}

export function parseOpenCodeGoUsage(value: unknown): OpenCodeGoUsageResponse | undefined {
	if (!isRecord(value)) return undefined;
	const windows: OpenCodeGoUsageWindow[] = [];
	if (Array.isArray(value.windows)) {
		for (const window of value.windows) {
			const parsed = parseOpenCodeGoUsageWindow(window);
			if (!parsed) return undefined;
			windows.push(parsed);
		}
		return { windows };
	}
	if (!isRecord(value.usage)) return undefined;
	for (const [name, window] of Object.entries(value.usage)) {
		const parsed = parseOpenCodeGoUsageWindow(window);
		if (!parsed) return undefined;
		windows.push(parsed.name === undefined ? { ...parsed, name } : parsed);
	}
	return { windows };
}

function formatUsageAmount(value: number | undefined): string | undefined {
	return value === undefined ? undefined : value.toLocaleString("en-US");
}

export function formatResetIn(seconds: number): string {
	if (seconds <= 0) return "now";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.ceil((seconds % 3_600) / 60);
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return minutes > 0 ? `${minutes}m` : "less than 1m";
}

function formatUsageWindow(window: OpenCodeGoUsageWindow, index: number): string {
	const label = window.name ?? `window ${index + 1}`;
	const details = [`${label}: ${window.status}`];
	const used = formatUsageAmount(window.used);
	const limit = formatUsageAmount(window.limit);
	const remaining = formatUsageAmount(window.remaining);
	if (window.usagePercent !== undefined) details.push(`${Math.round(window.usagePercent)}% used`);
	if (used !== undefined && limit !== undefined) details.push(`${used}/${limit} used`);
	else if (used !== undefined) details.push(`${used} used`);
	if (remaining !== undefined) details.push(`${remaining} remaining`);
	if (window.resetInSec !== undefined) details.push(`resets in ${formatResetIn(window.resetInSec)}`);
	else if (window.resetAt) details.push(`resets ${window.resetAt}`);
	else if (window.endAt) details.push(`ends ${window.endAt}`);
	return details.join("; ");
}

export function formatUsageStatus(result: UsageFetchResult): string {
	if (!result.ok) {
		return `OpenCode usage unavailable${result.keyName ? ` for ${result.keyName}` : ""}: ${result.message}`;
	}
	if (result.usage.windows.length === 0) return `OpenCode usage for ${result.keyName}: no usage windows returned.`;
	return [`OpenCode usage for ${result.keyName}:`, ...result.usage.windows.map(formatUsageWindow)].join("\n");
}

function resolveTimers(timers?: TimerApi): TimerApi {
	return timers ?? {
		setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
		clearTimeout: (timer) => globalThis.clearTimeout(timer as Parameters<typeof globalThis.clearTimeout>[0]),
	};
}

export async function fetchOpenCodeGoUsage(target: UsageLookupTarget | undefined, fetchApi: FetchApi, timers?: TimerApi): Promise<UsageFetchResult> {
	if (!target) return { ok: false, message: "No OpenCode keys configured." };
	const timerApi = resolveTimers(timers);
	const controller = new AbortController();
	const timeoutFailure: UsageFetchResult = { ok: false, keyName: target.keyName, message: "Usage request timed out after 10s." };
	let didTimeout = false;
	let timeout: unknown;
	const request = (async (): Promise<UsageFetchResult> => {
		try {
			const response = await fetchApi(OPENCODE_GO_USAGE_URL, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${target.bearerToken}`,
				},
				signal: controller.signal,
			});
			if (!response.ok) {
				return { ok: false, keyName: target.keyName, message: `Usage request failed with HTTP ${response.status}.` };
			}
			const usage = parseOpenCodeGoUsage(await response.json());
			if (!usage) return { ok: false, keyName: target.keyName, message: "Usage response did not match the expected OpenCode Go shape." };
			return { ok: true, keyName: target.keyName, usage };
		} catch {
			if (didTimeout) return timeoutFailure;
			return { ok: false, keyName: target.keyName, message: "Usage request failed." };
		}
	})();
	const timedOut = new Promise<UsageFetchResult>((resolve) => {
		timeout = timerApi.setTimeout(() => {
			didTimeout = true;
			controller.abort();
			resolve(timeoutFailure);
		}, OPENCODE_GO_USAGE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([request, timedOut]);
	} finally {
		timerApi.clearTimeout(timeout);
	}
}

/** One configured key and the usage reading collected for it. Carries no key material. */
export interface KeyUsageReport {
	readonly keyIndex: number;
	readonly keyName: string;
	readonly active: boolean;
	readonly stateTag?: string;
	readonly result: UsageFetchResult;
	/** Whole seconds since the reading was fetched, present only when it came from the cache. */
	readonly ageSec?: number;
}

type Column = readonly [value: string, width: number];

function formatColumns(...columns: readonly Column[]): string {
	return columns.map(([value, width]) => value.padEnd(width)).join("");
}

/** `→ 1. name` for the active key, `  1. name` for the others. */
function formatKeyHeader(number: number, name: string, active: boolean): string {
	return `${active ? "→" : " "} ${number}. ${name}`;
}

function formatReportWindowLine(window: OpenCodeGoUsageWindow, index: number): string {
	const used = formatUsageAmount(window.used);
	const limit = formatUsageAmount(window.limit);
	const remaining = formatUsageAmount(window.remaining);
	const usedCell = used === undefined ? "" : `${limit === undefined ? used : `${used}/${limit}`} used`;
	const remainingCell = remaining === undefined ? "" : `${remaining} left`;
	const resetCell = window.resetInSec !== undefined
		? `reset in ${formatResetIn(window.resetInSec)}`
		: window.resetAt
			? `reset ${window.resetAt}`
			: window.endAt ? `ends ${window.endAt}` : "";
	return (
		WINDOW_INDENT
		+ formatColumns(
			[window.name ?? `window ${index + 1}`, NAME_COLUMN],
			[window.status, STATUS_COLUMN],
			[window.usagePercent === undefined ? "" : `${Math.round(window.usagePercent)}% used`, PERCENT_COLUMN],
			[usedCell, USED_COLUMN],
			[remainingCell, REMAINING_COLUMN],
		)
		+ resetCell
	).trimEnd();
}

function formatReportWindowLines(result: UsageFetchResult): string[] {
	if (!result.ok) return [`${WINDOW_INDENT}unavailable: ${result.message}`];
	if (result.usage.windows.length === 0) return [`${WINDOW_INDENT}no usage windows returned`];
	return result.usage.windows.map(formatReportWindowLine);
}

export function formatUsageReport(reports: readonly KeyUsageReport[]): string {
	if (reports.length === 0) return NO_KEYS_MESSAGE;
	const active = reports.find((report) => report.active);
	const activeLabel = active === undefined ? "" : ` · active: ${active.keyIndex + 1} ${active.keyName}`;
	const ages = reports.flatMap((report) => report.ageSec === undefined ? [] : [report.ageSec]);
	const cachedLabel = ages.length === 0 ? "" : ` · cached ${Math.max(...ages)}s ago`;
	const lines = [`OpenCode Go usage · ${reports.length} keys${activeLabel}${cachedLabel}`];
	for (const report of reports) {
		const tag = report.stateTag === undefined ? "" : `  [${report.stateTag}]`;
		lines.push(formatKeyHeader(report.keyIndex + 1, report.keyName, report.active) + tag);
		lines.push(...formatReportWindowLines(report.result));
	}
	return lines.join("\n");
}

/** One configured key and its current quota state, as `/opencode quota` reports it. */
export interface QuotaKeyState {
	readonly keyIndex: number;
	readonly keyName: string;
	readonly active: boolean;
	readonly blockedForSec?: number;
	readonly coolingForSec?: number;
	readonly rateLimitedWindows: readonly string[];
	/** Whole seconds since the usage reading behind this state was fetched, when it came from the cache. */
	readonly ageSec?: number;
}

export function formatQuotaReport(states: readonly QuotaKeyState[]): string {
	if (states.length === 0) return NO_KEYS_MESSAGE;
	const nameColumn = states.reduce((width, state) => Math.max(width, state.keyName.length), 0);
	const lines = [`OpenCode Go quota · ${states.length} keys`];
	let earliestResetName: string | undefined;
	let earliestResetForSec = 0;
	for (const state of states) {
		const rateLimited = state.rateLimitedWindows.length === 0
			? ""
			: `; ${state.rateLimitedWindows.join(", ")} rate-limited`;
		const description = state.blockedForSec !== undefined
			? `quota-blocked, resets in ${formatResetIn(state.blockedForSec)}`
			: state.coolingForSec !== undefined
				? `cooldown, ready in ${formatResetIn(state.coolingForSec)}`
				: "available";
		lines.push(`${formatKeyHeader(state.keyIndex + 1, state.keyName.padEnd(nameColumn), state.active)}  ${description}${rateLimited}`);
		if (state.blockedForSec === undefined) continue;
		if (earliestResetName === undefined || state.blockedForSec < earliestResetForSec) {
			earliestResetName = state.keyName;
			earliestResetForSec = state.blockedForSec;
		}
	}
	lines.push(earliestResetName === undefined
		? "earliest reset: none"
		: `earliest reset in ${formatResetIn(earliestResetForSec)} (${earliestResetName})`);
	return lines.join("\n");
}

/** One key of the `/opencode usage --json` payload. Carries no key material. */
export interface UsagePayloadKey {
	/** 1-based, as the text report numbers keys. */
	readonly index: number;
	readonly name: string;
	readonly active: boolean;
	readonly state?: string;
	readonly windows?: OpenCodeGoUsageWindow[];
	readonly message?: string;
	readonly ageSec?: number;
}

export interface UsagePayload {
	readonly provider: "opencode-go";
	readonly keys: UsagePayloadKey[];
}

export function toUsagePayload(reports: readonly KeyUsageReport[]): UsagePayload {
	return {
		provider: "opencode-go",
		keys: reports.map((report) => ({
			index: report.keyIndex + 1,
			name: report.keyName,
			active: report.active,
			...(report.stateTag === undefined ? {} : { state: report.stateTag }),
			...(report.result.ok ? { windows: report.result.usage.windows } : { message: report.result.message }),
			...(report.ageSec === undefined ? {} : { ageSec: report.ageSec }),
		})),
	};
}

/** One key of the `/opencode quota --json` payload. Carries no key material. */
export interface QuotaPayloadKey {
	/** 1-based, as the text report numbers keys. */
	readonly index: number;
	readonly name: string;
	readonly active: boolean;
	readonly state: "available" | "quota-blocked" | "cooldown";
	readonly blockedForSec?: number;
	readonly coolingForSec?: number;
	readonly rateLimitedWindows: readonly string[];
	readonly ageSec?: number;
}

export interface QuotaPayload {
	readonly provider: "opencode-go";
	readonly keys: QuotaPayloadKey[];
	readonly earliestResetSec?: number;
	readonly earliestResetKey?: string;
}

export function toQuotaPayload(states: readonly QuotaKeyState[]): QuotaPayload {
	let earliestResetSec: number | undefined;
	let earliestResetKey: string | undefined;
	for (const state of states) {
		if (state.blockedForSec === undefined) continue;
		if (earliestResetSec === undefined || state.blockedForSec < earliestResetSec) {
			earliestResetSec = state.blockedForSec;
			earliestResetKey = state.keyName;
		}
	}
	return {
		provider: "opencode-go",
		keys: states.map((state) => ({
			index: state.keyIndex + 1,
			name: state.keyName,
			active: state.active,
			state: state.blockedForSec !== undefined
				? "quota-blocked"
				: state.coolingForSec === undefined ? "available" : "cooldown",
			...(state.blockedForSec === undefined ? {} : { blockedForSec: state.blockedForSec }),
			...(state.coolingForSec === undefined ? {} : { coolingForSec: state.coolingForSec }),
			rateLimitedWindows: state.rateLimitedWindows,
			...(state.ageSec === undefined ? {} : { ageSec: state.ageSec }),
		})),
		...(earliestResetSec === undefined ? {} : { earliestResetSec, earliestResetKey }),
	};
}

/**
 * How long a collected reading is reused before a command fetches a fresh one.
 * `/opencode usage` and `/opencode quota` share one cache, so a pair of commands
 * inside this window fetches each key once.
 */
export const USAGE_CACHE_TTL_MS = 60_000;

/** One reading kept for reuse: the fetch result and the clock reading it was stored at. */
export interface CachedUsage {
	readonly result: UsageFetchResult;
	readonly storedAt: number;
}

/** Readings addressed by {@link usageCacheKey}, each one ignored once it reaches the TTL. */
export interface UsageCache {
	get(key: string, now: number): CachedUsage | undefined;
	set(key: string, entry: CachedUsage): void;
}

/** A cache that keeps an entry for `ttlMs` from the moment it was stored. */
export function createUsageCache(ttlMs: number = USAGE_CACHE_TTL_MS): UsageCache {
	const entries = new Map<string, CachedUsage>();
	return {
		get: (key, now) => {
			const entry = entries.get(key);
			if (entry === undefined) return undefined;
			if (now - entry.storedAt >= ttlMs) {
				entries.delete(key);
				return undefined;
			}
			return entry;
		},
		set: (key, entry) => {
			entries.set(key, entry);
		},
	};
}

/**
 * Cache identity of a target: its configured index plus a digest of the bearer. A replaced
 * bearer at the same index is a different key, and the bearer never reaches the cache key.
 */
export function usageCacheKey(target: UsageLookupTarget): string {
	const digest = createHash("sha256").update(target.bearerToken).digest("hex");
	return `${target.keyIndex}:${digest.slice(0, 16)}`;
}

/** Whole seconds between a reading being stored and a later clock reading. */
export function usageAgeSec(storedAt: number, now: number): number {
	return Math.max(0, Math.floor((now - storedAt) / 1000));
}

/** One cached reading, without its key identity: all the status summary needs. */
export interface CachedUsageReading {
	readonly result: UsageFetchResult;
	readonly ageSec: number;
}

/**
 * The cache-only usage line `/opencode status` shows: the highest-percentage window among the
 * cached readings, with how old that reading is. Without a usable reading it points at the
 * command that fetches one.
 */
export function formatCachedUsageSummary(readings: readonly CachedUsageReading[]): string {
	let bestName: string | undefined;
	let bestPercent = 0;
	let bestAgeSec = 0;
	for (const reading of readings) {
		if (!reading.result.ok) continue;
		for (const [index, window] of reading.result.usage.windows.entries()) {
			if (window.usagePercent === undefined) continue;
			if (bestName !== undefined && window.usagePercent <= bestPercent) continue;
			bestName = window.name ?? `window ${index + 1}`;
			bestPercent = window.usagePercent;
			bestAgeSec = reading.ageSec;
		}
	}
	if (bestName === undefined) return "Usage: no cached reading (run /opencode usage)";
	return `Usage: ${bestName} ${Math.round(bestPercent)}% used · cached ${bestAgeSec}s ago`;
}

export interface CollectUsageOptions {
	/** Reuses recent readings and stores new ones. Without a cache every call fetches. */
	readonly cache?: UsageCache;
	/** Clock the reuse window is measured against; defaults to `Date.now`. */
	readonly now?: () => number;
	/** Ignores the cache for this pass and refreshes the entries it fetches. */
	readonly refresh?: boolean;
}

/**
 * Reads the usage endpoint once per configured key, in parallel and in the given order.
 * Every key gets its own 10 s window, so one silent key cannot delay the others.
 * A reading already in the cache is reused, and the report then carries its age.
 */
export async function collectUsageReports(
	targets: readonly UsageLookupTarget[],
	activeKeyIndex: number,
	fetchApi: FetchApi,
	timers?: TimerApi,
	options: CollectUsageOptions = {},
): Promise<KeyUsageReport[]> {
	const { cache, refresh = false } = options;
	const readClock = options.now ?? Date.now;
	return Promise.all(targets.map(async (target): Promise<KeyUsageReport> => {
		const header = {
			keyIndex: target.keyIndex,
			keyName: target.keyName,
			active: target.keyIndex === activeKeyIndex,
		};
		const cacheKey = usageCacheKey(target);
		const cached = refresh ? undefined : cache?.get(cacheKey, readClock());
		if (cached !== undefined) {
			return { ...header, result: cached.result, ageSec: usageAgeSec(cached.storedAt, readClock()) };
		}
		const result = await fetchOpenCodeGoUsage(target, fetchApi, timers);
		cache?.set(cacheKey, { result, storedAt: readClock() });
		return { ...header, result };
	}));
}
