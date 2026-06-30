import { Fragment, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  FileCode,
  FileText,
  LayoutGrid,
  Pencil,
  Puzzle,
  Server,
  Webhook,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CustomizationCounts, HookEntry, McpServerEntry, PluginEntry } from "@/lib/conductor";
import type { Capabilities, Capability, RuleFile } from "@/lib/inspect";
import { readTextFile, writeTextFile } from "@/lib/inspect";

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
  const wt = norm.match(/\/\.(?:kineloop|agent-editor)\/worktrees\/[^/]+\/(.+)$/);
  if (wt) return wt[1];
  // ~/ for Unix homes (/Users/x, /home/x) and Windows homes (C:/Users/x).
  return norm.replace(/^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+\//, "~/");
}

interface FileDetailViewProps {
  detail: { name: string; path: string; editable: boolean };
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
    if (!sessionId) return; // global/user scope is read-only via IPC
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

  // Only project-scope files inside the active worktree are writable via IPC; user/global
  // (~/.claude) files are read-only by design, so the editor controls are hidden for them.
  const canEdit = !loading && !error && content !== null && detail.editable && sessionId !== null;

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
          <span className="text-sm font-bold leading-tight truncate">{detail.name}</span>
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
            {!loading && !error && content !== null && <CodePreview content={content} />}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function CodePreview({ content }: { content: string }) {
  return (
    <pre className="m-0 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs leading-5 text-foreground">
      {content.split("\n").map((line, index) => (
        <Fragment key={index}>
          <span className="select-none text-right tabular-nums text-muted-foreground/60">
            {index + 1}
          </span>
          <code className="whitespace-pre-wrap break-words">{line || " "}</code>
        </Fragment>
      ))}
    </pre>
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
        <h2 className="text-base font-semibold">Customizations</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Agents, skills, rules, hooks, and servers configured for this session.
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

// ─── Shared capability row ────────────────────────────────────────────────────
//
// Renders as a <button> when path is non-empty (clickable to open detail view),
// or a plain <div> when path is empty (no backing file to show).

function CapabilityRow({
  capability,
  onOpen,
}: {
  capability: Capability;
  onOpen?: () => void;
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

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 min-w-0 w-full text-left"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md min-w-0">
      {content}
    </div>
  );
}

// ─── Agents section ───────────────────────────────────────────────────────────

function AgentsSection({
  capabilities,
  search,
  onSearchChange,
  onOpenDetail,
}: {
  capabilities: Capabilities | null;
  search: string;
  onSearchChange: (s: string) => void;
  onOpenDetail: (name: string, path: string, editable: boolean) => void;
}) {
  const subagents = capabilities?.subagents ?? [];
  const filtered = search
    ? subagents.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          (a.description?.toLowerCase().includes(search.toLowerCase()) ?? false)
      )
    : subagents;

  return (
    <SectionShell
      title="Agents"
      description="Subagents available to the active agent in this session."
      search={search}
      onSearchChange={onSearchChange}
    >
      {filtered.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {subagents.length === 0 ? "No agents found." : "No matches"}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {filtered.map((agent) => (
            <CapabilityRow
              key={agent.name}
              capability={agent}
              onOpen={
                agent.path
                  ? () => void onOpenDetail(agent.name, agent.path, agent.source === "project")
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </SectionShell>
  );
}

// ─── Skills section ───────────────────────────────────────────────────────────

function SkillsSection({
  capabilities,
  search,
  onSearchChange,
  onOpenDetail,
}: {
  capabilities: Capabilities | null;
  search: string;
  onSearchChange: (s: string) => void;
  onOpenDetail: (name: string, path: string, editable: boolean) => void;
}) {
  const skills = capabilities?.skills ?? [];
  const filtered = search
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          (s.description?.toLowerCase().includes(search.toLowerCase()) ?? false)
      )
    : skills;

  return (
    <SectionShell
      title="Skills"
      description="Slash commands and reusable skill scripts available in this session."
      search={search}
      onSearchChange={onSearchChange}
    >
      {filtered.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {skills.length === 0 ? "No skills found." : "No matches"}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {filtered.map((skill) => (
            <CapabilityRow
              key={skill.name}
              capability={skill}
              onOpen={
                skill.path
                  ? () => void onOpenDetail(skill.name, skill.path, skill.source === "project")
                  : undefined
              }
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
  onOpenDetail: (name: string, path: string, editable: boolean) => void;
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
              onClick={() => onOpenDetail(rule.label, rule.path, rule.scope === "project")}
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
}: {
  hooks: HookEntry[];
  search: string;
  onSearchChange: (s: string) => void;
}) {
  const filtered = search
    ? hooks.filter(
        (h) =>
          h.event.toLowerCase().includes(search.toLowerCase()) ||
          h.command.toLowerCase().includes(search.toLowerCase())
      )
    : hooks;

  return (
    <SectionShell
      title="Hooks"
      description="Lifecycle hooks that run before and after agent operations."
      search={search}
      onSearchChange={onSearchChange}
    >
      {filtered.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {hooks.length === 0 ? "No hooks configured." : "No matches"}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {filtered.map((hook, i) => (
            <div
              key={`${hook.event}-${i}`}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md min-w-0"
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
}: {
  mcpServers: McpServerEntry[];
  search: string;
  onSearchChange: (s: string) => void;
}) {
  const filtered = search
    ? mcpServers.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          (s.detail?.toLowerCase().includes(search.toLowerCase()) ?? false)
      )
    : mcpServers;

  return (
    <SectionShell
      title="MCP Servers"
      description="Model Context Protocol servers providing tools and resources to the agent."
      search={search}
      onSearchChange={onSearchChange}
    >
      {filtered.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          {mcpServers.length === 0 ? "No MCP servers configured." : "No matches"}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {filtered.map((server, i) => (
            <div
              key={`${server.name}-${i}`}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md min-w-0"
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
            </div>
          ))}
        </div>
      )}
    </SectionShell>
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
  children,
}: {
  title: string;
  description: string;
  search?: string;
  onSearchChange?: (s: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
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
}: CustomizationsDialogProps) {
  const [activeSection, setActiveSection] = useState<CustomizationSection>(initialSection);

  // Per-section search query — resets when section changes.
  const [search, setSearch] = useState("");

  // In-dialog file detail view state.
  const [detail, setDetail] = useState<{ name: string; path: string; editable: boolean } | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState(false);
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
    setFileContent(null);
    setFileError(false);
    setFileLoading(false);
  }, [open, initialSection]);

  // Clear detail + search whenever the active section changes (nav click or dialog open).
  useEffect(() => {
    setDetail(null);
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
  async function handleOpenDetail(name: string, path: string, editable: boolean) {
    latestRequestRef.current = path;
    setDetail({ name, path, editable });
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(1180px,84vw)] h-[min(800px,82vh)] max-w-none flex flex-col p-0 gap-0 overflow-hidden rounded-2xl border border-border shadow-2xl"
      >
        {/* A11y: accessible name and description for the dialog (sr-only). */}
        <DialogTitle className="sr-only">Agent customizations</DialogTitle>
        <DialogDescription className="sr-only">
          Browse agents, skills, instructions, hooks, MCP servers, and plugins configured for this session.
        </DialogDescription>

        {/* Two-column layout: left nav + inset rounded content panel */}
        <div className="flex flex-1 min-h-0 overflow-hidden gap-2 p-2">
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

          {/* Right content — inset rounded panel */}
          <div className="flex-1 min-w-0 min-h-0 rounded-xl border border-border overflow-hidden">
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
                  <AgentsSection
                    capabilities={capabilities}
                    search={search}
                    onSearchChange={setSearch}
                    onOpenDetail={(name, path, editable) => void handleOpenDetail(name, path, editable)}
                  />
                )}
                {activeSection === "skills" && (
                  <SkillsSection
                    capabilities={capabilities}
                    search={search}
                    onSearchChange={setSearch}
                    onOpenDetail={(name, path, editable) => void handleOpenDetail(name, path, editable)}
                  />
                )}
                {activeSection === "instructions" && (
                  <InstructionsSection
                    rules={rules}
                    search={search}
                    onSearchChange={setSearch}
                    onOpenDetail={(name, path, editable) => void handleOpenDetail(name, path, editable)}
                  />
                )}
                {activeSection === "hooks" && (
                  <HooksSection
                    hooks={hooks}
                    search={search}
                    onSearchChange={setSearch}
                  />
                )}
                {activeSection === "mcp" && (
                  <McpServersSection
                    mcpServers={mcpServers}
                    search={search}
                    onSearchChange={setSearch}
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
