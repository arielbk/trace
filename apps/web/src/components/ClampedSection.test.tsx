// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ClampedSection } from "./ClampedSection.tsx";

afterEach(cleanup);

test("ClampedSection shows a Show more toggle only when content overflows", () => {
  // jsdom reports scrollHeight as 0; force an overflow for this render.
  const spy = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(1000);

  render(
    <ClampedSection maxHeight={240}>
      <p>Lots of state</p>
    </ClampedSection>,
  );

  const toggle = screen.getByRole("button", { name: "Show more" });
  expect(toggle).toBeInTheDocument();
  expect(screen.getByText("Lots of state")).toBeInTheDocument();

  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();

  spy.mockRestore();
});

test("ClampedSection renders children without a toggle when content fits", () => {
  const spy = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(0);

  render(
    <ClampedSection maxHeight={240}>
      <p>Short state</p>
    </ClampedSection>,
  );

  expect(screen.getByText("Short state")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();

  spy.mockRestore();
});
