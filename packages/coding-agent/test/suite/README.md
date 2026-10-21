# Coding agent regression suite

`test/suite/regressions/` holds issue-numbered regression tests for the coding agent.

- Run them through `npm test --workspace @amazme/coding-agent`, or one file with
  `npx vitest --run test/suite/regressions/<file>` from the package directory.
- Keep provider-bound tests deterministic and offline by using the faux provider from
  `@amazme/ai`; tests that need real credentials must stay gated and skipped without them.
- `test/mcp-conformance/` is a separate suite for MCP protocol conformance.
