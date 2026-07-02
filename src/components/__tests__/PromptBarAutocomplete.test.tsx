import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptBar } from "../PromptBar";
import type { ModelInfo } from "../../lib/models";

// Mock the IPC layer so the hook's data fetches resolve without a Tauri backend.
vi.mock("@/lib/conductor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conductor")>();
  return {
    ...actual,
    worktreeTree: vi.fn(async () => [
      { path: "src", isDir: true, status: null },
      { path: "src/App.tsx", isDir: false, status: "modified" },
      { path: "README.md", isDir: false, status: null },
    ]),
    readWorktreeFile: vi.fn(async (_sessionId: string, path: string) => `body of ${path}`),
    listDir: vi.fn(async (path: string) => {
      if (path === "~/") return [{ name: "docs", isDir: true }, { name: "notes.md", isDir: false }];
      if (path === "~/docs/") return [{ name: "spec.md", isDir: false }];
      return [];
    }),
    readAnyFile: vi.fn(async (p: string) => `global body of ${p}`),
  };
});

vi.mock("@/lib/inspect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inspect")>();
  return {
    ...actual,
    listCapabilities: vi.fn(async () => ({
      skills: [{ name: "deploy", description: "Ship it", source: "user", path: "" }],
      commands: [{ name: "review", description: "Review the diff", source: "project", path: "" }],
      subagents: [
        { name: "code-reviewer", description: "Reviews code", source: "user", path: "" },
      ],
    })),
  };
});

const PLACEHOLDER = "Message the agent…";

const opus: ModelInfo = {
  value: "opus",
  label: "Claude Opus 4.8",
  agent: "claude",
  description: null,
  disabled: false,
  contextWindow: null,
};

function setup(overrides: Partial<React.ComponentProps<typeof PromptBar>> = {}) {
  const onStart = vi.fn();
  render(
    <PromptBar
      onStart={onStart}
      running={false}
      models={[opus]}
      model={opus}
      onModelChange={vi.fn()}
      agent="claude"
      sessionId="s1"
      permissionMode="default"
      onPermissionModeChange={vi.fn()}
      {...overrides}
    />,
  );
  return { onStart };
}

// ── @file autocomplete ───────────────────────────────────────────────────────────

test("typing @ opens a file suggestion menu from the worktree", async () => {
  setup();
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "look @App");
  expect(await screen.findByRole("option", { name: /src\/App\.tsx/ })).toBeInTheDocument();
});

test("@./ is treated as repo-relative (./src matches src files, not scattered subsequences)", async () => {
  setup();
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "@./src");
  expect(await screen.findByRole("option", { name: /src\/App\.tsx/ })).toBeInTheDocument();
});

test("selecting a file inserts the @path token and does not send", async () => {
  const { onStart } = setup();
  const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  await userEvent.type(ta, "@App");
  await userEvent.click(await screen.findByRole("option", { name: /src\/App\.tsx/ }));
  expect(ta.value).toContain("@src/App.tsx ");
  expect(onStart).not.toHaveBeenCalled();
});

test("Enter accepts the active suggestion instead of sending while the menu is open", async () => {
  const { onStart } = setup();
  const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  await userEvent.type(ta, "@READ");
  await screen.findByRole("option", { name: /README\.md/ });
  await userEvent.type(ta, "{enter}");
  expect(onStart).not.toHaveBeenCalled();
  expect(ta.value).toContain("@README.md ");
});

test("Escape closes the menu and a subsequent Enter sends", async () => {
  const { onStart } = setup();
  const ta = screen.getByPlaceholderText(PLACEHOLDER);
  await userEvent.type(ta, "hi @App");
  await screen.findByRole("option", { name: /src\/App\.tsx/ });
  await userEvent.type(ta, "{escape}");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  await userEvent.type(ta, "{enter}");
  expect(onStart).toHaveBeenCalledTimes(1);
});

// ── /command autocomplete (claude) ────────────────────────────────────────────────

