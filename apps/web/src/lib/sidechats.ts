import type { AssistantCitation, ThreadId } from "@t3tools/contracts";
import { resolveAssistantCitationRange } from "./assistantTextSelection";

export type SidechatAnchor = { threadId: ThreadId; citation: AssistantCitation };

export function sameSidechatCitation(left: AssistantCitation, right: AssistantCitation): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    left.messageId === right.messageId &&
    left.start === right.start &&
    left.end === right.end &&
    left.text === right.text
  );
}

/** Highlight DOM ranges without changing the Markdown or the user's native selection. */
export function observeSidechatAnchors(
  root: HTMLElement,
  anchors: ReadonlyArray<SidechatAnchor>,
  onOpen: (threadId: ThreadId) => void,
) {
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  let ranges: Array<{
    threadId: ThreadId;
    range: Range;
    highlight: Highlight | null;
    name: string;
  }> = [];
  const clear = () => {
    for (const { range, highlight, name } of ranges) {
      highlight?.delete(range);
      if (highlight?.size === 0 && registry?.get(name) === highlight) registry.delete(name);
    }
    ranges = [];
  };
  const update = () => {
    clear();
    for (const { threadId, citation } of anchors) {
      const range = resolveAssistantCitationRange(root, citation);
      if (!range) continue;
      const color = [...threadId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4;
      const name = `t3-sidechat-${color}`;
      let highlight: Highlight | null = null;
      if (registry && typeof Highlight !== "undefined") {
        highlight = registry.get(name) ?? new Highlight();
        highlight.add(range);
        registry.set(name, highlight);
      }
      ranges.push({ threadId, range, highlight, name });
    }
  };
  const click = (event: MouseEvent) => {
    if (root.ownerDocument.getSelection()?.toString()) return;
    if ((event.target as Element).closest("a, button, [role=button]")) return;
    const match = ranges.find(({ range }) =>
      Array.from(range.getClientRects()).some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom,
      ),
    );
    if (match) onOpen(match.threadId);
  };
  update();
  const observer = new MutationObserver(update);
  observer.observe(root, { childList: true, characterData: true, subtree: true });
  root.addEventListener("click", click);
  return () => {
    observer.disconnect();
    root.removeEventListener("click", click);
    clear();
  };
}
