import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import {
  CLEARED,
  runCommand,
  stripHtml,
  executeTool,
  isInteractiveSession,
  processSession,
} from "./index";

// -- Helpers ------------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "resurrect-test-"));
}

/** Serialize a session as JSONL */
function writeSession(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Read and parse a session JSONL */
function readSession(path: string): object[] {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

/** A minimal assistant line with a single tool_use */
function assistantLine(id: string, name: string, input: object) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
    timestamp: new Date().toISOString(),
  };
}

/** A user line with a single tool_result */
function resultLine(tool_use_id: string, content: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id, content }],
    },
    timestamp: new Date().toISOString(),
  };
}

/** A user line with a plain text message */
function textLine(text: string) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    timestamp: new Date().toISOString(),
  };
}

// -- runCommand ---------------------------------------------------------------

describe("runCommand", () => {
  it("returns stdout on success", () => {
    const out = runCommand("echo", ["hello"]);
    expect(out).toBe("hello");
  });

  it("surfaces non-zero exit code in output", () => {
    const out = runCommand("bash", ["-c", "exit 42"]);
    expect(out).toContain("42");
  });

  it("does not interpolate arguments as shell — semicolons are literal", () => {
    // If args were joined into a shell string this would echo 'injected'.
    const out = runCommand("echo", ["safe; echo injected"]);
    expect(out).toBe("safe; echo injected");
    expect(out).not.toContain("injected\n");
  });

  it("handles a missing executable gracefully", () => {
    const out = runCommand("__resurrect_nonexistent__", []);
    expect(out).toContain("[resurrect: exec error");
  });
});

// -- stripHtml ----------------------------------------------------------------

describe("stripHtml", () => {
  it("removes script blocks entirely", () => {
    const out = stripHtml("<script>alert('xss')</script>Hello");
    expect(out).not.toContain("alert");
    expect(out).toContain("Hello");
  });

  it("removes style blocks entirely", () => {
    const out = stripHtml("<style>.foo { color: red }</style>World");
    expect(out).not.toContain(".foo");
    expect(out).toContain("World");
  });

  it("strips tags and decodes entities", () => {
    const out = stripHtml("<p>Hello &amp; <b>World</b> &lt;em&gt;</p>");
    expect(out).toBe("Hello & World <em>");
  });

  it("collapses whitespace", () => {
    const out = stripHtml("<p>  foo   </p>  <p>  bar  </p>");
    expect(out).toBe("foo bar");
  });

  it("truncates at 50000 chars", () => {
    const out = stripHtml("a".repeat(100_000));
    expect(out.length).toBe(50_000);
  });
});

// -- executeTool --------------------------------------------------------------

describe("executeTool — Read", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns file contents", async () => {
    const fp = join(dir, "test.txt");
    writeFileSync(fp, "hello from file");
    const out = await executeTool("Read", { file_path: fp }, { bash: false });
    expect(out).toBe("hello from file");
  });

  it("returns error string for missing file", async () => {
    const out = await executeTool("Read", { file_path: join(dir, "nope.txt") }, { bash: false });
    expect(out).toMatch(/\[resurrect: read failed/);
  });

  it("returns error string when file_path is absent", async () => {
    const out = await executeTool("Read", {}, { bash: false });
    expect(out).toBe("[resurrect: missing file_path]");
  });

  it("accepts FileRead alias", async () => {
    const fp = join(dir, "alias.txt");
    writeFileSync(fp, "alias content");
    const out = await executeTool("FileRead", { file_path: fp }, { bash: false });
    expect(out).toBe("alias content");
  });
});

describe("executeTool — Bash", () => {
  it("returns null when bash is disabled", async () => {
    const out = await executeTool("Bash", { command: "echo hi" }, { bash: false });
    expect(out).toBeNull();
  });

  it("runs the command when bash is enabled", async () => {
    const out = await executeTool("Bash", { command: "echo hello" }, { bash: true });
    expect(out).toBe("hello");
  });

  it("returns null when command is missing", async () => {
    const out = await executeTool("Bash", {}, { bash: true });
    expect(out).toBeNull();
  });

  it("caps timeout at 30 seconds", async () => {
    // Supplying a huge timeout in input should be capped; the command itself
    // is fast so we just verify it completes without error.
    const out = await executeTool(
      "Bash",
      { command: "echo capped", timeout: 99999 },
      { bash: true },
    );
    expect(out).toBe("capped");
  });
});

