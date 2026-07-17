//! Optional BYOK ("bring your own key") API-key authentication for spawned agents.
//!
//! Kine Agent's default remains driving each vendor's official CLI under the user's OWN
//! existing login (subscription/OAuth). This module adds an *opt-in* alternative: for
//! agents whose CLI honors an API key, the user can paste a key in Settings and Kine Agent
//! injects it as a child-process environment variable at spawn time — metered, first-party
//! API billing instead of consumer-subscription driving.
//!
//! Firm boundaries (verified 2026-07-17 against live CLIs + codex-rs source):
//! - The key is injected ONLY on the child env, per spawn. Kine Agent NEVER mutates the
//!   CLI's own auth store. In particular we never run `codex login --with-api-key`, which
//!   REWRITES `~/.codex/auth.json` and erases the user's ChatGPT-subscription tokens.
//! - The key is stored ONLY in the OS-native secure store (Keychain / Windows Credential
//!   Manager / Secret Service) via the `keyring` crate — never in the SQLite event log,
//!   never in process argv (world-readable via `ps`).
//! - Per-agent facts: `claude` reads `ANTHROPIC_API_KEY` and in `-p` mode the key silently
//!   wins over OAuth (documented precedence: cloud-creds > `ANTHROPIC_AUTH_TOKEN` >
//!   `ANTHROPIC_API_KEY` > apiKeyHelper > OAuth). `codex exec` reads `CODEX_API_KEY` — NOT
//!   `OPENAI_API_KEY`, which its auth path ignores. `agy` (Antigravity) has NO API-key
//!   path at all, so it is subscription-only here.
//! - Leak guard: when the user has EXPLICITLY chosen subscription mode we actively STRIP any
//!   inherited key env vars from the child, so a key they happen to have exported in their
//!   shell can't silently override the subscription login the UI says is active. With NO
//!   explicit choice the caller skips resolution entirely (`AgentAuth::default`, a no-op) so
//!   a legacy env-key setup keeps working — see `commands::run_persisting`.

use std::fmt;

/// Secure-store service name. Appears as the "service"/"where" column in Keychain
/// Access / Credential Manager, so keep it human-recognizable and STABLE — changing it
/// orphans every previously-saved key. Only the production backend references it; the
/// test backend uses an in-memory map, hence the test-only dead-code allowance.
#[cfg_attr(test, allow(dead_code))]
const KEYCHAIN_SERVICE: &str = "Kine Agent API Keys";

/// Which agents can authenticate with an API key, and the env var their CLI reads.
/// Antigravity is deliberately absent: its CLI offers no key path (confirmed with the
/// maintainer — google-antigravity/antigravity-cli#78), so it stays subscription-only.
fn api_key_env_var(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("ANTHROPIC_API_KEY"),
        // NOT `OPENAI_API_KEY`: `codex exec` reads only `CODEX_API_KEY`; its default
        // provider has `env_key: None`, so `OPENAI_API_KEY` is ignored by exec's auth.
        "codex" => Some("CODEX_API_KEY"),
        _ => None,
    }
}

/// Whether the app should offer an API-key option for this agent at all.
pub fn supports_api_key(agent: &str) -> bool {
    api_key_env_var(agent).is_some()
}

/// Env vars that must be REMOVED from the child in the given mode so the auth the UI
/// advertises is the auth actually used.
///
/// - Subscription: strip every key/token var for the agent, so an inherited shell export
///   can't silently override the subscription login.
/// - Api-key: strip only vars that OUTRANK our injected key in the CLI's precedence order,
///   so the key the user entered is the one that authenticates.
fn strip_vars(agent: &str, api_key_mode: bool) -> &'static [&'static str] {
    match (agent, api_key_mode) {
        // Claude precedence: cloud-provider creds > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY.
        // In key mode, clear everything above our ANTHROPIC_API_KEY so the entered key wins.
        ("claude", true) => &[
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
        ],
        ("claude", false) => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        // Codex: CODEX_API_KEY is the top of exec's precedence, so nothing outranks it in
        // key mode. OPENAI_API_KEY is ignored by exec but confuses `codex doctor`, so drop
        // it in both modes for an unambiguous env.
        ("codex", true) => &["OPENAI_API_KEY"],
        ("codex", false) => &["CODEX_API_KEY", "OPENAI_API_KEY"],
        _ => &[],
    }
}

/// The per-agent auth choice, resolved into concrete env operations to apply to a child
/// process. Carries the raw key when in API-key mode — see the redacted `Debug` below,
/// which keeps the key out of logs even though `Prompt` (its container) derives `Debug`.
#[derive(Clone, Default)]
pub struct AgentAuth {
    /// `(var, key)` to set on the child, when in API-key mode.
    inject: Option<(&'static str, String)>,
    /// Vars to remove from the child (conflicting or higher-precedence auth).
    strip: &'static [&'static str],
}