test("typing / at line start lists commands + skills for claude", async () => {
  setup();
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "/re");
  expect(await screen.findByRole("option", { name: /\/review/ })).toBeInTheDocument();
});

test("opens the command menu for a / typed after an @ mention", async () => {
  setup();
  // The reported bug: "@agent-… /command" must still autocomplete the command.
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "@agent-code-reviewer /re");
  expect(await screen.findByRole("option", { name: /\/review/ })).toBeInTheDocument();
});

test("does not open the command menu for an absolute path (interior slash)", async () => {
  setup();
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "/usr/re");
  // brief settle; an interior slash marks a path, not a command
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});

// ── @agent mentions (claude) ──────────────────────────────────────────────────────

test("typing @ surfaces claude subagents alongside files", async () => {
  setup({ agent: "claude" });
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "@code");
  expect(await screen.findByRole("option", { name: /code-reviewer/ })).toBeInTheDocument();
});

test("claude send expands an @agent token to the natural-language nudge", async () => {
  const { onStart } = setup({ agent: "claude" });
  const ta = screen.getByPlaceholderText(PLACEHOLDER);
  await userEvent.type(ta, "review @code");
  await userEvent.click(await screen.findByRole("option", { name: /code-reviewer/ }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onStart).toHaveBeenCalled());
  expect(onStart.mock.calls[0][0]).toBe('review the "code-reviewer" subagent');
});

// ── @ filesystem browsing (@~/ , @/) ────────────────────────────────────────────

test("@~/ browses the home directory and shows a caution notice", async () => {
  setup();
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "@~/");
  expect(await screen.findByRole("option", { name: /docs/ })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /notes\.md/ })).toBeInTheDocument();
  expect(screen.getByText(/Filesystem — outside the repo/)).toBeInTheDocument();
});

test("selecting a directory descends into it (keeps the menu open)", async () => {
  const { onStart } = setup({ agent: "claude" });
  const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  await userEvent.type(ta, "@~/");
  await userEvent.click(await screen.findByRole("option", { name: /docs\// }));
  expect(ta.value).toContain("@~/docs/");
  // menu re-lists the entered directory
  await userEvent.click(await screen.findByRole("option", { name: /spec\.md/ }));
  expect(ta.value).toContain("@~/docs/spec.md ");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  // claude resolves absolute/home paths itself → passed through unchanged
  expect(onStart).toHaveBeenCalledWith("@~/docs/spec.md", opus);
});

test("codex inlines a global @~/ file via the filesystem reader", async () => {
  const { onStart } = setup({ agent: "codex" });
  const ta = screen.getByPlaceholderText(PLACEHOLDER);
  await userEvent.type(ta, "@~/");
  await userEvent.click(await screen.findByRole("option", { name: /notes\.md/ }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onStart).toHaveBeenCalled());
  const [sent] = onStart.mock.calls[0];
  expect(sent).toContain("===== ~/notes.md =====");
  expect(sent).toContain("global body of ~/notes.md");
});

// ── per-agent send semantics ──────────────────────────────────────────────────────

test("claude send passes @tokens through unchanged (native resolution)", async () => {
  const { onStart } = setup({ agent: "claude" });
  const ta = screen.getByPlaceholderText(PLACEHOLDER);
  await userEvent.type(ta, "@App");
  await userEvent.click(await screen.findByRole("option", { name: /src\/App\.tsx/ }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onStart).toHaveBeenCalledWith("@src/App.tsx", opus);
});

test("codex send inlines the referenced file's contents", async () => {
  const { onStart } = setup({ agent: "codex" });
  const ta = screen.getByPlaceholderText(PLACEHOLDER);
  await userEvent.type(ta, "check @App");
  await userEvent.click(await screen.findByRole("option", { name: /src\/App\.tsx/ }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onStart).toHaveBeenCalled());
  const [sentText] = onStart.mock.calls[0];
  expect(sentText).toContain("===== src/App.tsx =====");
  expect(sentText).toContain("body of src/App.tsx");
  expect(sentText).toContain("check @src/App.tsx");
});
