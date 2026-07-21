import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2, Maximize2, Minimize2, X } from "lucide-react";
import { PromptBar } from "./components/PromptBar";
import { NewSession } from "./components/NewSession";
import { Conversation, type Turn } from "./components/Conversation";
import { DiffReviewDialog } from "./components/DiffReviewDialog";
import { FilePreviewDialog, type FilePreviewState } from "./components/FilePreviewDialog";
import { TitleBar } from "./components/TitleBar";
import {
  SessionList,
  type SourceFilter,
  type StatusFilter,
} from "./components/SessionList";
import type { CustomizationSection } from "./components/CustomizationsDialog";
import { SessionHeader } from "./components/SessionHeader";
import { ContextPanel, FilesThisSession } from "./components/ContextPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { FilesTree } from "./components/FilesTree";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toaster } from "@/components/ui/sonner";
import { UpdaterHost } from "./components/UpdaterHost";
import {
  cleanupSession,
  continueExternalSession,
  defaultEngineFor,
  engineForSession,
  listTrustedRepos,
  nodeAvailable,
  openAgentLogin,
  pickRepository,
  respondToApproval,
  startSession,
  sendMessage,
  stopSession,
  type AgentEvent,
  type Engine,
} from "./lib/agent";
import {
  detectAgents,
  isAgentSpawnable,
  listModels,
  refreshModels,
  type AgentInfo,
  type ModelInfo,
} from "./lib/models";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  readAgentPrefs,
  writeAgentPrefs,
  isAgentEnabled,
  type AgentPrefs,
} from "./lib/agentPrefs";
import { reviewSession, type SessionDiff } from "./lib/review";
import {
  listSessions,
  renameSession,
  sessionEventsPage,
  type SessionSummary,
  type StoredEvent,
} from "./lib/sessions";
import { groupByWorkspace } from "./lib/workspaces";
import {
  coercePermissionMode,
  permissionModeLabel,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from "./lib/permissions";
import { shouldShowAcpDownloadNotice, shouldToastSessionNotice } from "./lib/acpNotice";
import {
  activityCountsFromEvents,
  contextFootprintFromSources,
  contextLoadTokens,
  estimateTokens,
  filesFromEvents,
  usageSummaryFromEvents,
} from "./lib/contextDerive";
import { detectTuiOnlyCommand } from "./lib/tuiCommands";
import {
  inspectRules,
  readTextFile,
  listCapabilities,
  type RuleFile,
  type Capabilities,
} from "./lib/inspect";
import { turnsFromEvents } from "./lib/turns";
import { lastAcpCommands } from "./lib/acpCommands";
import {
  branchChanges as fetchBranchChanges,
  worktreeTree as fetchWorktreeTree,
  commitSession,
  customizationsCounts,
  readWorktreeFile,
  openInEditor,
  openTerminal,
  listHooks,
  listMcpServers,
  listPlugins,
  type BranchChanges,
  type CustomizationCounts,
  type HookEntry,
  type McpServerEntry,
  type PluginEntry,
} from "./lib/conductor";
import { buildTree, type TreeNode } from "./lib/tree";
import {
  composeModels,
  getAgentConfig,
  pickDefaultModel,
  readAgentConfigs,
  useAgentConfigs,
} from "./lib/agentConfig";

const CustomizationsDialog = lazy(() =>
  import("./components/CustomizationsDialog").then((mod) => ({
    default: mod.CustomizationsDialog,
  })),
);

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 288;
const RIGHT_PANE_MIN_WIDTH = 360;
const RIGHT_PANE_MAX_WIDTH = 820;
const RIGHT_PANE_DEFAULT_WIDTH = 560;
const CENTER_MIN_WIDTH = 360;
const MAX_SESSION_PANES = 4;
const MIN_SPLIT_PANE_WIDTH = 520;
const MIN_SPLIT_PANE_HEIGHT = 340;
const EXTERNAL_EVENT_PAGE_SIZE = 300;
const PANEL_MOTION_MS = 160;

type SplitDirection = "vertical" | "horizontal";
type SessionPane = { id: string; sessionId: string | null };

/** Draft config for a New Session pane before it becomes a real session. Held per-pane so
 *  multiple New Session tabs each keep their own repo / agent / model / permission selection
 *  instead of sharing one global draft. */
type PaneDraft = {
  repo: string | null;
  agentId: string;
  /** Preferred model value for the agent; null ⇒ the agent's first model. */
  modelValue: string | null;
  permissionMode: PermissionMode;
  sandbox: boolean;
  /** Streaming engine, derived automatically (never user-chosen): "acp" for claude + codex when Node is available, "pipe" otherwise. */
  engine: Engine;
};
type EventPageState = {
  nextOffset: number;
  hasMore: boolean;
  loadingMore: boolean;
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clampNumber(parsed, min, max) : fallback;
  } catch {
    return fallback;
  }
}