impl fmt::Debug for AgentAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never render the key. Show only which var would be set and what is stripped.
        f.debug_struct("AgentAuth")
            .field("inject", &self.inject.as_ref().map(|(var, _)| *var))
            .field("key_present", &self.inject.is_some())
            .field("strip", &self.strip)
            .finish()
    }
}

impl AgentAuth {
    /// Apply the resolved auth to a child command: set the injected key (if any) and
    /// remove every stripped var. A `Default` (no inject, empty strip) is a pure no-op,
    /// preserving the pre-BYOK behavior of inheriting the parent env unchanged.
    pub fn apply(&self, command: &mut tokio::process::Command) {
        for var in self.strip {
            command.env_remove(var);
        }
        if let Some((var, key)) = &self.inject {
            command.env(var, key);
        }
    }

    /// Test/inspection helper: the var this auth would set, if any.
    #[cfg(test)]
    pub fn injected_var(&self) -> Option<&'static str> {
        self.inject.as_ref().map(|(var, _)| *var)
    }

    /// Test/inspection helper: the vars this auth would remove.
    #[cfg(test)]
    pub fn stripped(&self) -> &'static [&'static str] {
        self.strip
    }
}

/// The user's persisted auth choice for an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// Drive the CLI under the user's own login (the default).
    Subscription,
    /// Inject the user's stored API key at spawn.
    ApiKey,
}

impl AuthMode {
    /// Wire form persisted in the DB and exchanged with the frontend.
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::Subscription => "subscription",
            AuthMode::ApiKey => "apikey",
        }
    }

    /// Parse the wire form; anything unrecognized (including a missing row) is the safe
    /// default, Subscription.
    pub fn from_wire(s: Option<&str>) -> AuthMode {
        match s {
            Some("apikey") => AuthMode::ApiKey,
            _ => AuthMode::Subscription,
        }
    }
}

/// Resolve an agent's persisted mode into the concrete env operations for a spawn.
///
/// Reads the stored key from the OS keychain when in API-key mode. If the agent doesn't
/// support keys, or the mode is Subscription, the result strips inherited key vars and
/// injects nothing. If API-key mode is set but the key can't be read (deleted out from
/// under us, locked keychain), we fall back to subscription-style stripping and log —
/// never silently inheriting a stray key, and never aborting the run.
///
/// Blocking (the keychain read is synchronous) — call from `spawn_blocking`.
pub fn resolve(agent: &str, mode: AuthMode) -> AgentAuth {
    let Some(var) = api_key_env_var(agent) else {
        // Agent has no API-key path (e.g. Antigravity): always subscription, nothing to do.
        return AgentAuth {
            inject: None,
            strip: strip_vars(agent, false),
        };
    };

    if mode == AuthMode::ApiKey {
        match read_key(agent) {
            Ok(Some(key)) => {
                return AgentAuth {
                    inject: Some((var, key)),
                    strip: strip_vars(agent, true),
                };
            }
            Ok(None) => {
                eprintln!(
                    "auth: {agent} is set to API-key mode but no key is stored — using subscription login"
                );
            }
            Err(e) => {
                eprintln!("auth: could not read {agent} API key from the keychain ({e}) — using subscription login");
            }
        }
    }

    AgentAuth {
        inject: None,
        strip: strip_vars(agent, false),
    }
}

// ─── Keychain access ────────────────────────────────────────────────────────────
//
// All keychain functions are blocking (the `keyring` API is synchronous). Callers on the
// async runtime must wrap them in `spawn_blocking`. The raw store/get/delete are behind a
// `backend` module so tests use a shared in-memory map (the `keyring` MockCredential is
// per-Entry, so it can't model store-then-read across separate `Entry`s); production always
// uses the real OS keychain via `keyring`, which `cargo build`/`clippy` still type-check.

/// Store (or replace) the API key for an agent in the OS secure store.
pub fn store_key(agent: &str, key: &str) -> Result<(), String> {
    backend::set(agent, key)
}

/// Read the stored API key for an agent, or `None` if none is stored.
pub fn read_key(agent: &str) -> Result<Option<String>, String> {
    backend::get(agent)
}

/// Whether a key is stored for an agent (without exposing the key itself).
pub fn has_key(agent: &str) -> Result<bool, String> {
    Ok(read_key(agent)?.is_some())
}

/// Remove the stored API key for an agent. Deleting a key that isn't there succeeds.
pub fn delete_key(agent: &str) -> Result<(), String> {
    backend::delete(agent)
}

/// Production keychain backend: the real OS secure store via `keyring`.
#[cfg(not(test))]
mod backend {
    use super::KEYCHAIN_SERVICE;

