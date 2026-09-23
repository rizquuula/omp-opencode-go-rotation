# omp-opencode-go-rotation

Rotate between multiple OpenCode Go API keys in [omp](https://omp.sh).

The extension reacts to rate limits and stalls, and it can also rotate on a request-count cadence.

Fork of [lnilluv/pi-opencode-go-rotation](https://github.com/lnilluv/pi-opencode-go-rotation) v1.5.3, ported to the omp extension API.

## Install

```bash
omp plugin install github:rizquuula/omp-opencode-go-rotation
```

For local development, clone the repository and link it:

```bash
git clone https://github.com/rizquuula/omp-opencode-go-rotation ~/Playground/omp-opencode-go-rotation
omp plugin link ~/Playground/omp-opencode-go-rotation
```

`dist/` is committed, so the linked or installed package runs without a build step.

## Update

omp pins a git install to the resolved commit. Install an explicit tag to move to a newer release:

```bash
omp plugin install github:rizquuula/omp-opencode-go-rotation#v1.7.0
```

Restart omp sessions after an update.

For a linked clone, run `git pull` and `bun run build`, then restart omp.

## Setup

Add your API keys:

```
/opencode add personal sk-xxxx
/opencode add work sk-yyyy
/opencode add backup sk-zzzz
```

The first key added becomes active immediately.

When no key is configured, the extension imports the credential that omp already stores for `opencode-go`.

## How it works

The extension sets the active key as a runtime API key override, so it takes priority over `OPENCODE_API_KEY`, `models.yml` keys, and credentials in `agent.db`.

Four rotation paths exist:

1. **Usage-verified Go quota exhaustion**: when OpenCode Go returns HTTP 429, the extension sends the active key to `https://opencode.ai/zen/go/v1/usage`. If a usage window is `rate-limited`, the failed key is blocked until the reported reset, and the next non-blocked key becomes active.
2. **Transient limit errors**: when the usage endpoint is unavailable, reports no rate-limited window, or does not answer within 10 seconds, the extension marks the current key as cooling down and switches to the next key that is not quota-blocked.
3. **Silent stalls**: when an `opencode-go` request shows no response or stream activity for the watchdog window, the extension rotates to an eligible key and aborts the hung turn.
4. **Cadence rotation**: when `rotateEveryRequests` is set, the extension moves to the next available key after that many provider requests, without waiting for an error.

Keys that are quota-blocked or cooling down are skipped. Manual `/opencode use <n>` and `/opencode next` clear both restrictions on the selected key. Cooldowns default to 60 minutes; quota blocks expire at their persisted deadline.

Usage commands use `https://opencode.ai/zen/go/v1/usage` and stop waiting after 10 seconds.

## Commands

| Command | Description |
|---------|-------------|
| `/opencode` or `/opencode status` | Show all keys, the active key marker, cooldown and quota-blocked status, watchdog state, and cadence |
| `/opencode usage` or `/opencode quota` | Fetch OpenCode Go usage for the active key without showing key material |
| `/opencode use <n>` | Switch to key number `n` (1-based) and clear its cooldown and quota block |
| `/opencode next` | Advance to the next configured key and clear its cooldown and quota block before activating it |
| `/opencode add <name> <key>` | Add a new key |
| `/opencode rm <n>` | Remove key number `n` |
| `/opencode reset` | Clear all cooldowns and quota blocks |
| `/opencode cooldown <min>` | Set or view cooldown duration in minutes |
| `/opencode rotate-every <n\|off>` | Rotate to the next available key every `n` provider requests, or show the current cadence |
| `/opencode events` | Show recent watchdog timeout history (last 10) |
| `/opencode watchdog [status\|on\|off\|<seconds>]` | Configure silent-stall detection |

## Configuration

Keys are stored in `~/.omp/agent/opencode-keys.json` with file permissions `0600`. Set `PI_OPENCODE_ROTATION_CONFIG` to use a different path. Status output shows key names only; it never shows key material.

```json
{
  "keys": [
    { "name": "personal", "key": "sk-xxx" },
    { "name": "work", "key": "sk-yyy" }
  ],
  "activeKeyIndex": 0,
  "cooldownMinutes": 60,
  "watchdogEnabled": true,
  "watchdogIdleMs": 90000,
  "rotateEveryRequests": 20,
  "cooldowns": {},
  "quotaBlockedUntil": {}
}
```

`rotateEveryRequests` counts provider requests for the active key. The counter resets at session start and whenever the active key changes, so the value means "requests per key". `0` disables cadence rotation.

## omp-specific behavior

- `after_provider_response` runs only for successful responses in the omp `openai-completions` provider, because the non-2xx path throws before the notification. Rotation therefore triggers from the failed turn: the extension classifies the error message at `message_end` and switches the key.
- omp ignores handler results on `message_end`. The watchdog still rotates and aborts a stalled turn, but it cannot rewrite the aborted message into a retryable error. omp's own stream-idle timeout and interrupted-turn recovery handle the retry.
- omp already rotates stored credentials for a provider when a usage limit is reached. While this extension is active, its runtime key override takes priority, so this extension owns rotation for `opencode-go`.
- Extension code is loaded when an omp process starts. Restart omp sessions after you update the plugin.

## Limitations

- The watchdog is scoped to the `opencode-go` provider only. Other providers are not aborted or rotated.
- A legitimate long-running request with no stream activity can be treated as stalled. Tune it with `/opencode watchdog <seconds>`, or disable it with `/opencode watchdog off`.
- Cadence rotation loses provider-side prompt cache on each switch when the cache is scoped to the account.
- Go plan limits are tied to the subscription workspace. Keys from one workspace may share one quota; rotation then spreads requests instead of adding capacity. See the [OpenCode Go documentation](https://opencode.ai/docs/go/).
- Keys added through `/opencode add` are stored in plaintext, and the config file is created and maintained with `0600` permissions.

## Tests

```bash
bun run typecheck
bun run test
```

`bun run test` runs `test/config-store.test.ts` and `test/watchdog.test.ts`.

`test/extension-hooks.test.ts` comes from upstream. It imports the `@mariozechner/*` runtime, so it does not run against omp. Keep it for reference when you merge upstream changes.

## Releases

Push `feat:` or `fix:` commits to `main` (or `dev`). The release workflow bumps the version, commits the bump, tags it, and creates a GitHub Release. It does not publish to npm.

## License

MIT. See [LICENSE](./LICENSE), which keeps the upstream copyright notice.
