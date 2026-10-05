import type { AssistantCitation, ThreadId } from "@t3tools/contracts";
import { resolveAssistantCitationRange } from "./assistantTextSelection";

export type SidechatAnchor = {
  threadId: ThreadId;
  citation: AssistantCitation;
  active?: boolean;
  working?: boolean;
};

function sidechatColorIndex(threadId: ThreadId): number {
  // Match chat-ux: spread UUIDs across eight colors without changing them on reload.
  let hash = 0;
  for (const character of threadId) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return (hash >>> 0) % 8;
}

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
    for (const { threadId, citation, active, working } of anchors) {
      const range = resolveAssistantCitationRange(root, citation);
      if (!range) continue;
      const color = sidechatColorIndex(threadId);
      const name = `t3-sidechat-${color}${active ? "-active" : ""}${working ? "-working" : ""}`;
      let highlight: Highlight | null = null;
      if (registry && typeof Highlight !== "undefined") {
        highlight = registry.get(name) ?? new Highlight();
        highlight.add(range);
        registry.set(name, highlight);
      }
      ranges.push({ threadId, range, highlight, name });
    }
  };
  const originalCursor = root.style.cursor;
  const hitTest = (event: MouseEvent) => {
    if ((event.target as Element).closest("a, button, [role=button]")) return undefined;
    return ranges.find(({ range }) =>
      Array.from(range.getClientRects()).some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom,
      ),
    );
  };
  let hovered = false;
  const move = (event: MouseEvent) => {
    const next = hitTest(event) !== undefined;
    if (next === hovered) return;
    hovered = next;
    root.toggleAttribute("data-sidechat-hovered", hovered);
    root.style.cursor = hovered ? "pointer" : originalCursor;
  };
  const leave = () => {
    hovered = false;
    root.removeAttribute("data-sidechat-hovered");
    root.style.cursor = originalCursor;
  };
  const click = (event: MouseEvent) => {
    if (root.ownerDocument.getSelection()?.toString()) return;
    const match = hitTest(event);
    if (match) onOpen(match.threadId);
  };
  update();
  const reducedMotion = root.ownerDocument.defaultView?.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  let pulse: Animation | undefined;
  const updatePulse = () => {
    pulse?.cancel();
    pulse = undefined;
    if (reducedMotion?.matches || !anchors.some((anchor) => anchor.working)) return;
    pulse = root.animate(
      [
        { "--sidechat-pulse-opacity": 1 },
        { "--sidechat-pulse-opacity": 0.4 },
        { "--sidechat-pulse-opacity": 1 },
      ],
      { duration: 1600, iterations: Infinity, easing: "ease-in-out" },
    );
    pulse.id = "t3-sidechat-pulse";
  };
  updatePulse();
  reducedMotion?.addEventListener("change", updatePulse);
  const observer = new MutationObserver(update);
  observer.observe(root, { childList: true, characterData: true, subtree: true });
  root.addEventListener("click", click);
  root.addEventListener("pointermove", move, { passive: true });
  root.addEventListener("pointerleave", leave);
  return () => {
    pulse?.cancel();
    reducedMotion?.removeEventListener("change", updatePulse);
    observer.disconnect();
    root.removeEventListener("click", click);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerleave", leave);
    leave();
    clear();
  };
}
