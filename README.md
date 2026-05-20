# resurrect

Restore cleared tool results in a Claude Code session after time-based microcompaction.

## Install

**Requirements:** [Bun](https://bun.sh), [Claude Code](https://claude.ai/code)

```bash
git clone https://github.com/parker-brown-family/resurrect-claude
cd resurrect-claude
bash install.sh
```

That's it. `install.sh` writes a `/resurrect` slash command to
`~/.claude/commands/` pointing at your clone. Restart Claude Code and
`/resurrect` is available in every session.

To run it directly without the slash command:

```bash
bun run /path/to/resurrect-claude/index.ts
```

## Usage

```bash
# Auto-find the most recently modified interactive session and restore it
/resurrect

# Preview what would be restored without writing anything
/resurrect --dry-run

# Also re-execute Bash commands (off by default — commands may be destructive)
/resurrect --bash

# Target a specific session file
/resurrect ~/.claude/projects/.../session.jsonl

# List all sessions, newest first (~ marks likely subagent sessions)
/resurrect --list
```

Or call the script directly:

```bash
bun run /path/to/resurrect-claude/index.ts [--dry-run] [--bash] [--list] [session.jsonl]
```

Example output:

```
Session: ~/.claude/projects/-home-you-myproject/abc123.jsonl

  +  Read           4821 chars  "{ import { createServer } from ..."
  +  Bash            312 chars  "bun test --watch~  14 tests passed"
  +  Grep            890 chars  "src/api.ts:42:  export function handleAuth..."
  +  Read           1204 chars  "# Architecture~..."

Resurrected: 4  Skipped: 1

Warning: resurrected output reflects current on-disk state, not session state.
Files or command outputs may have changed since the original tool call.

Backup:   ~/.claude/projects/-home-you-myproject/abc123.jsonl.bak
Written:  ~/.claude/projects/-home-you-myproject/abc123.jsonl
```

Reopen Claude Code and it loads the restored session with actual file
contents instead of cleared markers.

---

## When this applies

Claude Code has two context-trimming paths:

**Cached microcompact** (the default): Uses the cache-editing API to remove old
tool results server-side without touching the local session file. The JSONL is
never modified. This is what most users run — resurrect is a no-op here.

**Time-based microcompact** (opt-in via GrowthBook flag `tengu_slate_heron`,
disabled by default): Fires when the gap since the last assistant message
exceeds a threshold (default 60 min), indicating the server-side prompt cache
has expired. It walks every tool result and replaces old content with:

```
[Old tool result content cleared]
```

Every file read, grep output, bash result, and glob listing from the old part
of the session becomes that single string. The model can still see it ran a
`Read` on `src/index.ts` — it just cannot see what was in that file.

`resurrect` only does anything when the time-based path has fired. If you do
not see `[Old tool result content cleared]` in your session, there is nothing
to resurrect.

## How it works

The compaction only clears `tool_result` content. The `tool_use` blocks — the
original calls with their names and inputs — are never touched. Every cleared
result has a surviving `tool_use` that records exactly what was called and
with what arguments.

`resurrect` walks the session JSONL, builds a map of
`tool_use_id → { name, input }`, finds every result carrying the cleared
marker, re-executes the original call, and writes the real output back.

**State drift caveat**: re-executed output reflects current disk state, not
state at the time of the original call. If Claude edited files during the
session, the resurrected Read will show the post-edit version — which is
usually what you want, but is not a perfect replay of history.

## What gets re-executed

| Tool | Action |
|------|--------|
| `Read` / `FileRead` | Re-reads the file from disk |
| `Bash` | Re-runs the command (requires `--bash`) |
| `Grep` / `GrepTool` | Re-runs the grep |
| `Glob` / `GlobTool` | Re-scans with Bun.Glob (handles `**` correctly) |
| `LS` | Re-runs ls |
| `WebFetch` | Re-fetches and strips HTML markup |
| `Write`, `Edit`, `TodoWrite`, `WebSearch`, … | Skipped — side effects or time-sensitive |

Bash is off by default because commands from old sessions can be destructive
(`git reset --hard`, deployment scripts, etc.) and may produce wrong output
if state has changed. Use `--bash` only when you know the commands are safe
to replay.

The original `.jsonl` is backed up as `.jsonl.bak` before any write. If
`.bak` already exists it is left untouched — the first backup is the
pristine original.

## Session auto-discovery

When no session file is given, `resurrect` picks the most recently modified
session that looks interactive (has at least one plain-text user turn, not
only tool results). This filters out subagent sessions — short-lived
background agents Claude Code spins up internally — that are often modified
more recently than the main session.

Use `--list` to see all sessions. The `~` prefix marks likely subagent
sessions.

## Development

```bash
bun test        # run the test suite (51 tests)
bun test --watch
```
