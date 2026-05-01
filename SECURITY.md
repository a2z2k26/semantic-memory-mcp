# Security Policy

## Threat model

The server is designed for **local-only** use:

- The MCP server communicates over stdio with a parent process (e.g. Claude Code). No network surface.
- The optional Memory Bridge HTTP server binds to `127.0.0.1` only, requires a per-instance auth token (`X-Bridge-Token`), and rejects non-loopback `Host` headers as a DNS-rebinding mitigation.

Do **not** expose the Memory Bridge via a reverse proxy, port forward, or to non-loopback addresses without adding additional authentication and TLS.

## Reporting a vulnerability

If you find a security issue, please email the maintainer at the address listed on the GitHub profile of the repository owner rather than opening a public issue. Provide:

- A description of the issue
- Steps to reproduce
- Affected versions
- Any suggested mitigation

You can expect an acknowledgment within a few days.
