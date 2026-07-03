import { useState } from "react";
import {
  ChevronDown,
  ClipboardList,
  Lock,
  LockOpen,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PERMISSION_MODE_META,
  permissionModeLabel,
  permissionModesForAgent,
  permissionQualifier,
  type PermissionMode,
} from "@/lib/permissions";

interface PermissionModeSelectProps {
  /** The agent whose supported modes are offered. */
  agent: string;
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  /** Antigravity-only orthogonal terminal sandbox toggle. */
  sandboxTerminal?: boolean;
  onSandboxTerminalChange?: (v: boolean) => void;
  disabled?: boolean;
  align?: "start" | "end";
}

const MODE_ICON: Record<PermissionMode, LucideIcon> = {
  plan: ClipboardList,
  default: Lock,
  acceptEdits: LockOpen,
  full: ShieldAlert,
  dontAsk: ShieldCheck,
};

/** Capitalize an agent id for user-facing copy. */
function agentLabel(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

/**
 * The permission selector: a dropdown of the modes the chosen agent supports (advanced
 * modes grouped separately), plus (for Antigravity only) an orthogonal terminal-sandbox
 * toggle. Choosing "Full access" is gated behind an explicit confirmation because it
 * auto-approves shell/network with no gating.
 */
export function PermissionModeSelect({
  agent,
  value,
  onChange,
  sandboxTerminal = false,
  onSandboxTerminalChange,
  disabled = false,
  align = "start",
}: PermissionModeSelectProps) {
  // Full access requires confirmation; hold the pending switch here until the user agrees.
  const [confirmingFull, setConfirmingFull] = useState(false);

  const modes = permissionModesForAgent(agent);
  const core = modes.filter((m) => !PERMISSION_MODE_META[m].advanced);
  const advanced = modes.filter((m) => PERMISSION_MODE_META[m].advanced);
  const showSandbox = agent === "antigravity" && onSandboxTerminalChange !== undefined;

  // Guard against a stale selection (e.g. an agent that no longer offers this mode): show
  // the label anyway, but the menu only lists supported modes.
  const TriggerIcon = MODE_ICON[value] ?? Lock;
  const qualifier = permissionQualifier(value, agent);

  function handleSelect(next: string) {
    const mode = next as PermissionMode;
    if (mode === value) return;
    // Selecting Full opens a confirm dialog instead of applying immediately.
    if (mode === "full") {
      setConfirmingFull(true);
      return;
    }
    onChange(mode);
  }

  function renderItem(mode: PermissionMode) {
    const meta = PERMISSION_MODE_META[mode];
    const Icon = MODE_ICON[mode];
    // Single-line rows matching the app's model/agent pickers; the full description lives
    // in a hover tooltip so the menu stays compact.
    return (
      <DropdownMenuRadioItem
        key={mode}
        value={mode}
        title={meta.description}
        className={cn("gap-2", meta.danger && "text-destructive")}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="text-sm">{meta.label}</span>
      </DropdownMenuRadioItem>
    );
  }

  // A single inline row so it can sit beside the model picker. The per-agent note lives in
  // the trigger's hover tooltip rather than a separate line, keeping the composer compact.
  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            title={qualifier ?? PERMISSION_MODE_META[value]?.description}
            className={cn(
              "gap-1.5 px-2 text-muted-foreground hover:text-foreground",
              value === "full" && "text-destructive hover:text-destructive",
            )}
            aria-label={`Permission mode: ${permissionModeLabel(value)}`}
          >
            <TriggerIcon className="size-4 shrink-0" aria-hidden />
            <span className="text-sm">{permissionModeLabel(value)}</span>
            <ChevronDown data-icon="inline-end" className="opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="min-w-56">
          <DropdownMenuRadioGroup value={value} onValueChange={handleSelect}>
            {core.map(renderItem)}
            {advanced.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">
                  Advanced
                </DropdownMenuLabel>
                {advanced.map(renderItem)}
              </>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {showSandbox && (
        <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
          <Switch
            checked={sandboxTerminal}
            onCheckedChange={onSandboxTerminalChange}
            disabled={disabled}
            aria-label="Sandbox terminal commands"
          />
          <span>Sandbox terminal</span>
        </label>
      )}

      <Dialog open={confirmingFull} onOpenChange={setConfirmingFull}>
        <DialogContent className="max-w-md p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-destructive" aria-hidden />
              Enable Full access?
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-1 text-left">
              <span className="block">
                Full access auto-approves <strong>everything</strong> (file edits, shell commands, and
                network) with no gating. Kineloop reviews file edits in this session's worktree; it
                does not sandbox what the agent's own process can access on your machine.
              </span>
              {(agent === "claude" || agent === "antigravity") && (
                <span className="block">
                  Note: on {agentLabel(agent)} this bypasses all permission checks and may conflict
                  with the CLI's terms under a consumer subscription.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmingFull(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmingFull(false);
                onChange("full");
              }}
            >
              Enable full access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
