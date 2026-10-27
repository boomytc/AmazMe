# Coding agent regression suite

`test/suite/regressions/` holds issue-numbered regression tests for the coding agent.

- Run them through `npm test --workspace @amazme/coding-agent`, or one file with
  `npx vitest --run test/suite/regressions/<file>` from the package directory.
- Business execution uses the Python backend. Provider-bound tests use its faux
  provider; real credentials require an explicit opt-in.
- MCP protocol conformance belongs to the backend: run `npm run test:mcp-conformance`
  from the repository root.
