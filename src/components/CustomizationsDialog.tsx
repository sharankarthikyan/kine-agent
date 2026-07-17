import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  FileCode,
  FileText,
  LayoutGrid,
  Pencil,
  Plus,
  Puzzle,
  Server,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CodeBlock } from "@/components/CodeBlock";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CustomizationCounts, HookEntry, McpServerEntry, PluginEntry } from "@/lib/conductor";
import { addHook, addMcpServer, deleteHook, deleteMcpServer } from "@/lib/conductor";
import type { Capabilities, Capability, CapabilityKind, RuleFile } from "@/lib/inspect";
import { createCustomization, deleteCustomization, readTextFile, writeTextFile } from "@/lib/inspect";

export type CustomizationSection =
  | "overview"
  | "agents"
  | "skills"
  | "instructions"
  | "hooks"
  | "mcp"
  | "plugins";

export interface CustomizationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection: CustomizationSection;
  counts: CustomizationCounts | null;
  capabilities: Capabilities | null;
  rules: RuleFile[];
  /** Active session worktree, or `null` to browse the user's global ~/.claude scope. */
  sessionId: string | null;
  hooks: HookEntry[];
  mcpServers: McpServerEntry[];
  plugins: PluginEntry[];
  /** Called after any create/edit/delete so the host can re-fetch the listings. */
  onChanged?: () => void;
}

// ─── Nav config ───────────────────────────────────────────────────────────────

interface NavItem {
  id: CustomizationSection;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  countKey?: keyof CustomizationCounts;
  description: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "overview",
    label: "Overview",
    Icon: LayoutGrid,
    description: "All customizations at a glance",
  },
  {
    id: "agents",
    label: "Agents",
    Icon: Bot,
    countKey: "agents",
    description: "Subagents available in this session",
  },
  {
    id: "skills",
    label: "Skills",
    Icon: Zap,
    countKey: "skills",
    description: "Slash commands and reusable skill scripts",
  },
  {
    id: "instructions",
    label: "Instructions",
    Icon: FileText,
    countKey: "instructions",
    description: "CLAUDE.md and other rule files",
  },
  {
    id: "hooks",
    label: "Hooks",
    Icon: Webhook,
    countKey: "hooks",
    description: "Lifecycle hooks configured for this agent",
  },
  {
    id: "mcp",
    label: "MCP Servers",
    Icon: Server,
    countKey: "mcpServers",
    description: "Model Context Protocol server connections",
  },
  {
    id: "plugins",
    label: "Plugins",
    Icon: Puzzle,
    description: "Installed Claude Code plugins",
  },
];

// ─── Left nav ─────────────────────────────────────────────────────────────────

interface NavRowProps {
  item: NavItem;
  active: boolean;
  count: number | null;
  onClick: () => void;
}

function NavRow({ item, active, count, onClick }: NavRowProps) {
  const { label, Icon } = item;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
	        "flex items-center gap-2.5 w-full px-3 py-1.5 rounded-md text-sm text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "hover:bg-muted/50",
        active
          ? "bg-muted text-foreground font-medium"
          : "text-muted-foreground"
      )}
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {count !== null && (
        <span className="tabular-nums font-mono text-xs shrink-0">{count}</span>
      )}
    </button>
  );
}

// ─── File detail view ─────────────────────────────────────────────────────────

// Returns a display-friendly path: worktree files become repo-relative, home
// files become ~/…, everything else is unchanged. The full path is preserved
// as a title attribute for hover inspection. Handles both Unix (`/`) and Windows
// (`\`, drive letters) separators by normalizing to `/` for matching.
function shortenPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const wt = norm.match(/\/(?:\.(?:kine-agent|kineloop|agent-editor)|KineAgent|Kineloop)\/worktrees\/[^/]+\/(.+)$/);
  if (wt) return wt[1];
  // ~/ for Unix homes (/Users/x, /home/x) and Windows homes (C:/Users/x).
  return norm.replace(/^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+\//, "~/");
}

interface FileDetail {
  name: string;
  path: string;
  editable: boolean;
  /** Which scope the file lives in — surfaced as a badge so the user always knows
   *  whether they are editing a project file or a global (~/.claude) one. */
  scope: "project" | "global";
}

interface FileDetailViewProps {
  detail: FileDetail;
  loading: boolean;
  error: boolean;
  content: string | null;
  sessionId: string | null;
  onBack: () => void;
  onSaved: (newContent: string) => void;
}

