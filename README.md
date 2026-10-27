# adamzr-plugin-marketplace

[![CI](https://github.com/adamzr/adamzr-plugin-marketplace/actions/workflows/ci.yml/badge.svg)](https://github.com/adamzr/adamzr-plugin-marketplace/actions/workflows/ci.yml)

Claude Code plugins and mods by Adam Richeimer. Each plugin is a valid Claude Code plugin
and also conforms to [Agent Plugins 1.0.0](https://agent-plugins.org/specification).

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
A plugin carries two manifests: `.claude-plugin/plugin.json` for Claude Code, and `plugin.json`
at the plugin root for Agent Plugins.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in
[SECURITY.md](SECURITY.md). Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

MIT
