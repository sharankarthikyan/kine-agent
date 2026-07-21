import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  type AgentAuthStatus,
  type AuthMode,
  clearAgentApiKey,
  getAgentAuthStatus,
  setAgentApiKey,
  setAgentAuthMode,
} from "@/lib/agentAuth";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentLogo } from "@/components/AgentLogo";
import { AgentCustomize } from "@/components/AgentCustomize";
import type { AgentInfo } from "@/lib/models";
import {
  AGENT_META,
  type AgentMeta,
  type AgentPrefs,
  hasAcknowledged,
  isAgentEnabled,
  setAgentEnabled,
} from "@/lib/agentPrefs";

// Settings is a small orchestrator with a left nav + content panel — the same shell as
// CustomizationsDialog, so the two dialogs feel like siblings and new preference areas
// drop in as one more entry here. Only "agents" exists today.
export type SettingsSection = "agents" | "about";

interface NavItem {
  id: SettingsSection;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "about", label: "About", Icon: Info },
];

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Detected agents (for installed status); non-spawnable ones are ignored here. */
  agents: AgentInfo[];
  prefs: AgentPrefs;
  onPrefsChange: (next: AgentPrefs) => void;
}

// ─── Left nav ─────────────────────────────────────────────────────────────────

function NavRow({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  const { label, Icon } = item;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-1.5 rounded-md text-sm text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "hover:bg-muted/50",
        active ? "bg-muted text-foreground font-medium" : "text-muted-foreground",
      )}
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex-1 min-w-0 truncate">{label}</span>
    </button>
  );
}

// ─── Agents section ───────────────────────────────────────────────────────────

// A small colored warning glyph matching the muted-hint aesthetic elsewhere —
// amber for a cautionary path, destructive for the actively-enforced one.
function RiskGlyph({ meta }: { meta: AgentMeta }) {
  if (meta.risk === "compliant") return null;
  return (
    <AlertTriangle
      aria-hidden
      className={cn(
        "size-3 shrink-0",
        meta.risk === "high" ? "text-destructive" : "text-amber-500",
      )}
    />
  );
}

// A compact segmented-control button (Subscription | API key).
function SegButton({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
        disabled && "opacity-60",
      )}
    >
      {children}
    </button>
  );
}

// Per-agent authentication (BYOK). Renders for installed, enabled agents. For an agent
// whose CLI has NO API-key path (Antigravity), it states that plainly instead of offering
// a toggle that would do nothing — honest about the divergence between the CLIs.
// Inline ToS warning shown when a risky agent is authenticating under its consumer
// subscription (the concern doesn't apply in API-key mode). Reuses the agent's existing
// consent copy so there's one source of truth. Amber for a cautionary path, destructive
// for the actively-enforced one — matching the row's RiskGlyph.
function SubscriptionRiskWarning({ meta }: { meta: AgentMeta }) {
  if (meta.risk === "compliant" || !meta.consent) return null;
  const high = meta.risk === "high";
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-md border p-2",
        high
          ? "border-destructive/30 bg-destructive/5"
          : "border-amber-500/30 bg-amber-500/5",
      )}
    >
      <AlertTriangle
        aria-hidden
        className={cn("mt-0.5 size-3.5 shrink-0", high ? "text-destructive" : "text-amber-500")}
      />
      <span className="text-xs leading-relaxed text-muted-foreground">{meta.consent.body}</span>
    </div>
  );
}

