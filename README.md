# adamzr-plugin-marketplace

Claude Code plugins and mods by Adam Richeimer.

## Add the marketplace

At the prompt of a terminal session:

```
/plugin marketplace add adamzr/adamzr-plugin-marketplace
```

From a shell:

```
claude plugin marketplace add adamzr/adamzr-plugin-marketplace
```

Then install any plugin below with `/plugin install <name>@adamzr-plugin-marketplace`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [usage-awareness](plugins/usage-awareness) | Makes Claude aware of its own rate limits, reset times, session cost and extra-usage credits. It warns Claude at milestones and enforces per-session spend ceilings you set. |

## Layout

Each plugin lives in its own folder under `plugins/` and is listed in `.claude-plugin/marketplace.json`.

## License

MIT
