import { render, screen } from "@testing-library/react";
import { RunningIndicator } from "../RunningIndicator";

test("shows a working message with status role", () => {
  render(<RunningIndicator />);
  expect(screen.getByRole("status")).toHaveTextContent(/working/i);
});