/** The remembered default permission mode for NEW sessions, from localStorage. */
const PERMISSION_MODE_KEY = "kine-agent.defaultPermissionMode";
const PERMISSION_MODES: readonly PermissionMode[] = [
  "plan",
  "default",
  "acceptEdits",
  "full",
  "dontAsk",
];
function storedPermissionMode(): PermissionMode {
  try {
    const raw = localStorage.getItem(PERMISSION_MODE_KEY);
    return raw && (PERMISSION_MODES as readonly string[]).includes(raw)
      ? (raw as PermissionMode)
      : DEFAULT_PERMISSION_MODE;
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
}

/** Derive a short display title from the first non-empty line of the prompt. */
function titleFromPrompt(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  return line.length > 60
    ? `${line.slice(0, 59)}…`
    : line || "Untitled session";
}

function safeErrorMessage(err: unknown): string {
  const raw = String(err instanceof Error ? err.message : err);
  return raw
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/\/private\/var\/folders\/[^\s)]+/g, "<temp>")
    .replace(/\/var\/folders\/[^\s)]+/g, "<temp>");
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [turnsBySession, setTurnsBySession] = useState<Record<string, Turn[]>>({});
  const [eventsBySession, setEventsBySession] = useState<Record<string, StoredEvent[]>>({});
  const [eventPagesBySession, setEventPagesBySession] = useState<
    Record<string, EventPageState>
  >({});
  const [panes, setPanes] = useState<SessionPane[]>([
    { id: "pane-primary", sessionId: null },
  ]);
  const [focusedPaneId, setFocusedPaneId] = useState("pane-primary");
  const [splitDirection, setSplitDirection] = useState<SplitDirection>("vertical");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadingSessionIds, setLoadingSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [rightTab, setRightTab] = useState<
    "context" | "changes" | "files" | null
  >(null);
  const [renderedRightTab, setRenderedRightTab] = useState<typeof rightTab>(rightTab);
  const [rightExpanded, setRightExpanded] = useState(false);
  const [renderedRightExpanded, setRenderedRightExpanded] = useState(rightExpanded);
  const [storedEvents, setStoredEvents] = useState<StoredEvent[]>([]);
  const [rules, setRules] = useState<RuleFile[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [ruleView, setRuleView] = useState<{
    label: string;
    content: string;
  } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
  const [sessionModelValues, setSessionModelValues] = useState<Record<string, string>>({});
  const agentConfigs = useAgentConfigs();
  // The picker never renders the raw discovered list — curation applies everywhere.
  const modelsForAgent = useCallback(
    (agentId: string) =>
      composeModels(
        models.filter((m) => m.agent === agentId),
        getAgentConfig(agentConfigs, agentId),
        agentId,
      ),
    [models, agentConfigs],
  );
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  // Per-agent enable/disable choices (localStorage-backed). Codex ships enabled;
  // Claude/Antigravity are opt-in. Held in state so the Settings dialog and the New
  // Session picker share one reactive source, and written through on every change.
  const [agentPrefs, setAgentPrefs] = useState<AgentPrefs>(() => readAgentPrefs());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const updateAgentPrefs = useCallback((next: AgentPrefs) => {
    setAgentPrefs(next);
    writeAgentPrefs(next);
  }, []);
  // Node presence gates the ACP default for new drafts (ACP agents launch via
  // npx). Optimistic true: worst case a Node-less machine's first draft shows
  // ACP and the spawn error explains — flipped to false as soon as the check
  // lands, and the check is near-instant.
  const [nodeOk, setNodeOk] = useState(true);
  // Permission mode for the NEW Session composer — remembered across launches as the
  // user's preferred default. Its Antigravity terminal-sandbox toggle is transient.
  const [newSessionPermissionMode, setNewSessionPermissionMode] =
    useState<PermissionMode>(storedPermissionMode);
  // Mirror of the composer mode for reading inside callbacks without stale-closure deps.
  const newSessionPermissionModeRef = useRef(newSessionPermissionMode);
  newSessionPermissionModeRef.current = newSessionPermissionMode;
  const [newSessionSandbox] = useState(false);
  // Per-session permission mode + sandbox overrides, keyed by session id. These hold the
  // user's pending choice optimistically until the backend persists it (and seed the
  // dropdown for a session before its persisted value round-trips through list_sessions).
  const [sessionPermissionValues, setSessionPermissionValues] = useState<
    Record<string, PermissionMode>
  >({});
  const [sessionSandboxValues, setSessionSandboxValues] = useState<Record<string, boolean>>(
    {},
  );
  // Per-pane New Session draft, so each New Session tab is independent. A pane with no entry
  // falls back to defaultPaneDraft() (seeded from the last-used defaults); the first edit
  // commits a pane-specific entry, isolating it from the other panes.
  const [paneDrafts, setPaneDrafts] = useState<Record<string, PaneDraft>>({});
  const [recents, setRecents] = useState<string[]>([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    storedNumber(
      "kine-agent.sidebarWidth",
      SIDEBAR_DEFAULT_WIDTH,
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
    ),
  );
  const [rightPaneWidth, setRightPaneWidth] = useState(() =>
    storedNumber(
      "kine-agent.rightPaneWidth",
      RIGHT_PANE_DEFAULT_WIDTH,
      RIGHT_PANE_MIN_WIDTH,
      RIGHT_PANE_MAX_WIDTH,
    ),
  );
  // Sidebar collapse — persisted in localStorage.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("kine-agent.sidebarCollapsed") === "true";
    } catch {
      return false;
    }
  });
  // Customization counts for the active session, fetched best-effort.
  const [counts, setCounts] = useState<CustomizationCounts | null>(null);
  // Hooks, MCP servers, and plugins for the active session — fetched when the
  // customizations dialog opens and reset on session change.
  const [hooks, setHooks] = useState<HookEntry[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [contextResourceTokens, setContextResourceTokens] = useState<Record<string, number>>({});
  // Customizations dialog state — section defaults to "overview" until set by the sidebar row click.
  const [custDialogOpen, setCustDialogOpen] = useState(false);
  const [custSection, setCustSection] =
    useState<CustomizationSection>("overview");
  // Bumped after any create/edit/delete inside the Customizations dialog to re-run the
  // loader effect below and refresh the listings + sidebar counts.
  const [custReloadKey, setCustReloadKey] = useState(0);
  // Changes tab state.
  const [branchChanges, setBranchChanges] = useState<BranchChanges | null>(
    null,
  );
  const [branchChangesStatus, setBranchChangesStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  // Files tab state.
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  // Commit-in-flight flag.
  const [committing, setCommitting] = useState(false);
  // File-click diff review dialog — null means closed.
  const [diffDialog, setDiffDialog] = useState<{
    path: string;
    diff: SessionDiff;
  } | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);

  // Synchronous ref keeps the active session ID readable inside async callbacks
  // without stale-closure issues — the guard for cross-session contamination.
  const activeSessionIdRef = useRef<string | null>(null);
  const setActive = (id: string | null) => {
    activeSessionIdRef.current = id;
    setActiveSessionId(id);
  };

  function updateFocusedPaneSession(sessionId: string | null) {
    setPanes((prev) =>
      prev.map((pane) =>
        pane.id === focusedPaneId ? { ...pane, sessionId } : pane,
      ),
    );
  }

  function paneExists(paneId: string | null | undefined): boolean {
    return paneId === undefined || paneId === null || panes.some((pane) => pane.id === paneId);
  }

  function updatePaneSession(paneId: string | null | undefined, sessionId: string | null) {
    if (!paneId) {
      updateFocusedPaneSession(sessionId);
      return;
    }
    setPanes((prev) =>
      prev.map((pane) => (pane.id === paneId ? { ...pane, sessionId } : pane)),
    );
  }

  function resetFocusedSessionState() {
    setStoredEvents([]);
    setDiff(null);
    setRules([]);
    setCapabilities(null);
    setRuleView(null);
    setBranchChanges(null);
    setBranchChangesStatus("idle");
    setTreeNodes([]);
    setDiffDialog(null);
    setFilePreview(null);
    setHooks([]);
    setMcpServers([]);
    setPlugins([]);
    setContextResourceTokens({});
  }

  function setSessionLoading(sessionId: string, loading: boolean) {
    setLoadingSessionIds((prev) => {
      const next = new Set(prev);
      if (loading) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function setSessionTurns(
    sessionId: string,
    nextTurns: Turn[] | ((prev: Turn[]) => Turn[]),
  ) {
    setTurnsBySession((prev) => {
      const current = prev[sessionId] ?? [];
      const next =
        typeof nextTurns === "function" ? nextTurns(current) : nextTurns;
      return { ...prev, [sessionId]: next };
    });
  }

  function hasEventCache(sessionId: string): boolean {
    return Object.prototype.hasOwnProperty.call(eventsBySession, sessionId);
  }

  function hydrateSessionFromCache(sessionId: string): boolean {
    if (!hasEventCache(sessionId)) return false;
    const events = eventsBySession[sessionId] ?? [];
    setSessionTurns(sessionId, turnsFromEvents(events));
    if (activeSessionIdRef.current === sessionId) setStoredEvents(events);
    return true;
  }

  function appendStoredEvent(
    sessionId: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    const ts = Date.now();
    const cachedEvents = eventsBySession[sessionId] ?? [];
    setSessions((rows) =>
      rows.map((row) => {
        if (row.id !== sessionId) return row;
        const nextRow = { ...row, updatedAt: ts };
        if (kind === "prompt") {
          nextRow.turnCount = (row.turnCount ?? 0) + 1;
        } else if (kind === "toolCall") {
          nextRow.toolCallCount = (row.toolCallCount ?? 0) + 1;
        } else if (kind === "fileWrite") {
          const path = typeof payload.path === "string" ? payload.path : "";
          const alreadySeen =
            path !== "" &&
            cachedEvents.some((event) => {
              if (event.kind !== "fileWrite") return false;
              try {
                return JSON.parse(event.payloadJson)?.path === path;
              } catch {
                return false;
              }
            });
          if (!alreadySeen) {
            nextRow.fileActionCount = (row.fileActionCount ?? 0) + 1;
          }
        }
        return nextRow;
      }),
    );

    setEventsBySession((prev) => {
      const current = prev[sessionId] ?? [];
      const nextEvent: StoredEvent = {
        seq: current.length,
        kind,
        payloadJson: JSON.stringify(payload),
        ts,
      };
      const next = [...current, nextEvent];
      if (activeSessionIdRef.current === sessionId) setStoredEvents(next);
      return { ...prev, [sessionId]: next };
    });
  }

  async function loadSessionEvents(sessionId: string, opts?: { force?: boolean }) {
    if (!opts?.force && hydrateSessionFromCache(sessionId)) return;
    setSessionLoading(sessionId, true);
    try {
      const page = await sessionEventsPage(sessionId, 0, EXTERNAL_EVENT_PAGE_SIZE);
      setEventsBySession((prev) => ({ ...prev, [sessionId]: page.events }));
      setEventPagesBySession((prev) => ({
        ...prev,
        [sessionId]: {
          nextOffset: page.nextOffset,
          hasMore: page.hasMore,
          loadingMore: false,
        },
      }));
      setSessionTurns(sessionId, turnsFromEvents(page.events));
      if (activeSessionIdRef.current === sessionId) setStoredEvents(page.events);
    } catch {
      setEventsBySession((prev) => ({ ...prev, [sessionId]: [] }));
      setEventPagesBySession((prev) => ({
        ...prev,
        [sessionId]: { nextOffset: 0, hasMore: false, loadingMore: false },
      }));
      setSessionTurns(sessionId, []);
      if (activeSessionIdRef.current === sessionId) setStoredEvents([]);
    } finally {
      setSessionLoading(sessionId, false);
    }
  }

  async function loadMoreSessionEvents(sessionId: string) {
    const pageState = eventPagesBySession[sessionId];
    if (!pageState?.hasMore || pageState.loadingMore) return;
    setEventPagesBySession((prev) => ({
      ...prev,
      [sessionId]: { ...pageState, loadingMore: true },
    }));
    try {
      const page = await sessionEventsPage(
        sessionId,
        pageState.nextOffset,
        EXTERNAL_EVENT_PAGE_SIZE,
      );
      const merged = [...page.events, ...(eventsBySession[sessionId] ?? [])];
      setEventsBySession((prev) => ({ ...prev, [sessionId]: merged }));
      setSessionTurns(sessionId, turnsFromEvents(merged));
      if (activeSessionIdRef.current === sessionId) setStoredEvents(merged);
      setEventPagesBySession((prev) => ({
        ...prev,
        [sessionId]: {
          nextOffset: page.nextOffset,
          hasMore: page.hasMore,
          loadingMore: false,
        },
      }));
    } catch {
      setEventPagesBySession((prev) => ({
        ...prev,
        [sessionId]: { ...pageState, loadingMore: false },
      }));
      toast.error("Could not load more of this CLI session.");
    }
  }

  // Mirror of runningSessionIds for reading inside the closePane state-updater without a
  // stale closure. Used to avoid evicting the event/turn cache of a session that is still
  // streaming (its in-flight onEvent would immediately recreate the entry, churning).
  const runningSessionIdsRef = useRef(runningSessionIds);
  useEffect(() => {
    runningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds]);

  // Returns the session list so callers can chain follow-up work off it.
  // Best-effort — no-op in a plain browser preview (assertDesktop throws).
  const refreshSessions = useCallback(async (): Promise<SessionSummary[]> => {
    try {
      const list = await listSessions();
      setSessions(list);
      return list;
    } catch {
      /* not in the desktop app */
      return [];
    }
  }, []);

  // Per-id rename token. Each rename bumps the id's counter; only the most recent
  // rename's async result is allowed to reconcile state. This prevents an earlier
  // rename whose IPC resolves LATER (out-of-order under backend lock contention) from
  // clobbering a newer title the user already committed.
  const renameSeqRef = useRef<Map<string, number>>(new Map());

  // Rename a session: optimistically update the row, then reconcile with the
  // canonical (trimmed/capped) title the backend stores. On failure, revert by
  // re-fetching the list and surface the error. Stale (superseded) results are ignored.
  const handleRenameSession = useCallback(
    async (id: string, title: string) => {
      const seq = (renameSeqRef.current.get(id) ?? 0) + 1;
      renameSeqRef.current.set(id, seq);
      const isLatest = () => renameSeqRef.current.get(id) === seq;
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
      try {
        const stored = await renameSession(id, title);
        if (isLatest()) {
          setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: stored } : s)));
        }
      } catch (e) {
        if (isLatest()) {
          toast.error(typeof e === "string" ? e : "Failed to rename session.");
          void refreshSessions();
        }
      }
    },
    [refreshSessions],
  );

  // Discover installed agents and their available models on mount.
  // Best-effort — no-op in the browser preview where IPC is unavailable.
  const loadModels = useCallback(async () => {
    try {
      const discovered = await detectAgents();
      const supported = discovered.filter(
        (a) => a.id === "claude" || a.id === "codex" || a.id === "antigravity",
      );
      const installed = supported.filter((a) => a.installed);
      const results = await Promise.allSettled(
        installed.map((a) => listModels(a.id)),
      );
      const all = results
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .filter((m) => !m.disabled);
      // Default to an ENABLED spawnable agent (Codex ships on; Claude/Antigravity are
      // opt-in), then fall back to any spawnable, then any installed — so the picker is
      // never empty even before the user visits Settings. A disabled default still can't
      // send: the composer gates on enablement and points the user to Settings.
      const defaultAgent =
        installed.find(
          (a) => isAgentSpawnable(a.id) && isAgentEnabled(a.id, agentPrefs),
        ) ??
        installed.find((a) => isAgentSpawnable(a.id)) ??
        installed[0] ??
        null;
      const configs = readAgentConfigs();
      const defaultModel = defaultAgent
        ? (pickDefaultModel(
            composeModels(
              all.filter((m) => m.agent === defaultAgent.id),
              getAgentConfig(configs, defaultAgent.id),
              defaultAgent.id,
            ),
            getAgentConfig(configs, defaultAgent.id),
          ) ??
          all[0] ??
          null)
        : (all[0] ?? null);
      setAgents(supported);
      setSelectedAgent((prev) => prev ?? defaultAgent);
      setModels(all);
      setSelectedModel((prev) => prev ?? defaultModel);

      // Background pass: re-resolve aliases against the CLI so labels upgrade
      // from "Claude Opus" to the versioned "Claude Opus 4.8". This may spawn
      // CLI subprocesses, so it must not block the initial selector render.
      void upgradeModelLabels(installed);
    } catch (err) {
      console.error("failed to load models", err);
    }
  }, []);

  // Resolve versioned labels in the background and merge them in, keeping the
  // current selection (matched by alias `value`). A failed/empty refresh leaves
  // the alias list untouched.
  const upgradeModelLabels = useCallback(async (installed: AgentInfo[]) => {
    try {
      const results = await Promise.allSettled(
        installed.map((a) => refreshModels(a.id)),
      );
      const upgraded = results
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .filter((m) => !m.disabled);
      if (upgraded.length === 0) return;
      setModels(upgraded);
      setSelectedModel((prev) =>
        prev
          ? (upgraded.find((m) => m.value === prev.value) ?? prev)
          : (upgraded[0] ?? null),
      );
    } catch (err) {
      console.error("failed to refresh model labels", err);
    }
  }, []);

  // Agents support different permission modes; when the composer's target agent changes,
  // coerce the New Session mode to one the agent supports (always resolving DOWN to a safe
  // mode, never escalating to Full). Surface the change so it's never silent.
  const applyComposerModeForAgent = useCallback((agentId: string, agentLabel: string) => {
    const prev = newSessionPermissionModeRef.current;
    const { mode, changed } = coercePermissionMode(prev, agentId);
    if (!changed) return;
    newSessionPermissionModeRef.current = mode;
    setNewSessionPermissionMode(mode);
    toast.info(
      `${agentLabel} doesn't support "${permissionModeLabel(prev)}"; using "${permissionModeLabel(mode)}".`,
    );
    try {
      localStorage.setItem(PERMISSION_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, []);

  // Selecting a model also syncs the agent back to that model's agent, so the
  // pair stays consistent regardless of which control the user touches — including
  // coercing the permission mode when the model belongs to a different agent.
  const handleModelChange = useCallback(
    (m: ModelInfo) => {
      setSelectedModel(m);
      setSelectedAgent((prev) =>
        prev?.id === m.agent ? prev : (agents.find((a) => a.id === m.agent) ?? prev),
      );
      // If the picked model belongs to a different agent, coerce the mode to match.
      const nextAgent = agents.find((a) => a.id === m.agent);
      if (nextAgent) applyComposerModeForAgent(nextAgent.id, nextAgent.label);
    },
    [agents, applyComposerModeForAgent],
  );

  function modelForAgent(agentId: string, preferredValue?: string): ModelInfo | null {
    const agentModels = models.filter((m) => m.agent === agentId);
    if (preferredValue) {
      const preferred = agentModels.find(
        (m) =>
          m.value === preferredValue ||
          m.label === preferredValue ||
          m.description === preferredValue,
      );
      if (preferred) return preferred;
    }
    return agentModels[0] ?? null;
  }

  function modelForSession(session: SessionSummary | null): ModelInfo | null {
    if (session === null) return selectedModel;
    const agentId = isAgentSpawnable(session.agent)
      ? session.agent
      : (selectedModel?.agent ?? models[0]?.agent ?? "claude");
    return modelForAgent(agentId, sessionModelValues[session.id] ?? session.branch);
  }

  function handleSessionModelChange(sessionId: string, model: ModelInfo) {
    setSessionModelValues((prev) => ({ ...prev, [sessionId]: model.value }));
  }

  // The effective permission mode / sandbox flag for a session: the user's pending
  // override wins, then the persisted value from the session row, then the safe default.
  function permissionModeForSession(session: SessionSummary | null): PermissionMode {
    if (session === null) return newSessionPermissionMode;
    return (
      sessionPermissionValues[session.id] ??
      (session.permissionMode as PermissionMode | null | undefined) ??
      DEFAULT_PERMISSION_MODE
    );
  }

  function sandboxForSession(session: SessionSummary | null): boolean {
    if (session === null) return newSessionSandbox;
    return sessionSandboxValues[session.id] ?? session.sandboxTerminal ?? false;
  }

  function setSessionPermissionMode(sessionId: string, mode: PermissionMode) {
    setSessionPermissionValues((prev) => ({ ...prev, [sessionId]: mode }));
  }

  // ── Per-pane New Session draft ────────────────────────────────────────────────
  // A fresh pane is seeded from the last-used defaults; once edited it holds its own entry,
  // so changing one New Session tab's repo/agent/model/permission never touches the others.
  function defaultPaneDraft(): PaneDraft {
    const agentId = selectedAgent?.id ?? models[0]?.agent ?? "claude";
    return {
      repo: null,
      agentId,
      modelValue: selectedModel?.agent === agentId ? (selectedModel?.value ?? null) : null,
      permissionMode: newSessionPermissionMode,
      sandbox: newSessionSandbox,
      engine: defaultEngineFor(agentId, nodeOk),
    };
  }

  function draftFor(paneId: string): PaneDraft {
    return paneDrafts[paneId] ?? defaultPaneDraft();
  }

  function updatePaneDraft(paneId: string, patch: Partial<PaneDraft>) {
    setPaneDrafts((prev) => ({
      ...prev,
      [paneId]: { ...(prev[paneId] ?? defaultPaneDraft()), ...patch },
    }));
  }

  // The agent picker is the source of truth: switching narrows the model to that agent and
  // coerces the permission mode when the new agent doesn't support the current one.
  function paneAgentChange(paneId: string, a: AgentInfo) {
    const cur = draftFor(paneId);
    const keepModel =
      cur.modelValue !== null &&
      models.some((m) => m.value === cur.modelValue && m.agent === a.id);
    const modelValue = keepModel
      ? cur.modelValue
      : (models.find((m) => m.agent === a.id)?.value ?? null);
    const { mode, changed } = coercePermissionMode(cur.permissionMode, a.id);
    if (changed) {
      toast.info(
        `${a.label} doesn't support "${permissionModeLabel(cur.permissionMode)}"; using "${permissionModeLabel(mode)}".`,
      );
    }
    updatePaneDraft(paneId, {
      agentId: a.id,
      modelValue,
      permissionMode: mode,
      // Engine is automatic — re-derived for the new agent, never user-chosen.
      engine: defaultEngineFor(a.id, nodeOk),
    });
  }

  function paneModelChange(paneId: string, m: ModelInfo) {
    const cur = draftFor(paneId);
    const { mode } = coercePermissionMode(cur.permissionMode, m.agent);
    updatePaneDraft(paneId, {
      modelValue: m.value,
      agentId: m.agent,
      permissionMode: mode,
      // Picking another agent's model also switches agents — same automatic derivation.
      engine: defaultEngineFor(m.agent, nodeOk),
    });
  }

  function panePermissionChange(paneId: string, mode: PermissionMode) {
    updatePaneDraft(paneId, { permissionMode: mode });
    try {
      localStorage.setItem(PERMISSION_MODE_KEY, mode); // remembered as the next-launch default
    } catch {
      /* ignore */
    }
  }

  async function pickRepoForPane(paneId: string) {
    try {
      const path = await pickRepository();
      if (!path) return;
      updatePaneDraft(paneId, { repo: path });
      setRecents(await listTrustedRepos());
    } catch (err) {
      toast.error(safeErrorMessage(err));
    }
  }

  function setSessionSandbox(sessionId: string, value: boolean) {
    setSessionSandboxValues((prev) => ({ ...prev, [sessionId]: value }));
  }

  // Sidebar toggle — persists the new value to localStorage immediately.
  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("kine-agent.sidebarCollapsed", String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function persistPanelWidth(key: string, value: number) {
    try {
      localStorage.setItem(key, String(Math.round(value)));
    } catch {
      /* ignore */
    }
  }

  function rightPaneMaxWidth(): number {
    const sidebarSpace = sidebarCollapsed ? 0 : sidebarWidth;
    const available = window.innerWidth - sidebarSpace - CENTER_MIN_WIDTH - 48;
    return Math.max(RIGHT_PANE_MIN_WIDTH, Math.min(RIGHT_PANE_MAX_WIDTH, available));
  }

  function startSidebarResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (event: PointerEvent) => {
      const next = clampNumber(
        startWidth + event.clientX - startX,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
      );
      setSidebarWidth(next);
    };
    const onUp = (event: PointerEvent) => {
      const next = clampNumber(
        startWidth + event.clientX - startX,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
      );
      setSidebarWidth(next);
      persistPanelWidth("kine-agent.sidebarWidth", next);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function startRightPaneResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightPaneWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (event: PointerEvent) => {
      const next = clampNumber(
        startWidth - (event.clientX - startX),
        RIGHT_PANE_MIN_WIDTH,
        rightPaneMaxWidth(),
      );
      setRightPaneWidth(next);
    };
    const onUp = (event: PointerEvent) => {
      const next = clampNumber(
        startWidth - (event.clientX - startX),
        RIGHT_PANE_MIN_WIDTH,
        rightPaneMaxWidth(),
      );
      setRightPaneWidth(next);
      persistPanelWidth("kine-agent.rightPaneWidth", next);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function resizeSidebarBy(delta: number) {
    const next = clampNumber(sidebarWidth + delta, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    setSidebarWidth(next);
    persistPanelWidth("kine-agent.sidebarWidth", next);
  }

  function resizeRightPaneBy(delta: number) {
    const next = clampNumber(
      rightPaneWidth + delta,
      RIGHT_PANE_MIN_WIDTH,
      rightPaneMaxWidth(),
    );
    setRightPaneWidth(next);
    persistPanelWidth("kine-agent.rightPaneWidth", next);
  }

  function centerWorkspaceSize() {
    const sidebarSpace = sidebarCollapsed ? 0 : sidebarWidth;
    return {
      width: Math.max(0, window.innerWidth - sidebarSpace - 48),
      height: Math.max(0, window.innerHeight - 72),
    };
  }

  function maxPanesForViewport() {
    if (window.innerWidth < 900) return 1;
    const { width, height } = centerWorkspaceSize();
    const canTwoColumns = width >= MIN_SPLIT_PANE_WIDTH * 2;
    const canTwoRows = height >= MIN_SPLIT_PANE_HEIGHT * 2;
    if (canTwoColumns && canTwoRows) return MAX_SESSION_PANES;
    if (splitDirection === "horizontal") return canTwoRows ? 2 : 1;
    return canTwoColumns ? 2 : 1;
  }

  function focusPane(pane: SessionPane) {
    setFocusedPaneId(pane.id);
    setActive(pane.sessionId);
    resetFocusedSessionState();
    closeRight();
    if (pane.sessionId !== null) {
      void loadSessionEvents(pane.sessionId);
      const session = sessions.find((s) => s.id === pane.sessionId);
      if (session?.source !== "external") void refreshDiff(pane.sessionId);
    }
  }

  function addSplit(direction: SplitDirection) {
    if (panes.length >= MAX_SESSION_PANES) return;
    if (panes.length >= maxPanesForViewport()) {
      toast.error("Not enough space for another split.");
      return;
    }
    setSplitDirection(direction);
    const pane: SessionPane = { id: crypto.randomUUID(), sessionId: null };
    setPanes((prev) => [...prev, pane]);
    setFocusedPaneId(pane.id);
    setActive(null);
    resetFocusedSessionState();
    closeRight();
  }

  function closePane(paneId: string) {
    setPanes((prev) => {
      const closing = prev.find((pane) => pane.id === paneId);
      if (prev.length === 1) {
        setActive(null);
        resetFocusedSessionState();
        closeRight();
        return [{ ...prev[0], sessionId: null }];
      }
      const next = prev.filter((pane) => pane.id !== paneId);
      if (focusedPaneId === paneId) {
        const replacement = next[0];
        setFocusedPaneId(replacement.id);
        setActive(replacement.sessionId);
        resetFocusedSessionState();
        closeRight();
        if (replacement.sessionId !== null) void loadSessionEvents(replacement.sessionId);
      }
      // Evict the closed session's caches — but NOT while it is still streaming. A
      // running session's in-flight onEvent would immediately recreate the entry (churn),
      // and the session is still live + reachable from the list, so its cache is
      // legitimately retained until the run ends or the session is reopened.
      if (
        closing?.sessionId &&
        !next.some((pane) => pane.sessionId === closing.sessionId) &&
        !runningSessionIdsRef.current.has(closing.sessionId)
      ) {
        setTurnsBySession((cache) => {
          const { [closing.sessionId!]: _removed, ...rest } = cache;
          return rest;
        });
        setEventsBySession((cache) => {
          const { [closing.sessionId!]: _removed, ...rest } = cache;
          return rest;
        });
        setEventPagesBySession((cache) => {
          const { [closing.sessionId!]: _removed, ...rest } = cache;
          return rest;
        });
      }
      return next;
    });
  }

  // Guard: only apply the fetched diff if the session is still the active one.
  // A late fetch from a prior session must not clobber the now-active session's diff.
  const refreshDiff = useCallback(async (sessionId: string) => {
    try {
      const d = await reviewSession({ sessionId });
      if (activeSessionIdRef.current === sessionId) setDiff(d);
    } catch {
      if (activeSessionIdRef.current === sessionId) setDiff(null);
    }
  }, []);

  // Refresh branch-level changes for the Changes tab — same stale-session guard.
  const refreshBranchChanges = useCallback(async (sessionId: string) => {
    setBranchChangesStatus("loading");
    try {
      const result = await fetchBranchChanges(sessionId);
      if (activeSessionIdRef.current === sessionId) {
        setBranchChanges(result);
        setBranchChangesStatus("ready");
      }
    } catch {
      if (activeSessionIdRef.current === sessionId) {
        setBranchChanges(null);
        setBranchChangesStatus("error");
      }
    }
  }, []);

  // Open the backend-owned native directory picker and update repo + recents.
  // On mount: load sessions.
  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    nodeAvailable()
      .then(setNodeOk)
      .catch(() => setNodeOk(false));
  }, []);

  useEffect(() => {
    const clampPanes = () => {
      const max = maxPanesForViewport();
      if (panes.length <= max) return;
      const focused = panes.find((pane) => pane.id === focusedPaneId) ?? panes[0];
      const next = [
        focused,
        ...panes.filter((pane) => pane.id !== focused.id),
      ].slice(0, max);
      const sessionChanged = activeSessionIdRef.current !== next[0].sessionId;
      setPanes(next);
      setFocusedPaneId(next[0].id);
      setActive(next[0].sessionId);
      if (sessionChanged) resetFocusedSessionState();
    };
    clampPanes();
    window.addEventListener("resize", clampPanes);
    return () => window.removeEventListener("resize", clampPanes);
  }, [
    panes,
    focusedPaneId,
    sidebarCollapsed,
    sidebarWidth,
    rightPaneWidth,
    rightTab,
    rightExpanded,
    splitDirection,
  ]);

  useEffect(() => {
    try {
      localStorage.removeItem("agent-editor.recentRepos");
    } catch {
      /* legacy cleanup */
    }
    (async () => {
      try {
        setRecents(await listTrustedRepos());
      } catch {
        setRecents([]);
      }
    })();
  }, []);

  // Fetch customization counts whenever the active session changes. With no active
  // session (null) the backend reports the user's global ~/.claude scope, so the
  // sidebar always shows real counts — even on the New Session screen.
  useEffect(() => {
    const sessionId = activeSessionId;
    (async () => {
      try {
        const c = await customizationsCounts(sessionId);
        if (activeSessionIdRef.current === sessionId) setCounts(c);
      } catch {
        if (activeSessionIdRef.current === sessionId) setCounts(null);
      }
    })();
    // custReloadKey: refresh counts after a create/edit/delete in the dialog.
  }, [activeSessionId, custReloadKey]);

  // closeRight keeps the "reset both flags together" invariant structural.
  const closeRight = () => {
    setRightTab(null);
    setRightExpanded(false);
  };

  // Esc closes the right pane — especially useful in the chat-hiding expanded state.
  // Inline the two setters so the linter's exhaustive-deps rule is satisfied.
  useEffect(() => {
    if (rightTab === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRightTab(null);
        setRightExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rightTab]);

  // Fetch rules/config, lightweight capability metadata, and local token estimates
  // whenever the Context tab becomes active for a session. Capability inventory
  // belongs in Customizations; the Context tab only uses metadata to match consumed
  // agents/skills/commands that appear in the transcript.
  // Captures sessionId at effect-run time so the cross-session ref guard works correctly
  // even if the user switches sessions while awaiting IPC calls.
  useEffect(() => {
    if (rightTab !== "context" || !activeSessionId) return;
    const sessionId = activeSessionId;
    (async () => {
      let nextRules: RuleFile[] = [];
      let nextCapabilities: Capabilities | null = null;

      try {
        nextRules = await inspectRules(sessionId);
      } catch {
        nextRules = [];
      }

      try {
        const session = sessions.find((s) => s.id === sessionId) ?? null;
        const agentId = session?.agent ?? selectedModel?.agent ?? "claude";
        nextCapabilities = await listCapabilities(sessionId, agentId);
      } catch {
        nextCapabilities = null;
      }

      const resourcePaths = Array.from(
        new Set(
          nextRules.filter((rule) => rule.exists).map((rule) => rule.path).filter(Boolean),
        ),
      );
      const tokenEntries = await Promise.all(
        resourcePaths.map(async (path) => {
          try {
            const content = await readTextFile(sessionId, path);
            return [path, estimateTokens(content)] as const;
          } catch {
            return [path, 0] as const;
          }
        }),
      );

      if (activeSessionIdRef.current !== sessionId) return;
      setRules(nextRules);
      setCapabilities(nextCapabilities);
      setContextResourceTokens(Object.fromEntries(tokenEntries.filter(([, tokens]) => tokens > 0)));
    })();
  }, [rightTab, activeSessionId, selectedModel?.agent, sessions]);

  // Fetch rules, capabilities, hooks, MCP servers, and plugins when the Customizations
  // dialog opens. With an active session this is the worktree (project + user) scope;
  // with none, the user's global ~/.claude scope. All best-effort — failures produce
  // empty state rather than errors. If the Context tab already fetched rules/capabilities,
  // the setters are idempotent and the IPC round-trip is cheap.
  useEffect(() => {
    if (!custDialogOpen) return;
    const sessionId = activeSessionId; // null → user's global ~/.claude scope
    (async () => {
      try {
        const r = await inspectRules(sessionId);
        if (activeSessionIdRef.current === sessionId) setRules(r);
      } catch {
        /* best-effort */
      }
      try {
        const session = sessions.find((s) => s.id === sessionId) ?? null;
        const agentId = session?.agent ?? selectedModel?.agent ?? "claude";
        const c = await listCapabilities(sessionId, agentId);
        if (activeSessionIdRef.current === sessionId) setCapabilities(c);
      } catch {
        /* best-effort */
      }
      try {
        const h = await listHooks(sessionId);
        if (activeSessionIdRef.current === sessionId) setHooks(h);
      } catch {
        /* best-effort */
      }
      try {
        const m = await listMcpServers(sessionId);
        if (activeSessionIdRef.current === sessionId) setMcpServers(m);
      } catch {
        /* best-effort */
      }
      try {
        const p = await listPlugins(sessionId);
        if (activeSessionIdRef.current === sessionId) setPlugins(p);
      } catch {
        /* best-effort */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custDialogOpen, activeSessionId, selectedModel?.agent, sessions, custReloadKey]);

  // Fetch branch-level changes when the Changes tab becomes active.
  useEffect(() => {
    if (rightTab !== "changes" || !activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session?.source === "external") return;
    const sessionId = activeSessionId;
    void refreshBranchChanges(sessionId);
  }, [rightTab, activeSessionId, refreshBranchChanges, sessions]);

  // Fetch the flat worktree file list and build the nested tree when Files tab opens.
  useEffect(() => {
    if (rightTab !== "files" || !activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session?.source === "external") return;
    const sessionId = activeSessionId;
    (async () => {
      try {
        const entries = await fetchWorktreeTree(sessionId);
        if (activeSessionIdRef.current === sessionId)
          setTreeNodes(buildTree(entries));
      } catch {
        if (activeSessionIdRef.current === sessionId) setTreeNodes([]);
      }
    })();
  }, [rightTab, activeSessionId, sessions]);

  function appendToLastTurn(sessionId: string, event: AgentEvent) {
    appendStoredEvent(sessionId, event.kind, event.data);
    setSessionTurns(sessionId, (prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, events: [...last.events, event] };
      return next;
    });
  }

  async function handleOpenAgentLogin(sessionId: string, agent: string) {
    try {
      await openAgentLogin(agent, sessionId);
      toast.info("Login terminal opened", {
        description: "Choose a login method, finish the browser step, paste the code into that terminal, then retry.",
      });
    } catch (err) {
      toast.error(safeErrorMessage(err));
    }
  }

  // Commit the session's worktree changes. Shows toast feedback and refreshes
  // the Changes tab data after a successful commit.
  // Returns true on a successful commit so the composer can close itself; false on
  // failure (or a no-op guard) so the user keeps their typed message to retry.
  async function handleCommit(message: string): Promise<boolean> {
    if (!activeSessionId || committing || activeSession?.source === "external")
      return false;
    const sessionId = activeSessionId;
    setCommitting(true);
    try {
      const result = await commitSession(sessionId, message);
      toast.success(`Committed ${result.sha.slice(0, 7)}`);
      // Refresh the Changes tab data, diff, and sessions list after a successful commit.
      await Promise.allSettled([
        refreshBranchChanges(sessionId),
        refreshDiff(sessionId),
        refreshSessions(),
      ]);
      return true;
    } catch (err) {
      toast.error(safeErrorMessage(err));
      return false;
    } finally {
      setCommitting(false);
    }
  }

  // Open the diff review dialog for a clicked file path. If the patch has not
  // loaded yet, attempt a best-effort fetch first.
  async function handleOpenFile(path: string) {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    let sessionDiff = diff;
    if (!sessionDiff) {
      try {
        sessionDiff = await reviewSession({ sessionId });
        if (activeSessionIdRef.current === sessionId) setDiff(sessionDiff);
      } catch {
        sessionDiff = null;
      }
    }
    if (sessionDiff && activeSessionIdRef.current === sessionId) {
      setDiffDialog({ path, diff: sessionDiff });
    }
  }

  async function handlePreviewWorktreeFile(path: string) {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    setFilePreview({ path, content: null, status: "loading" });
    try {
      const content = await readWorktreeFile(sessionId, path);
      if (activeSessionIdRef.current === sessionId) {
        setFilePreview({ path, content, status: "ready" });
      }
    } catch (err) {
      if (activeSessionIdRef.current === sessionId) {
        setFilePreview({
          path,
          content: null,
          status: "error",
          error: safeErrorMessage(err),
        });
      }
    }
  }

  async function handleOpenFilesTreeFile(path: string, node: TreeNode) {
    if (node.status) {
      await handleOpenFile(path);
    } else {
      await handlePreviewWorktreeFile(path);
    }
  }

  async function handleSend(
    text: string,
    model: ModelInfo | null,
    opts?: {
      repo?: string;
      permissionMode?: PermissionMode;
      sandboxTerminal?: boolean;
      agent?: string;
      /** Streaming engine for NEW sessions only; follow-ups reuse the persisted engine. */
      engine?: Engine;
      sessionId?: string | null;
      paneId?: string;
    },
  ) {
    if (opts?.paneId && !paneExists(opts.paneId)) return;
    const currentSessionId = opts?.sessionId ?? activeSessionIdRef.current;
    const currentSession =
      sessions.find((session) => session.id === currentSessionId) ?? null;
    if (currentSessionId !== null && currentSession === null) {
      toast.error("Session is no longer available.");
      return;
    }
    const targetPaneId = opts?.paneId;
    const isExternalContinuation = currentSession?.source === "external";
    const isNew = currentSessionId === null || isExternalContinuation;
    const sessionId = isNew ? crypto.randomUUID() : currentSessionId;
    const repo = opts?.repo ?? currentSession?.repo ?? ".";
    // The engine this send runs on: new sessions carry the draft's derived engine in
    // opts; follow-ups reuse the engine persisted on the session row.
    const sendEngine: Engine =
      opts?.engine ?? (currentSession ? engineForSession(currentSession) : "pipe");
    const modelArg = model?.value;
    // Effective permission mode + terminal sandbox for this send: an explicit opt (the New
    // Session composer) wins; otherwise the pane session's pending override, then its
    // persisted value, then the safe default.
    const permissionKey = currentSessionId;
    const effectivePermissionMode: PermissionMode =
      opts?.permissionMode ??
      (permissionKey ? sessionPermissionValues[permissionKey] : undefined) ??
      (currentSession?.permissionMode as PermissionMode | null | undefined) ??
      DEFAULT_PERMISSION_MODE;
    const effectiveSandbox: boolean =
      opts?.sandboxTerminal ??
      (permissionKey ? sessionSandboxValues[permissionKey] : undefined) ??
      currentSession?.sandboxTerminal ??
      false;
    const preferredAgent = opts?.agent ?? model?.agent ?? currentSession?.agent ?? "claude";
    const startAgent = isAgentSpawnable(preferredAgent)
      ? preferredAgent
      : (selectedModel?.agent ?? "claude");
    // Adopting external CLI history starts a NEW automated session, so it honors the
    // agent-enablement gate (unlike follow-ups on an existing Kine Agent session, which
    // always resume their row's agent). This guard MUST run before any optimistic state
    // mutation below, so a disabled agent is a clean no-op that routes to Settings —
    // otherwise the early return would strand a half-created "running" row.
    if (isExternalContinuation && !isAgentEnabled(startAgent, agentPrefs)) {
      const label = agents.find((a) => a.id === startAgent)?.label ?? startAgent;
      toast.info(`${label} is disabled`, {
        description: "Enable it in Settings to continue this session in Kine Agent.",
      });
      setSettingsOpen(true);
      return;
    }
    // TUI-only built-ins (e.g. /status, /model) open interactive screens that a
    // headless `claude -p` spawn rejects — hint instead of burning a turn.
    if (startAgent === "claude") {
      const customNames = [
        ...(capabilities?.skills.map((s) => s.name) ?? []),
        ...(capabilities?.commands.map((c) => c.name) ?? []),
      ];
      const tuiCommand = detectTuiOnlyCommand(text, customNames);
      if (tuiCommand) {
        toast.info(`/${tuiCommand} needs Claude Code's interactive terminal`, {
          description:
            "Headless sessions can't open its screen. Run `claude` in a terminal for that — model, permission mode, and usage live in Kine Agent's Context panel.",
        });
        return;
      }
    }
    if (opts?.engine === "acp" && shouldShowAcpDownloadNotice()) {
      toast.info("First ACP run downloads the agent adapter", {
        description:
          "npx fetches the pinned adapter package for this agent (one-time per install) — the first turn can take a minute before streaming starts.",
      });
    }
    // Set the ref synchronously before the first await so the cross-session guard
    // is exact for new sessions (id now known up front, not after startSession resolves).
    setActive(sessionId);
    if (targetPaneId) setFocusedPaneId(targetPaneId);
    updatePaneSession(targetPaneId, sessionId);
    // Optimistically upsert a "running" row at the top of the list immediately —
    // refreshSessions() in finally reconciles the real title/status from the backend.
    setSessions((prev) => {
      const existing = prev.find((s) => s.id === sessionId);
      const now = Date.now();
      const row: SessionSummary = existing
        ? { ...existing, status: "running", updatedAt: now }
        : {
            id: sessionId,
            agent: startAgent,
            repo,
            branch: `agent/${sessionId}`,
            // Continuing a renamed CLI-history session keeps the user's chosen title
            // (the backend carries the override into the new session); otherwise derive
            // it from the prompt.
            title:
              isExternalContinuation && currentSession
                ? currentSession.title
                : titleFromPrompt(text),
            status: "running",
            source: "kine-agent",
            turnCount: null,
            toolCallCount: null,
            fileActionCount: null,
            permissionMode: effectivePermissionMode,
            sandboxTerminal: effectiveSandbox,
            // Carried on the optimistic row so engine-aware UI (Context panel) is
            // right immediately, before refreshSessions round-trips.
            engine: sendEngine,
            createdAt: now,
            updatedAt: now,
          };
      return [row, ...prev.filter((s) => s.id !== sessionId)];
    });
    closeRight();
    // Seed the session's model so its PromptBar picker reflects the pick
    // immediately, before the persisted value round-trips.
    if (modelArg) {
      setSessionModelValues((prev) => ({ ...prev, [sessionId]: modelArg }));
    }
    // Seed the (possibly new) session's mode so its PromptBar dropdown reflects the choice
    // immediately, before the persisted value round-trips through refreshSessions().
    setSessionPermissionValues((prev) => ({ ...prev, [sessionId]: effectivePermissionMode }));
    setSessionSandboxValues((prev) => ({ ...prev, [sessionId]: effectiveSandbox }));
    setRunningSessionIds((prev) => new Set(prev).add(sessionId));
    setSessionTurns(sessionId, (prev) => [...prev, { prompt: text, events: [] }]);
    appendStoredEvent(sessionId, "prompt", { text });
    // Streaming output is scoped to the session cache so panes can update in parallel
    // even when focus moves to another visible session.
    const onEvent = (event: AgentEvent) => {
      if (event.kind === "notice" && shouldToastSessionNotice(sessionId)) {
        toast.info(event.data.message);
      }
      if (event.kind === "authRequired") {
        const isAntigravity = event.data.agent === "antigravity";
        setSessions((prev) =>
          prev.map((session) =>
            session.id === sessionId ? { ...session, status: "auth" } : session,
          ),
        );
        toast.info(isAntigravity ? "Antigravity login required" : "Sign in required", {
          description: isAntigravity
            ? "Open the login terminal, paste the browser code there, then retry."
            : `${event.data.agent}: ${event.data.command}`,
        });
      }
      appendToLastTurn(sessionId, event);
    };
    // Forward the selected model verbatim (alias for Claude, concrete id for
    // Codex/Antigravity); null model → omit → CLI default. The agent is only sent
    // on new sessions — follow-ups resume the agent recorded on the session row.
    // Prefer the explicitly-chosen agent (from the New Session picker) over the
    // model's agent, which can momentarily lag while a new agent's models load.
    try {
      if (isExternalContinuation && currentSessionId) {
        await continueExternalSession({
          externalSessionId: currentSessionId,
          prompt: text,
          sessionId,
          agent: startAgent,
          model: modelArg,
          permissionMode: effectivePermissionMode,
          sandboxTerminal: effectiveSandbox,
          // Inherit the CLI-history session's displayed title so the continuation reads
          // as a continuation of it, not a new session named after the first message.
          title: currentSession?.title,
          onEvent,
        });
      } else if (isNew) {
        await startSession({
          prompt: text,
          repo,
          sessionId,
          agent: startAgent,
          model: modelArg,
          permissionMode: effectivePermissionMode,
          sandboxTerminal: effectiveSandbox,
          engine: opts?.engine,
          onEvent,
        });
      } else {
        await sendMessage({
          sessionId,
          prompt: text,
          model: modelArg,
          permissionMode: effectivePermissionMode,
          sandboxTerminal: effectiveSandbox,
          onEvent,
        });
      }
    } catch (err) {
      onEvent({ kind: "error", data: { message: safeErrorMessage(err) } });
    } finally {
      setRunningSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      const refreshed = await refreshSessions();
      const persisted = refreshed.some((session) => session.id === sessionId);
      if (!persisted && activeSessionIdRef.current === sessionId) {
        const fallbackSessionId =
          isExternalContinuation && currentSessionId ? currentSessionId : null;
        setActive(fallbackSessionId);
        updatePaneSession(targetPaneId, fallbackSessionId);
      }
      if (persisted && activeSessionIdRef.current === sessionId) {
        await refreshDiff(sessionId);
        await loadSessionEvents(sessionId, { force: true });
      }
    }
  }

  // Start a brand-new session from the NewSession composer, threading repo,
  // permissionMode, and the currently selected model into the shared send path.
  function handleStartNewSession(text: string, paneId: string) {
    const draft = draftFor(paneId);
    const agentId = draft.agentId || "claude";
    const model =
      models.find((m) => m.value === draft.modelValue && m.agent === agentId) ??
      models.find((m) => m.agent === agentId) ??
      null;
    return handleSend(text, model, {
      repo: draft.repo ?? ".",
      permissionMode: draft.permissionMode,
      sandboxTerminal: draft.sandbox,
      engine: draft.engine,
      agent: agentId,
      sessionId: null,
      paneId,
    });
  }

  async function handleSelectSession(id: string) {
    const selected = sessions.find((s) => s.id === id) ?? null;
    const existingPane = panes.find((pane) => pane.sessionId === id);
    if (existingPane) {
      setFocusedPaneId(existingPane.id);
    } else {
      updateFocusedPaneSession(id);
    }
    setActive(id);
    closeRight();
    resetFocusedSessionState();
    await loadSessionEvents(id);
    if (selected?.source !== "external") {
      await refreshDiff(id);
    }
  }

  function handleNewSession() {
    updateFocusedPaneSession(null);
    setActive(null);
    resetFocusedSessionState();
    closeRight();
  }

  // Clean up a SPECIFIC session's worktree (pane-scoped, not the globally-active one) so
  // the Trash button in a non-focused split pane acts on that pane's session. Cleanup now
  // also deletes the session, so any pane showing it is reset to the New Session view.
  async function handleCleanupSession(sessionId: string) {
    const session = sessions.find((s) => s.id === sessionId) ?? null;
    if (!session || session.source === "external") return;
    const confirmed = window.confirm(
      `Remove the worktree and branch for "${session.title}"? This does not touch the original repository.`,
    );
    if (!confirmed) return;
    try {
      await cleanupSession(sessionId);
      toast.success("Session worktree cleaned up");
      // Blank every pane that was showing the now-deleted session.
      setPanes((prev) =>
        prev.map((pane) =>
          pane.sessionId === sessionId ? { ...pane, sessionId: null } : pane,
        ),
      );
      if (activeSessionIdRef.current === sessionId) {
        setActive(null);
        resetFocusedSessionState();
        closeRight();
      }
      await refreshSessions();
    } catch (err) {
      toast.error(safeErrorMessage(err));
    }
  }

  // Stop a specific in-flight run. The backend kills the agent process and marks the
  // session idle; refreshSessions in handleSend's finally reconciles the row.
  async function handleStopSession(sessionId: string) {
    try {
      await stopSession(sessionId);
    } catch (err) {
      toast.error(safeErrorMessage(err));
    }
  }

  // Answer a pending tool-approval request from a session's live turn. Agent-agnostic:
  // resolves whatever the agent's approval bridge is blocking on so the run proceeds.
  async function handleApprovalRespond(
    sessionId: string,
    requestId: string,
    selectedOptionId: string,
  ) {
    try {
      const resolved = await respondToApproval(sessionId, requestId, selectedOptionId);
      if (resolved) {
        // The backend persisted an approvalResolved row, but no live event streams
        // back for it — reflect the answer locally so the card renders answered now.
        appendToLastTurn(sessionId, {
          kind: "approvalResolved",
          data: { requestId, selectedOptionId },
        });
      }
    } catch (err) {
      toast.error(safeErrorMessage(err));
    }
  }

  async function handleOpenRule(rule: RuleFile) {
    if (!activeSessionId) return;
    // Capture the session this read belongs to; if the user switches sessions while
    // the IPC is in flight, discard the result so we never show another session's file
    // (mirrors the activeSessionIdRef guard used by every other async handler).
    const sessionId = activeSessionId;
    try {
      const content = await readTextFile(sessionId, rule.path);
      if (activeSessionIdRef.current !== sessionId) return;
      setRuleView({ label: rule.label, content });
    } catch (e) {
      if (activeSessionIdRef.current !== sessionId) return;
      setRuleView({
        label: rule.label,
        content: `Failed to read: ${safeErrorMessage(e)}`,
      });
    }
  }

  const files = filesFromEvents(storedEvents);
  const usageSummary = usageSummaryFromEvents(storedEvents);
  const usage = usageSummary.latest;
  const loadedActivityCounts = activityCountsFromEvents(storedEvents);

  // Derived: active session object and its display values for TitleBar + SessionHeader.
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const titleBarTitle = activeSession?.title ?? null;
  const titleBarRepo = activeSession?.repo
    ? (activeSession.repo.split("/").pop() ?? null)
    : null;
  const activeIsExternal = activeSession?.source === "external";
  const activePanelModel = modelForSession(activeSession);
  const activePermissionMode = permissionModeForSession(activeSession);
  const activeSandboxTerminal = sandboxForSession(activeSession);
  const activePageState = activeSessionId ? eventPagesBySession[activeSessionId] : undefined;
  const activeTranscriptComplete = !(activePageState?.hasMore ?? false);
  const contextFootprint = contextFootprintFromSources({
    events: storedEvents,
    files,
    rules,
    capabilities,
    mcpServers,
    resourceTokens: contextResourceTokens,
    measuredContextTokens: usage
      ? contextLoadTokens(usage, activeSession?.agent ?? activePanelModel?.agent ?? "claude")
      : null,
  });
  const activeTurnCount = activeTranscriptComplete
    ? loadedActivityCounts.turnCount
    : (activeSession?.turnCount ?? loadedActivityCounts.turnCount);
  const activeToolCallCount = activeTranscriptComplete
    ? loadedActivityCounts.toolCallCount
    : (activeSession?.toolCallCount ?? loadedActivityCounts.toolCallCount);
  const activeFileActionCount = activeTranscriptComplete
    ? loadedActivityCounts.fileActionCount
    : (activeSession?.fileActionCount ?? loadedActivityCounts.fileActionCount);

  // Search + status + source filters applied before grouping. Search is a
  // case-insensitive substring match on title; status/source are exact matches.
  const searchLower = sessionSearch.trim().toLowerCase();
  const filteredSessions = sessions.filter((s) => {
    if (searchLower && !s.title.toLowerCase().includes(searchLower)) return false;
    if (statusFilter !== "all" && s.status !== statusFilter) return false;
    if (sourceFilter !== "all" && s.source !== sourceFilter) return false;
    return true;
  });

  // Open the active session's worktree in the system editor. Best-effort.
  async function handleOpenEditor() {
    if (!activeSessionId || activeSession?.source === "external") return;
    try {
      await openInEditor(activeSessionId);
    } catch (err) {
      toast.error(safeErrorMessage(err));
    }
  }

  // Open a terminal at the active session's worktree directory. Best-effort.
  async function handleOpenTerminal() {
    if (!activeSessionId || activeSession?.source === "external") return;
    try {
      await openTerminal(activeSessionId);
    } catch (err) {
      toast.error(safeErrorMessage(err));
    }
  }

  const paneGridClass =
    panes.length <= 1
      ? "grid-cols-1 grid-rows-1"
      : panes.length === 2
        ? splitDirection === "horizontal"
          ? "grid-cols-1 grid-rows-2"
          : "grid-cols-2 grid-rows-1"
        : "grid-cols-2 grid-rows-2";
  const canSplitWorkspace =
    !rightExpanded &&
    panes.length < MAX_SESSION_PANES &&
    panes.length < maxPanesForViewport();

  useEffect(() => {
    if (rightTab !== null) {
      setRenderedRightTab(rightTab);
      setRenderedRightExpanded(rightExpanded);
      return;
    }
    if (renderedRightTab === null) return;
    const timer = window.setTimeout(() => setRenderedRightTab(null), PANEL_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [renderedRightTab, rightExpanded, rightTab]);

  const visibleRightTab = rightTab ?? renderedRightTab;
  const rightPanePresent = visibleRightTab !== null;
  const rightPaneOpen = rightTab !== null;
  const visibleRightExpanded = rightPaneOpen ? rightExpanded : renderedRightExpanded;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <TitleBar
        title={titleBarTitle}
        repo={titleBarRepo}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        onOpenEditor={() => void handleOpenEditor()}
        onOpenTerminal={() => void handleOpenTerminal()}
        canSplit={canSplitWorkspace}
        onSplitVertical={() => addSplit("vertical")}
        onSplitHorizontal={() => addSplit("horizontal")}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div
        className="kl-sidebar-layout flex flex-1 min-h-0 min-w-0 overflow-hidden px-2 pb-2"
        style={{ columnGap: sidebarCollapsed ? 0 : 8 }}
      >
        <div
          data-state={sidebarCollapsed ? "closed" : "open"}
          aria-hidden={sidebarCollapsed}
          className={cn(
            "kl-sidebar-motion shrink-0 max-[900px]:hidden overflow-hidden",
            sidebarCollapsed && "pointer-events-none",
          )}
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          <div
            className="kl-sidebar-panel flex h-full flex-col rounded-xl overflow-hidden"
            style={{ width: sidebarWidth }}
          >
              <SessionList
                groups={groupByWorkspace(filteredSessions)}
                activeId={activeSessionId}
                onSelect={handleSelectSession}
                onNew={handleNewSession}
                counts={counts}
                search={sessionSearch}
                onSearchChange={setSessionSearch}
                statusFilter={statusFilter}
                sourceFilter={sourceFilter}
                onStatusFilterChange={setStatusFilter}
                onSourceFilterChange={setSourceFilter}
                onRename={handleRenameSession}
                onOpenCustomization={(section) => {
                  setCustSection(section);
                  setCustDialogOpen(true);
                }}
              />
            </div>
        </div>
        <main className="relative flex flex-1 min-h-0 min-w-0 gap-2 overflow-hidden">
          {/* Session workspace — hidden only while the right pane is expanded to fullscreen. */}
          {!rightExpanded && (
            <div
              className={cn(
                "relative grid flex-1 min-w-0 min-h-0 gap-2",
                paneGridClass,
                rightTab && "max-[900px]:hidden",
              )}
            >
              {!sidebarCollapsed && (
                <div
                  role="separator"
                  aria-label="Resize sessions panel"
                  aria-orientation="vertical"
                  aria-valuemin={SIDEBAR_MIN_WIDTH}
                  aria-valuemax={SIDEBAR_MAX_WIDTH}
                  aria-valuenow={Math.round(sidebarWidth)}
                  tabIndex={0}
                  onPointerDown={startSidebarResize}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") resizeSidebarBy(-16);
                    else if (e.key === "ArrowRight") resizeSidebarBy(16);
                    else if (e.key === "Home") resizeSidebarBy(SIDEBAR_MIN_WIDTH - sidebarWidth);
                    else if (e.key === "End") resizeSidebarBy(SIDEBAR_MAX_WIDTH - sidebarWidth);
                    else return;
                    e.preventDefault();
                  }}
                  className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize outline-none max-[900px]:hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                />
              )}
              {panes.map((pane) => {
                const paneSession =
                  sessions.find((session) => session.id === pane.sessionId) ??
                  null;
                const paneFocused = pane.id === focusedPaneId;
                const paneRepo = paneSession?.repo
                  ? (paneSession.repo.split("/").pop() ?? null)
                  : null;
                const paneRunning =
                  pane.sessionId !== null &&
                  (runningSessionIds.has(pane.sessionId) ||
                    paneSession?.status === "running");
                const paneLoading =
                  pane.sessionId !== null &&
                  loadingSessionIds.has(pane.sessionId);
                const paneTurns =
                  pane.sessionId !== null
                    ? (turnsBySession[pane.sessionId] ?? [])
                    : [];
                const paneEventPage =
                  pane.sessionId !== null
                    ? eventPagesBySession[pane.sessionId]
                    : undefined;
                const importedAgent = paneSession?.agent ?? "claude";
                const paneAgent = isAgentSpawnable(importedAgent)
                  ? importedAgent
                  : (selectedModel?.agent ?? models[0]?.agent ?? "claude");
                const paneModels = modelsForAgent(paneAgent);
                const paneModel = paneSession
                  ? modelForSession(paneSession)
                  : selectedModel?.agent === paneAgent
                    ? selectedModel
                    : pickDefaultModel(paneModels, getAgentConfig(agentConfigs, paneAgent));
                // New Session pane draft (per-pane, so tabs don't share model/agent/permission).
                const draft = pane.sessionId === null ? draftFor(pane.id) : null;
                const draftAgent = draft
                  ? (agents.find((a) => a.id === draft.agentId) ?? null)
                  : null;
                const draftModels = draft ? modelsForAgent(draft.agentId) : [];
                const draftModel = draft
                  ? (draftModels.find((m) => m.value === draft.modelValue) ??
                    pickDefaultModel(draftModels, getAgentConfig(agentConfigs, draft.agentId)))
                  : null;
                return (
                  <section
                    key={pane.id}
                    className={cn(
                      "flex min-w-0 min-h-0 flex-col overflow-hidden rounded-xl border bg-card",
                      paneFocused
                        ? "border-ring shadow-sm"
                        : "border-border",
                    )}
                    onPointerDown={() => {
                      if (!paneFocused) focusPane(pane);
                    }}
                  >
                    {pane.sessionId === null ? (
                      <>
                        <div className="flex items-center gap-3 border-b border-border px-4 py-2 shrink-0">
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate text-sm font-medium">
                              New session
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              Choose a repo and start an agent
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {panes.length > 1 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Close pane"
                                className="size-9"
                                onClick={() => closePane(pane.id)}
                              >
                                <X data-icon />
                              </Button>
                            )}
                          </div>
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto">
                          <NewSession
                            repo={draft?.repo ?? null}
                            recents={recents}
                            agents={agents}
                            agent={draftAgent}
                            models={draftModels}
                            model={draftModel}
                            permissionMode={draft?.permissionMode ?? DEFAULT_PERMISSION_MODE}
                            sandboxTerminal={draft?.sandbox ?? false}
                            running={false}
                            agentPrefs={agentPrefs}
                            onPickRepo={() => void pickRepoForPane(pane.id)}
                            onPickRecent={(p) => updatePaneDraft(pane.id, { repo: p })}
                            onAgentChange={(a) => paneAgentChange(pane.id, a)}
                            onModelChange={(m) => paneModelChange(pane.id, m)}
                            onPermissionModeChange={(mode) => panePermissionChange(pane.id, mode)}
                            onSandboxTerminalChange={(v) => updatePaneDraft(pane.id, { sandbox: v })}
                            onStart={(text) => handleStartNewSession(text, pane.id)}
                            onOpenSettings={() => setSettingsOpen(true)}
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <SessionHeader
                          title={paneSession?.title ?? ""}
                          agent={paneSession?.agent ?? "claude"}
                          repo={paneRepo}
                          status={paneSession?.status ?? "idle"}
                          source={paneSession?.source ?? "kine-agent"}
                          onClose={() => closePane(pane.id)}
                          onCleanup={() => void handleCleanupSession(pane.sessionId!)}
                          onRename={
                            paneSession
                              ? (t) => void handleRenameSession(paneSession.id, t)
                              : undefined
                          }
                          panelOpen={paneFocused && rightTab !== null}
                          onTogglePanel={() => {
                            if (!paneFocused) {
                              focusPane(pane);
                              setRightTab("context");
                            } else if (rightTab) closeRight();
                            else setRightTab("context");
                          }}
                        />
                        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
                          <div className="mt-auto w-full min-w-0 max-w-3xl mx-auto px-4">
                            {paneLoading ? (
                              <div
                                role="status"
                                className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
                              >
                                <Loader2
                                  aria-hidden="true"
                                  className="size-4 animate-spin motion-reduce:animate-none shrink-0"
                                />
                                Loading session…
                              </div>
                            ) : (
                              <Conversation
                                turns={paneTurns}
                                running={paneRunning}
                                hasMore={paneEventPage?.hasMore ?? false}
                                loadingMore={paneEventPage?.loadingMore ?? false}
                                onLoadMore={
                                  pane.sessionId !== null
                                    ? () => void loadMoreSessionEvents(pane.sessionId!)
                                    : undefined
                                }
                                onOpenFile={(path) => {
                                  if (!paneFocused) focusPane(pane);
                                  void handleOpenFile(path);
                                }}
                                onApprovalRespond={
                                  pane.sessionId !== null
                                    ? (requestId, selectedOptionId) =>
                                        void handleApprovalRespond(
                                          pane.sessionId!,
                                          requestId,
                                          selectedOptionId,
                                        )
                                    : undefined
                                }
                                onOpenAuthLogin={
                                  pane.sessionId !== null
                                    ? (agent) =>
                                        void handleOpenAgentLogin(pane.sessionId!, agent)
                                    : undefined
                                }
                              />
                            )}
                          </div>
                        </div>
                        <PromptBar
                          onStart={(text, sendModel) =>
                            handleSend(text, sendModel, {
                              sessionId: pane.sessionId,
                              paneId: pane.id,
                            })
                          }
                          running={paneRunning}
                          onStop={
                            pane.sessionId !== null
                              ? () => void handleStopSession(pane.sessionId!)
                              : undefined
                          }
                          models={paneModels}
                          model={paneModel}
                          onModelChange={(model) => {
                            if (pane.sessionId !== null) {
                              handleSessionModelChange(pane.sessionId, model);
                            } else {
                              handleModelChange(model);
                            }
                          }}
                          agent={paneAgent}
                          sessionId={
                            pane.sessionId !== null && paneSession?.source !== "external"
                              ? pane.sessionId
                              : undefined
                          }
                          acpCommands={
                            pane.sessionId !== null
                              ? lastAcpCommands(eventsBySession[pane.sessionId] ?? [])
                              : undefined
                          }
                          permissionMode={permissionModeForSession(paneSession)}
                          onPermissionModeChange={(m) =>
                            setSessionPermissionMode(pane.sessionId!, m)
                          }
                          sandboxTerminal={sandboxForSession(paneSession)}
                          onSandboxTerminalChange={(v) =>
                            setSessionSandbox(pane.sessionId!, v)
                          }
                          onManageModels={() => setSettingsOpen(true)}
                          mode={
                            paneSession?.source === "external"
                              ? "external-continuation"
                              : "default"
                          }
                        />
                      </>
                    )}
                  </section>
                );
              })}
            </div>
          )}

          {/* Right side-pane — tabbed Context | Changes | Files, collapsible + expandable. */}
          {rightPanePresent && (
            <aside
              data-state={rightPaneOpen ? "open" : "closed"}
              aria-hidden={!rightPaneOpen}
              className={cn(
                "kl-detail-panel-motion absolute z-30 flex flex-col min-w-0 min-h-0 bg-background overflow-hidden",
                !rightPaneOpen && "pointer-events-none",
                visibleRightExpanded
                  ? // Fullscreen: fill the workspace as a framed card, matching the
                    // session panes (rounded + bordered) instead of a flat plane.
                    "inset-0 rounded-xl border border-border"
                  : // Docked: a floating, clearly-elevated sheet — inset off every
                    // edge, fully rounded, ringed, with a deep shadow so it reads as
                    // hovering above the conversation rather than a flush column.
                    "top-2 bottom-2 right-2 rounded-xl border border-border ring-1 ring-black/5 shadow-2xl dark:ring-white/10 " +
                      "max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:right-0 max-[900px]:rounded-none max-[900px]:ring-0",
              )}
              style={
                visibleRightExpanded
                  ? undefined
                  : { width: `min(${Math.round(rightPaneWidth)}px, 100%)` }
              }
            >
              {!visibleRightExpanded && (
                <div
                  role="separator"
                  aria-label="Resize detail panel"
                  aria-orientation="vertical"
                  aria-valuemin={RIGHT_PANE_MIN_WIDTH}
                  aria-valuemax={Math.round(rightPaneMaxWidth())}
                  aria-valuenow={Math.round(rightPaneWidth)}
                  tabIndex={0}
                  onPointerDown={startRightPaneResize}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") resizeRightPaneBy(16);
                    else if (e.key === "ArrowRight") resizeRightPaneBy(-16);
                    else if (e.key === "Home") resizeRightPaneBy(RIGHT_PANE_MIN_WIDTH - rightPaneWidth);
                    else if (e.key === "End") resizeRightPaneBy(rightPaneMaxWidth() - rightPaneWidth);
                    else return;
                    e.preventDefault();
                  }}
                  className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize outline-none max-[900px]:hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                />
              )}
              <Tabs
                value={visibleRightTab ?? "context"}
                onValueChange={(v) =>
                  setRightTab(v as "context" | "changes" | "files")
                }
                className="flex flex-col min-h-0 flex-1"
              >
                <header className="flex items-center gap-2 px-3 pt-1.5 border-b border-border/60">
                  <TabsList className="flex-1">
                    <TabsTrigger value="context">Context</TabsTrigger>
                    <TabsTrigger value="changes">Changes</TabsTrigger>
                    <TabsTrigger value="files">Files</TabsTrigger>
                  </TabsList>
                  <div className="flex items-center gap-1 pb-1.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setRightExpanded((v) => !v)}
                      aria-label={
                        visibleRightExpanded ? "Collapse panel" : "Expand panel"
                      }
                    >
                      {visibleRightExpanded ? <Minimize2 /> : <Maximize2 />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={closeRight}
                      aria-label="Close panel"
                    >
                      <X />
                    </Button>
                  </div>
                </header>
                <TabsContent
                  value="context"
                  className="flex-1 min-h-0 overflow-auto"
                >
                  <ContextPanel
                    usage={usage}
                    usageSummary={usageSummary}
                    files={files}
                    rules={rules}
                    capabilities={capabilities}
                    model={activePanelModel}
                    contextFootprint={contextFootprint}
                    agent={activeSession?.agent}
                    source={activeSession?.source}
                    permissionMode={activePermissionMode}
                    sandboxTerminal={activeSandboxTerminal}
                    sessionTurnCount={activeTurnCount}
                    sessionToolCallCount={activeToolCallCount}
                    sessionFileActionCount={activeFileActionCount}
                    transcriptComplete={activeTranscriptComplete}
                    onOpenRule={handleOpenRule}
                    onOpenFile={(path) => void handleOpenFile(path)}
                  />
                </TabsContent>
                <TabsContent
                  value="changes"
                  className="flex-1 min-h-0 overflow-hidden"
                >
                  {activeIsExternal ? (
                    <div className="flex h-full flex-col justify-center p-6 text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">No Kine Agent worktree</p>
                      <p className="mt-1">
                        This CLI history is read-only, so Kine Agent cannot compute a live
                        branch diff. Use Files to review files mentioned by the session.
                      </p>
                    </div>
                  ) : (
                    <ChangesPanel
                      branch={branchChanges}
                      status={branchChangesStatus}
                      onCommit={handleCommit}
                      onOpenFile={(path) => void handleOpenFile(path)}
                      committing={committing}
                    />
                  )}
                </TabsContent>
                <TabsContent
                  value="files"
                  className="flex-1 min-h-0 overflow-hidden"
                >
                  {activeIsExternal ? (
                    <div className="flex h-full min-w-0 flex-col">
                      <div className="border-b border-border/60 px-4 py-3">
                        <p className="text-sm font-medium">Files from CLI history</p>
                        <p className="text-xs text-muted-foreground">
                          Read-only file activity recovered from the external session.
                        </p>
                      </div>
                      <ScrollArea className="min-h-0 flex-1">
                        {files.length === 0 ? (
                          <p className="p-4 text-sm text-muted-foreground">
                            No files were found in this session history.
                          </p>
                        ) : (
                          <FilesThisSession
                            files={files}
                            onOpenFile={(path) => void handleOpenFile(path)}
                          />
                        )}
                      </ScrollArea>
                    </div>
                  ) : (
                    <FilesTree
                      nodes={treeNodes}
                      onOpenFile={(path, node) => void handleOpenFilesTreeFile(path, node)}
                    />
                  )}
                </TabsContent>
              </Tabs>
            </aside>
          )}
        </main>
      </div>

      {/* Rule viewer Sheet — rendered once, controlled by ruleView state. */}
      <Sheet
        open={ruleView !== null}
        onOpenChange={(o) => {
          if (!o) setRuleView(null);
        }}
      >
        <SheetContent className="w-[min(480px,calc(100vw-1rem))] sm:max-w-none flex flex-col rounded-l-xl">
          <SheetHeader>
            <SheetTitle className="font-mono text-sm">
              {ruleView?.label}
            </SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0">
            <pre className="font-mono text-xs whitespace-pre-wrap p-4">
              {ruleView?.content}
            </pre>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <DiffReviewDialog
        open={diffDialog !== null}
        diff={diffDialog?.diff ?? null}
        selectedPath={diffDialog?.path ?? null}
        committing={committing}
        onOpenChange={(open) => {
          if (!open) setDiffDialog(null);
        }}
        onSelectPath={(path) =>
          setDiffDialog((current) => (current ? { ...current, path } : current))
        }
        onCommit={handleCommit}
      />

      <FilePreviewDialog
        preview={filePreview}
        onOpenChange={(open) => {
          if (!open) setFilePreview(null);
        }}
      />

      {/* Customizations dialog — opened when a sidebar Customizations row is clicked. */}
      <Suspense fallback={null}>
        <CustomizationsDialog
          open={custDialogOpen}
          onOpenChange={setCustDialogOpen}
          initialSection={custSection}
          counts={counts}
          capabilities={capabilities}
          rules={rules}
          sessionId={activeSessionId}
          hooks={hooks}
          mcpServers={mcpServers}
          plugins={plugins}
          onChanged={() => setCustReloadKey((k) => k + 1)}
        />
      </Suspense>

      {/* Settings — global app preferences (which agents may start new sessions). */}
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        agents={agents}
        prefs={agentPrefs}
        onPrefsChange={updateAgentPrefs}
      />

      <Toaster />
      <UpdaterHost />
    </div>
  );
}
