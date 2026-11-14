import { useMemo } from "react";

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(diff: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

interface Props {
  diff: string;
  label?: string;
  defaultOpen?: boolean;
}

export default function DiffView({ diff, label = "Review diff", defaultOpen = false }: Props): React.JSX.Element {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  const stat = useMemo(() => diffStat(diff), [diff]);
  return (
    <details className="diff-view" data-testid="diff-view" open={defaultOpen || undefined}>
      <summary className="diff-summary">
        {label}
        <span className="diff-add" data-testid="diff-add">+{stat.added}</span>
        <span className="diff-del" data-testid="diff-del">−{stat.removed}</span>
      </summary>
      <pre className="diff-body" data-testid="diff-body">
        {lines.map((line, index) => {
          const kind = line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "context";
          return (
            <span className={`diff-line diff-line-${kind}`} key={`${index}-${line.slice(0, 12)}`}>
              {line}
              {"\n"}
            </span>
          );
        })}
      </pre>
    </details>
  );
}
