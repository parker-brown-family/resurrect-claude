#!/usr/bin/env bun
/**
 * resurrect -- restore cleared tool results in Claude Code sessions
 *
 * When the tengu_slate_heron GrowthBook flag is enabled, Claude Code's
 * time-based microcompact replaces old tool result content with
 * "[Old tool result content cleared]" when the server-side prompt cache TTL
 * (1 hour) expires. This tool re-executes the original tool calls and writes
 * the real output back into the session file.
 *
 * IMPORTANT: time-based MC is DISABLED by default. The standard cached-MC
 * path (used by most users) never modifies the JSONL — only time-based MC
 * does. If you see no "[Old tool result content cleared]" markers, nothing
 * here applies.
 *
 * Resurrected output reflects CURRENT state, not state at session time.
 * Bash re-execution is OFF by default (pass --bash to enable — commands may
 * be destructive or state-dependent).
 *
 * Usage:
 *   bun run index.ts [session.jsonl] [--dry-run] [--bash]
 *   bun run index.ts --list
 *   bun run index.ts --help
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  copyFileSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";

export const CLEARED = "[Old tool result content cleared]";
const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

// Only read this many bytes when checking if a session is interactive.
// A single JSONL line with a text user turn is well under 4 KB.
const INTERACTIVE_SCAN_BYTES = 4096;

// -- Types --------------------------------------------------------------------

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown[];
  [k: string]: unknown;
}

export type ContentBlock =
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [k: string]: unknown };

export interface SessionLine {
  type?: string;
  message?: { role: string; content: string | ContentBlock[] };
  [k: string]: unknown;
}

// -- Shell execution (injection-safe) -----------------------------------------

/**
 * Run a command with an explicit argument list — no shell interpolation.
 * Stdout and stderr are combined; non-zero exit is surfaced in the output.
 */
export function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 15_000,
): string {
  const result = spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    return "[resurrect: exec error — " + result.error.message + "]";
  }
  const out = (result.stdout ?? "").trimEnd();
  const err = (result.stderr ?? "").trimEnd();
  if (result.status !== 0) {
    return (
      "Exit code " +
      (result.status ?? 1) +
      (out ? "\n" + out : "") +
      (err ? "\n" + err : "")
    ).trimEnd();
  }
  return out || err;
}

// -- HTML stripping -----------------------------------------------------------

/**
 * Strip HTML markup from a raw fetch response so the model sees readable
 * text rather than raw tags. Exported for unit testing.
 */
export function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50_000);
}

// -- Tool execution -----------------------------------------------------------

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  opts: { bash: boolean },
): Promise<string | null> {
  switch (name) {
    case "Read":
    case "FileRead": {
      const fp = (input.file_path ?? input.path) as string | undefined;
      if (!fp) return "[resurrect: missing file_path]";
      try {
        return readFileSync(fp, "utf-8");
      } catch (e: any) {
        return "[resurrect: read failed — " + e.message + "]";
      }
    }

    case "Bash": {
      if (!opts.bash) return null;
      const cmd = input.command as string | undefined;
      if (!cmd) return null;
      const timeoutMs =
        typeof input.timeout === "number"
          ? Math.min(input.timeout * 1000, 30_000)
          : 15_000;
      // bash -c <cmd> — the command is a single argument, not interpolated
      // into a larger shell string.
      return runCommand("bash", ["-c", cmd], timeoutMs);
    }

    case "Grep":
    case "GrepTool": {
      const pat = input.pattern as string | undefined;
      const path = (input.path ?? ".") as string;
      if (!pat) return "[resurrect: missing pattern]";
      const flagArg = input.case_insensitive ? "-rin" : "-rn";
      // -- terminates flag parsing; pattern and path are separate args.
      const lines = runCommand("grep", [flagArg, "--", pat, path]).split("\n");
      return lines.slice(0, 500).join("\n");
    }

    case "Glob":
    case "GlobTool": {
      const pat = input.pattern as string | undefined;
      const root = (input.path ?? ".") as string;
      if (!pat) return "[resurrect: missing pattern]";
      // Bun.Glob handles **, ?, [...] correctly — find -name does not.
      // absolute: true avoids ambiguity about which directory relative paths
      // are relative to (resurrect may run from a different cwd than the
      // original session).
      const glob = new Bun.Glob(pat);
      const matches: string[] = [];
      for await (const file of glob.scan({ cwd: root, dot: true, absolute: true })) {
        matches.push(file);
        if (matches.length >= 500) break;
      }
      return matches.join("\n") || "(no matches)";
    }

    case "LS": {
      const path = (input.path ?? ".") as string;
      return runCommand("ls", ["-la", path]);
    }

    case "WebFetch": {
      const url = input.url as string | undefined;
      if (!url) return null;
      // curl args are a list — url is not interpolated into a shell string.
      const raw = runCommand("curl", ["-sL", "--max-time", "10", url]);
      return stripHtml(raw);
    }

    // Side-effect or time-sensitive — never re-execute.
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "FileWrite":
    case "FileEdit":
    case "TodoWrite":
    case "TodoRead":
    case "WebSearch":
      return null;

    default:
      return null;
  }
}

