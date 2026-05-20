# resurrect

Restore cleared tool results in a Claude Code session after time-based microcompaction.

## When this applies

Claude Code has two context-trimming paths:

**Cached microcompact** (the default): Uses the cache-editing API to remove old
tool results server-side without touching the local session file. The JSONL is
never modified. This is what most users run.

**Time-based microcompact** (opt-in via GrowthBook flag `tengu_slate_heron`,
disabled by default): Fires when the gap since the last assistant message
exceeds a threshold (default 60 min), indicating the server-side prompt cache
has expired. It walks every tool result and replaces old content with a marker:

```
[Old tool result content cleared]
```

Every file read, grep output, bash result, and glob listing from the old part
of the session becomes that single string. The model can still see it ran a
`Read` on `src/index.ts` — it just cannot see what was in that file.

`resurrect` only does anything when the time-based path has fired. If you do
not see `[Old tool result content cleared]` in your session, nothing here
applies.

## The solution

The compaction only clears `tool_result` content. The `tool_use` blocks — the
original calls with their names and inputs — are never touched. Every cleared
result has a surviving `tool_use` that records exactly what was called and
with what arguments.

`resurrect` walks the session JSONL, builds a map of
`tool_use_id → { name, input }`, finds every result carrying the cleared
marker, re-executes the original call, and writes the real output back.

```
Session: ~/.claude/projects/-home-pbrown-myproject/abc123.jsonl

  +  Read           4821 chars  "{ import { createServer } from ..."
  +  Bash            312 chars  "bun test --watch~  14 tests passed"
  +  Grep            890 chars  "src/api.ts:42:  export function handleAuth..."
  +  Read           1204 chars  "# Architecture~..."

Resurrected: 4  Skipped: 1

Warning: resurrected output reflects current on-disk state, not session state.
Files or command outputs may have changed since the original tool call.

Written:  ~/.claude/projects/-home-pbrown-myproject/abc123.jsonl
Backup:   ~/.claude/projects/-home-pbrown-myproject/abc123.jsonl.bak
```

Reopen Claude Code and it loads the restored session.

**State drift caveat**: re-executed output reflects current disk state, not
state at the time of the original call. If Claude edited files during the
session, the resurrected Read will show the post-edit version — which is
usually what you want, but is not a perfect replay of history.

## Usage

```bash
# Auto-find the most recently modified interactive session and restore it
bun run ~/Projects/resurrect/index.ts

# Preview what would be restored without writing anything
bun run ~/Projects/resurrect/index.ts --dry-run

# Also re-run Bash commands (off by default — commands may be destructive)
bun run ~/Projects/resurrect/index.ts --bash

# Target a specific session file
bun run ~/Projects/resurrect/index.ts ~/.claude/projects/.../session.jsonl

# List all sessions, newest first (~ marks likely subagent sessions)
bun run ~/Projects/resurrect/index.ts --list
```

## What gets re-executed

| Tool | Action |
|------|--------|
| `Read` | Re-reads the file from disk |
| `Bash` | Re-runs the command (requires `--bash`) |
| `Grep` | Re-runs the grep |
| `Glob` | Re-scans with Bun.Glob (handles `**` correctly) |
| `LS` | Re-runs ls |
| `WebFetch` | Re-fetches and strips HTML markup |
| `Write`, `Edit`, `TodoWrite`, `WebSearch` | Skipped — side effects or time-sensitive |

Bash is off by default because commands from old sessions can be destructive
(`git reset --hard`, deployment scripts, etc.) and may produce wrong output
if state has changed. Use `--bash` only when you know the session's commands
are safe to replay.

The original `.jsonl` is backed up as `.jsonl.bak` before any write.

## Session auto-discovery

When no session file is given, `resurrect` picks the most recently modified
session that looks interactive (has at least one plain-text user turn, not only
tool results). This filters out subagent sessions — short-lived background
agents that Claude Code spins up internally and that are often modified more
recently than the main session.

Use `--list` to see all sessions. The `~` prefix marks likely subagent sessions.

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code sessions in `~/.claude/projects/` (default location)
- `tengu_slate_heron` GrowthBook flag enabled in your Claude Code build
  (this is what causes the cleared markers to appear in the first place)