function FileDetailView({ detail, loading, error, content, sessionId, onBack, onSaved }: FileDetailViewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset edit state when a different file is opened.
  useEffect(() => {
    setIsEditing(false);
    setEditedContent("");
    setSaving(false);
  }, [detail.path]);

  function handleEditClick() {
    setEditedContent(content ?? "");
    setIsEditing(true);
  }

  function handleCancel() {
    setIsEditing(false);
    setEditedContent("");
  }

  async function handleSave() {
    setSaving(true);
    try {
      await writeTextFile(sessionId, detail.path, editedContent);
      const basename = detail.path.split(/[\\/]/).pop() || detail.name;
      toast.success(`Saved ${basename}`);
      onSaved(editedContent);
      setIsEditing(false);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  // Every discovered capability/rule file — project or global (~/.claude) — is writable
  // through the allowlist-gated IPC, so the editor is offered whenever a file loaded.
  const canEdit = !loading && !error && content !== null && detail.editable;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header: back button + name + path + edit/save/cancel */}
      <div className="flex items-start gap-2 p-3 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={onBack}
          className="shrink-0 mt-0.5"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex flex-col min-w-0 gap-0.5 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-bold leading-tight truncate">{detail.name}</span>
            <Badge variant="outline" className="shrink-0 text-xs font-normal">
              {detail.scope === "project" ? "Project" : "Global"}
            </Badge>
          </div>
          <span
            className="text-xs text-muted-foreground font-mono leading-tight truncate"
            title={detail.path}
          >
            {shortenPath(detail.path)}
          </span>
        </div>
        {canEdit && (
          isEditing ? (
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="default"
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Edit"
              onClick={handleEditClick}
              className="shrink-0 mt-0.5"
            >
              <Pencil className="size-4" />
            </Button>
          )
        )}
        {!loading && !error && content !== null && !detail.editable && (
          <span className="shrink-0 mt-1 text-xs text-muted-foreground">Read-only</span>
        )}
      </div>
      {/* Body: edit textarea or syntax-highlighted read view */}
      {isEditing ? (
        <textarea
          className="flex-1 min-h-0 resize-none font-mono text-xs p-4 bg-muted/30 border-0 outline-none w-full"
          value={editedContent}
          onChange={(e) => setEditedContent(e.target.value)}
          spellCheck={false}
          aria-label="File content editor"
        />
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4">
            {loading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {!loading && error && (
              <p className="text-sm text-muted-foreground">Couldn't read this file</p>
            )}
            {!loading && !error && content !== null && (
              <CodeBlock content={content} path={detail.path} />
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

// ─── Overview section ─────────────────────────────────────────────────────────
//
// Each card is a plain div. Navigation is triggered by a <button> covering
// the label + description. The inert action stub sits below as a sibling
// element — this avoids nesting interactive elements.

interface OverviewCardProps {
  item: NavItem;
  count: number | null;
  onNavigate: (id: CustomizationSection) => void;
}

function OverviewCard({ item, count, onNavigate }: OverviewCardProps) {
  const { id, label, Icon, description } = item;
  if (id === "overview") return null;
  return (
    <button
      type="button"
      className="flex flex-col gap-2.5 p-3 rounded-lg border border-border bg-muted/20 w-full text-left hover:bg-muted/30 transition-colors"
      onClick={() => onNavigate(id)}
    >
      <div className="flex items-center justify-between gap-2">
        <Icon className="size-4 text-muted-foreground shrink-0" />
        {count !== null && (
          <span className="text-xs tabular-nums text-muted-foreground font-mono">
            {count}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium leading-tight">{label}</p>
        <p className="text-xs text-muted-foreground leading-snug">{description}</p>
      </div>
    </button>
  );
}

function OverviewSection({
  counts,
  pluginsCount,
  onNavigate,
}: {
  counts: CustomizationCounts | null;
  pluginsCount: number;
  onNavigate: (id: CustomizationSection) => void;
}) {
  const getCount = (item: NavItem): number | null => {
    if (item.id === "plugins") return pluginsCount;
    if (!item.countKey || counts === null) return null;
    return counts[item.countKey];
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-base font-semibold">Overview</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          All customizations configured for this session, at a glance.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {NAV_ITEMS.filter((item) => item.id !== "overview").map((item) => (
          <OverviewCard
            key={item.id}
            item={item}
            count={getCount(item)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Inline delete control ────────────────────────────────────────────────────
//
// A trash button that, on click, swaps in a two-step "Delete / Cancel" confirmation
// so a destructive action always needs a deliberate second click. Rendered as a
// sibling (never nested inside another button) to keep the markup valid.

function DeleteControl({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (confirming) {
    return (
      <span className="flex items-center gap-1 shrink-0">
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
              setConfirming(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Delete"}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-destructive"
      onClick={() => setConfirming(true)}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}

// ─── Shared capability row ────────────────────────────────────────────────────
//
// The label area is a <button> when the capability has a backing file (opens the
// detail view); the delete control sits beside it as a sibling. The wrapping element
// is a plain <div> so the two interactive controls are never nested.

function CapabilityRow({
  capability,
  onOpen,
  onDelete,
}: {
  capability: Capability;
  onOpen?: () => void;
  onDelete?: () => Promise<void>;
}) {
  const content = (
    <>
      <span className="text-sm font-medium shrink-0 whitespace-nowrap">
        {capability.name}
      </span>
      {capability.description && (
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
          {capability.description}
        </span>
      )}
      <Badge variant="outline" className="ml-auto shrink-0 text-xs font-normal">
        {capability.source}
      </Badge>
    </>
  );

  return (
    <div className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 min-w-0">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {content}
        </button>
      ) : (
        <div className="flex items-center gap-2 flex-1 min-w-0">{content}</div>
      )}
      {onDelete && (
        <DeleteControl label={`Delete ${capability.name}`} onConfirm={onDelete} />
      )}
    </div>
  );
}

// ─── Scope selection ──────────────────────────────────────────────────────────

type Scope = "project" | "user";

// The two-way toggle itself (no label). `value` is `null` until the user picks — there is
// no default, so nothing lands in the wrong scope by accident.
function ScopeToggle({ value, onChange }: { value: Scope | null; onChange: (s: Scope) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5 shrink-0">
      {(["project", "user"] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={value === s}
          onClick={() => onChange(s)}
          className={cn(
            "px-2 py-1 text-xs rounded transition-colors",
            value === s
              ? "bg-muted text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {s === "project" ? "Project" : "Global"}
        </button>
      ))}
    </div>
  );
}

// Scope selector shown on every add form, so where an item lands is always explicit. With
// an active session the user picks Project vs Global; with none, the only valid target is
// the user's global ~/.claude, shown as a fixed "Global" chip (Project needs a worktree).
function ScopeField({
  sessionId,
  value,
  onChange,
}: {
  sessionId: string | null;
  value: Scope | null;
  onChange: (s: Scope) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium">Scope</span>
      {sessionId === null ? (
        <Badge variant="outline" className="text-xs font-normal" title="Open Customizations from a session to create project files">
          Global
        </Badge>
      ) : (
        <ScopeToggle value={value} onChange={onChange} />
      )}
    </div>
  );
}

// Resolve the session id a mutation should target for a chosen scope: project keeps the
// active session (its worktree), user forces `null` (the global ~/.claude scope). With no
// active session there is only global scope, so the scope argument is irrelevant.
function scopedSessionId(sessionId: string | null, scope: Scope | null): string | null {
  if (sessionId === null) return null;
  return scope === "project" ? sessionId : null;
}

// A create/add form's scope is settled when there is no session (always global) or the
// user has explicitly picked one. Used to gate the submit button so nothing is created
// without a deliberate scope choice.
function scopeChosen(sessionId: string | null, scope: Scope | null): boolean {
  return sessionId === null || scope !== null;
}

// ─── New-capability inline form ───────────────────────────────────────────────
//
// A name field + Create button shown at the top of a section when "Add" is toggled.
// A scope toggle appears when a session is active; the name is re-validated server-side.

function NewCapabilityForm({
  kind,
  sessionId,
  onCreated,
  onCancel,
}: {
  kind: CapabilityKind;
  sessionId: string | null;
  onCreated: (name: string, path: string, scope: "project" | "global") => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = name.trim() !== "" && scopeChosen(sessionId, scope);

  async function submit() {
    if (!valid) return;
    const trimmed = name.trim();
    const target = scopedSessionId(sessionId, scope);
    setBusy(true);
    try {
      const path = await createCustomization(target, kind, trimmed);
      toast.success(`Created ${trimmed}`);
      onCreated(trimmed, path, target === null ? "global" : "project");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={`New ${kind} name…`}
        className="h-8 text-sm flex-1 min-w-0"
        disabled={busy}
      />
      <ScopeField sessionId={sessionId} value={scope} onChange={setScope} />
      <Button size="sm" onClick={() => void submit()} disabled={busy || !valid}>
        {busy ? "Creating…" : "Create"}
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}

// ─── Agents section ───────────────────────────────────────────────────────────

// A capability list (agents or skills) with search, an inline "Add" form that scaffolds
// a new item then opens it in the editor, and per-row delete. Agents and skills share
// this identical shape, differing only in label copy and the created capability kind.
function CapabilitySection({
  title,
  description,
  kind,
  items,
  emptyLabel,
  search,
  onSearchChange,
  sessionId,
  onOpenDetail,
  onCreated,
  onDelete,
}: {
  title: string;
  description: string;
  kind: CapabilityKind;
  items: Capability[];
  emptyLabel: string;
  search: string;
  onSearchChange: (s: string) => void;
  sessionId: string | null;
  onOpenDetail: (name: string, path: string, editable: boolean, scope: "project" | "global") => void;
  onCreated: (name: string, path: string, scope: "project" | "global") => void;
  onDelete: (path: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const filtered = search
    ? items.filter(
        (c) =>
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          (c.description?.toLowerCase().includes(search.toLowerCase()) ?? false)
      )
    : items;

  return (
    <SectionShell
      title={title}
      description={description}
      search={search}
      onSearchChange={onSearchChange}
      action={
        !adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add
          </Button>
        )
      }
    >
      {adding && (
        <NewCapabilityForm
          kind={kind}
          sessionId={sessionId}
          onCreated={(name, path, scope) => {
            setAdding(false);
            onCreated(name, path, scope);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {filtered.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {items.length === 0 ? emptyLabel : "No matches"}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {filtered.map((cap) => (
            <CapabilityRow
              key={cap.path || `${cap.source}-${cap.name}`}
              capability={cap}
              onOpen={
                cap.path
                  ? () =>
                      onOpenDetail(
                        cap.name,
                        cap.path,
                        true,
                        cap.source === "user" ? "global" : "project"
                      )
                  : undefined
              }
              onDelete={cap.path ? () => onDelete(cap.path) : undefined}
            />
          ))}
        </div>
      )}
    </SectionShell>
  );
}

// ─── Instructions section ─────────────────────────────────────────────────────

function InstructionsSection({
  rules,
  search,
  onSearchChange,
  onOpenDetail,
}: {
  rules: RuleFile[];
  search: string;
  onSearchChange: (s: string) => void;
  onOpenDetail: (name: string, path: string, editable: boolean, scope: "project" | "global") => void;
}) {
  const existing = rules.filter((r) => r.exists);
  const filtered = search
    ? existing.filter((r) => r.label.toLowerCase().includes(search.toLowerCase()))
    : existing;

  return (
    <SectionShell
      title="Instructions"
      description="Rule files (CLAUDE.md, AGENTS.md, etc.) that apply to this session."
      search={search}
      onSearchChange={onSearchChange}
    >
      {filtered.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {existing.length === 0 ? "No instruction files found." : "No matches"}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {filtered.map((rule) => (
            <button
              key={rule.path}
              type="button"
              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 text-left w-full min-w-0"
              onClick={() => onOpenDetail(rule.label, rule.path, true, rule.scope)}
            >
              <FileCode className="size-3.5 text-muted-foreground shrink-0" />
              <span className="flex-1 min-w-0 truncate text-sm">{rule.label}</span>
              <Badge variant="outline" className="ml-auto shrink-0 text-xs font-normal">
                {rule.scope}
              </Badge>
            </button>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

// ─── Hooks section ────────────────────────────────────────────────────────────

function HooksSection({
  hooks,
  search,
  onSearchChange,
  sessionId,
  onAdd,
  onChanged,
}: {
  hooks: HookEntry[];
  search: string;
  onSearchChange: (s: string) => void;
  sessionId: string | null;
  onAdd: () => void;
  onChanged: () => void;
}) {
  const filtered = search
    ? hooks.filter(
        (h) =>
          h.event.toLowerCase().includes(search.toLowerCase()) ||
          h.command.toLowerCase().includes(search.toLowerCase())
      )
    : hooks;

  async function handleDelete(hook: HookEntry) {
    try {
      await deleteHook(sessionId, hook.source, hook.event, hook.matcher, hook.command);
      toast.success(`Deleted ${hook.event} hook`);
      onChanged();
    } catch (err) {
      toast.error(String(err));
    }
  }

  return (
    <SectionShell
      title="Hooks"
      description="Lifecycle hooks that run before and after agent operations."
      search={search}
      onSearchChange={onSearchChange}
      action={
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-3.5" />
          Add
        </Button>
      }
    >
      {filtered.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {hooks.length === 0 ? "No hooks configured." : "No matches"}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {filtered.map((hook, i) => (
            <div
              key={`${hook.source}-${hook.event}-${hook.command}-${i}`}
              className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 min-w-0"
            >
              <span className="text-sm font-medium shrink-0 whitespace-nowrap">
                {hook.event}
              </span>
              {hook.matcher && (
                <span className="text-xs text-muted-foreground shrink-0">
                  {hook.matcher}
                </span>
              )}
              <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground font-mono">
                {hook.command}
              </span>
              <Badge variant="outline" className="ml-auto shrink-0 text-xs font-normal">
                {hook.source}
              </Badge>
              <DeleteControl
                label={`Delete ${hook.event} hook`}
                onConfirm={() => handleDelete(hook)}
              />
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

// ─── MCP Servers section ──────────────────────────────────────────────────────

function McpServersSection({
  mcpServers,
  search,
  onSearchChange,
  sessionId,
  onAdd,
  onChanged,
}: {
  mcpServers: McpServerEntry[];
  search: string;
  onSearchChange: (s: string) => void;
  sessionId: string | null;
  onAdd: () => void;
  onChanged: () => void;
}) {
  const filtered = search
    ? mcpServers.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          (s.detail?.toLowerCase().includes(search.toLowerCase()) ?? false)
      )
    : mcpServers;

  async function handleDelete(server: McpServerEntry) {
    try {
      await deleteMcpServer(sessionId, server.source, server.name);
      toast.success(`Deleted ${server.name}`);
      onChanged();
    } catch (err) {
      toast.error(String(err));
    }
  }

  return (
    <SectionShell
      title="MCP Servers"
      description="Model Context Protocol servers providing tools and resources to the agent."
      search={search}
      onSearchChange={onSearchChange}
      action={
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-3.5" />
          Add
        </Button>
      }
    >
      {filtered.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {mcpServers.length === 0 ? "No MCP servers configured." : "No matches"}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {filtered.map((server, i) => (
            <div
              key={`${server.source}-${server.name}-${i}`}
              className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 min-w-0"
            >
              <span className="text-sm font-medium shrink-0 whitespace-nowrap">
                {server.name}
              </span>
              {server.detail && (
                <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground font-mono">
                  {server.detail}
                </span>
              )}
              <Badge variant="outline" className="ml-auto shrink-0 text-xs font-normal">
                {server.source}
              </Badge>
              <DeleteControl label={`Delete ${server.name}`} onConfirm={() => handleDelete(server)} />
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

// ─── Add panels (in-dialog sub-views, mirroring the file detail view) ───────────
//
// Hooks and MCP servers are state-dependent, multi-field forms, so they push a full
// panel with a back button rather than expanding a cramped inline row — and never a
// second modal stacked on this dialog.

// Claude Code hook events are a fixed set, and matcher semantics differ per event
// (some match tool names, some a fixed enum, some ignore the matcher entirely). This
// drives constrained inputs so a typo can't produce a hook that silently never fires.
type HookMatcherSpec =
  | { kind: "none" }
  | { kind: "tool" }
  | { kind: "enum"; values: string[] };

interface HookEventDef {
  event: string;
  description: string;
  matcher: HookMatcherSpec;
}

const HOOK_EVENTS: HookEventDef[] = [
  { event: "PreToolUse", description: "Before a tool runs.", matcher: { kind: "tool" } },
  { event: "PostToolUse", description: "After a tool completes.", matcher: { kind: "tool" } },
  {
    event: "UserPromptSubmit",
    description: "When you submit a prompt. Fires on every prompt.",
    matcher: { kind: "none" },
  },
  {
    event: "Notification",
    description: "On a Claude notification. Fires on every notification.",
    matcher: { kind: "none" },
  },
  {
    event: "Stop",
    description: "When the main agent finishes responding.",
    matcher: { kind: "none" },
  },
  {
    event: "SubagentStop",
    description: "When a subagent finishes.",
    matcher: { kind: "none" },
  },
  {
    event: "SessionStart",
    description: "When a session starts.",
    matcher: { kind: "enum", values: ["startup", "resume", "clear", "compact"] },
  },
  {
    event: "SessionEnd",
    description: "When a session ends.",
    matcher: { kind: "enum", values: ["clear", "resume", "logout", "prompt_input_exit", "other"] },
  },
  {
    event: "PreCompact",
    description: "Before the context is compacted.",
    matcher: { kind: "enum", values: ["manual", "auto"] },
  },
];

// Shared shell for an add panel: back-button header, scrolling body, sticky footer —
// the same chrome as FileDetailView so navigating in and out feels consistent.
function AddPanelShell({
  title,
  onBack,
  footer,
  children,
}: {
  title: string;
  onBack: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 p-3 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={onBack}
          className="shrink-0"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="text-sm font-bold leading-tight">{title}</span>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-4 p-4 max-w-xl">{children}</div>
      </ScrollArea>
      <div className="flex items-center justify-end gap-2 p-3 border-t border-border shrink-0">
        {footer}
      </div>
    </div>
  );
}

// A labelled form field with an optional hint below the control.
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground leading-snug">{hint}</span>}
    </div>
  );
}

function HookAddPanel({
  sessionId,
  onBack,
  onAdded,
}: {
  sessionId: string | null;
  onBack: () => void;
  onAdded: () => void;
}) {
  const [event, setEvent] = useState("");
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);

  const def = HOOK_EVENTS.find((e) => e.event === event) ?? null;
  const valid = event !== "" && command.trim() !== "" && scopeChosen(sessionId, scope);

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      await addHook(
        scopedSessionId(sessionId, scope),
        event,
        matcher.trim() || null,
        command.trim()
      );
      toast.success(`Added ${event} hook`);
      onAdded();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AddPanelShell
      title="Add hook"
      onBack={onBack}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || !valid}>
            {busy ? "Adding…" : "Add hook"}
          </Button>
        </>
      }
    >
      <Field label="Event" hint={def?.description}>
        <Select
          aria-label="Hook event"
          value={event}
          placeholder="Select an event…"
          options={HOOK_EVENTS.map((e) => ({ value: e.event, label: e.event }))}
          onChange={(e) => {
            setEvent(e.target.value);
            setMatcher(""); // matcher semantics change per event
          }}
        />
      </Field>

      {def?.matcher.kind === "tool" && (
        <Field
          label="Matcher"
          hint="Tool name(s) — e.g. Bash, Edit|Write, or a regex like mcp__.*. Leave blank to match all tools."
        >
          <Input
            value={matcher}
            onChange={(e) => setMatcher(e.target.value)}
            placeholder="Blank = all tools"
            className="font-mono"
          />
        </Field>
      )}
      {def?.matcher.kind === "enum" && (
        <Field label="Matcher" hint="Restrict to a specific trigger, or Any to match all.">
          <Select
            aria-label="Hook matcher"
            value={matcher}
            options={[
              { value: "", label: "Any" },
              ...def.matcher.values.map((v) => ({ value: v, label: v })),
            ]}
            onChange={(e) => setMatcher(e.target.value)}
          />
        </Field>
      )}

      <Field label="Command" hint="Shell command Claude runs when this hook fires.">
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="e.g. npm run lint"
          className="font-mono"
        />
      </Field>

      <ScopeField sessionId={sessionId} value={scope} onChange={setScope} />
    </AddPanelShell>
  );
}

function McpAddPanel({
  sessionId,
  onBack,
  onAdded,
}: {
  sessionId: string | null;
  onBack: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);

  const detailValid = transport === "stdio" ? command.trim() !== "" : url.trim() !== "";
  const valid = name.trim() !== "" && detailValid && scopeChosen(sessionId, scope);

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      const spec =
        transport === "stdio"
          ? {
              transport: "stdio" as const,
              command: command.trim(),
              args: args.trim() ? args.trim().split(/\s+/) : [],
            }
          : { transport: "http" as const, url: url.trim() };
      await addMcpServer(scopedSessionId(sessionId, scope), name.trim(), spec);
      toast.success(`Added ${name.trim()}`);
      onAdded();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AddPanelShell
      title="Add MCP server"
      onBack={onBack}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || !valid}>
            {busy ? "Adding…" : "Add server"}
          </Button>
        </>
      }
    >
      <Field label="Name" hint="Unique identifier for this server.">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. context7" />
      </Field>

      <Field label="Transport" hint="How Claude connects to the server.">
        <Select
          aria-label="MCP transport"
          value={transport}
          options={[
            { value: "stdio", label: "Local (stdio)" },
            { value: "http", label: "Remote (HTTP)" },
          ]}
          onChange={(e) => setTransport(e.target.value as "stdio" | "http")}
        />
      </Field>

      {transport === "stdio" ? (
        <>
          <Field label="Command" hint="Executable to launch, e.g. npx.">
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. npx"
              className="font-mono"
            />
          </Field>
          <Field label="Arguments" hint="Optional, space-separated.">
            <Input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="e.g. -y @context7/mcp"
              className="font-mono"
            />
          </Field>
        </>
      ) : (
        <Field label="URL" hint="Endpoint of the remote MCP server.">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className="font-mono"
          />
        </Field>
      )}

      <ScopeField sessionId={sessionId} value={scope} onChange={setScope} />
    </AddPanelShell>
  );
}

// ─── Plugins section ──────────────────────────────────────────────────────────

function PluginsSection({
  plugins,
  search,
  onSearchChange,
}: {
  plugins: PluginEntry[];
  search: string;
  onSearchChange: (s: string) => void;
}) {
  const filtered = search
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          (p.detail?.toLowerCase().includes(search.toLowerCase()) ?? false)
      )
    : plugins;

  return (
    <SectionShell
      title="Plugins"
      description="Installed Claude Code plugins that extend agent capabilities."
      search={search}
      onSearchChange={onSearchChange}
    >
      {filtered.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {plugins.length === 0 ? "No plugins installed." : "No matches"}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {filtered.map((plugin, i) => (
            <div
              key={`${plugin.name}-${i}`}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md min-w-0"
            >
              <span className="text-sm font-medium shrink-0 whitespace-nowrap">
                {plugin.name}
              </span>
              {plugin.detail && (
                <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
                  {plugin.detail}
                </span>
              )}
              <Badge variant="outline" className="ml-auto shrink-0 text-xs font-normal">
                {plugin.source}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

// ─── Section shell (shared heading + optional search + content wrapper) ────────

function SectionShell({
  title,
  description,
  search,
  onSearchChange,
  action,
  children,
}: {
  title: string;
  description: string;
  search?: string;
  onSearchChange?: (s: string) => void;
  /** Optional control rendered at the top-right of the header (e.g. an Add button). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {onSearchChange !== undefined && (
        <Input
          value={search ?? ""}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Type to search…"
          className="h-8 text-sm"
        />
      )}
      <div className="rounded-lg border border-border bg-muted/10 py-1">{children}</div>
    </div>
  );
}

// ─── CustomizationsDialog ─────────────────────────────────────────────────────

export function CustomizationsDialog({
  open,
  onOpenChange,
  initialSection,
  counts,
  capabilities,
  rules,
  sessionId,
  hooks,
  mcpServers,
  plugins,
  onChanged,
}: CustomizationsDialogProps) {
  const notifyChanged = onChanged ?? (() => {});
  const [activeSection, setActiveSection] = useState<CustomizationSection>(initialSection);

  // Per-section search query — resets when section changes.
  const [search, setSearch] = useState("");

  // In-dialog file detail view state.
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState(false);
  // In-dialog add-panel view (hooks / MCP), mutually exclusive with the file detail view.
  const [addPanel, setAddPanel] = useState<"hook" | "mcp" | null>(null);
  // Path of the most recently requested file read — lets an in-flight read detect that
  // a newer file was opened and bail out instead of clobbering the newer view.
  const latestRequestRef = useRef<string | null>(null);

  // Reset active section + clear any stale detail/file state whenever the dialog opens.
  // Clearing here (not only in the activeSection effect) covers re-opening to the SAME
  // section the dialog last showed — where setActiveSection would be a no-op and the
  // section effect would not fire, leaving a stale file detail view on screen.
  useEffect(() => {
    if (!open) return;
    setActiveSection(initialSection);
    setDetail(null);
    setAddPanel(null);
    setFileContent(null);
    setFileError(false);
    setFileLoading(false);
  }, [open, initialSection]);

  // Clear detail + add panel + search whenever the active section changes.
  useEffect(() => {
    setDetail(null);
    setAddPanel(null);
    setSearch("");
    setFileContent(null);
    setFileError(false);
    setFileLoading(false);
  }, [activeSection]);

  const getNavCount = (item: NavItem): number | null => {
    if (item.id === "plugins") return plugins.length;
    if (!item.countKey || counts === null) return null;
    return counts[item.countKey];
  };

  // Open a file in the in-dialog viewer.
  async function handleOpenDetail(
    name: string,
    path: string,
    editable: boolean,
    scope: "project" | "global"
  ) {
    latestRequestRef.current = path;
    setDetail({ name, path, editable, scope });
    setFileContent(null);
    setFileError(false);
    setFileLoading(true);
    try {
      const content = await readTextFile(sessionId, path);
      // Guard against a fast A→B click: only apply the result if the file the user is
      // looking at is still the one we fetched. Otherwise the header (B) and body (A)
      // would disagree.
      if (latestRequestRef.current !== path) return;
      setFileContent(content);
    } catch {
      if (latestRequestRef.current !== path) return;
      setFileError(true);
    } finally {
      if (latestRequestRef.current === path) setFileLoading(false);
    }
  }

  function handleBack() {
    setDetail(null);
    setFileContent(null);
    setFileError(false);
    setFileLoading(false);
  }

  // After scaffolding a new capability: refresh the listings, then drop straight into the
  // editor on the freshly created file so the user can fill in the template.
  function handleCreated(name: string, path: string, scope: "project" | "global") {
    notifyChanged();
    void handleOpenDetail(name, path, true, scope);
  }

  // Delete a capability (agent/skill) by its backing-file path, then refresh. A skill's
  // whole directory is removed server-side. If the deleted file is open, return to the list.
  async function handleDeleteCapability(path: string) {
    try {
      await deleteCustomization(sessionId, path);
      toast.success("Deleted");
      if (detail?.path === path) handleBack();
      notifyChanged();
    } catch (err) {
      toast.error(String(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(1180px,84vw)] h-[min(800px,82vh)] max-w-none flex flex-col p-0 gap-0 overflow-hidden rounded-2xl border border-border shadow-2xl"
      >
        {/* Title bar: visible dialog title on the left, and the h-12 strip keeps the
            absolute close button (top-4 + 16px icon → center 24px) vertically
            centered beside the content panel instead of overlaying it. */}
        <DialogTitle className="flex h-12 shrink-0 items-center px-4 text-sm font-medium text-muted-foreground">
          Customizations
        </DialogTitle>
        <DialogDescription className="sr-only">
          Browse agents, skills, instructions, hooks, MCP servers, and plugins configured for this session.
        </DialogDescription>

        {/* Two-column layout: left nav + inset rounded content panel. */}
        <div className="flex flex-1 min-h-0 overflow-hidden gap-2 px-2 pb-2">
          {/* Left nav */}
          <nav
            className="w-48 shrink-0 flex flex-col py-1 px-1 gap-0.5 overflow-y-auto"
            aria-label="Customization sections"
          >
            {NAV_ITEMS.map((item) => (
              <NavRow
                key={item.id}
                item={item}
                active={activeSection === item.id}
                count={item.id === "overview" ? null : getNavCount(item)}
                onClick={() => setActiveSection(item.id)}
              />
            ))}
          </nav>

          {/* Right content — inset rounded panel. rounded-lg keeps the radius
              concentric with the outer frame: outer rounded-2xl (16px) − p-2 gap
              (8px) = 8px. */}
          <div className="flex-1 min-w-0 min-h-0 rounded-lg border border-border overflow-hidden">
            {detail !== null ? (
              <FileDetailView
                detail={detail}
                loading={fileLoading}
                error={fileError}
                content={fileContent}
                sessionId={sessionId}
                onBack={handleBack}
                onSaved={(newContent) => setFileContent(newContent)}
              />
            ) : addPanel === "hook" ? (
              <HookAddPanel
                sessionId={sessionId}
                onBack={() => setAddPanel(null)}
                onAdded={() => {
                  setAddPanel(null);
                  notifyChanged();
                }}
              />
            ) : addPanel === "mcp" ? (
              <McpAddPanel
                sessionId={sessionId}
                onBack={() => setAddPanel(null)}
                onAdded={() => {
                  setAddPanel(null);
                  notifyChanged();
                }}
              />
            ) : (
              <ScrollArea className="h-full">
                {activeSection === "overview" && (
                  <OverviewSection
                    counts={counts}
                    pluginsCount={plugins.length}
                    onNavigate={setActiveSection}
                  />
                )}
                {activeSection === "agents" && (
                  <CapabilitySection
                    title="Agents"
                    description="Subagents available to the active agent in this session."
                    kind="agent"
                    items={capabilities?.subagents ?? []}
                    emptyLabel="No agents found."
                    search={search}
                    onSearchChange={setSearch}
                    sessionId={sessionId}
                    onOpenDetail={(name, path, editable, scope) => void handleOpenDetail(name, path, editable, scope)}
                    onCreated={handleCreated}
                    onDelete={handleDeleteCapability}
                  />
                )}
                {activeSection === "skills" && (
                  <CapabilitySection
                    title="Skills"
                    description="Slash commands and reusable skill scripts available in this session."
                    kind="skill"
                    items={capabilities?.skills ?? []}
                    emptyLabel="No skills found."
                    search={search}
                    onSearchChange={setSearch}
                    sessionId={sessionId}
                    onOpenDetail={(name, path, editable, scope) => void handleOpenDetail(name, path, editable, scope)}
                    onCreated={handleCreated}
                    onDelete={handleDeleteCapability}
                  />
                )}
                {activeSection === "instructions" && (
                  <InstructionsSection
                    rules={rules}
                    search={search}
                    onSearchChange={setSearch}
                    onOpenDetail={(name, path, editable, scope) => void handleOpenDetail(name, path, editable, scope)}
                  />
                )}
                {activeSection === "hooks" && (
                  <HooksSection
                    hooks={hooks}
                    search={search}
                    onSearchChange={setSearch}
                    sessionId={sessionId}
                    onAdd={() => setAddPanel("hook")}
                    onChanged={notifyChanged}
                  />
                )}
                {activeSection === "mcp" && (
                  <McpServersSection
                    mcpServers={mcpServers}
                    search={search}
                    onSearchChange={setSearch}
                    sessionId={sessionId}
                    onAdd={() => setAddPanel("mcp")}
                    onChanged={notifyChanged}
                  />
                )}
                {activeSection === "plugins" && (
                  <PluginsSection
                    plugins={plugins}
                    search={search}
                    onSearchChange={setSearch}
                  />
                )}
              </ScrollArea>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
