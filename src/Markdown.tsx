import type { ReactNode } from "react";

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "link"; text: string; href: string };

export type MarkdownBlock =
  | { kind: "paragraph"; tokens: InlineToken[] }
  | { kind: "heading"; level: 1 | 2 | 3; tokens: InlineToken[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; items: InlineToken[][] }
  | { kind: "quote"; tokens: InlineToken[] }
  | { kind: "rule" };

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const FENCE = /^\s*```([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])\1{2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

function matchClosing(text: string, from: number, marker: string): number {
  let index = from;
  while (index < text.length) {
    if (text.startsWith(marker, index)) return index;
    index += 1;
  }
  return -1;
}

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buffer = "";
  let index = 0;
  const flush = (): void => {
    if (buffer.length > 0) {
      tokens.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };
  while (index < text.length) {
    const rest = text.slice(index);
    if (rest.startsWith("`")) {
      const end = matchClosing(text, index + 1, "`");
      if (end > index + 1) {
        flush();
        tokens.push({ kind: "code", text: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.startsWith("**") ? "**" : "__";
      const end = matchClosing(text, index + marker.length, marker);
      if (end > index + marker.length) {
        flush();
        tokens.push({ kind: "strong", text: text.slice(index + marker.length, end) });
        index = end + marker.length;
        continue;
      }
    }
    if (rest.startsWith("*") || rest.startsWith("_")) {
      const marker = rest.startsWith("*") ? "*" : "_";
      const end = matchClosing(text, index + 1, marker);
      if (end > index + 1) {
        flush();
        tokens.push({ kind: "em", text: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (rest.startsWith("[")) {
      const closeText = matchClosing(text, index + 1, "]");
      const hrefStart = closeText + 1;
      if (closeText > index && text.startsWith("(", hrefStart)) {
        const hrefEnd = matchClosing(text, hrefStart + 1, ")");
        if (hrefEnd > hrefStart + 1) {
          const href = text.slice(hrefStart + 1, hrefEnd).trim();
          const label = text.slice(index + 1, closeText);
          if (SAFE_LINK.test(href)) {
            flush();
            tokens.push({ kind: "link", text: label, href });
            index = hrefEnd + 1;
            continue;
          }
        }
      }
    }
    buffer += text[index];
    index += 1;
  }
  flush();
  return tokens;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", tokens: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flushParagraph();
      const language = fence[1] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", language, text: body.join("\n") });
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      const level = heading[1]?.length === 1 ? 1 : heading[1]?.length === 2 ? 2 : 3;
      blocks.push({ kind: "heading", level, tokens: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flushParagraph();
      const body: string[] = [];
      while (index < lines.length) {
        const current = QUOTE.exec(lines[index] ?? "");
        if (current === null) break;
        body.push(current[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "quote", tokens: parseInline(body.join("\n")) });
      continue;
    }
    const unordered = UNORDERED.exec(line);
    const ordered = ORDERED.exec(line);
    if (unordered !== null || ordered !== null) {
      flushParagraph();
      const wantOrdered = ordered !== null;
      const items: InlineToken[][] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const asUnordered = UNORDERED.exec(current);
        const asOrdered = ORDERED.exec(current);
        const match = wantOrdered ? asOrdered : asUnordered;
        if (match === null) break;
        items.push(parseInline(match[1] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered: wantOrdered, items });
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

function renderInline(tokens: InlineToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, position) => {
    const key = `${keyPrefix}-${position}`;  // aikit:allow-secret[high-entropy-value] -- map key built from ids, not a credential
    if (token.kind === "code") return <code key={key}>{token.text}</code>;
    if (token.kind === "strong") return <strong key={key}>{token.text}</strong>;
    if (token.kind === "em") return <em key={key}>{token.text}</em>;
    if (token.kind === "link") {
      return (
        <a key={key} href={token.href} target="_blank" rel="noreferrer noopener">
          {token.text}
        </a>
      );
    }
    return <span key={key}>{token.text}</span>;
  });
}

export interface MarkdownProps {
  text: string;
  onCopyCode?: (code: string) => void;
  copiedCode?: string | null;
}

export default function Markdown({ text, onCopyCode, copiedCode = null }: MarkdownProps): React.JSX.Element {
  const blocks = parseMarkdown(text);
  return (
    <div className="markdown">
      {blocks.map((block, position) => {
        const key = `block-${position}`;
        if (block.kind === "code") {
          return (
            <div className="code-block" key={key}>
              <div className="code-head">
                <span>{block.language.length > 0 ? block.language : "code"}</span>
                {onCopyCode === undefined ? null : (
                  <button
                    type="button"
                    className="code-copy"
                    onClick={() => onCopyCode(block.text)}
                    data-testid="copy-code"
                  >
                    {copiedCode === block.text ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
              <pre>
                <code>{block.text}</code>
              </pre>
            </div>
          );
        }
        if (block.kind === "heading") {
          const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
          return <Tag key={key}>{renderInline(block.tokens, key)}</Tag>;
        }
        if (block.kind === "list") {
          const items = block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ));
          return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
        }
        if (block.kind === "quote") return <blockquote key={key}>{renderInline(block.tokens, key)}</blockquote>;
        if (block.kind === "rule") return <hr key={key} />;
        return <p key={key}>{renderInline(block.tokens, key)}</p>;
      })}
    </div>
  );
}
