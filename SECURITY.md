# Security policy

## Supported versions

Only the latest released version of each plugin receives security fixes. Update with
`/plugin update <name>@adamzr-plugin-marketplace` before reporting.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub instead: open the
[Security tab](https://github.com/adamzr/adamzr-plugin-marketplace/security) and choose
**Report a vulnerability**. Include the plugin name and version, what an attacker could do,
and the steps to reproduce it.

You should get an acknowledgment within 3 business days. Once a fix ships, the advisory is
published with credit to you, unless you ask to stay anonymous.

## Scope

In scope: code and manifests in this repository, including hooks modules, MCP
configuration, and the CI workflows.

Out of scope: Claude Code itself (report those to
[Anthropic](https://www.anthropic.com/responsible-disclosure-policy)) and third-party
services a plugin talks to.
