#!/usr/bin/env python3
"""Repo checks that `claude plugin validate` does not cover.

- Each plugin's root plugin.json conforms to Agent Plugins 1.0.0.
- That file agrees with .claude-plugin/plugin.json on every field the spec defines.
- marketplace.json lists every plugin, with a matching source, name, and version.
- With --since REF, every plugin changed since REF has a higher version.

Exits 1 and prints one line per problem when any check fails.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "scripts" / "schemas" / "agent-plugins-1.0.0"
SPEC_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"

# Files whose edits do not need a version bump: they do not change what a client loads.
NO_BUMP_FILES = {"README.md", "LICENSE", "CHANGELOG.md"}


def load_json(path: Path, errors: list[str]) -> dict | None:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        errors.append(f"{rel(path)}: missing")
        return None
    except json.JSONDecodeError as exc:
        errors.append(f"{rel(path)}: invalid JSON ({exc})")
        return None
    if not isinstance(data, dict):
        errors.append(f"{rel(path)}: must be a JSON object")
        return None
    return data


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def schema_errors(validator: Draft202012Validator, data: dict, label: str) -> list[str]:
    return [
        f"{label}: {'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}"
        for e in validator.iter_errors(data)
    ]


def check_plugin(plugin_dir: Path, validators: dict, errors: list[str]) -> dict | None:
    spec_path = plugin_dir / "plugin.json"
    claude_path = plugin_dir / ".claude-plugin" / "plugin.json"
    spec = load_json(spec_path, errors)
    claude = load_json(claude_path, errors)
    if spec is None or claude is None:
        return None

    errors.extend(schema_errors(validators["plugin"], spec, rel(spec_path)))
    if spec.get("name") != plugin_dir.name:
        errors.append(f"{rel(spec_path)}: name must match the folder name {plugin_dir.name!r}")

    # Claude Code reads .claude-plugin/plugin.json, which may add Claude-only fields
    # (userConfig, types, ...). Every field the spec defines must agree in both files.
    spec_fields = set(validators["plugin"].schema["properties"]) - {"$schema"}
    for field in sorted(spec_fields):
        if spec.get(field) != claude.get(field):
            errors.append(
                f"{rel(spec_path)}: {field!r} differs from {rel(claude_path)} "
                f"({spec.get(field)!r} vs {claude.get(field)!r})"
            )

    mcp_path = plugin_dir / "mcp.json"
    if mcp_path.exists():
        mcp = load_json(mcp_path, errors)
        if mcp is not None:
            errors.extend(schema_errors(validators["mcp"], mcp, rel(mcp_path)))
    if "mcpServers" in claude:
        errors.append(f"{rel(claude_path)}: declare MCP servers in mcp.json, not inline")
    return spec


def check_marketplace(plugins: dict[str, dict], errors: list[str]) -> None:
    market = load_json(MARKETPLACE, errors)
    if market is None:
        return
    entries = {e.get("name"): e for e in market.get("plugins", [])}
    for name, spec in plugins.items():
        entry = entries.pop(name, None)
        if entry is None:
            errors.append(f"{rel(MARKETPLACE)}: no entry for plugins/{name}")
            continue
        if entry.get("source") != f"./plugins/{name}":
            errors.append(f"{rel(MARKETPLACE)}: {name}: source must be './plugins/{name}'")
        if entry.get("version") != spec.get("version"):
            errors.append(
                f"{rel(MARKETPLACE)}: {name}: version {entry.get('version')!r} "
                f"does not match plugin.json {spec.get('version')!r}"
            )
    for name in entries:
        errors.append(f"{rel(MARKETPLACE)}: entry {name!r} has no folder under plugins/")


def parse_version(version: str) -> tuple[int, ...] | None:
    core = version.split("-", 1)[0].split("+", 1)[0]
    parts = core.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        return None
    return tuple(int(p) for p in parts)


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout


def check_bumps(since: str, plugins: dict[str, dict], errors: list[str]) -> None:
    base = git("merge-base", since, "HEAD").strip()
    changed = git("diff", "--name-only", base).splitlines()  # Includes uncommitted edits.
    for name, spec in plugins.items():
        prefix = f"plugins/{name}/"
        touched = [f for f in changed if f.startswith(prefix) and Path(f).name not in NO_BUMP_FILES]
        if not touched:
            continue
        try:
            old = json.loads(git("show", f"{base}:{prefix}.claude-plugin/plugin.json"))
        except subprocess.CalledProcessError:
            continue  # New plugin: nothing to compare against.
        old_v, new_v = parse_version(old.get("version", "")), parse_version(spec.get("version", ""))
        if new_v is None:
            errors.append(f"{prefix}plugin.json: version {spec.get('version')!r} is not SemVer")
        elif old_v is not None and new_v <= old_v:
            errors.append(
                f"{prefix}: changed since {since} ({', '.join(touched[:3])}) "
                f"but version is still {spec.get('version')}; bump it"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--since", help="git ref to check version bumps against")
    args = parser.parse_args()

    validators = {}
    for key, url in (("plugin", SPEC_SCHEMA_URL), ("mcp", MCP_SCHEMA_URL)):
        schema = json.loads((SCHEMA_DIR / f"{key}.schema.json").read_text())
        if schema.get("$id") != url:
            print(f"vendored {key} schema is not {url}")
            return 1
        validators[key] = Draft202012Validator(schema)

    errors: list[str] = []
    plugins = {}
    for plugin_dir in sorted(p for p in (ROOT / "plugins").iterdir() if p.is_dir()):
        spec = check_plugin(plugin_dir, validators, errors)
        if spec is not None:
            plugins[plugin_dir.name] = spec
    check_marketplace(plugins, errors)
    if args.since:
        check_bumps(args.since, plugins, errors)

    for error in errors:
        print(f"::error::{error}" if "GITHUB_ACTIONS" in os.environ else error)
    if not errors:
        print(f"OK: {len(plugins)} plugin(s) pass the repo checks.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
