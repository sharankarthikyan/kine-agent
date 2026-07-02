import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // Stale agent worktree checkouts under .claude/worktrees carry their own copies
    // of the test suite; their "@" alias resolves against THIS repo's src, so they
    // fail against code they were never written for. Never sweep them up.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
