# usage-awareness

A Claude Code mod that makes Claude aware of its own usage limits. It shows the 5-hour window, the 7-day window, per-model weekly windows (Opus, Sonnet, Fable), when each resets, this session's cost, and extra-usage credits. It warns Claude at milestones, tells it to checkpoint its work, and enforces per-session spend ceilings you set, so a long autonomous run stops cleanly instead of silently rolling into extra-usage credits.

Works on Pro, Max, Team and Enterprise logins (windows and credits), and on an API key, Bedrock, Vertex or Foundry (session cost only).

## What it does

- **A tool Claude calls**: `get_usage` reports every window with percent used and local reset time, session cost, extra-usage credits, the policy for this session, and a ready one-shot cron expression per reset so Claude can schedule a resume with `CronCreate`.
- **A tool Claude uses to record your policy**: `set_usage_policy`. Say "only use $50 of credits", "never use extra usage", or "stop at 90% and resume after the reset" and Claude records it; the mod enforces it.
- **Warnings injected into the conversation** at 80% and 95% (configurable), once per window period. The 95% warning spells out a checkpoint protocol: stop subagents, have each write `progress/<agent>.md`, write `PROGRESS.md` linking them, then ask before spending credits.
- **Enforcement**: at a hard ceiling the mod denies tool calls (except AskUserQuestion, the cron tools, TaskStop, SendMessage and its own tools), aborts the running turn, and sends a desktop notification. Warn-only mode is available.
- **A lift that always works**: `/usage-aware lift` is answered by the mod itself, immediately, even mid-turn, with no model turn and no tool call, so the block cannot stop it.
- **Per-session, persistent**: ceilings and the block are keyed by session id and kept in the plugin store, so several sessions can run with different ceilings, and a resumed session keeps its own.
- A status-line entry (`5h 82% · 7d 61% · Fable 30% · $12.40`) once any window reaches the warn threshold or a block is in force, and a band above the prompt when a threshold or ceiling is in play.

## Install

At the prompt of a terminal session:

```
/plugin marketplace add adamzr/adamzr-plugin-marketplace
/plugin install usage-awareness@adamzr-plugin-marketplace
```

From a shell:

```
claude plugin marketplace add adamzr/adamzr-plugin-marketplace
claude plugin install usage-awareness@adamzr-plugin-marketplace
```

Pick a scope when asked, then run `/reload-plugins` in any session that is already open. In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `adamzr/adamzr-plugin-marketplace`, then Add plugin.

To try it from a clone without installing: `claude --plugin-dir /path/to/adamzr-plugin-marketplace/plugins/usage-awareness`.

## Commands

```
/usage-aware                 show usage, reset times and the session policy
/usage-aware credits 50      allow extra usage, up to $50 in this session (from now)
/usage-aware allow-extra     allow extra usage in this session, no ceiling
/usage-aware no-extra        never use extra usage in this session (block when exhausted)
/usage-aware cost 20         stop when this session has cost $20
/usage-aware stop-at 95      stop when any window reaches 95%
/usage-aware block | warn    at a ceiling: deny tool calls and abort, or only warn
/usage-aware lift            lift the block in force (allows extra usage, drops the ceiling hit)
/usage-aware clear           drop every ceiling for this session and unblock
/usage-aware default <...>   set the default policy new sessions start with
/usage-aware simulate 96     pretend a window is at 96% (testing); "simulate off" clears
```

Or just tell Claude in words. Examples:

- "Work until the usage limits are nearly hit, then stop all subagents, have them write their progress to files, write a PROGRESS.md that links to them, and stop before we use any credits."
- "Only use up to $50 of extra-usage credits in this session."
- "When you get close to the limit, stop and schedule a cron to resume when the limit resets."

## How the credit ceiling is counted

The extra-usage balance the usage endpoint reports is account-wide, shared by every session. A per-session ceiling is therefore measured against this session's own cost accrued while a plan window is exhausted (that is, while extra usage is in effect), counted from the moment the ceiling was set. The account-wide figure is shown for information.

## Settings (`userConfig`)

| Option | Default | Meaning |
| --- | --- | --- |
| `warnPercent` | 80 | First heads-up: wrap up and plan a checkpoint |
| `criticalPercent` | 95 | Checkpoint now; ask before continuing into extra usage |
| `allowExtraUsage` | false | Default for new sessions; `false` blocks once a window is exhausted |
| `enforce` | true | Deny tool calls and abort at a ceiling; `false` warns only |
| `pollMinutes` | 5 | How often to refresh the claude.ai usage endpoint |

Set them in `/plugin` (Configure) or in settings under `pluginConfigs`.

## Privacy

The mod reads the claude.ai usage endpoint with the session's own login through the engine's credential handle; the token never reaches the mod's code. It makes no other network request and writes nothing outside the plugin store.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir . --debug
```

## License

MIT
