import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Bot,
  FileCode,
  FileText,
  LayoutGrid,
  Puzzle,
  Server,
  Webhook,
  Zap,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "@/components/theme-provider";

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
import type { CustomizationCounts } from "@/lib/conductor";
import type { Capabilities, Capability, RuleFile } from "@/lib/inspect";
import { readTextFile } from "@/lib/inspect";

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
  sessionId: string;
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
        "flex items-center gap-2.5 w-full px-3 py-1.5 rounded-md text-sm text-left transition-colors",
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

// Maps file extension to a Prism language id. Defaults to "markdown" because
// the majority of agent/skill files are .md. Falls back gracefully — Prism
// renders unsupported languages as plain text.
function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "md":
    case "markdown":
      return "markdown";
    case "ts":
    case "tsx":
      return "tsx";
    case "js":
    case "jsx":
    case "mjs":
      return "jsx";
    case "json":
      return "json";
    case "toml":
      return "toml";
    case "yaml":
    case "yml":
      return "yaml";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "sh":
    case "bash":
      return "bash";
    case "css":
      return "css";
    case "html":
      return "markup";
    default:
      return "markdown";
  }
}

interface FileDetailViewProps {
  detail: { name: string; path: string };
  loading: boolean;
  error: boolean;
  content: string | null;
  onBack: () => void;
}

function FileDetailView({ detail, loading, error, content, onBack }: FileDetailViewProps) {
  const { theme } = useTheme();
  const codeStyle = theme === "dark" ? oneDark : oneLight;
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header: back button + name + path */}
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
        <div className="flex flex-col min-w-0 gap-0.5">
          <span className="text-sm font-bold leading-tight truncate">{detail.name}</span>
          <span className="text-xs text-muted-foreground font-mono leading-tight truncate">
            {detail.path}
          </span>
        </div>
      </div>
      {/* Body: file contents, read-only with syntax highlighting */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4">
          {loading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {!loading && error && (
            <p className="text-sm text-muted-foreground">Couldn't read this file</p>
          )}
          {!loading && !error && content !== null && (
            <SyntaxHighlighter
              language={detectLanguage(detail.path)}
              style={codeStyle}
              showLineNumbers
              wrapLongLines
              customStyle={{
                background: "transparent",
                margin: 0,
                padding: 0,
                fontSize: "0.75rem",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                overflowWrap: "anywhere",
              }}
              codeTagProps={{
                style: { whiteSpace: "pre-wrap", wordBreak: "break-word" },
              }}
              lineNumberStyle={{
                color: "var(--muted-foreground)",
                opacity: 0.5,
                userSelect: "none",
                minWidth: "2.5em",
              }}
            >
              {content}
            </SyntaxHighlighter>
          )}
        </div>
      </ScrollArea>
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
  onNavigate,
}: {
  counts: CustomizationCounts | null;
  onNavigate: (id: CustomizationSection) => void;
}) {
  const getCount = (item: NavItem): number | null => {
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
  onOpenDetail: (name: string, path: string) => void;
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
                  ? () => void onOpenDetail(agent.name, agent.path)
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
  onOpenDetail: (name: string, path: string) => void;
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
                  ? () => void onOpenDetail(skill.name, skill.path)
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
  onOpenDetail: (name: string, path: string) => void;
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
              onClick={() => onOpenDetail(rule.label, rule.path)}
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

// ─── Coming-soon section (Hooks / MCP Servers / Plugins) ──────────────────────

interface ComingSoonSectionProps {
  title: string;
  description: string;
  count: number | null;
  countLabel: string;
}

function ComingSoonSection({ title, description, count, countLabel }: ComingSoonSectionProps) {
  return (
    <SectionShell title={title} description={description}>
      <div className="px-4 py-2 flex flex-col gap-1">
        {count !== null && (
          <p className="text-sm tabular-nums">
            <span className="font-medium">{count}</span>{" "}
            <span className="text-muted-foreground">{countLabel}</span>
          </p>
        )}
        <p className="text-xs text-muted-foreground">Detailed listing coming soon.</p>
      </div>
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
}: CustomizationsDialogProps) {
  const [activeSection, setActiveSection] = useState<CustomizationSection>(initialSection);

  // Per-section search query — resets when section changes.
  const [search, setSearch] = useState("");

  // In-dialog file detail view state.
  const [detail, setDetail] = useState<{ name: string; path: string } | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState(false);

  // Reset active section + clear detail/search whenever the dialog opens.
  useEffect(() => {
    if (open) setActiveSection(initialSection);
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
    if (!item.countKey || counts === null) return null;
    return counts[item.countKey];
  };

  // Open a file in the in-dialog viewer.
  async function handleOpenDetail(name: string, path: string) {
    setDetail({ name, path });
    setFileContent(null);
    setFileError(false);
    setFileLoading(true);
    try {
      const content = await readTextFile(sessionId, path);
      setFileContent(content);
    } catch {
      setFileError(true);
    } finally {
      setFileLoading(false);
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
                onBack={handleBack}
              />
            ) : (
              <ScrollArea className="h-full">
                {activeSection === "overview" && (
                  <OverviewSection counts={counts} onNavigate={setActiveSection} />
                )}
                {activeSection === "agents" && (
                  <AgentsSection
                    capabilities={capabilities}
                    search={search}
                    onSearchChange={setSearch}
                    onOpenDetail={(name, path) => void handleOpenDetail(name, path)}
                  />
                )}
                {activeSection === "skills" && (
                  <SkillsSection
                    capabilities={capabilities}
                    search={search}
                    onSearchChange={setSearch}
                    onOpenDetail={(name, path) => void handleOpenDetail(name, path)}
                  />
                )}
                {activeSection === "instructions" && (
                  <InstructionsSection
                    rules={rules}
                    search={search}
                    onSearchChange={setSearch}
                    onOpenDetail={(name, path) => void handleOpenDetail(name, path)}
                  />
                )}
                {activeSection === "hooks" && (
                  <ComingSoonSection
                    title="Hooks"
                    description="Lifecycle hooks that run before and after agent operations."
                    count={counts?.hooks ?? null}
                    countLabel={counts?.hooks === 1 ? "hook configured" : "hooks configured"}
                  />
                )}
                {activeSection === "mcp" && (
                  <ComingSoonSection
                    title="MCP Servers"
                    description="Model Context Protocol servers providing tools and resources to the agent."
                    count={counts?.mcpServers ?? null}
                    countLabel={counts?.mcpServers === 1 ? "MCP server configured" : "MCP servers configured"}
                  />
                )}
                {activeSection === "plugins" && (
                  <ComingSoonSection
                    title="Plugins"
                    description="Installed Claude Code plugins that extend agent capabilities."
                    count={0}
                    countLabel="plugins installed"
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
