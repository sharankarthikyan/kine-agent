import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. A render error anywhere in the tree would otherwise
 * white-screen the whole app with no way out; this catches it and shows a
 * recoverable fallback with a reload affordance. Must be a class component —
 * React error boundaries require getDerivedStateFromError/componentDidCatch,
 * which have no hook equivalent.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log for a local bug report — Kineloop ships no telemetry, so this stays on-device.
    console.error("Kineloop crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            Kineloop hit an unexpected error. Reloading usually fixes it — your
            sessions are saved locally and will still be here.
          </p>
        </div>
        <pre className="max-h-40 max-w-lg overflow-auto rounded-md border border-border bg-muted/30 p-3 text-left text-xs text-muted-foreground">
          {error.message}
        </pre>
        <Button onClick={() => window.location.reload()}>Reload Kineloop</Button>
      </div>
    );
  }
}
