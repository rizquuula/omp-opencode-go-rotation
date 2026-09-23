/**
 * End-to-end coverage for the multi-key `/opencode usage` and `/opencode quota` commands:
 * how many usage requests each command sends, what the rendered notification says, and which
 * notify level it carries.
 *
 * The host is faked here rather than imported. `test/extension-hooks.test.ts` imports the
 * `@mariozechner/*` runtime, which this port does not run against.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createOpencodeGoRotationExtension } from "../src/index.ts";
import type { FetchApi, FetchResponseApi, OpenCodeGoUsageWindow } from "../src/usage-report.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

interface FakeTimerEntry {
	readonly callback: () => void;
	readonly ms: number;
}

class FakeTimers {
	private nextId = 1;
	private readonly timers = new Map<number, FakeTimerEntry>();

	setTimeout = (callback: () => void, ms: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { callback, ms });
		return id;
	};

	clearTimeout = (timer: unknown): void => {
		if (typeof timer !== "number") return;
		this.timers.delete(timer);
	};

	/** Fires every pending timer that was registered with exactly this delay. */
	fireByDelay(ms: number): void {
		const pending = [...this.timers.entries()].filter(([, entry]) => entry.ms === ms);
		for (const [id, entry] of pending) {
			this.timers.delete(id);
			entry.callback();
		}
	}

	get delays(): number[] {
		return [...this.timers.values()].map((entry) => entry.ms);
	}
}

class FakeClock {
	time = 0;

	now = (): number => this.time;
}

type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface CommandRegistration {
	readonly description: string;
	readonly handler: CommandHandler;
}

class FakePi {
	readonly commands: Record<string, CommandRegistration> = {};

	on(): void {
		// Event handlers are not exercised by these command tests.
	}

	registerCommand(name: string, command: CommandRegistration): void {
		this.commands[name] = command;
	}

	async runCommand(name: string, args: string, ctx: ExtensionContext): Promise<unknown> {
		const command = this.commands[name];
		assert.ok(command, `missing command ${name}`);
		return await command.handler(args, ctx);
	}
}

interface FakeNotification {
	readonly message: string;
	readonly level: string;
}

interface FakeContextState {
	readonly notifications: FakeNotification[];
}

function createContext(state: FakeContextState): ExtensionContext {
	const context = {
		model: { provider: "opencode-go", baseUrl: "https://example.test/opencode" },
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
			authStorage: {
				setRuntimeApiKey: () => {},
				removeRuntimeApiKey: () => {},
			},
		},
		ui: {
			notify: (message: string, level: string) => {
				state.notifications.push({ message, level });
			},
		},
		abort: () => {},
	};
	// Test double: this object implements only the ExtensionContext fields the extension uses.
	return context as unknown as ExtensionContext;
}

const TWO_KEYS = [{ name: "one", key: "sk-one" }, { name: "two", key: "sk-two" }];
const THREE_KEYS = [...TWO_KEYS, { name: "three", key: "sk-three" }];

function writeConfigFile(path: string, overrides: Record<string, unknown>): void {
	writeFileSync(path, JSON.stringify({
		keys: TWO_KEYS,
		activeKeyIndex: 0,
		cooldownMinutes: 60,
		watchdogEnabled: true,
		watchdogIdleMs: 90_000,
		cooldowns: {},
		quotaBlockedUntil: {},
		...overrides,
	}), { mode: 0o600 });
}

let tempConfigQueue = Promise.resolve();

async function withTempConfig(run: (configPath: string) => Promise<void>, overrides: Record<string, unknown> = {}): Promise<void> {
	const previous = tempConfigQueue;
	let release: () => void = () => {};
	tempConfigQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;

	const dir = mkdtempSync(join(tmpdir(), "opencode-usage-command-test-"));
	const configPath = join(dir, "opencode-keys.json");
	const previousConfigPath = process.env.PI_OPENCODE_ROTATION_CONFIG;
	process.env.PI_OPENCODE_ROTATION_CONFIG = configPath;
	writeConfigFile(configPath, overrides);
	try {
		await run(configPath);
	} finally {
		if (previousConfigPath === undefined) {
			delete process.env.PI_OPENCODE_ROTATION_CONFIG;
		} else {
			process.env.PI_OPENCODE_ROTATION_CONFIG = previousConfigPath;
		}
		rmSync(dir, { recursive: true, force: true });
		release();
	}
}

