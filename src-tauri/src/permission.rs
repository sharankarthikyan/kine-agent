//! Unified permission model spanning every agent CLI.
//!
//! The three CLIs speak different permission languages: Claude has a rich
//! `--permission-mode` (default/acceptEdits/plan/dontAsk/bypassPermissions; its `auto`
//! classifier mode is intentionally omitted because it aborts under headless `-p`),
//! Codex has only a `--sandbox` tier plus a full-bypass flag (its headless `exec`
//! has no interactive-approval prompt), and Antigravity's `--print` mode is
//! all-or-nothing (`--dangerously-skip-permissions`). This module maps one wire
//! vocabulary onto each CLI's real flags so the rest of the app reasons about a
//! single set of modes and the adapters stay declarative.
//!
//! The frontend only offers each agent the subset it truly supports (see
//! `src/lib/permissions.ts`); the mappings below also coerce any mode an agent
//! can't express to a safe nearest-equivalent, so a stray IPC value never widens
//! blast radius unexpectedly.

/// A permission mode as chosen in the UI and carried over IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    /// Read + plan only; no edits. Claude-native; Codex approximates with read-only.
    Plan,
    /// Read freely; edits/commands are not auto-approved (headless ⇒ effectively read-only).
    Default,
    /// Auto-apply file edits; risky shell/network still gated where the CLI supports a tier.
    AcceptEdits,
    /// Auto-approve everything, including shell and network. Highest blast radius.
    Full,
    /// Claude-only: auto-deny anything that would prompt; only pre-allowed tools run (CI-safe).
    DontAsk,
}

impl PermissionMode {
    /// Parse the wire id sent by the frontend. Returns `None` for unknown ids so the
    /// caller can fall back to a default rather than trusting arbitrary IPC input.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "plan" => Self::Plan,
            "default" => Self::Default,
            "acceptEdits" => Self::AcceptEdits,
            "full" => Self::Full,
            "dontAsk" => Self::DontAsk,
            _ => return None,
        })
    }

    /// Whether this is the maximal, gate-nothing mode. Adapters treat it specially
    /// (a dedicated bypass flag rather than a sandbox tier).
    pub fn is_full(self) -> bool {
        matches!(self, Self::Full)
    }

    /// The value for Claude's `--permission-mode <mode>`. Claude supports every unified
    /// mode natively, so this is a faithful 1:1 mapping (`Full` ⇒ `bypassPermissions`).
    pub fn claude_flag(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Full => "bypassPermissions",
            Self::DontAsk => "dontAsk",
        }
    }

    /// The Codex `--sandbox <tier>` value. `Full` is NOT expressed here; it uses
    /// `--dangerously-bypass-approvals-and-sandbox` instead (see the codex adapter).
    ///
    /// Codex `exec` has no interactive-approval tier, so `Plan` and `Default` both map
    /// to `read-only`: "ask before edits" genuinely doesn't write (there is no live
    /// approver headless). `DontAsk` (Claude-only, not offered for Codex) coerces to the
    /// safe `read-only`.
    pub fn codex_sandbox(self) -> &'static str {
        match self {
            Self::Plan | Self::Default | Self::DontAsk => "read-only",
            Self::AcceptEdits => "workspace-write",
            // Kept sane for defense-in-depth; Full is handled via the bypass flag and
            // never actually reaches this arm through the codex adapter.
            Self::Full => "danger-full-access",
        }
    }

    /// Whether Antigravity should auto-approve all tool permissions
    /// (`--dangerously-skip-permissions`). `agy --print` has no edits-only tier (its
    /// only lever is blanket skip-all), so only `Full` grants it. Every other mode
    /// leaves the CLI's own settings-based gating in place.
    pub fn antigravity_skip_permissions(self) -> bool {
        self.is_full()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_wire_parses_every_known_id() {
        assert_eq!(
            PermissionMode::from_wire("plan"),
            Some(PermissionMode::Plan)
        );
        assert_eq!(
            PermissionMode::from_wire("default"),
            Some(PermissionMode::Default)
        );
        assert_eq!(
            PermissionMode::from_wire("acceptEdits"),
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(
            PermissionMode::from_wire("full"),
            Some(PermissionMode::Full)
        );
        assert_eq!(
            PermissionMode::from_wire("dontAsk"),
            Some(PermissionMode::DontAsk)
        );
    }

    #[test]
    fn from_wire_rejects_unknown_and_raw_cli_spellings() {
        assert_eq!(PermissionMode::from_wire("bypassPermissions"), None);
        assert_eq!(PermissionMode::from_wire(""), None);
        assert_eq!(PermissionMode::from_wire("YOLO"), None);
        // `auto` is intentionally unsupported: its classifier aborts under headless -p.
        assert_eq!(PermissionMode::from_wire("auto"), None);
    }

    #[test]
    fn claude_maps_full_to_bypass_and_passes_others_through() {
        assert_eq!(PermissionMode::Plan.claude_flag(), "plan");
        assert_eq!(PermissionMode::Default.claude_flag(), "default");
        assert_eq!(PermissionMode::AcceptEdits.claude_flag(), "acceptEdits");
        assert_eq!(PermissionMode::Full.claude_flag(), "bypassPermissions");
        assert_eq!(PermissionMode::DontAsk.claude_flag(), "dontAsk");
    }

    #[test]
    fn codex_default_is_read_only_and_accept_edits_writes() {
        // The quirk-fix: Default must be read-only (Codex used to write on default).
        assert_eq!(PermissionMode::Default.codex_sandbox(), "read-only");
        assert_eq!(PermissionMode::Plan.codex_sandbox(), "read-only");
        assert_eq!(
            PermissionMode::AcceptEdits.codex_sandbox(),
            "workspace-write"
        );
        assert!(PermissionMode::Full.is_full());
    }

    #[test]
    fn antigravity_only_full_skips_permissions() {
        assert!(PermissionMode::Full.antigravity_skip_permissions());
        assert!(!PermissionMode::AcceptEdits.antigravity_skip_permissions());
        assert!(!PermissionMode::Default.antigravity_skip_permissions());
        assert!(!PermissionMode::Plan.antigravity_skip_permissions());
    }
}
