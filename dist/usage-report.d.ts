/**
 * Usage reporting for the OpenCode Go keys: parsing the usage endpoint payload, fetching it
 * per key, and rendering the multi-key `/opencode usage` and `/opencode quota` reports.
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
}
export declare function formatQuotaReport(states: readonly QuotaKeyState[]): string;
/**
 * Reads the usage endpoint once per configured key, in parallel and in the given order.
 * Every key gets its own 10 s window, so one silent key cannot delay the others.
 */
export declare function collectUsageReports(targets: readonly UsageLookupTarget[], activeKeyIndex: number, fetchApi: FetchApi, timers?: TimerApi): Promise<KeyUsageReport[]>;
