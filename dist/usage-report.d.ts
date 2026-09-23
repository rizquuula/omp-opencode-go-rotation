/**
 * Usage reporting for the OpenCode Go keys: parsing the usage endpoint payload, fetching it
 * per key, reusing recent readings, and rendering the multi-key `/opencode usage` and
 * `/opencode quota` reports.
 *
 * This module must stay free of host imports so it can be unit tested without the extension
 * runtime.
 */
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
export type FetchApi = (url: string, init: {
    method: "GET";
    headers: Record<string, string>;
    signal?: AbortSignal;
}) => Promise<FetchResponseApi>;
/** A key whose usage can be looked up: its configured index, display name, and bearer token. */
export interface UsageLookupTarget {
    readonly keyIndex: number;
    readonly keyName: string;
    readonly bearerToken: string;
}
/** Canonical JSON-object guard for the whole package; never re-declare it at call sites. */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function parseOpenCodeGoUsageWindow(value: unknown): OpenCodeGoUsageWindow | undefined;
export declare function parseOpenCodeGoUsage(value: unknown): OpenCodeGoUsageResponse | undefined;
export declare function formatResetIn(seconds: number): string;
export declare function formatUsageStatus(result: UsageFetchResult): string;
export declare function fetchOpenCodeGoUsage(target: UsageLookupTarget | undefined, fetchApi: FetchApi, timers?: TimerApi): Promise<UsageFetchResult>;
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
export declare function formatUsageReport(reports: readonly KeyUsageReport[]): string;
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
export declare function formatQuotaReport(states: readonly QuotaKeyState[]): string;
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
export declare function toUsagePayload(reports: readonly KeyUsageReport[]): UsagePayload;
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
export declare function toQuotaPayload(states: readonly QuotaKeyState[]): QuotaPayload;
/**
 * How long a collected reading is reused before a command fetches a fresh one.
 * `/opencode usage` and `/opencode quota` share one cache, so a pair of commands
 * inside this window fetches each key once.
 */
export declare const USAGE_CACHE_TTL_MS = 60000;
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
export declare function createUsageCache(ttlMs?: number): UsageCache;
/**
 * Cache identity of a target: its configured index plus a digest of the bearer. A replaced
 * bearer at the same index is a different key, and the bearer never reaches the cache key.
 */
export declare function usageCacheKey(target: UsageLookupTarget): string;
/** Whole seconds between a reading being stored and a later clock reading. */
export declare function usageAgeSec(storedAt: number, now: number): number;
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
export declare function formatCachedUsageSummary(readings: readonly CachedUsageReading[]): string;
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
export declare function collectUsageReports(targets: readonly UsageLookupTarget[], activeKeyIndex: number, fetchApi: FetchApi, timers?: TimerApi, options?: CollectUsageOptions): Promise<KeyUsageReport[]>;
