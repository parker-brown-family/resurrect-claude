#!/usr/bin/env bun
/**
 * resurrect -- restore cleared tool results in Claude Code sessions
 *
 * Claude Code time-based microcompact replaces old tool result content with
 * "[Old tool result content cleared]" when the 1-hour KV cache TTL expires.
 * This tool re-executes the original tool calls and writes real output back.
 *
 * Usage:
 *   bun run index.ts [session.jsonl] [--dry-run] [--skip-bash]
 *   bun run index.ts --list
 *   bun run index.ts --help
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";

const CLEARED = "[Old tool result content cleared]";
const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

// -- Types --------------------------------------------------------------------

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown[];
  [k: string]: unknown;
}

type ContentBlock = ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

interface SessionLine {
  type?: string;
  message?: { role: string; content: string | ContentBlock[] };
  [k: string]: unknown;
}

// -- Session discovery --------------------------------------------------------

function getAllSessions(): { path: string; mtime: number }[] {
  const sessions: { path: string; mtime: number }[] = [];
  if (!existsSync(CLAUDE_PROJECTS)) return sessions;
  for (const proj of readdirSync(CLAUDE_PROJECTS)) {
    const projPath = join(CLAUDE_PROJECTS, proj);
    try {
      for (const file of readdirSync(projPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const fp = join(projPath, file);
        const { mtimeMs } = statSync(fp);
        sessions.push({ path: fp, mtime: mtimeMs });
      }
    } catch {}
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

function findSession(override?: string): string {
  if (override) {
    if (!existsSync(override)) throw new Error("File not found: " + override);
    return override;
  }
  const sessions = getAllSessions();
  if (sessions.length === 0) throw new Error("No sessions found in " + CLAUDE_PROJECTS);
  return sessions[0].path;
}

// -- Tool execution -----------------------------------------------------------

function runShell(command: string, timeoutMs = 15_000): string {
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  const combined = ((result.stdout ?? "") + (result.stderr ?? "")).trimEnd();
  if (result.status !== 0) {
    return ("Exit code " + (result.status ?? 1) + "\n" + combined).trimEnd();
  }
  return combined;
}

// Tools the microcompact source marks compactable:
// Read, Bash (shell tools), Grep, Glob, WebSearch, WebFetch, Edit, Write
function executeTool(
  name: string,
  input: Record<string, unknown>,
  opts: { skipBash: boolean }
): string | null {
  switch (name) {
    case "Read":
    case "FileRead": {
      const fp = (input.file_path ?? input.path) as string;
      if (!fp) return "[resurrect: missing file_path]";
      try { return readFileSync(fp, "utf-8"); }
      catch (e: any) { return "[resurrect: read failed -- " + e.message + "]"; }
    }

    case "Bash": {
      if (opts.skipBash) return null;
      const cmd = input.command as string;
      if (!cmd) return null;
      const timeoutMs = typeof input.timeout === "number"
        ? Math.min(input.timeout * 1000, 30_000)
        : 15_000;
      return runShell(cmd, timeoutMs);
    }

    case "Grep":
    case "GrepTool": {
      const pat = (input.pattern as string ?? "").replace(/"/g, "\"");
      const path = (input.path ?? ".") as string;
      const flags = input.case_insensitive ? "-rin" : "-rn";
      return runShell("grep " + flags + " \"" + pat + "\" \"" + path + "\" 2>/dev/null | head -500");
    }

    case "Glob":
    case "GlobTool": {
      const pat = input.pattern as string;
      const path = (input.path ?? ".") as string;
      return runShell("find \"" + path + "\" -name \"" + pat + "\" 2>/dev/null | head -500");
    }

    case "LS": {
      return runShell("ls -la \"" + (input.path ?? ".") + "\" 2>&1");
    }

    case "WebFetch": {
      const url = input.url as string;
      if (!url) return null;
      return runShell("curl -sL --max-time 10 \"" + url + "\" | head -c 50000");
    }

    // Write/edit tools -- do not re-run (side effects; state already changed)
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

// -- Session processor --------------------------------------------------------

function processSession(
  sessionPath: string,
  opts: { dryRun: boolean; skipBash: boolean }
): void {
  const rel = sessionPath.replace(homedir(), "~");
  console.error("Session: " + rel + "\n");

  const raw = readFileSync(sessionPath, "utf-8");
  const lines: SessionLine[] = raw
    .trim()
    .split("\n")
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch (e) { throw new Error("JSON parse error on line " + (i + 1) + ": " + e); }
    });

  // Build tool_use id -> block map from all assistant messages
  const toolUseMap = new Map<string, ToolUseBlock>();
  for (const line of lines) {
    const msg = line.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "tool_use") {
        toolUseMap.set(block.id, block as ToolUseBlock);
      }
    }
  }

  let resurrected = 0;
  let skipped = 0;

  const updated: SessionLine[] = lines.map((line) => {
    const msg = line.message;
    if (!msg || line.type !== "user" || !Array.isArray(msg.content)) return line;

    let touched = false;
    const newContent = (msg.content as ContentBlock[]).map((block) => {
      if (block.type !== "tool_result") return block;
      const result = block as ToolResultBlock;
      if (result.content !== CLEARED) return block;

      const toolUse = toolUseMap.get(result.tool_use_id);
      if (!toolUse) {
        console.error("  !  No tool_use found for " + result.tool_use_id);
        skipped++;
        return block;
      }

      const restored = executeTool(toolUse.name, toolUse.input, opts);
      if (restored === null) {
        console.error("  o  " + toolUse.name + " -- skipped (not safe to re-execute)");
        skipped++;
        return block;
      }

      resurrected++;
      const preview = restored.slice(0, 72).replace(/\n/g, "~");
      const nameCol = toolUse.name.padEnd(12);
      const lenCol = restored.length.toString().padStart(6);
      console.error("  +  " + nameCol + lenCol + " chars  \"" + preview + "\"");
      touched = true;
      return Object.assign({}, result, { content: restored });
    });

    if (!touched) return line;
    return Object.assign({}, line, { message: Object.assign({}, msg, { content: newContent }) });
  });

  console.error("\nResurrected: " + resurrected + "  Skipped: " + skipped);

  if (resurrected === 0) {
    console.error("Nothing to resurrect -- all tool results are already live.");
    return;
  }

  if (opts.dryRun) {
    console.error("(dry run -- nothing written)");
    return;
  }

  const backupPath = sessionPath + ".bak";
  copyFileSync(sessionPath, backupPath);
  writeFileSync(sessionPath, updated.map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.error("\nWritten:  " + rel);
  console.error("Backup:   " + rel + ".bak");
}

// -- Entry point --------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "resurrect -- restore cleared Claude Code tool results\n" +
      "\nUsage:" +
      "\n  bun run index.ts [session.jsonl] [--dry-run] [--skip-bash]" +
      "\n  bun run index.ts --list" +
      "\n\nOptions:" +
      "\n  --dry-run    Show what would be restored, do not write" +
      "\n  --skip-bash  Skip Bash tool re-execution (safe mode)" +
      "\n  --list       List all sessions, newest first" +
      "\n  --help       Show this help" +
      "\n\nIf no session file is given, uses the most recently modified session" +
      "\nin ~/.claude/projects/."
    );
    return;
  }

  if (args.includes("--list")) {
    const sessions = getAllSessions();
    if (sessions.length === 0) { console.log("No sessions found."); return; }
    for (const { path, mtime } of sessions.slice(0, 30)) {
      const age = Math.round((Date.now() - mtime) / 60_000);
      const ageStr = age < 60 ? age + "m" : age < 1440 ? Math.round(age / 60) + "h" : Math.round(age / 1440) + "d";
      console.log(ageStr.padStart(5) + "  " + path.replace(homedir(), "~"));
    }
    return;
  }

  const dryRun = args.includes("--dry-run");
  const skipBash = args.includes("--skip-bash");
  const sessionArg = args.find((a) => !a.startsWith("--"));

  try {
    const sessionPath = findSession(sessionArg);
    processSession(sessionPath, { dryRun, skipBash });
  } catch (e: any) {
    console.error("Error: " + e.message);
    process.exit(1);
  }
}

main();
