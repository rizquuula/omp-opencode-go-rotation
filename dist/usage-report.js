/**
 * Usage reporting for the OpenCode Go keys: parsing the usage endpoint payload, fetching it
 * per key, and rendering the multi-key `/opencode usage` and `/opencode quota` reports.
 *
 * This module must stay free of host imports so it can be unit tested without the extension
 * runtime.
 */
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
/** Canonical JSON-object guard for the whole package; never re-declare it at call sites. */
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string")
            return value;
    }
    return undefined;
}
function readNumber(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value))
            return value;
    }
    return undefined;
}
export function parseOpenCodeGoUsageWindow(value) {
    if (!isRecord(value))
        return undefined;
    const status = value.status === "ok" || value.status === "active"
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
export function parseOpenCodeGoUsage(value) {
    if (!isRecord(value))
        return undefined;
    const windows = [];
    if (Array.isArray(value.windows)) {
        for (const window of value.windows) {
            const parsed = parseOpenCodeGoUsageWindow(window);
            if (!parsed)
                return undefined;
            windows.push(parsed);
        }
        return { windows };
    }
    if (!isRecord(value.usage))
        return undefined;
    for (const [name, window] of Object.entries(value.usage)) {
        const parsed = parseOpenCodeGoUsageWindow(window);
        if (!parsed)
            return undefined;
        windows.push(parsed.name === undefined ? { ...parsed, name } : parsed);
    }
    return { windows };
}
function formatUsageAmount(value) {
    return value === undefined ? undefined : value.toLocaleString("en-US");
}
export function formatResetIn(seconds) {
    if (seconds <= 0)
        return "now";
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.ceil((seconds % 3_600) / 60);
    if (days > 0)
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0)
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return minutes > 0 ? `${minutes}m` : "less than 1m";
}
function formatUsageWindow(window, index) {
    const label = window.name ?? `window ${index + 1}`;
    const details = [`${label}: ${window.status}`];
    const used = formatUsageAmount(window.used);
    const limit = formatUsageAmount(window.limit);
    const remaining = formatUsageAmount(window.remaining);
    if (window.usagePercent !== undefined)
        details.push(`${Math.round(window.usagePercent)}% used`);
    if (used !== undefined && limit !== undefined)
        details.push(`${used}/${limit} used`);
    else if (used !== undefined)
        details.push(`${used} used`);
    if (remaining !== undefined)
        details.push(`${remaining} remaining`);
    if (window.resetInSec !== undefined)
        details.push(`resets in ${formatResetIn(window.resetInSec)}`);
    else if (window.resetAt)
        details.push(`resets ${window.resetAt}`);
    else if (window.endAt)
        details.push(`ends ${window.endAt}`);
    return details.join("; ");
}
export function formatUsageStatus(result) {
    if (!result.ok) {
        return `OpenCode usage unavailable${result.keyName ? ` for ${result.keyName}` : ""}: ${result.message}`;
    }
    if (result.usage.windows.length === 0)
        return `OpenCode usage for ${result.keyName}: no usage windows returned.`;
    return [`OpenCode usage for ${result.keyName}:`, ...result.usage.windows.map(formatUsageWindow)].join("\n");
}
function resolveTimers(timers) {
    return timers ?? {
        setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
        clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
}
export async function fetchOpenCodeGoUsage(target, fetchApi, timers) {
    if (!target)
        return { ok: false, message: "No OpenCode keys configured." };
    const timerApi = resolveTimers(timers);
    const controller = new AbortController();
    const timeoutFailure = { ok: false, keyName: target.keyName, message: "Usage request timed out after 10s." };
    let didTimeout = false;
    let timeout;
    const request = (async () => {
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
            if (!usage)
                return { ok: false, keyName: target.keyName, message: "Usage response did not match the expected OpenCode Go shape." };
            return { ok: true, keyName: target.keyName, usage };
        }
        catch {
            if (didTimeout)
                return timeoutFailure;
            return { ok: false, keyName: target.keyName, message: "Usage request failed." };
        }
    })();
    const timedOut = new Promise((resolve) => {
        timeout = timerApi.setTimeout(() => {
            didTimeout = true;
            controller.abort();
            resolve(timeoutFailure);
        }, OPENCODE_GO_USAGE_TIMEOUT_MS);
    });
    try {
        return await Promise.race([request, timedOut]);
    }
    finally {
        timerApi.clearTimeout(timeout);
    }
}
function formatColumns(...columns) {
    return columns.map(([value, width]) => value.padEnd(width)).join("");
}
/** `→ 1. name` for the active key, `  1. name` for the others. */
function formatKeyHeader(number, name, active) {
    return `${active ? "→" : " "} ${number}. ${name}`;
}
function formatReportWindowLine(window, index) {
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
    return (WINDOW_INDENT
        + formatColumns([window.name ?? `window ${index + 1}`, NAME_COLUMN], [window.status, STATUS_COLUMN], [window.usagePercent === undefined ? "" : `${Math.round(window.usagePercent)}% used`, PERCENT_COLUMN], [usedCell, USED_COLUMN], [remainingCell, REMAINING_COLUMN])
        + resetCell).trimEnd();
}
function formatReportWindowLines(result) {
    if (!result.ok)
        return [`${WINDOW_INDENT}unavailable: ${result.message}`];
    if (result.usage.windows.length === 0)
        return [`${WINDOW_INDENT}no usage windows returned`];
    return result.usage.windows.map(formatReportWindowLine);
}
export function formatUsageReport(reports) {
    if (reports.length === 0)
        return NO_KEYS_MESSAGE;
    const active = reports.find((report) => report.active);
    const activeLabel = active === undefined ? "" : ` · active: ${active.keyIndex + 1} ${active.keyName}`;
    const lines = [`OpenCode Go usage · ${reports.length} keys${activeLabel}`];
    for (const report of reports) {
        const tag = report.stateTag === undefined ? "" : `  [${report.stateTag}]`;
        lines.push(formatKeyHeader(report.keyIndex + 1, report.keyName, report.active) + tag);
        lines.push(...formatReportWindowLines(report.result));
    }
    return lines.join("\n");
}
export function formatQuotaReport(states) {
    if (states.length === 0)
        return NO_KEYS_MESSAGE;
    const nameColumn = states.reduce((width, state) => Math.max(width, state.keyName.length), 0);
    const lines = [`OpenCode Go quota · ${states.length} keys`];
    let earliestResetName;
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
        if (state.blockedForSec === undefined)
            continue;
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
/**
 * Reads the usage endpoint once per configured key, in parallel and in the given order.
 * Every key gets its own 10 s window, so one silent key cannot delay the others.
 */
export async function collectUsageReports(targets, activeKeyIndex, fetchApi, timers) {
    return Promise.all(targets.map(async (target) => {
        const result = await fetchOpenCodeGoUsage(target, fetchApi, timers);
        return {
            keyIndex: target.keyIndex,
            keyName: target.keyName,
            active: target.keyIndex === activeKeyIndex,
            result,
        };
    }));
}
