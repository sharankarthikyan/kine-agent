import { ThemeProvider as NextThemesProvider, useTheme as useNextTheme } from "next-themes";
import type { ReactNode } from "react";

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * Wraps next-themes with attribute="class" and dark default.
 * next-themes applies the .dark class to <html>, persists via localStorage,
 * and is what the shadcn sonner component's useTheme call resolves to.
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}

/**
 * Returns `{ theme, setTheme, toggle }`.
 * Must be called inside ThemeProvider.
 */
export function useTheme() {
  const { theme, setTheme } = useNextTheme();
  const resolved = (theme ?? "dark") as "dark" | "light";

  return {
    theme: resolved,
    setTheme: (t: "dark" | "light") => setTheme(t),
    toggle: () => setTheme(resolved === "dark" ? "light" : "dark"),
  };
}
