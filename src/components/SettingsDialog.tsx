import { useEffect, useState } from "react";
import { AlertTriangle, Bot, ExternalLink, Info } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
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

function AgentRow({
  meta,
  installed,
  prefs,
  confirming,
  onToggle,
  onConfirm,
  onCancel,
  onInstall,
}: {
  meta: AgentMeta;
  installed: boolean;
  prefs: AgentPrefs;
  confirming: boolean;
  onToggle: (on: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onInstall: () => void;
}) {
  const enabled = isAgentEnabled(meta.id, prefs);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/10 p-3">
      <div className="flex items-center gap-3">
        <AgentLogo agent={meta.id} className="size-5" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium leading-tight">{meta.label}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground leading-tight">
            <RiskGlyph meta={meta} />
            {meta.note}
          </span>
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

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-base font-semibold">Agents</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Choose which agents can start new sessions. Codex runs under its supported
          scriptable path; Claude and Antigravity read your consumer subscription login,
          so they're off until you enable them.
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
            onToggle={(on) => onToggle(meta, on)}
            onConfirm={() => onConfirm(meta)}
            onCancel={onCancel}
            onInstall={() => onInstall(meta)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── About section ────────────────────────────────────────────────────────────

// In-app non-affiliation disclaimer + a plain-language disclosure that Kineloop
// records session content verbatim on-device (audit items: in-app disclaimer +
// local-store disclosure). Static content — no props.
function AboutSection() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-base font-semibold">About</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Kineloop — MIT licensed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">Affiliation</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Kineloop is an independent project and is not affiliated with, sponsored by, or
          endorsed by Anthropic, OpenAI, or Google. "Claude", "Codex", "Gemini", and
          "Antigravity" are trademarks of their respective owners. Kineloop drives each
          vendor's own official CLI under your existing login and adds no accounts of its own.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">Your data stays on this machine</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Kineloop makes no network calls of its own and includes no telemetry. Your prompts,
          the agents' replies, the commands they run, and those commands' output are recorded
          verbatim in a local SQLite database under <span className="font-mono">~/.kineloop</span>{" "}
          so you can review and resume sessions — nothing is sent anywhere. Deleting a session,
          or the <span className="font-mono">~/.kineloop</span> folder, removes that history.
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
