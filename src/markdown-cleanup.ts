import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

/** Remove the legacy archive envelope only before the first body paragraph. */
export function stripArchiveMetadata(markdown: string): string {
  const lines = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let index = 0;
  let metadataFound = false;
  for (; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!line.trim() || /^#\s+/.test(line)) {
      kept.push(line);
      continue;
    }
    // Accept plain, list and bold labels produced by previous archive formats.
    const label = line.replace(/^\s*(?:[-*+]\s+)?/, "").replace(/\*\*|__/g, "");
    if (/^(?:source|published(?:[ _]at)?|url|link|author|tags|type|article[ _]id|id)\s*[:：]/i.test(label)) {
      metadataFound = true;
      continue;
    }
    if (metadataFound && /^\s*(?:---+|\*\*\*+)\s*$/.test(line)) continue;
    break;
  }
  return [...kept, ...lines.slice(index)].join("\n");
}

interface Edit { start: number; end: number; text: string }

/** Use CommonMark positions so nested brackets, URL parentheses and references are complete. */
function cleanLinkSyntax(markdown: string, removeImages: boolean): string {
  const edits: Edit[] = [];
  const walk = (node: Nodes): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (removeImages && (node.type === "image" || node.type === "imageReference" || node.type === "definition")) {
      edits.push({ start, end, text: "" });
      return;
    }
    if (node.type === "link" || node.type === "linkReference") {
      const first = node.children[0]?.position?.start.offset ?? end;
      const last = node.children.at(-1)?.position?.end.offset ?? end;
      edits.push({ start, end: first, text: "" }, { start: last, end, text: "" });
    }
    if (node.type === "text") {
      const raw = markdown.slice(start, end);
      const repaired = removeBrokenHttpLinks(raw, removeImages);
      if (raw !== repaired) edits.push({ start, end, text: repaired });
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(fromMarkdown(markdown));
  // Apply disjoint source edits without serializing (and reformatting) the article.
  let cursor = 0;
  const output: string[] = [];
  for (const edit of edits.sort((a, b) => a.start - b.start || a.end - b.end)) {
    output.push(markdown.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  output.push(markdown.slice(cursor));
  return output.join("");
}

// Some imported WeChat query strings contain literal spaces (decoded '+').
// CommonMark treats those links as text. Consume the complete balanced target
// before removing bare URLs, which would otherwise leave query-token fragments.
function removeBrokenHttpLinks(text: string, removeImages: boolean): string {
  const pattern = /(!?)\[([^\]\r\n]*)\]\([ \t]*https?:\/\//gi;
  const edits: Edit[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index > 0 && text[match.index - 1] === "\\") continue;
    if (match[1] && !removeImages) continue;
    let depth = 1;
    let end = match.index + match[0].length;
    for (; end < text.length && text[end] !== "\n" && text[end] !== "\r"; end++) {
      if (text[end] === "\\") { end++; continue; }
      if (text[end] === "(") depth++;
      if (text[end] === ")" && --depth === 0) break;
    }
    if (depth === 0) edits.push({ start: match.index, end: end + 1, text: match[1] ? "" : match[2] ?? "" });
  }
  let output = text;
  for (const edit of edits.reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output;
}

export function cleanMarkdownTextLinks(markdown: string): string {
  return cleanLinkSyntax(markdown, false);
}

export function cleanMarkdownLinksAndImages(markdown: string): string {
  // HTML can be embedded in a Markdown paragraph or block and is opaque to CommonMark.
  const withoutHtmlMedia = markdown
    .replace(/<(?:img|source)\b[^>]*>/gi, "")
    .replace(/<\/?(?:a|picture)\b[^>]*>/gi, "");
  return cleanLinkSyntax(withoutHtmlMedia, true)
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .replace(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanArchiveMarkdown(markdown: string): string {
  return cleanMarkdownLinksAndImages(stripArchiveMetadata(markdown));
}
