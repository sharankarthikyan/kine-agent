import { render, screen } from "@testing-library/react";
import { EmptyState } from "../EmptyState";

test("renders heading and hint", () => {
  render(<EmptyState heading="No activity yet" hint="Describe a task above and press Start." />);
  expect(screen.getByText("No activity yet")).toBeInTheDocument();
  expect(screen.getByText("Describe a task above and press Start.")).toBeInTheDocument();
});
