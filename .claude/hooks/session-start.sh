#!/bin/bash
# SessionStart hook (.claude/settings.json) of Claude Code cloud sessions: installs the npm packages and compiles, so
# that the scripts, the MCP server and the unit tests run at once, on samples/Demo too (skill reproduce-issue).
# Elsewhere (a local session, on Windows too) it does nothing. Its stdout goes to Claude's context: one line.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"
log="${TMPDIR:-/tmp}/session-start.log"
: > "$log"

# The packages, only when this script, package.json or package-lock.json changed since the last install that
# succeeded (the hashes are kept in node_modules, which git ignores). npm ci rather than npm install: it never
# rewrites package-lock.json, which a session could then commit by mistake.
hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2> /dev/null; then
  rm -f "$hashes"
  if ! npm ci --no-audit --no-fund >> "$log" 2>&1; then
    echo "npm ci failed: see $log" >&2
    exit 1
  fi
  sha256sum .claude/hooks/session-start.sh package.json package-lock.json > "$hashes"
fi

# out/, at every start: the code may have changed since. A branch that does not compile yet must not stop the session.
if npm run compile >> "$log" 2>&1; then
  echo "SessionStart: npm packages installed and out/ compiled; scripts/, out/mcp/server.js and npm run test:unit run now."
else
  echo "SessionStart: npm packages installed, but npm run compile failed (log: $log); run it to see the errors."
fi
