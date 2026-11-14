// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TodoStrip, { type TodoItem } from "../../src/TodoStrip";

afterEach(cleanup);

const item = (overrides: Partial<TodoItem> = {}): TodoItem => ({
  id: "t1",
  text: "Read the parser",
  status: "pending",
  ...overrides,
});

describe("TodoStrip", () => {
  it("renders nothing without todos", () => {
    const { container } = render(<TodoStrip todos={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows every todo with its status marker and progress", () => {
    render(
      <TodoStrip
        todos={[
          item({ id: "t1", text: "Read the parser", status: "completed" }),
          item({ id: "t2", text: "Fix the bug", status: "in_progress" }),
          item({ id: "t3", text: "Run tests" }),
        ]}
      />,
    );
    expect(screen.getByTestId("todo-count").textContent).toBe("1/3");
    const rows = screen.getAllByTestId("todo-item");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute("data-status")).toBe("completed");
    expect(rows[0]?.textContent).toContain("✓");
    expect(rows[1]?.getAttribute("data-status")).toBe("in_progress");
    expect(rows[1]?.textContent).toContain("Fix the bug");
    expect(rows[2]?.getAttribute("data-status")).toBe("pending");
  });

  it("marks a fully completed list and can be dismissed", () => {
    const onDismiss = vi.fn();
    render(<TodoStrip todos={[item({ status: "completed" })]} onDismiss={onDismiss} />);
    expect(screen.getByTestId("todo-strip").getAttribute("data-done")).toBe("true");
    screen.getByTestId("todo-dismiss").click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
