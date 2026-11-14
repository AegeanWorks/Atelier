// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TodoStrip, { type TodoItem } from "../../src/TodoStrip";

afterEach(cleanup);

const items: TodoItem[] = [
  { id: "t1", text: "Read the parser", status: "completed" },
  { id: "t2", text: "Refactor the tokenizer", status: "in_progress" },
  { id: "t3", text: "Run the suite", status: "pending" },
];

describe("TodoStrip", () => {
  it("renders nothing for an empty list", () => {
    const { container } = render(<TodoStrip todos={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows progress, the current item and each status", () => {
    render(<TodoStrip todos={items} />);
    expect(screen.getByTestId("todo-strip")).toBeDefined();
    expect(screen.getByTestId("todo-count").textContent).toBe("1/3");
    const rows = screen.getAllByTestId("todo-item");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute("data-status")).toBe("completed");
    expect(rows[1]?.getAttribute("data-status")).toBe("in_progress");
    expect(rows[2]?.getAttribute("data-status")).toBe("pending");
    expect(rows[1]?.textContent).toContain("Refactor the tokenizer");
  });

  it("marks a finished list and offers dismissal", () => {
    const onDismiss = vi.fn();
    render(<TodoStrip todos={items.map((item) => ({ ...item, status: "completed" as const }))} onDismiss={onDismiss} />);
    expect(screen.getByTestId("todo-strip").getAttribute("data-done")).toBe("true");
    expect(screen.getByTestId("todo-count").textContent).toBe("3/3");
    fireEvent.click(screen.getByTestId("todo-dismiss"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("has no dismiss control when no handler is provided", () => {
    render(<TodoStrip todos={items} />);
    expect(screen.queryByTestId("todo-dismiss")).toBeNull();
  });
});
