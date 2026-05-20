# resurrect

Restore cleared tool results in a Claude Code session after time-based microcompaction.

## The problem

When you return to a Claude Code session after an hour or more away, the responses feel
noticeably worse -- slower, less aware of the codebase, like the model forgot what it was
doing. It is easy to blame the model. The real cause is deliberate and surgical.

Anthropic's prompt cache has a 1-hour TTL. When Claude Code detects that the cache has
gone cold, it runs a **time-based microcompact** before sending the next request. This
function walks every tool result in the conversation and replaces the content of all but
the last few with a single marker string:

```ts
function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }

  ...

  let tokensSaved = 0
  const result: Message[] = messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content))
    let touched = false
    const newContent = message.message.content.map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.tool_use_id) &&
        block.content !== TIME_BASED_MC_CLEARED_MESSAGE
      ) {
        tokensSaved += calculateToolResultTokens(block)
        touched = true
        return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
      }
      return block
    })
  })
}
```

Every file read, grep output, bash result, and glob listing from the old part of the
session is replaced with `[Old tool result content cleared]`. The model can still
see that it ran a `Read` on `src/index.ts` two hours ago -- it just can no
longer see what was in that file.

This is a reasonable cost tradeoff. Re-uploading megabytes of stale tool output that
will not hit the cache is wasteful. But the side effect is that Claude is now working
from a sketch of the session rather than the session itself.

## The solution

The compaction only clears `tool_result` content. The `tool_use` blocks -- the
original tool calls with their names and inputs -- are never touched. Every cleared
result has a surviving `tool_use` that says exactly what was called and with what
arguments.

`resurrect` walks the session JSONL, builds a map of
`tool_use_id -> { name, input }`, finds every result carrying
`[Old tool result content cleared]`, re-executes the original call, and writes the
real output back into the file.

```
Session: ~/.claude/projects/-home-pbrown-myproject/abc123.jsonl

  +  Read           4821 chars  "{ import { createServer } from ..."
  +  Bash            312 chars  "bun test --watch~  14 tests passed"
  +  Grep            890 chars  "src/api.ts:42:  export function handleAuth..."
  +  Read           1204 chars  "# Architecture~..."

Resurrected: 4  Skipped: 1

Written:  ~/.claude/projects/-home-pbrown-myproject/abc123.jsonl
Backup:   ~/.claude/projects/-home-pbrown-myproject/abc123.jsonl.bak
```

Reopen Claude Code and it loads the restored session. The model has the actual data again.

## Usage

```bash
# Auto-find the most recently modified session and restore it
bun run ~/Projects/resurrect/index.ts

# Preview what would be restored without writing anything
bun run ~/Projects/resurrect/index.ts --dry-run

# Skip re-running Bash commands (restore only reads/greps/globs)
bun run ~/Projects/resurrect/index.ts --skip-bash

# Target a specific session file
bun run ~/Projects/resurrect/index.ts ~/.claude/projects/.../session.jsonl

# List all sessions, newest first
bun run ~/Projects/resurrect/index.ts --list
```

## What gets re-executed

| Tool | Action |
|------|--------|
| `Read` | Re-reads the file from disk |
| `Bash` | Re-runs the command (skip with `--skip-bash`) |
| `Grep` | Re-runs the grep |
| `Glob` | Re-runs the find |
| `LS` | Re-runs ls |
| `WebFetch` | Re-fetches the URL via curl |
| `Write`, `Edit`, `TodoWrite`, `WebSearch` | Skipped -- side effects or time-sensitive |

The original `.jsonl` is backed up as `.jsonl.bak` before any write.

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code sessions in `~/.claude/projects/` (default location)