const notFoundFetch: FetchApi = async () => ({ ok: false, status: 404, json: async () => ({}) });

function createHarness(fetch: FetchApi = notFoundFetch): { pi: FakePi; ctx: ExtensionContext; state: FakeContextState; timers: FakeTimers; clock: FakeClock } {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	const pi = new FakePi();
	const state: FakeContextState = { notifications: [] };
	const ctx = createContext(state);
	createOpencodeGoRotationExtension({ timers, clock, fetch })(pi as unknown as ExtensionAPI);
	return { pi, ctx, state, timers, clock };
}

interface RecordedRequest {
	readonly url: string;
	readonly method: string;
	readonly authorization: string | undefined;
}

interface FakeResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly body: unknown;
}

function recordingFetch(respond: (authorization: string | undefined) => FakeResponse): { fetch: FetchApi; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetch: FetchApi = async (url, init) => {
		const authorization = init.headers.Authorization;
		requests.push({ url, method: init.method, authorization });
		const response = respond(authorization);
		return { ok: response.ok, status: response.status, json: async () => response.body };
	};
	return { fetch, requests };
}

const neverResolvingFetch: FetchApi = () => new Promise<FetchResponseApi>(() => {});

const ACTIVE_WINDOW: OpenCodeGoUsageWindow[] = [{ name: "weekly", status: "active", usagePercent: 12 }];
const RATE_LIMITED_WINDOW: OpenCodeGoUsageWindow[] = [{ name: "weekly", status: "rate-limited", usagePercent: 100 }];
const OK_ACTIVE: FakeResponse = { ok: true, status: 200, body: { windows: ACTIVE_WINDOW } };
const OK_RATE_LIMITED: FakeResponse = { ok: true, status: 200, body: { windows: RATE_LIMITED_WINDOW } };
/** A rejected request that still carries a rate-limited body: the body must be ignored. */
const FAILED_WITH_RATE_LIMITED_BODY: FakeResponse = { ok: false, status: 500, body: { windows: RATE_LIMITED_WINDOW } };

function latestNotification(state: FakeContextState): FakeNotification {
	const latest = state.notifications.at(-1);
	assert.ok(latest, "expected the command to notify");
	return latest;
}

/** No command may render key material, whatever else the report says. */
function assertNoKeyMaterial(state: FakeContextState): void {
	assert.ok(state.notifications.length > 0, "expected the command to notify");
	for (const notification of state.notifications) {
		assert.equal(notification.message.includes("sk-"), false, `notification leaked key material: ${notification.message}`);
	}
}

test("/opencode usage queries every configured key with its own bearer and reports all of them", async () => {
	await withTempConfig(async () => {
		const { fetch, requests } = recordingFetch(() => OK_ACTIVE);
		const { pi, ctx, state } = createHarness(fetch);

		await pi.runCommand("opencode", "usage", ctx);

		assert.deepEqual(requests, [
			{ url: USAGE_URL, method: "GET", authorization: "Bearer sk-one" },
			{ url: USAGE_URL, method: "GET", authorization: "Bearer sk-two" },
		]);
		const notification = latestNotification(state);
		assert.equal(notification.message, [
			"OpenCode Go usage · 2 keys · active: 1 one",
			"→ 1. one",
			"     weekly   active        12% used",
			"  2. two",
			"     weekly   active        12% used",
		].join("\n"));
		assert.equal(notification.level, "info");
		assertNoKeyMaterial(state);
	});
});

test("/opencode usage still reports the other keys when one key fails", async () => {
	await withTempConfig(async () => {
		const { fetch } = recordingFetch((authorization) => authorization === "Bearer sk-two"
			? { ok: false, status: 500, body: {} }
			: OK_ACTIVE);
		const { pi, ctx, state } = createHarness(fetch);

		await pi.runCommand("opencode", "usage", ctx);

		const notification = latestNotification(state);
		assert.equal(notification.message, [
			"OpenCode Go usage · 2 keys · active: 1 one",
			"→ 1. one",
			"     weekly   active        12% used",
			"  2. two",
			"     unavailable: Usage request failed with HTTP 500.",
		].join("\n"));
		assert.equal(notification.level, "info");
		assertNoKeyMaterial(state);
	});
});

