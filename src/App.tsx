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
import { DiffViewer } from "./components/DiffViewer";
import { TitleBar } from "./components/TitleBar";
import { SessionList } from "./components/SessionList";
import type { CustomizationSection } from "./components/CustomizationsDialog";
import { SessionHeader } from "./components/SessionHeader";
import { ContextPanel } from "./components/ContextPanel";
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
import {
  cleanupSession,
  listTrustedRepos,
  pickRepository,
  startSession,
  sendMessage,
  type AgentEvent,
} from "./lib/agent";
import {
  detectAgents,
  listModels,
  type AgentInfo,
  type ModelInfo,
} from "./lib/models";
import { reviewSession, type SessionDiff } from "./lib/review";
import {
  listSessions,
  sessionEvents,
  type SessionSummary,
  type StoredEvent,
} from "./lib/sessions";
import { groupByWorkspace } from "./lib/workspaces";
import { filesFromEvents, latestUsage } from "./lib/contextDerive";
import {
  inspectRules,
  readTextFile,
  listCapabilities,
  type RuleFile,
  type Capabilities,
} from "./lib/inspect";
import { turnsFromEvents } from "./lib/turns";
import {
  branchChanges as fetchBranchChanges,
  worktreeTree as fetchWorktreeTree,
  commitSession,
  customizationsCounts,
  sessionDiffstat,
  openInEditor,
  openTerminal,
  listHooks,
  listMcpServers,
  listPlugins,
  type BranchChanges,
  type CustomizationCounts,
  type Diffstat,
  type HookEntry,
  type McpServerEntry,
  type PluginEntry,
} from "./lib/conductor";
import { buildTree, type TreeNode } from "./lib/tree";

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
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [rightTab, setRightTab] = useState<
    "context" | "changes" | "files" | null
  >(null);
  const [rightExpanded, setRightExpanded] = useState(false);
  const [storedEvents, setStoredEvents] = useState<StoredEvent[]>([]);
  const [rules, setRules] = useState<RuleFile[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [ruleView, setRuleView] = useState<{
    label: string;
    content: string;
  } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [autoEdit, setAutoEdit] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    storedNumber(
      "kineloop.sidebarWidth",
      SIDEBAR_DEFAULT_WIDTH,
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
    ),
  );
  const [rightPaneWidth, setRightPaneWidth] = useState(() =>
    storedNumber(
      "kineloop.rightPaneWidth",
      RIGHT_PANE_DEFAULT_WIDTH,
      RIGHT_PANE_MIN_WIDTH,
      RIGHT_PANE_MAX_WIDTH,
    ),
  );
  // Sidebar collapse — persisted in localStorage.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("kineloop.sidebarCollapsed") === "true";
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
  // Customizations dialog state — section defaults to "overview" until set by the sidebar row click.
  const [custDialogOpen, setCustDialogOpen] = useState(false);
  const [custSection, setCustSection] =
    useState<CustomizationSection>("overview");
  // Per-session diffstats, fetched opportunistically and retained across session switches.
  const [diffstats, setDiffstats] = useState<Record<string, Diffstat>>({});
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
  // File-click diff Sheet — null means closed.
  const [diffSheet, setDiffSheet] = useState<{
    path: string;
    diff: SessionDiff;
  } | null>(null);

  // Synchronous ref keeps the active session ID readable inside async callbacks
  // without stale-closure issues — the guard for cross-session contamination.
  const activeSessionIdRef = useRef<string | null>(null);
  const setActive = (id: string | null) => {
    activeSessionIdRef.current = id;
    setActiveSessionId(id);
  };

  // Ref that tracks sidebarCollapsed for reading inside async callbacks without
  // stale-closure issues (same pattern as activeSessionIdRef above).
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  useEffect(() => {
    sidebarCollapsedRef.current = sidebarCollapsed;
  }, [sidebarCollapsed]);

  // Fetch diffstat for a single session and merge into the diffstats record.
  // Best-effort — silently ignores IPC failures (e.g. browser preview, no worktree yet).
  const fetchDiffstat = useCallback(async (sessionId: string) => {
    try {
      const stat = await sessionDiffstat(sessionId);
      setDiffstats((prev) => ({ ...prev, [sessionId]: stat }));
    } catch {
      /* best-effort */
    }
  }, []);

  // Fetch diffstats for all sessions in one Promise.allSettled, then merge
  // into a SINGLE setDiffstats call — avoids N separate re-renders and N subprocess
  // spawns. Skipped entirely when the sidebar is collapsed (rows aren't rendered).
  const refreshAllDiffstats = useCallback(async (list: SessionSummary[]) => {
    const reviewable = list.filter((s) => s.source !== "external");
    if (sidebarCollapsedRef.current || reviewable.length === 0) return;
    const results = await Promise.allSettled(
      reviewable.map((s) => sessionDiffstat(s.id)),
    );
    const updates: Record<string, Diffstat> = {};
    reviewable.forEach((s, i) => {
      const r = results[i];
      if (r.status === "fulfilled") updates[s.id] = r.value;
    });
    setDiffstats((prev) => ({ ...prev, ...updates }));
  }, []);

  // Returns the session list so callers can pipe it into refreshAllDiffstats.
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

  // Discover installed agents and their available models on mount.
  // Best-effort — no-op in the browser preview where IPC is unavailable.
  const loadModels = useCallback(async () => {
    try {
      const discovered = await detectAgents();
      const supported = discovered.filter((a) => a.id === "claude");
      const installed = supported.filter((a) => a.installed);
      const results = await Promise.allSettled(
        installed.map((a) => listModels(a.id)),
      );
      const all = results
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .filter((m) => !m.disabled);
      setAgents(supported);
      setSelectedAgent((prev) => prev ?? installed[0] ?? null);
      setModels(all);
      setSelectedModel((prev) => prev ?? all[0] ?? null);
    } catch (err) {
      console.error("failed to load models", err);
    }
  }, []);

  // Sidebar toggle — persists the new value to localStorage immediately.
  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("kineloop.sidebarCollapsed", String(next));
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
      persistPanelWidth("kineloop.sidebarWidth", next);
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
      persistPanelWidth("kineloop.rightPaneWidth", next);
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
    persistPanelWidth("kineloop.sidebarWidth", next);
  }

  function resizeRightPaneBy(delta: number) {
    const next = clampNumber(
      rightPaneWidth + delta,
      RIGHT_PANE_MIN_WIDTH,
      rightPaneMaxWidth(),
    );
    setRightPaneWidth(next);
    persistPanelWidth("kineloop.rightPaneWidth", next);
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
  async function pickRepo() {
    try {
      const path = await pickRepository();
      if (!path) return;
      setSelectedRepo(path);
      setRecents(await listTrustedRepos());
    } catch (err) {
      toast.error(safeErrorMessage(err));
    }
  }

  // On mount: load sessions then batch-refresh all diffstats in one shot.
  useEffect(() => {
    (async () => {
      const list = await refreshSessions();
      void refreshAllDiffstats(list);
    })();
  }, [refreshSessions, refreshAllDiffstats]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

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
  }, [activeSessionId]);

  // Fetch diffstat for the active session whenever it changes (new session start
  // or session switch) — keeps the SessionHeader diffstat current without a full refresh.
  useEffect(() => {
    if (!activeSessionId) return;
    void fetchDiffstat(activeSessionId);
  }, [activeSessionId, fetchDiffstat]);

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

  // Fetch rules + capabilities whenever the Context tab becomes active for a session.
  // Captures sessionId at effect-run time so the cross-session ref guard works correctly
  // even if the user switches sessions while awaiting IPC calls.
  useEffect(() => {
    if (rightTab !== "context" || !activeSessionId) return;
    const sessionId = activeSessionId;
    (async () => {
      try {
        const r = await inspectRules(sessionId);
        if (activeSessionIdRef.current === sessionId) setRules(r);
      } catch {
        if (activeSessionIdRef.current === sessionId) setRules([]);
      }
      try {
        const c = await listCapabilities(
          sessionId,
          selectedModel?.agent ?? "claude",
        );
        if (activeSessionIdRef.current === sessionId) setCapabilities(c);
      } catch {
        if (activeSessionIdRef.current === sessionId) setCapabilities(null);
      }
    })();
  }, [rightTab, activeSessionId, selectedModel?.agent]);

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
        const c = await listCapabilities(
          sessionId,
          selectedModel?.agent ?? "claude",
        );
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
  }, [custDialogOpen, activeSessionId, selectedModel?.agent]);

  // Fetch branch-level changes when the Changes tab becomes active.
  useEffect(() => {
    if (rightTab !== "changes" || !activeSessionId) return;
    const sessionId = activeSessionId;
    void refreshBranchChanges(sessionId);
  }, [rightTab, activeSessionId, refreshBranchChanges]);

  // Fetch the flat worktree file list and build the nested tree when Files tab opens.
  useEffect(() => {
    if (rightTab !== "files" || !activeSessionId) return;
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
  }, [rightTab, activeSessionId]);

  function appendToLastTurn(event: AgentEvent) {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, events: [...last.events, event] };
      return next;
    });
  }

  // Commit the session's worktree changes. Shows toast feedback and refreshes
  // the Changes tab data + the session's diffstat after a successful commit.
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
      // Refresh changes, diff, sessions list, and all diffstats after a successful commit.
      // Sessions + diffstats are chained (need the list) while branch + diff run in parallel.
      await Promise.allSettled([
        refreshBranchChanges(sessionId),
        refreshDiff(sessionId),
        (async () => {
          const list = await refreshSessions();
          await refreshAllDiffstats(list);
        })(),
      ]);
      return true;
    } catch (err) {
      toast.error(safeErrorMessage(err));
      return false;
    } finally {
      setCommitting(false);
    }
  }

  // Open the diff Sheet for a clicked file path. Reuses the existing `diff` state
  // (full patch, acceptable per spec — DiffViewer has no per-file filter prop).
  // If diff hasn't loaded yet, attempt a best-effort fetch first.
  async function handleOpenFile(path: string) {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
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
      setDiffSheet({ path, diff: sessionDiff });
    }
  }

  async function handleSend(
    text: string,
    model: ModelInfo | null,
    opts?: { repo?: string; permissionMode?: string },
  ) {
    if (activeSession?.source === "external") {
      toast.error("External CLI sessions are read-only in Kineloop.");
      return;
    }
    const isNew = activeSessionId === null;
    const sessionId = activeSessionId ?? crypto.randomUUID();
    const repo = opts?.repo ?? ".";
    // Set the ref synchronously before the first await so the cross-session guard
    // is exact for new sessions (id now known up front, not after startSession resolves).
    setActive(sessionId);
    setLoadingSessionId(null);
    // Optimistically upsert a "running" row at the top of the list immediately —
    // refreshSessions() in finally reconciles the real title/status from the backend.
    setSessions((prev) => {
      const existing = prev.find((s) => s.id === sessionId);
      const now = Date.now();
      const row: SessionSummary = existing
        ? { ...existing, status: "running", updatedAt: now }
        : {
            id: sessionId,
            agent: "claude",
            repo,
            branch: `agent/${sessionId}`,
            title: titleFromPrompt(text),
            status: "running",
            source: "kineloop",
            turnCount: null,
            toolCallCount: null,
            fileActionCount: null,
            createdAt: now,
            updatedAt: now,
          };
      return [row, ...prev.filter((s) => s.id !== sessionId)];
    });
    closeRight();
    setRunningSessionIds((prev) => new Set(prev).add(sessionId));
    setTurns((prev) => [...prev, { prompt: text, events: [] }]);
    // Guard: if the user switches sessions while this send is streaming, drop the late
    // events from the UI — the backend persists all events regardless, so re-selecting
    // the session rehydrates anything dropped here.
    const onEvent = (event: AgentEvent) => {
      if (activeSessionIdRef.current !== sessionId) return;
      appendToLastTurn(event);
    };
    // Forward the model value for Claude; null model → omit → CLI default.
    const modelArg =
      model && model.agent === "claude" ? model.value : undefined;
    try {
      if (isNew) {
        await startSession({
          prompt: text,
          repo,
          sessionId,
          model: modelArg,
          permissionMode: opts?.permissionMode,
          onEvent,
        });
      } else {
        await sendMessage({
          sessionId,
          prompt: text,
          model: modelArg,
          permissionMode: autoEdit ? "acceptEdits" : "default",
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
      await refreshSessions();
      if (activeSessionIdRef.current === sessionId) {
        // Refresh this session's diffstat so the sidebar row + SessionHeader stay
        // current after files are edited — one targeted call, not a fan-out.
        void fetchDiffstat(sessionId);
        await refreshDiff(sessionId);
        try {
          const ev = await sessionEvents(sessionId);
          if (activeSessionIdRef.current === sessionId) setStoredEvents(ev);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Start a brand-new session from the NewSession composer, threading repo,
  // permissionMode, and the currently selected model into the shared send path.
  function handleStartNewSession(text: string) {
    return handleSend(text, selectedModel, {
      repo: selectedRepo ?? ".",
      permissionMode: autoEdit ? "acceptEdits" : "default",
    });
  }

  async function handleSelectSession(id: string) {
    const selected = sessions.find((s) => s.id === id) ?? null;
    setActive(id);
    setLoadingSessionId(id);
    closeRight();
    setTurns([]);
    setStoredEvents([]);
    setDiff(null);
    setRules([]);
    setCapabilities(null);
    setRuleView(null);
    setBranchChanges(null);
    setBranchChangesStatus("idle");
    setTreeNodes([]);
    setDiffSheet(null);
    setHooks([]);
    setMcpServers([]);
    setPlugins([]);
    try {
      const ev = await sessionEvents(id);
      if (activeSessionIdRef.current !== id) return;
      setStoredEvents(ev);
      setTurns(turnsFromEvents(ev));
    } catch {
      if (activeSessionIdRef.current !== id) return;
      setStoredEvents([]);
      setTurns([]);
    }
    if (activeSessionIdRef.current === id) {
      setLoadingSessionId(null);
    }
    if (selected?.source !== "external") {
      await refreshDiff(id);
    }
  }

  function handleNewSession() {
    setActive(null);
    setLoadingSessionId(null);
    setTurns([]);
    setDiff(null);
    setStoredEvents([]);
    setRules([]);
    setCapabilities(null);
    setRuleView(null);
    setBranchChanges(null);
    setBranchChangesStatus("idle");
    setTreeNodes([]);
    setDiffSheet(null);
    setHooks([]);
    setMcpServers([]);
    setPlugins([]);
    closeRight();
  }

  async function handleCleanupSession() {
    if (!activeSessionId || activeSession?.source === "external") return;
    const session = activeSession;
    const confirmed = window.confirm(
      `Remove the worktree and branch for "${session?.title ?? "this session"}"? This does not touch the original repository.`,
    );
    if (!confirmed) return;
    const sessionId = activeSessionId;
    try {
      await cleanupSession(sessionId);
      toast.success("Session worktree cleaned up");
      handleNewSession();
      const list = await refreshSessions();
      await refreshAllDiffstats(list);
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
  const usage = latestUsage(storedEvents);

  // Derived: active session object and its display values for TitleBar + SessionHeader.
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeRunning =
    activeSessionId !== null &&
    (runningSessionIds.has(activeSessionId) ||
      activeSession?.status === "running");
  const activeLoading =
    activeSessionId !== null && loadingSessionId === activeSessionId;
  const titleBarTitle = activeSession?.title ?? null;
  const titleBarRepo = activeSession?.repo
    ? (activeSession.repo.split("/").pop() ?? null)
    : null;

  // Search filter applied before grouping — case-insensitive substring match on title.
  const filteredSessions = sessionSearch
    ? sessions.filter((s) =>
        s.title.toLowerCase().includes(sessionSearch.toLowerCase()),
      )
    : sessions;

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

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <TitleBar
        title={titleBarTitle}
        repo={titleBarRepo}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        onOpenEditor={() => void handleOpenEditor()}
        onOpenTerminal={() => void handleOpenTerminal()}
      />
      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden gap-2 px-2 pb-2">
        {!sidebarCollapsed && (
          <>
            <div
              className="shrink-0 max-[900px]:hidden flex flex-col rounded-xl overflow-hidden"
              style={{ width: sidebarWidth }}
            >
              <SessionList
                groups={groupByWorkspace(filteredSessions)}
                activeId={activeSessionId}
                onSelect={handleSelectSession}
                onNew={handleNewSession}
                counts={counts}
                diffstats={diffstats}
                search={sessionSearch}
                onSearchChange={setSessionSearch}
                onOpenCustomization={(section) => {
                  setCustSection(section);
                  setCustDialogOpen(true);
                }}
              />
            </div>
          </>
        )}
        <main className="flex flex-1 min-h-0 min-w-0 gap-2">
          {/* Chat column — hidden only while the right pane is expanded to fullscreen. */}
          {!rightExpanded && (
            <section
              className={cn(
                "relative flex flex-1 flex-col min-w-0 min-h-0 rounded-xl border border-border bg-card overflow-hidden",
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
              {activeSessionId === null ? (
                /* No active session — show the new-session composer. */
                <NewSession
                  repo={selectedRepo}
                  recents={recents}
                  agents={agents}
                  agent={selectedAgent}
                  models={models}
                  model={selectedModel}
                  autoEdit={autoEdit}
                  running={false}
                  onPickRepo={pickRepo}
                  onPickRecent={(p) => {
                    setSelectedRepo(p);
                  }}
                  onAgentChange={setSelectedAgent}
                  onModelChange={setSelectedModel}
                  onAutoEditChange={setAutoEdit}
                  onStart={handleStartNewSession}
                />
              ) : (
                /* Active session — header + toolbar + conversation + prompt bar. */
                <>
                  {/* Session-detail header — title, status, repo, diffstat, close + inert stubs. */}
                  <SessionHeader
                    title={activeSession?.title ?? ""}
                    repo={titleBarRepo}
                    status={activeSession?.status ?? "idle"}
                    source={activeSession?.source ?? "kineloop"}
                    diffstat={diffstats[activeSessionId] ?? null}
                    onClose={handleNewSession}
                    onCleanup={() => void handleCleanupSession()}
                    panelOpen={rightTab !== null}
                    onTogglePanel={() =>
                      rightTab ? closeRight() : setRightTab("context")
                    }
                  />
                  <div className="flex flex-1 flex-col overflow-auto min-h-0">
                    <div className="mt-auto w-full max-w-3xl mx-auto px-4">
                      {activeLoading ? (
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
                          turns={turns}
                          running={activeRunning}
                          onOpenFile={(path) => void handleOpenFile(path)}
                        />
                      )}
                    </div>
                  </div>
                  {activeSession?.source === "external" ? (
                    <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
                      External CLI history is read-only in Kineloop.
                    </div>
                  ) : (
                    <PromptBar
                      onStart={handleSend}
                      running={activeRunning}
                      models={models}
                      model={selectedModel}
                      onModelChange={setSelectedModel}
                      autoEdit={autoEdit}
                      onAutoEditChange={setAutoEdit}
                    />
                  )}
                </>
              )}
            </section>
          )}

          {/* Right side-pane — tabbed Context | Changes | Files, collapsible + expandable. */}
          {rightTab && (
            <aside
              className={cn(
                "relative flex flex-col min-w-0 min-h-0 rounded-xl border border-border bg-card overflow-hidden",
                rightExpanded
                  ? "w-full"
                  : "max-[900px]:w-full",
              )}
              style={rightExpanded ? undefined : { width: rightPaneWidth }}
            >
              {!rightExpanded && (
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
                value={rightTab}
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
                        rightExpanded ? "Collapse panel" : "Expand panel"
                      }
                    >
                      {rightExpanded ? <Minimize2 /> : <Maximize2 />}
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
                    files={files}
                    rules={rules}
                    capabilities={capabilities}
                    model={selectedModel}
                    onOpenRule={handleOpenRule}
                    onOpenFile={(path) => void handleOpenFile(path)}
                  />
                </TabsContent>
                <TabsContent
                  value="changes"
                  className="flex-1 min-h-0 overflow-hidden"
                >
                  <ChangesPanel
                    branch={branchChanges}
                    status={branchChangesStatus}
                    onCommit={handleCommit}
                    onOpenFile={(path) => void handleOpenFile(path)}
                    committing={committing}
                  />
                </TabsContent>
                <TabsContent
                  value="files"
                  className="flex-1 min-h-0 overflow-hidden"
                >
                  <FilesTree
                    nodes={treeNodes}
                    onOpenFile={(path) => void handleOpenFile(path)}
                  />
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

      {/* File diff Sheet — opens when a file is clicked in Changes or Files tab.
          Shows the full session patch (DiffViewer has no per-file filter). */}
      <Sheet
        open={diffSheet !== null}
        onOpenChange={(o) => {
          if (!o) setDiffSheet(null);
        }}
      >
        <SheetContent className="w-[min(640px,calc(100vw-1rem))] sm:max-w-none flex flex-col rounded-l-xl">
          <SheetHeader>
            <SheetTitle className="font-mono text-sm">
              {diffSheet?.path}
            </SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0">
            {diffSheet && <DiffViewer diff={diffSheet.diff} />}
          </ScrollArea>
        </SheetContent>
      </Sheet>

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
        />
      </Suspense>

      <Toaster />
    </div>
  );
}
