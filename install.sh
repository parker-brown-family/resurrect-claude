#!/usr/bin/env bash
# install.sh — wire up the /resurrect slash command in Claude Code
#
# Writes ~/.claude/commands/resurrect.md pointing at this repo's index.ts.
# Run from anywhere; the script resolves its own location.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND_DIR="$HOME/.claude/commands"
COMMAND_FILE="$COMMAND_DIR/resurrect.md"

mkdir -p "$COMMAND_DIR"

cat > "$COMMAND_FILE" <<EOF
Run the resurrect tool to restore cleared tool results in this Claude Code session after time-based microcompaction.

## What to do

Run this command and report the output:

\`\`\`bash
bun run $SCRIPT_DIR/index.ts \$ARGUMENTS
\`\`\`

Pass any \$ARGUMENTS the user provided directly to the tool (e.g. \`--dry-run\`, \`--bash\`, \`--list\`, or a specific session path).

## After running

Report what was resurrected and what was skipped. If nothing was found (\`Nothing to resurrect\`), tell the user that their session likely uses the standard cached-MC path which never clears the JSONL, so no action is needed.
EOF

echo "Installed: $COMMAND_FILE"
echo "         → $SCRIPT_DIR/index.ts"
echo ""
echo "Restart Claude Code, then type /resurrect in any session."
