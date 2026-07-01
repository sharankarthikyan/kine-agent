import { render, screen } from "@testing-library/react";
import { RunningIndicator } from "../RunningIndicator";

test("shows starting state with status role", () => {
  render(<RunningIndicator />);
  expect(screen.getByRole("status")).toHaveTextContent(/starting agent/i);
  expect(screen.getByRole("status")).toHaveTextContent(/waiting for the first response/i);
});