describe("executeTool — Grep", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds matching lines", async () => {
    writeFileSync(join(dir, "a.txt"), "foo\nbar\nbaz");
    const out = await executeTool("Grep", { pattern: "bar", path: dir }, { bash: false });
    expect(out).toContain("bar");
    expect(out).not.toContain("foo");
  });

  it("is case-insensitive when flag is set", async () => {
    writeFileSync(join(dir, "b.txt"), "Hello World");
    const out = await executeTool(
      "Grep",
      { pattern: "hello", path: dir, case_insensitive: true },
      { bash: false },
    );
    expect(out).toContain("Hello World");
  });

  it("returns error string when pattern is missing", async () => {
    const out = await executeTool("Grep", { path: dir }, { bash: false });
    expect(out).toBe("[resurrect: missing pattern]");
  });

  it("treats pattern as a literal arg — semicolons do not inject", async () => {
    writeFileSync(join(dir, "c.txt"), "safe");
    // A shell-injected pattern would cause problems; here it's just passed
    // literally to grep and should produce no output (or an error).
    const out = await executeTool(
      "Grep",
      { pattern: "x; echo injected", path: dir },
      { bash: false },
    );
    expect(out).not.toContain("injected");
  });
});

describe("executeTool — Glob", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("matches files by extension", async () => {
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "b.ts"), "");
    writeFileSync(join(dir, "c.txt"), "");
    const out = await executeTool("Glob", { pattern: "*.ts", path: dir }, { bash: false });
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
    expect(out).not.toContain("c.txt");
  });

  it("handles ** recursive patterns correctly", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "deep.ts"), "");
    writeFileSync(join(dir, "top.ts"), "");
    const out = await executeTool("Glob", { pattern: "**/*.ts", path: dir }, { bash: false });
    expect(out).toContain("deep.ts");
    expect(out).toContain("top.ts");
  });

  it("returns (no matches) for a pattern with zero hits", async () => {
    const out = await executeTool("Glob", { pattern: "*.xyz", path: dir }, { bash: false });
    expect(out).toBe("(no matches)");
  });

  it("returns error string when pattern is missing", async () => {
    const out = await executeTool("Glob", { path: dir }, { bash: false });
    expect(out).toBe("[resurrect: missing pattern]");
  });

  it("returns absolute paths", async () => {
    writeFileSync(join(dir, "abs.ts"), "");
    const out = await executeTool("Glob", { pattern: "*.ts", path: dir }, { bash: false });
    // Should contain the full absolute path, not just the filename.
    expect(out).toContain(dir);
  });
});

describe("executeTool — skip list", () => {
  const skipped = ["Write", "Edit", "MultiEdit", "FileWrite", "FileEdit", "TodoWrite", "TodoRead", "WebSearch"];
  for (const name of skipped) {
    it(`${name} returns null`, async () => {
      const out = await executeTool(name, {}, { bash: false });
      expect(out).toBeNull();
    });
  }

  it("unknown tool returns null", async () => {
    const out = await executeTool("SomeNewTool", {}, { bash: false });
    expect(out).toBeNull();
  });
});

// -- isInteractiveSession -----------------------------------------------------

describe("isInteractiveSession", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns true when a user message contains a text block", () => {
    const fp = join(dir, "interactive.jsonl");
    writeSession(fp, [
      textLine("What does this function do?"),
      assistantLine("tu_1", "Read", { file_path: "/some/file.ts" }),
      resultLine("tu_1", "export function foo() {}"),
    ]);
    expect(isInteractiveSession(fp)).toBe(true);
  });

  it("returns false for a subagent session with only tool_result user turns", () => {
    const fp = join(dir, "subagent.jsonl");
    writeSession(fp, [
      assistantLine("tu_1", "Read", { file_path: "/some/file.ts" }),
      resultLine("tu_1", "export function foo() {}"),
      assistantLine("tu_2", "Bash", { command: "ls" }),
      resultLine("tu_2", "file.ts"),
    ]);
    expect(isInteractiveSession(fp)).toBe(false);
  });

  it("returns false for an empty file", () => {
    const fp = join(dir, "empty.jsonl");
    writeFileSync(fp, "");
    expect(isInteractiveSession(fp)).toBe(false);
  });

  it("returns false for a nonexistent file", () => {
    expect(isInteractiveSession(join(dir, "nope.jsonl"))).toBe(false);
  });

  it("handles a file whose first 4KB is a partial line without crashing", () => {
    const fp = join(dir, "big.jsonl");
    // Write a line that starts with a text user message, then pad it well
    // past INTERACTIVE_SCAN_BYTES so the head read cuts it mid-line.
    const line = JSON.stringify(textLine("Hello")) + "\n" + "x".repeat(8192);
    writeFileSync(fp, line);
    // Should still find the text turn in the head.
    expect(isInteractiveSession(fp)).toBe(true);
  });
});

// -- processSession -----------------------------------------------------------