// -- Session discovery --------------------------------------------------------

/**
 * Read up to maxBytes from the start of a file without loading it all.
 * The tail may be a truncated UTF-8 sequence or partial JSON line; callers
 * must tolerate parse errors on the last element.
 */
function readHead(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Return true if the session looks like an interactive (main-thread) session:
 * at least one user message in the first 4 KB contains a text block (human
 * input), not only tool_result blocks.
 *
 * Subagent sessions (session_memory, prompt_suggestion, etc.) consist almost
 * entirely of tool_use / tool_result pairs and have no plain-text user turns.
 * Reading only the head avoids loading large session files in full.
 */
export function isInteractiveSession(path: string): boolean {
  try {
    const head = readHead(path, INTERACTIVE_SCAN_BYTES);
    const lines = head.split("\n");
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as SessionLine;
        if (obj.type === "user" && Array.isArray(obj.message?.content)) {
          for (const block of obj.message.content as ContentBlock[]) {
            if (block.type === "text") return true;
          }
        }
      } catch {
        // truncated or unparseable line — skip
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function getAllSessions(): { path: string; mtime: number; interactive: boolean }[] {
  const sessions: { path: string; mtime: number; interactive: boolean }[] = [];
  if (!existsSync(CLAUDE_PROJECTS)) return sessions;
  for (const proj of readdirSync(CLAUDE_PROJECTS)) {
    const projPath = join(CLAUDE_PROJECTS, proj);
    try {
      for (const file of readdirSync(projPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const fp = join(projPath, file);
        const { mtimeMs } = statSync(fp);
        sessions.push({
          path: fp,
          mtime: mtimeMs,
          interactive: isInteractiveSession(fp),
        });
      }
    } catch {
      // skip inaccessible project dirs
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

export function findSession(override?: string): string {
  if (override) {
    if (!existsSync(override)) throw new Error("File not found: " + override);
    return override;
  }
  const sessions = getAllSessions();
  if (sessions.length === 0)
    throw new Error("No sessions found in " + CLAUDE_PROJECTS);
  // Prefer the most-recently-modified interactive session.
  const interactive = sessions.find((s) => s.interactive);
  return (interactive ?? sessions[0]).path;
}

// -- Session processor --------------------------------------------------------

export async function processSession(
  sessionPath: string,
  opts: { dryRun: boolean; bash: boolean },
): Promise<void> {
  const rel = sessionPath.replace(homedir(), "~");
  console.error("Session: " + rel + "\n");

  const raw = readFileSync(sessionPath, "utf-8");
  const lines: SessionLine[] = raw
    .trim()
    .split("\n")
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error("JSON parse error on line " + (i + 1) + ": " + e);
      }
    });

  // Build tool_use id → block map from all assistant messages.
  const toolUseMap = new Map<string, ToolUseBlock>();
  for (const line of lines) {
    const msg = line.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "tool_use") {
        toolUseMap.set((block as ToolUseBlock).id, block as ToolUseBlock);
      }
    }
  }

  let resurrected = 0;
  let skipped = 0;

  const updated: SessionLine[] = [];
  for (const line of lines) {
    const msg = line.message;
    if (!msg || line.type !== "user" || !Array.isArray(msg.content)) {
      updated.push(line);
      continue;
    }

    let touched = false;
    const newContent: ContentBlock[] = [];
    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== "tool_result") {
        newContent.push(block);
        continue;
      }
      const result = block as ToolResultBlock;
      if (result.content !== CLEARED) {
        newContent.push(block);
        continue;
      }

      const toolUse = toolUseMap.get(result.tool_use_id);
      if (!toolUse) {
        console.error("  !  No tool_use found for " + result.tool_use_id);
        skipped++;
        newContent.push(block);
        continue;
      }

      const restored = await executeTool(toolUse.name, toolUse.input, opts);
      if (restored === null) {
        const reason =
          toolUse.name === "Bash" && !opts.bash
            ? "skipped (pass --bash to enable)"
            : "skipped (not safe to re-execute)";
        console.error("  o  " + toolUse.name.padEnd(12) + " -- " + reason);
        skipped++;
        newContent.push(block);
        continue;
      }

      resurrected++;
      const preview = restored.slice(0, 72).replace(/\n/g, "~");
      console.error(
        "  +  " +
          toolUse.name.padEnd(12) +
          restored.length.toString().padStart(6) +
          ' chars  "' +
          preview +
          '"',
      );
      touched = true;
      newContent.push(Object.assign({}, result, { content: restored }));
    }

    if (!touched) {
      updated.push(line);
    } else {
      updated.push(
        Object.assign({}, line, {
          message: Object.assign({}, msg, { content: newContent }),
        }),
      );
    }
  }

  console.error("\nResurrected: " + resurrected + "  Skipped: " + skipped);

  if (resurrected === 0) {
    console.error("Nothing to resurrect — all tool results are already live.");
    return;
  }

  console.error(
    "\nWarning: resurrected output reflects current on-disk state, not " +
      "session state.\nFiles or command outputs may have changed since the " +
      "original tool call.",
  );

  if (opts.dryRun) {
    console.error("\n(dry run — nothing written)");
    return;
  }

  const backupPath = sessionPath + ".bak";
  if (existsSync(backupPath)) {
    // Never overwrite an existing backup — the first one is the pristine
    // original. If the user wants a fresh backup they can delete it manually.
    console.error("\nBackup already exists (preserving original): " + backupPath.replace(homedir(), "~"));
  } else {
    copyFileSync(sessionPath, backupPath);
    console.error("\nBackup:   " + backupPath.replace(homedir(), "~"));
  }

  writeFileSync(
    sessionPath,
    updated.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  console.error("Written:  " + rel);
}

// -- Entry point --------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Migration: --skip-bash was removed; bash is off by default now.
  if (args.includes("--skip-bash")) {
    console.error(
      "Note: --skip-bash is no longer needed. Bash re-execution is off by " +
        "default.\nRemove --skip-bash from your command. Use --bash to opt in.",
    );
    process.exit(1);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "resurrect — restore cleared Claude Code tool results\n" +
        "\nUsage:" +
        "\n  bun run index.ts [session.jsonl] [--dry-run] [--bash]" +
        "\n  bun run index.ts --list" +
        "\n\nOptions:" +
        "\n  --dry-run  Show what would be restored; do not write" +
        "\n  --bash     Re-execute Bash commands (off by default — commands may be destructive)" +
        "\n  --list     List all sessions, newest first" +
        "\n  --help     Show this help" +
        "\n\nIf no session file is given, uses the most recently modified interactive" +
        "\nsession in ~/.claude/projects/." +
        "\n\nOnly fires when Claude Code's time-based microcompact has run" +
        "\n(tengu_slate_heron GrowthBook flag, disabled by default). The standard" +
        "\ncached-MC path never modifies the session JSONL.",
    );
    return;
  }

  if (args.includes("--list")) {
    const sessions = getAllSessions();
    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }
    for (const { path, mtime, interactive } of sessions.slice(0, 30)) {
      const age = Math.round((Date.now() - mtime) / 60_000);
      const ageStr =
        age < 60
          ? age + "m"
          : age < 1440
            ? Math.round(age / 60) + "h"
            : Math.round(age / 1440) + "d";
      // ~ marks subagent sessions (no interactive text turns)
      const marker = interactive ? " " : "~";
      console.log(
        ageStr.padStart(5) + marker + " " + path.replace(homedir(), "~"),
      );
    }
    console.error("\n~ = likely subagent session (no interactive user turns)");
    return;
  }

  const dryRun = args.includes("--dry-run");
  const bash = args.includes("--bash");
  const sessionArg = args.find((a) => !a.startsWith("--"));

  try {
    const sessionPath = findSession(sessionArg);
    await processSession(sessionPath, { dryRun, bash });
  } catch (e: any) {
    console.error("Error: " + e.message);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