test("/opencode usage gives every key its own 10s window", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state, timers } = createHarness(neverResolvingFetch);

		const pending = pi.runCommand("opencode", "usage", ctx);
		assert.deepEqual(timers.delays, [10_000, 10_000]);

		timers.fireByDelay(10_000);
		await pending;

		const notification = latestNotification(state);
		assert.equal(notification.message, [
			"OpenCode Go usage · 2 keys · active: 1 one",
			"→ 1. one",
			"     unavailable: Usage request timed out after 10s.",
			"  2. two",
			"     unavailable: Usage request timed out after 10s.",
		].join("\n"));
		assert.equal(notification.level, "warning");
		assertNoKeyMaterial(state);
	});
});

test("/opencode usage tags a quota-blocked key with the wording /opencode status uses", async () => {
	await withTempConfig(async () => {
		const { fetch } = recordingFetch(() => OK_ACTIVE);
		const { pi, ctx, state } = createHarness(fetch);

		await pi.runCommand("opencode", "usage", ctx);

		const notification = latestNotification(state);
		assert.equal(notification.message, [
			"OpenCode Go usage · 2 keys · active: 1 one",
			"→ 1. one",
			"     weekly   active        12% used",
			"  2. two  [quota-blocked 2h 10m]",
			"     weekly   active        12% used",
		].join("\n"));
		assertNoKeyMaterial(state);
	}, { quotaBlockedUntil: { 1: 7_800_000 } });
});

test("/opencode quota queries every key and describes each one's own restriction", async () => {
	await withTempConfig(async () => {
		const { fetch, requests } = recordingFetch((authorization) => authorization === "Bearer sk-one"
			? OK_RATE_LIMITED
			: OK_ACTIVE);
		const { pi, ctx, state } = createHarness(fetch);

		await pi.runCommand("opencode", "quota", ctx);

		assert.deepEqual(requests.map((request) => request.authorization), [
			"Bearer sk-one",
			"Bearer sk-two",
			"Bearer sk-three",
		]);
		const notification = latestNotification(state);
		assert.equal(notification.message, [
			"OpenCode Go quota · 3 keys",
			"  1. one    quota-blocked, resets in 2h 10m; weekly rate-limited",
			"  2. two    cooldown, ready in 3m",
			"→ 3. three  available",
			"earliest reset in 2h 10m (one)",
		].join("\n"));
		assert.equal(notification.level, "info");
		assertNoKeyMaterial(state);
	}, {
		keys: THREE_KEYS,
		cooldownMinutes: 3,
		cooldowns: { 1: 0 },
		quotaBlockedUntil: { 0: 7_800_000 },
	});
});

test("/opencode quota reports an all-clear fleet with no earliest reset", async () => {
	await withTempConfig(async () => {
		const { fetch } = recordingFetch(() => OK_ACTIVE);
		const { pi, ctx, state } = createHarness(fetch);

		await pi.runCommand("opencode", "quota", ctx);

		const notification = latestNotification(state);
		assert.equal(notification.message, [
			"OpenCode Go quota · 2 keys",
			"→ 1. one  available",
			"  2. two  available",
			"earliest reset: none",
		].join("\n"));
		assert.equal(notification.level, "info");
		assertNoKeyMaterial(state);
	});
});

test("/opencode quota warns when every key failed and reads no window from a failed response", async () => {
	await withTempConfig(async () => {
		const { fetch } = recordingFetch(() => FAILED_WITH_RATE_LIMITED_BODY);
		const { pi, ctx, state } = createHarness(fetch);

		await pi.runCommand("opencode", "quota", ctx);

		const notification = latestNotification(state);
		assert.equal(notification.message, [
			"OpenCode Go quota · 2 keys",
			"→ 1. one  available",
			"  2. two  available",
			"earliest reset: none",
		].join("\n"));
		assert.equal(notification.level, "warning");
		assertNoKeyMaterial(state);
	});
});

test("/opencode status keeps its exact output for a blocked key and a cooling key", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness();

		await pi.runCommand("opencode", "status", ctx);

		assert.equal(latestNotification(state).message, [
			"→ 1. one [quota-blocked 2h 10m]",
			"  2. two [cooldown 3m]",
			"  3. three",
			"Watchdog: on (90s idle)",
			"Rotate every: off",
		].join("\n"));
		assertNoKeyMaterial(state);
	}, {
		keys: THREE_KEYS,
		cooldownMinutes: 3,
		cooldowns: { 1: 0 },
		quotaBlockedUntil: { 0: 7_800_000 },
	});
});
