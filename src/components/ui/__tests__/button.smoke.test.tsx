import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";

/**
 * Smoke test: verifies the shadcn Button component resolves via the @/ alias
 * under Vitest and renders correctly. This guards the Tailwind v4 + shadcn
 * foundation — if the alias or component resolution breaks, this fails fast.
 */
describe("shadcn Button smoke test", () => {
  it("renders and is in the document", () => {
    render(<Button>Test</Button>);
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
  });
});
