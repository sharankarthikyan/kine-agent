# Design System

> Kine Agent is a local-first Tauri 2 desktop app that supervises AI coding-agent CLIs.
> **Design direction (user, 2026-06-28): minimalistic shadcn/ui aesthetic — ALWAYS.**
> This supersedes the original custom near-black token palette (`src/styles/tokens.css`),
> which the user explicitly disliked (too harsh/raw). Calm, neutral, low-contrast.

## UX Defaults
- Target users: expert developers / power users, keyboard-driven, running many agent sessions in parallel.
- Default interaction model: keyboard-friendly desktop; 3-zone master-detail (session list | chat | diff pane).
- Tone: calm and restrained — "felt, not seen". Whitespace and subtle surfaces over borders and color.
- **No decorative emoji:** UI uses Lucide icons (`data-icon`) exclusively — never emoji glyphs. All labels are normal-case (no uppercase / title-case forcing). Explicit user preference.

## Tokens (shadcn/ui, zinc base)
- **Colors:** shadcn CSS variables (`--background`, `--foreground`, `--card`, `--popover`, `--primary`,
  `--secondary`, `--muted`, `--muted-foreground`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`).
  Base palette **zinc**. Default theme **dark** (calm: `zinc-950` background, `zinc-900` cards, `zinc-50`
  foreground, `zinc-400` muted-foreground) — NOT pure black. Light theme available via `.dark` class toggle.
- **Status colors** (session state / diff): emerald (success/added), red=`destructive` (error/deleted),
  sky/blue (running/modified), amber (waiting). Always paired with an icon or text label — never color-only.
- **Typography:** `font-sans` (Inter / system) for UI; `font-mono` (JetBrains Mono / ui-monospace) for
  paths, diffs, ids, counts. Base `text-sm` (14px). `tabular-nums` on counts/durations. 2–3 text colors, 2 weights.
- **Spacing:** Tailwind 4px scale; `p-2`/`gap-2` base, `p-4` section padding. More space *around* groups than within.
- **Radii:** `--radius: 0.625rem` (shadcn default). `rounded-lg` cards/panels, `rounded-md` inputs/buttons,
  `rounded-xl` the composer, `rounded-full` status dots + the send button.
- **Shadows:** minimal — `shadow-sm` on raised elements (composer, popovers); flat elsewhere.
- **Icons:** **Lucide** (lucide-react), 16/20px, stroke-width 1.5–2.

## Motion
- **Transitions:** `duration-150 ease-out` for hover/press/selection; `duration-200` for layout (pane open/close).
- **Entrances:** subtle fade/slide for popovers, the diff pane, and new session rows.
- **Reduced motion:** respect `prefers-reduced-motion`; don't animate streaming text or row reordering.

## Component Library
- Framework: React 19 + Vite + TypeScript, inside Tauri 2 (system WebView).
- Styling: **Tailwind CSS** (v4).
- Components: **shadcn/ui** (Radix primitives + `cva` variants), copied into `src/components/ui/`.
- Installed: alert, badge, button, card, dropdown-menu, empty, input, progress, scroll-area, separator,
  sheet, skeleton, sonner (toast), switch, tabs, textarea, tooltip.
- Extension: custom variants via `cva()` in the component file; never fork a primitive unnecessarily.
- Composition: every component accepts `className` and merges via `cn()` (`src/lib/utils.ts`).

## Patterns
- **Layout:** 3-zone master-detail — session list (left, ~`w-72`, collapsible, state in `localStorage`) | chat (center, bottom-anchored composer) | context/changes/files pane (right, collapsible + expand-to-fullscreen). **Inset rounded-panel chrome:** all 3 columns are inset from the window edges with a gap; each is a `rounded-xl border border-border bg-card` surface on a darker window `background` — floating-card look (per Conductor screenshots / user feedback).
- **Composer (prompt bar):** modern AI-chat input — a roomy `rounded-xl` bordered card with a `Textarea`
  ("Message the agent…"), bottom-left a **model/agent selector** (Lucide icon + model name + tier `Badge` +
  chevron, via `DropdownMenu`/`Select`), bottom-right an attach icon button + a circular `rounded-full` send
  button (Lucide `ArrowUp`). Enter sends, Shift+Enter newline. (Reference: ChatGPT/Cursor composer.)
- **Session row:** status dot + title + textual status; active row = subtle `bg-accent` + left accent + `aria-current`.
- **Tool calls / file writes:** compact muted chips inside the assistant turn (not bordered rows).
- **Review entry point:** "N files changed" chip in the conversation opens the diff side-pane (per Design Ledger).
- **Loading:** `Skeleton` matching row geometry for lists; inline typing indicator for streaming output.
- **Errors:** inline, scoped to the turn/session (`destructive` accent); never blank the whole view.
- **Empty state:** centered icon + short heading + one CTA ("Start a session").
- **States:** every interactive component defines default / hover / focus-visible / disabled (+ loading/error where apt).
- **Right pane:** shadcn `Tabs` with three tabs — **Context** (window-usage `Progress` + cost, files this session, loaded rules/config open in a `Sheet`, discovered skills/subagents) · **Changes** (primary Commit button + branch-ahead badge + file rows; file row opens diff in a `Sheet`) · **Files** (collapsible directory tree). Pane is collapsible/expandable; all content is read-only, derived from agent events.
- **TitleBar:** 3-zone drag region (macOS traffic lights | centered app title | right buttons). Functional: left sidebar-toggle + right open-editor / open-terminal / theme-toggle buttons. Future stub buttons carry `aria-disabled` and never intercept pointer events.
- **Sidebar session rows:** status dot + status label (never color-only) + session title + muted diffstat `+A −D · relativeTime` (added in emerald, removed in `destructive`, `tabular-nums`). Group headers = `text-muted-foreground`, normal-case workspace name. Customizations section rows: Lucide icon + label + muted count (`tabular-nums`).
- **New-session:** centered card; repo picker and agent picker rendered as `DropdownMenu` triggers; full-width `Textarea` ("Describe the task…"); autonomy `Switch` labeled "Edit automatically".
- **Session-detail header:** status dot + session title + muted `<repo> · +A −D`; right: approve / pin stub buttons (`aria-disabled`) + close.
- **Responsive:** desktop-first; panes collapse gracefully on narrow widths (diff → tab fallback).
- **Dark mode:** default dark (calm zinc); light available via class toggle; theme-aware tokens only (no hardcoded hex).

## Z-Index Scale
- dropdown/popover/select: 50 · diff-pane-expanded overlay: 40 · toast (sonner): 60 · tooltip: 70.

## Accessibility
- Target: WCAG AA. Contrast ≥ 4.5:1 text, ≥ 3:1 large/UI.
- Focus: visible `ring` (`--ring`) on ALL interactive elements (shadcn default).
- Keyboard: full navigation; Enter/Shift+Enter in composer; Escape closes the diff pane / overlays.
- Status never conveyed by color alone (icon + text label always present).