    fn entry(agent: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, agent)
            .map_err(|e| format!("failed to open the OS keychain: {e}"))
    }

    pub fn set(agent: &str, key: &str) -> Result<(), String> {
        entry(agent)?
            .set_password(key)
            .map_err(|e| format!("failed to store key in the OS keychain: {e}"))
    }

    pub fn get(agent: &str) -> Result<Option<String>, String> {
        match entry(agent)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("failed to read key from the OS keychain: {e}")),
        }
    }

    pub fn delete(agent: &str) -> Result<(), String> {
        match entry(agent)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("failed to delete key from the OS keychain: {e}")),
        }
    }
}

/// Test keychain backend: a process-wide in-memory map, so store-then-read is coherent
/// across calls without touching (or needing) a real OS keychain.
#[cfg(test)]
mod backend {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    fn store() -> &'static Mutex<HashMap<String, String>> {
        static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn set(agent: &str, key: &str) -> Result<(), String> {
        store()
            .lock()
            .unwrap()
            .insert(agent.to_string(), key.to_string());
        Ok(())
    }

    pub fn get(agent: &str) -> Result<Option<String>, String> {
        Ok(store().lock().unwrap().get(agent).cloned())
    }

    pub fn delete(agent: &str) -> Result<(), String> {
        store().lock().unwrap().remove(agent);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_has_no_api_key_path() {
        assert!(!supports_api_key("antigravity"));
        // Even if some caller sets ApiKey mode, resolve never injects for it.
        let auth = resolve("antigravity", AuthMode::ApiKey);
        assert_eq!(auth.injected_var(), None);
    }

    #[test]
    fn claude_and_codex_support_keys_with_correct_vars() {
        assert!(supports_api_key("claude"));
        assert!(supports_api_key("codex"));
        assert_eq!(api_key_env_var("claude"), Some("ANTHROPIC_API_KEY"));
        // The load-bearing correction: codex reads CODEX_API_KEY, not OPENAI_API_KEY.
        assert_eq!(api_key_env_var("codex"), Some("CODEX_API_KEY"));
    }

    #[test]
    fn subscription_mode_strips_inherited_key_vars() {
        let claude = resolve("claude", AuthMode::Subscription);
        assert_eq!(claude.injected_var(), None);
        assert!(claude.stripped().contains(&"ANTHROPIC_API_KEY"));
        assert!(claude.stripped().contains(&"ANTHROPIC_AUTH_TOKEN"));

        let codex = resolve("codex", AuthMode::Subscription);
        assert!(codex.stripped().contains(&"CODEX_API_KEY"));
        assert!(codex.stripped().contains(&"OPENAI_API_KEY"));
    }

    #[test]
    fn api_key_mode_injects_stored_key_and_strips_higher_precedence() {

        store_key("claude", "sk-ant-test").unwrap();

        let auth = resolve("claude", AuthMode::ApiKey);
        assert_eq!(auth.injected_var(), Some("ANTHROPIC_API_KEY"));
        // ANTHROPIC_AUTH_TOKEN outranks ANTHROPIC_API_KEY, so it must be stripped.
        assert!(auth.stripped().contains(&"ANTHROPIC_AUTH_TOKEN"));
        // We do NOT strip our own injected var.
        assert!(!auth.stripped().contains(&"ANTHROPIC_API_KEY"));

        delete_key("claude").unwrap();
    }

    #[test]
    fn api_key_mode_without_a_stored_key_falls_back_to_subscription() {

        // Ensure nothing is stored for codex.
        delete_key("codex").unwrap();

        let auth = resolve("codex", AuthMode::ApiKey);
        assert_eq!(auth.injected_var(), None);
        // Falls back to subscription stripping rather than inheriting a stray key.
        assert!(auth.stripped().contains(&"CODEX_API_KEY"));
    }

    #[test]
    fn store_read_delete_roundtrip() {

        assert!(!has_key("codex").unwrap());
        store_key("codex", "sk-secret").unwrap();
        assert!(has_key("codex").unwrap());
        assert_eq!(read_key("codex").unwrap().as_deref(), Some("sk-secret"));
        delete_key("codex").unwrap();
        assert!(!has_key("codex").unwrap());
        // Deleting an absent key is not an error.
        delete_key("codex").unwrap();
    }

    #[test]
    fn debug_never_prints_the_key() {
        let auth = AgentAuth {
            inject: Some(("ANTHROPIC_API_KEY", "sk-ant-super-secret".to_string())),
            strip: &[],
        };
        let rendered = format!("{auth:?}");
        assert!(!rendered.contains("super-secret"));
        assert!(rendered.contains("ANTHROPIC_API_KEY"));
        assert!(rendered.contains("key_present: true"));
    }
}
