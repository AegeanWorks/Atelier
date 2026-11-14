// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ActivityFeed, { appendActivity, toolLabel, type ActivityItem } from "../../src/ActivityFeed";

afterEach(cleanup);

const item = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "c1",
  tool: "read_file",
  detail: "src/App.tsx",
  ok: true,
  at: 1,
  ...overrides,
});

describe("ActivityFeed", () => {
  it("renders nothing when idle with no activity", () => {
    const { container } = render(<ActivityFeed items={[]} running={false} onDismiss={() => undefined} onOpenTask={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the waiting state while a run has no tool calls yet", () => {
    render(<ActivityFeed items={[]} running onDismiss={() => undefined} onOpenTask={() => undefined} />);
    expect(screen.getByTestId("activity-feed")).toBeDefined();
    expect(screen.getByText("Working")).toBeDefined();
    expect(screen.getByText("Waiting for the first tool call…")).toBeDefined();
  });

  it("lists tool steps with a readable label and outcome", () => {
    render(
      <ActivityFeed
        items={[item(), item({ id: "c2", tool: "edit_file", detail: "src/App.tsx", ok: false })]}
        running
        onDismiss={() => undefined}
        onOpenTask={() => undefined}
      />,
    );
    const rows = screen.getAllByTestId("activity-item");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Read");
    expect(rows[0]?.textContent).toContain("src/App.tsx");
    expect(rows[1]?.getAttribute("data-ok")).toBe("false");
    expect(rows[1]?.textContent).toContain("failed");
    expect(screen.getByText("2 steps")).toBeDefined();
  });

  it("keeps only the latest six rows visible and reports the total", () => {
    const items = Array.from({ length: 9 }, (_value, index) => item({ id: `c${index}`, detail: `file-${index}.ts` }));
    render(<ActivityFeed items={items} running={false} onDismiss={() => undefined} onOpenTask={() => undefined} />);
    expect(screen.getAllByTestId("activity-item")).toHaveLength(6);
    expect(screen.getByText("9 steps")).toBeDefined();
    expect(screen.getByText("Last run")).toBeDefined();
  });

  it("opens the task panel and dismisses the finished feed", () => {
    const onOpenTask = vi.fn();
    const onDismiss = vi.fn();
    render(<ActivityFeed items={[item()]} running={false} onDismiss={onDismiss} onOpenTask={onOpenTask} />);
    fireEvent.click(screen.getByTestId("activity-open-task"));
    fireEvent.click(screen.getByTestId("activity-dismiss"));
    expect(onOpenTask).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("labels MCP tools and bounds the stored history", () => {
    expect(toolLabel("mcp__files__read")).toBe("Called files · read");
    let list: ActivityItem[] = [];
    for (let index = 0; index < 45; index += 1) list = appendActivity(list, item({ id: `c${index}` }), 40);
    expect(list).toHaveLength(40);
    expect(list[0]?.id).toBe("c5");
    expect(list[39]?.id).toBe("c44");
  });
});
