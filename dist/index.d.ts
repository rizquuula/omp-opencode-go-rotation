import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type FetchApi, type TimerApi } from "./usage-report.ts";
export { parseOpenCodeGoUsage, formatResetIn, formatUsageStatus, } from "./usage-report.ts";
export type { FetchApi, FetchResponseApi, OpenCodeGoUsageWindow, OpenCodeGoUsageWindowStatus, OpenCodeGoUsageResponse, TimerApi, UsageFetchResult, UsageLookupTarget, } from "./usage-report.ts";
export declare function shouldWatchProvider(provider: string | undefined): boolean;
export type RateLimitKind = "transient" | "fixed-window-quota";
export declare function classifyRateLimitError(message: string): RateLimitKind | undefined;
export type ProviderActivityPhase = "waiting-for-response" | "waiting-for-stream" | "streaming";
export interface ProviderTimeoutInfo {
    phase: ProviderActivityPhase;
    idleMs: number;
    elapsedMs: number;
    idleForMs: number;
    lastStatus?: number;
}
export declare function shouldRotateAfterWatchdogTimeout(timeoutInfo: ProviderTimeoutInfo, rateLimitAlreadyRotated: boolean): boolean;
export interface ClockApi {
    now(): number;
}
export interface ExtensionOptions {
    timers?: TimerApi;
    clock?: ClockApi;
    fetch?: FetchApi;
}
export declare class ProviderIdleWatchdog {
    private timer;
    private active;
    private timedOut;
    private phase;
    private startedAt;
    private lastActivityAt;
    private lastStatus;
    private timeoutInfo;
    private readonly options;
    constructor(options: {
        idleMs: number;
        onTimeout: () => void;
        timers?: TimerApi;
        clock?: ClockApi;
    });
    start(): void;
    response(status: number): void;
    streamActivity(): void;
    activity(): void;
    stop(): void;
    consumeTimeoutInfo(): ProviderTimeoutInfo | undefined;
    currentTimeoutInfo(): ProviderTimeoutInfo | undefined;
    private markActivity;
    private now;
    private getTimers;
    private schedule;
    private clear;
}
export declare function createOpencodeGoRotationExtension(options?: ExtensionOptions): (pi: ExtensionAPI) => void;
declare const extension: (pi: ExtensionAPI) => void;
export default extension;
