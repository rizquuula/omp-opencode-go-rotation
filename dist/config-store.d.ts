export declare const CONFIG_PATH_ENV = "PI_OPENCODE_ROTATION_CONFIG";
export declare const DEFAULT_COOLDOWN_MINUTES = 60;
export declare const DEFAULT_WATCHDOG_IDLE_MS = 90000;
/** 0 disables proactive cadence rotation. */
export declare const DEFAULT_ROTATE_EVERY_REQUESTS = 0;
export interface KeyEntry {
    name: string;
    key: string;
}
export interface Config {
    keys: KeyEntry[];
    activeKeyIndex: number;
    cooldownMinutes: number;
    watchdogEnabled: boolean;
    watchdogIdleMs: number;
    /** Move to the next available key after this many provider requests. 0 disables cadence rotation. */
    rotateEveryRequests: number;
    /** Key index → epoch ms when cooldown started */
    cooldowns: Record<number, number>;
    quotaBlockedUntil: Record<number, number>;
}
export declare class ConfigLoadError extends Error {
    readonly path: string;
    constructor(path: string, reason: string);
}
export declare function createEmptyConfig(): Config;
export declare function getConfigPath(): string;
export declare function loadConfig(path?: string): Config;
export declare function updateConfig<T>(mutator: (config: Config) => T, path?: string): {
    config: Config;
    result: T;
};
export declare function writeConfig(config: Config, path?: string): void;
