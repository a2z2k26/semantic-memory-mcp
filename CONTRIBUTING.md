# Contributing

Thanks for your interest in improving bumba-memory-mcp.

## Development setup

```bash
git clone https://github.com/a2z2k26/bumba-memory-mcp.git
cd bumba-memory-mcp
npm install
npm test
```

## Project layout

```
src/
├── mcp-server.js              # MCP server entry (the bin)
├── memory-bridge-server.js    # Optional HTTP bridge for sandboxes
├── storage/                   # SQLite adapter + schema reference
├── memory/                    # Team memory coordination
├── peers/                     # Peer registration & messaging
└── lib/                       # Shared utilities (logger, conflict resolver, etc.)
test/                          # Integration tests
docs/                          # Reference documentation
```

`index.js` at the repo root is the library entry — exports `BumbaMemorySystem` for programmatic use.

## Running

- `npm start` — run the MCP server over stdio
- `npm run bridge` — run the HTTP Memory Bridge (loopback only, token-authenticated)
- `npm test` — run the peer-discovery integration test suite

## Pull requests

- Keep changes focused; one concern per PR.
- Update tests when changing behavior.
- Update the README if you change tool surface, env vars, or install flow.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).

## Reporting security issues

Please do not file public issues for security problems. See `SECURITY.md`.
