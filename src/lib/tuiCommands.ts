/**
 * Claude Code built-in commands that only work in the interactive terminal UI —
 * they open a screen/picker or manage the interactive session/account, so a
 * headless `claude -p` spawn rejects them ("/status isn't available in this
 * environment"). Kine Agent intercepts these before spawning and shows a hint
 * instead of burning a session on a guaranteed refusal.
 *
 * Deliberately conservative: commands that print text headless (/usage, /cost,
 * /context, /compact) and bundled skills (/init, /code-review, …) are NOT here.
 * Source: https://code.claude.com/docs/en/commands (verified 2026-07-01;
 * /status rejection smoke-tested live via `claude -p`).
 */
const TUI_ONLY_CLAUDE_COMMANDS = new Set([
  // Settings / management screens
  "status",
  "config",
  "model",
  "effort",
  "permissions",
  "agents",
  "mcp",
  "hooks",
  "memory",
  "skills",
  "theme",
  "statusline",
  "terminal-setup",
  "keybindings",
  "ide",
  "doctor",
  "plugin",
  "release-notes",
  "privacy-settings",
  "chrome",
  "advisor",
  "sandbox",
  "fast",
  "voice",
  "color",
  "scroll-speed",
  "tui",
  "vim",
  "focus",
  // Interactive session lifecycle
  "clear",
  "exit",
  "quit",
  "resume",
  "rewind",
  "branch",
  "diff",
  "rename",
  "tasks",
  "bashes",
  "stop",
  "background",
  "desktop",
  "teleport",
  "tp",
  "goal",
  "plan",
  "add-dir",
  "cd",
  "remote-control",
  "remote-env",
  // Account / installer flows
  "login",
  "logout",
  "upgrade",
  "passes",
  "usage-credits",
  "mobile",
  "ios",
  "android",
  "stickers",
  "radio",
  "powerup",
  "feedback",
  "bug",
  "install-github-app",
  "install-slack-app",
  "web-setup",
  "setup-bedrock",
  "setup-vertex",
  "design-login",
  "heapdump",
  "reload-plugins",
  "reload-skills",
]);

/**
 * If `text` starts with a TUI-only Claude built-in, return its name; else null.
 * A user-defined skill/command of the same name wins — `claude -p` expands
 * custom commands, so those must be sent through.
 */
export function detectTuiOnlyCommand(
  text: string,
  customCommandNames: Iterable<string>,
): string | null {
  const match = text.trimStart().match(/^\/([A-Za-z0-9_-]+)(?:\s|$)/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!TUI_ONLY_CLAUDE_COMMANDS.has(name)) return null;
  for (const custom of customCommandNames) {
    if (custom.toLowerCase() === name) return null;
  }
  return name;
}
