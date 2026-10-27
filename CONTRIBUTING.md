# Contributing

Thanks for helping out. Bug reports, fixes, and new plugins are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.
- By contributing, you agree that your work is licensed under the [MIT License](LICENSE).

## Setup

You need [Claude Code](https://code.claude.com), Python 3.12 or later, and git.

```bash
git clone https://github.com/adamzr/adamzr-plugin-marketplace
cd adamzr-plugin-marketplace
python3 -m venv .venv && .venv/bin/pip install -r .github/requirements-ci.txt
```

Try a plugin from your checkout without installing it:

```bash
claude --plugin-dir plugins/<name>
```

## Checks

CI runs these on every pull request. Run them locally first:

```bash
claude plugin validate --strict .
claude plugin validate --strict plugins/<name>
claude plugin test plugins/<name>                 # mods with *.test.ts files
.venv/bin/python scripts/validate.py --since main
.venv/bin/ruff check . && .venv/bin/ruff format --check .
actionlint && zizmor --persona pedantic .github/  # when you touch .github/
```

## Rules for plugin changes

[CLAUDE.md](CLAUDE.md) is the full rulebook. The short version:

- Each plugin has two manifests that must agree: `.claude-plugin/plugin.json` for Claude
  Code and `plugin.json` for [Agent Plugins 1.0.0](https://agent-plugins.org/specification).
- Bump the plugin's version, in both manifests and in `.claude-plugin/marketplace.json`,
  for any change other than its README.
- Add a test for behavior you change in a mod.

## Pull requests

- Branch from `main`. Direct pushes to `main` are blocked.
- Keep each pull request to one change, and fill in the template.
- All checks must pass. Pull requests are squash-merged.