function AgentAuthControl({
  meta,
  status,
  onChange,
}: {
  meta: AgentMeta;
  status: AgentAuthStatus | undefined;
  onChange: () => void;
}) {
  const agentId = meta.id;
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  // Which method is visually selected. Mirrors the persisted mode, but "API key" can be
  // previewed (its input revealed) before a key exists — the mode only flips to apikey
  // once a key is actually saved.
  const [tab, setTab] = useState<AuthMode>(status?.mode ?? "subscription");
  useEffect(() => {
    if (status) setTab(status.mode);
  }, [status?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!status) return null;

  // No key path (Antigravity): say so, no toggle. A risky agent still gets the ToS warning,
  // since there's no compliant alternative to switch to.
  if (!status.supportsApiKey) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Subscription only — the Antigravity CLI has no API-key option, so this agent always
          runs under your Google login.
        </p>
        <SubscriptionRiskWarning meta={meta} />
      </div>
    );
  }

  async function chooseSubscription() {
    setBusy(true);
    try {
      await setAgentAuthMode(agentId, "subscription");
      setTab("subscription");
      onChange();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  function chooseApiKey() {
    // Reveal the input. If a key is already stored, activate api-key mode immediately;
    // otherwise wait until the user saves one (the backend refuses apikey mode with no key).
    setTab("apikey");
    if (status?.hasKey && status.mode !== "apikey") {
      void (async () => {
        setBusy(true);
        try {
          await setAgentAuthMode(agentId, "apikey");
          onChange();
        } catch (e) {
          toast.error(String(e));
        } finally {
          setBusy(false);
        }
      })();
    }
  }

  async function saveKey() {
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await setAgentApiKey(agentId, trimmed);
      setKey("");
      setReveal(false);
      toast.success("API key saved");
      onChange();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    setBusy(true);
    try {
      await clearAgentApiKey(agentId);
      setKey("");
      toast.success("API key removed");
      onChange();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="radiogroup"
        aria-label="Authentication method"
        className="inline-flex w-fit rounded-md border border-border bg-muted/30 p-0.5"
      >
        <SegButton selected={tab === "subscription"} disabled={busy} onClick={chooseSubscription}>
          Subscription login
        </SegButton>
        <SegButton selected={tab === "apikey"} disabled={busy} onClick={chooseApiKey}>
          API key
        </SegButton>
      </div>

      {tab === "subscription" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Uses your existing <span className="font-mono">{agentId}</span> CLI login (your
            subscription). This is the default.
          </p>
          <SubscriptionRiskWarning meta={meta} />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {status.hasKey && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <Check className="size-3.5 shrink-0" />
              A key is saved — new sessions bill to your API key.
            </span>
          )}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                type={reveal ? "text" : "password"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={status.hasKey ? "Enter a new key to replace it" : "Paste your API key"}
                autoComplete="off"
                spellCheck={false}
                className="pr-9 font-mono text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveKey();
                }}
              />
              <button
                type="button"
                aria-label={reveal ? "Hide key" : "Show key"}
                onClick={() => setReveal((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
            <Button size="sm" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
              Save
            </Button>
            {status.hasKey && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void removeKey()}
                aria-label="Remove saved key"
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Stored in your OS keychain — never in Kine Agent's database or logs. Kine Agent never
            runs the CLI's own login, so your subscription sign-in stays untouched.
          </p>
        </div>
      )}
    </div>
  );
}

function AgentRow({
  meta,
  installed,
  prefs,
  confirming,
  status,
  onToggle,
  onConfirm,
  onCancel,
  onInstall,
  onAuthChange,
}: {
  meta: AgentMeta;
  installed: boolean;
  prefs: AgentPrefs;
  confirming: boolean;
  status: AgentAuthStatus | undefined;
  onToggle: (on: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onInstall: () => void;
  onAuthChange: () => void;
}) {
  const enabled = isAgentEnabled(meta.id, prefs);
  // In API-key mode the consumer-subscription ToS concern doesn't apply, so the row reads
  // as compliant instead of carrying the risk note.
  const inApiKeyMode = status?.mode === "apikey";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/10 p-3">
      <div className="flex items-center gap-3">
        <AgentLogo agent={meta.id} className="size-5" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium leading-tight">{meta.label}</span>
          {inApiKeyMode ? (
            <span className="flex items-center gap-1 text-xs leading-tight text-emerald-600 dark:text-emerald-400">
              <ShieldCheck aria-hidden className="size-3 shrink-0" />
              Authenticating with your API key
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-muted-foreground leading-tight">
              <RiskGlyph meta={meta} />
              {meta.note}
            </span>
          )}
        </div>

        {installed ? (
          <Switch
            checked={enabled}
            // Enabling a risky agent routes through the inline consent below first;
            // disabling is always immediate. Cancel leaves the switch OFF.
            onCheckedChange={onToggle}
            aria-label={`${enabled ? "Disable" : "Enable"} ${meta.label}`}
          />
        ) : (
          <button
            type="button"
            onClick={onInstall}
            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
          >
            Not installed · Install
            <ExternalLink className="size-3" />
          </button>
        )}
      </div>

      {/* One-time risk acknowledgement, inline (never a modal stacked on this dialog). */}
      {confirming && meta.consent && (
        <Alert variant="destructive" className="mt-1">
          <AlertTriangle className="size-4" />
          <AlertTitle>{meta.consent.title}</AlertTitle>
          <AlertDescription className="mt-1 flex flex-col gap-3">
            <span className="text-muted-foreground">{meta.consent.body}</span>
            <span className="flex items-center gap-2">
              <Button size="sm" variant="destructive" onClick={onConfirm}>
                I understand — enable
              </Button>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      {/* Authentication (BYOK): only meaningful once the agent is installed and enabled. */}
      {installed && enabled && (
        <div className="mt-1 flex items-start gap-2 border-t border-border/60 pt-2.5">
          <KeyRound aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <AgentAuthControl meta={meta} status={status} onChange={onAuthChange} />
          </div>
        </div>
      )}

      {installed && enabled && <AgentCustomize agentId={meta.id} />}
    </div>
  );
}

function AgentsSection({
  agents,
  prefs,
  confirming,
  onToggle,
  onConfirm,
  onCancel,
  onInstall,
}: {
  agents: AgentInfo[];
  prefs: AgentPrefs;
  confirming: string | null;
  onToggle: (meta: AgentMeta, on: boolean) => void;
  onConfirm: (meta: AgentMeta) => void;
  onCancel: () => void;
  onInstall: (meta: AgentMeta) => void;
}) {
  const installedFor = (id: string) =>
    agents.find((a) => a.id === id)?.installed ?? false;

  // Per-agent auth status (mode + whether a key is stored). Fetched on mount — which
  // recurs each time Settings reopens, since AgentsSection remounts — and refreshed after
  // any auth mutation so the row reflects the new state immediately.
  const [authStatuses, setAuthStatuses] = useState<Record<string, AgentAuthStatus>>({});
  const reloadAuth = useCallback(async (agentId: string) => {
    try {
      const s = await getAgentAuthStatus(agentId);
      setAuthStatuses((prev) => ({ ...prev, [agentId]: s }));
    } catch {
      // Non-Tauri contexts (tests) or a transient IPC error: leave the row without a
      // control rather than surfacing an error for a purely optional feature.
    }
  }, []);
  useEffect(() => {
    for (const meta of AGENT_META) void reloadAuth(meta.id);
  }, [reloadAuth]);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-base font-semibold">Agents</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Choose which agents can start new sessions, and how each one signs in — under your
          existing CLI subscription login, or with your own API key. Codex runs under its
          supported scriptable path; Claude and Antigravity read your consumer subscription
          login, so they're off until you enable them.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {AGENT_META.map((meta) => (
          <AgentRow
            key={meta.id}
            meta={meta}
            installed={installedFor(meta.id)}
            prefs={prefs}
            confirming={confirming === meta.id}
            status={authStatuses[meta.id]}
            onToggle={(on) => onToggle(meta, on)}
            onConfirm={() => onConfirm(meta)}
            onCancel={onCancel}
            onInstall={() => onInstall(meta)}
            onAuthChange={() => void reloadAuth(meta.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── About section ────────────────────────────────────────────────────────────

// In-app non-affiliation disclaimer + a plain-language disclosure that Kine Agent
// records session content verbatim on-device (audit items: in-app disclaimer +
// local-store disclosure). Static content — no props.
function AboutSection() {
  // The version is compiled into the app (tauri.conf.json), so read it at runtime
  // rather than hardcoding — it can never drift from the actual build. Absent until
  // it resolves (and in non-Tauri contexts like tests), the line just omits it.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-base font-semibold">About</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Kine Agent{version ? ` v${version}` : ""} — MIT licensed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">Affiliation</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Kine Agent is an independent project and is not affiliated with, sponsored by, or
          endorsed by Anthropic, OpenAI, or Google. "Claude", "Codex", "Gemini", and
          "Antigravity" are trademarks of their respective owners. Kine Agent drives each
          vendor's own official CLI under your existing login and adds no accounts of its own.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">Your data stays on this machine</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Kine Agent includes no telemetry, analytics, or accounts. Its only network calls are
          the app-update check against GitHub, a one-time integrity-verified download of the
          agent adapter packages, and — if you add an API key — fetching that vendor's model
          list with your key. Your prompts, the agents' replies, the commands they run, and
          those commands' output are recorded verbatim in a local SQLite database under{" "}
          <span className="font-mono">~/.kine-agent</span> so you can review and resume
          sessions — none of it is sent anywhere. Deleting a session,
          or the <span className="font-mono">~/.kine-agent</span> folder, removes that history.
          If you add an API key for an agent, it is stored in your OS keychain — never in that
          database or in logs — and used only to authenticate that agent's own CLI.
        </p>
      </div>
    </div>
  );
}

// ─── SettingsDialog ─────────────────────────────────────────────────────────────

export function SettingsDialog({
  open,
  onOpenChange,
  agents,
  prefs,
  onPrefsChange,
}: SettingsDialogProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("agents");
  // The agent id whose enable is awaiting a one-time acknowledgement, if any.
  const [confirming, setConfirming] = useState<string | null>(null);

  // Reset to the first section and drop any pending consent when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setActiveSection("agents");
    setConfirming(null);
  }, [open]);

  function handleToggle(meta: AgentMeta, on: boolean) {
    if (!on) {
      // Disabling never needs consent, and clears any open confirmation.
      setConfirming(null);
      onPrefsChange(setAgentEnabled(prefs, meta.id, false));
      return;
    }
    // Enabling a risky, not-yet-acknowledged agent opens the inline consent first.
    if (meta.consent && !hasAcknowledged(meta.id, prefs)) {
      setConfirming(meta.id);
      return;
    }
    onPrefsChange(setAgentEnabled(prefs, meta.id, true));
  }

  function handleConfirm(meta: AgentMeta) {
    onPrefsChange(setAgentEnabled(prefs, meta.id, true));
    setConfirming(null);
  }

  function handleInstall(meta: AgentMeta) {
    void openUrl(meta.installDocsUrl).catch(() =>
      toast.error("Couldn't open the browser"),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(760px,88vw)] h-[min(540px,80vh)] max-w-none flex flex-col p-0 gap-0 overflow-hidden rounded-2xl border border-border shadow-2xl">
        <DialogTitle className="flex h-12 shrink-0 items-center px-4 text-sm font-medium text-muted-foreground">
          Settings
        </DialogTitle>
        <DialogDescription className="sr-only">
          Application settings. Choose which coding agents can start new sessions.
        </DialogDescription>

        {/* Two-column layout: left nav + inset rounded content panel (mirrors Customizations). */}
        <div className="flex flex-1 min-h-0 overflow-hidden gap-2 px-2 pb-2">
          <nav
            className="w-44 shrink-0 flex flex-col py-1 px-1 gap-0.5 overflow-y-auto"
            aria-label="Settings sections"
          >
            {NAV_ITEMS.map((item) => (
              <NavRow
                key={item.id}
                item={item}
                active={activeSection === item.id}
                onClick={() => setActiveSection(item.id)}
              />
            ))}
          </nav>

          <div className="flex-1 min-w-0 min-h-0 rounded-lg border border-border overflow-hidden">
            <ScrollArea className="h-full">
              {activeSection === "agents" && (
                <AgentsSection
                  agents={agents}
                  prefs={prefs}
                  confirming={confirming}
                  onToggle={handleToggle}
                  onConfirm={handleConfirm}
                  onCancel={() => setConfirming(null)}
                  onInstall={handleInstall}
                />
              )}
              {activeSection === "about" && <AboutSection />}
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
