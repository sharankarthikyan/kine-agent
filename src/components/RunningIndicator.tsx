import { Loader2 } from "lucide-react";

export function RunningIndicator() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 p-3 text-sm text-muted-foreground"
    >
      <Loader2 aria-hidden="true" className="size-4 animate-spin shrink-0" />
      Working…
    </div>
  );
}