describe("processSession — basic restoration", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("restores a cleared Read result", async () => {
    const fp = join(dir, "target.txt");
    writeFileSync(fp, "restored content");

    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Read", { file_path: fp }),
      resultLine("tu_1", CLEARED),
    ]);

    await processSession(session, { dryRun: false, bash: false });

    const lines = readSession(session);
    const userLine = lines[1] as any;
    const block = userLine.message.content[0];
    expect(block.content).toBe("restored content");
  });

  it("leaves non-cleared results untouched", async () => {
    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Read", { file_path: "/some/file" }),
      resultLine("tu_1", "already live content"),
    ]);

    await processSession(session, { dryRun: false, bash: false });

    const lines = readSession(session);
    const userLine = lines[1] as any;
    expect(userLine.message.content[0].content).toBe("already live content");
  });

  it("skips Bash without --bash and leaves result as CLEARED", async () => {
    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Bash", { command: "echo hi" }),
      resultLine("tu_1", CLEARED),
    ]);

    await processSession(session, { dryRun: false, bash: false });

    const lines = readSession(session);
    const userLine = lines[1] as any;
    expect(userLine.message.content[0].content).toBe(CLEARED);
  });

  it("restores Bash when --bash is set", async () => {
    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Bash", { command: "echo hello" }),
      resultLine("tu_1", CLEARED),
    ]);

    await processSession(session, { dryRun: false, bash: true });

    const lines = readSession(session);
    const userLine = lines[1] as any;
    expect(userLine.message.content[0].content).toBe("hello");
  });

  it("skips Write and leaves result as CLEARED", async () => {
    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Write", { file_path: "/some/file", content: "x" }),
      resultLine("tu_1", CLEARED),
    ]);

    await processSession(session, { dryRun: false, bash: false });

    const lines = readSession(session);
    const userLine = lines[1] as any;
    expect(userLine.message.content[0].content).toBe(CLEARED);
  });

  it("restores multiple results in a single session", async () => {
    const fp1 = join(dir, "a.txt");
    const fp2 = join(dir, "b.txt");
    writeFileSync(fp1, "content A");
    writeFileSync(fp2, "content B");

    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Read", { file_path: fp1 }),
      assistantLine("tu_2", "Read", { file_path: fp2 }),
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: CLEARED },
            { type: "tool_result", tool_use_id: "tu_2", content: CLEARED },
          ],
        },
        timestamp: new Date().toISOString(),
      },
    ]);

    await processSession(session, { dryRun: false, bash: false });

    const lines = readSession(session);
    const userLine = lines[2] as any;
    expect(userLine.message.content[0].content).toBe("content A");
    expect(userLine.message.content[1].content).toBe("content B");
  });
});

describe("processSession — dry-run", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("does not write the session file", async () => {
    const fp = join(dir, "target.txt");
    writeFileSync(fp, "new content");

    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Read", { file_path: fp }),
      resultLine("tu_1", CLEARED),
    ]);
    const originalContent = readFileSync(session, "utf-8");

    await processSession(session, { dryRun: true, bash: false });

    expect(readFileSync(session, "utf-8")).toBe(originalContent);
  });

  it("does not create a backup in dry-run mode", async () => {
    const fp = join(dir, "target.txt");
    writeFileSync(fp, "content");

    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Read", { file_path: fp }),
      resultLine("tu_1", CLEARED),
    ]);

    await processSession(session, { dryRun: true, bash: false });

    expect(existsSync(session + ".bak")).toBe(false);
  });
});

describe("processSession — backup", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a .bak file on first run", async () => {
    const fp = join(dir, "target.txt");
    writeFileSync(fp, "content");

    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Read", { file_path: fp }),
      resultLine("tu_1", CLEARED),
    ]);

    await processSession(session, { dryRun: false, bash: false });

    expect(existsSync(session + ".bak")).toBe(true);
  });

  it("preserves original .bak on second run — does not overwrite", async () => {
    const fp = join(dir, "target.txt");
    writeFileSync(fp, "original content");

    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Read", { file_path: fp }),
      resultLine("tu_1", CLEARED),
    ]);

    // First run: creates .bak with original
    await processSession(session, { dryRun: false, bash: false });
    const firstBak = readFileSync(session + ".bak", "utf-8");

    // Mutate the file on disk and run again
    writeFileSync(fp, "mutated content");
    // Re-introduce a cleared marker so processSession has something to do
    writeSession(session, [
      assistantLine("tu_1", "Read", { file_path: fp }),
      resultLine("tu_1", CLEARED),
    ]);

    await processSession(session, { dryRun: false, bash: false });
    const secondBak = readFileSync(session + ".bak", "utf-8");

    // The backup must be unchanged — the original is preserved
    expect(secondBak).toBe(firstBak);
  });

  it("does nothing if there are no cleared markers", async () => {
    const session = join(dir, "session.jsonl");
    writeSession(session, [
      assistantLine("tu_1", "Read", { file_path: "/some/file" }),
      resultLine("tu_1", "live content"),
    ]);
    const before = readFileSync(session, "utf-8");

    await processSession(session, { dryRun: false, bash: false });

    expect(readFileSync(session, "utf-8")).toBe(before);
    expect(existsSync(session + ".bak")).toBe(false);
  });
});
