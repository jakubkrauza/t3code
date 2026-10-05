import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ resolveRange: vi.fn() }));
vi.mock("./assistantTextSelection", () => ({ resolveAssistantCitationRange: mocks.resolveRange }));
import { observeSidechatAnchors, sameSidechatCitation } from "./sidechats";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("parent"),
  messageId: MessageId.make("message"),
  text: "quote",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
class FakeHighlight extends Set<Range> {}

function source(reduceMotion = false) {
  const handlers = new Map<string, EventListener>();
  const selection = { text: "" };
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel, id: "" }));
  const motionListeners = new Map<string, () => void>();
  const motion = {
    matches: reduceMotion,
    addEventListener: (name: string, callback: () => void) => motionListeners.set(name, callback),
    removeEventListener: (name: string) => motionListeners.delete(name),
  };
  const root = {
    style: { cursor: "text" },
    animate,
    toggleAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    ownerDocument: {
      getSelection: () => ({ toString: () => selection.text }),
      defaultView: { matchMedia: () => motion },
    },
    addEventListener: (name: string, callback: EventListener) => handlers.set(name, callback),
    removeEventListener: (name: string) => handlers.delete(name),
  } as unknown as HTMLElement;
  return {
    root,
    handlers,
    selection,
    animate,
    cancel,
    motion,
    motionListeners,
    click: (x: number, y: number) =>
      handlers.get("click")?.({
        clientX: x,
        clientY: y,
        target: { closest: () => null },
      } as unknown as Event),
  };
}
function range() {
  return {
    getClientRects: () => [{ left: 10, right: 70, top: 20, bottom: 40 }],
  } as unknown as Range;
}
function setup() {
  const highlights = new Map<string, FakeHighlight>();
  const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal(
    "MutationObserver",
    class {
      disconnect = vi.fn();
      constructor(callback: () => void) {
        observers.push({ callback, disconnect: this.disconnect });
      }
      observe() {}
    },
  );
  return { highlights, observers };
}
afterEach(() => {
  vi.unstubAllGlobals();
  mocks.resolveRange.mockReset();
});

it("switches between an underline and a selected passage without changing its color", () => {
  const { highlights } = setup();
  const node = source();
  const selectedRange = range();
  mocks.resolveRange.mockReturnValue(selectedRange);
  const anchor = { threadId: ThreadId.make("child"), citation };
  let stop = observeSidechatAnchors(node.root, [anchor], vi.fn());
  const name = [...highlights.keys()][0]!;
  expect(name).toMatch(/^t3-sidechat-\d$/);
  expect(node.animate).not.toHaveBeenCalled();
  stop();
  stop = observeSidechatAnchors(node.root, [{ ...anchor, active: true }], vi.fn());
  expect([...highlights.keys()]).toEqual([`${name}-active`]);
  expect(highlights.get(`${name}-active`)!.has(selectedRange)).toBe(true);
  stop();
  stop = observeSidechatAnchors(node.root, [anchor], vi.fn());
  expect([...highlights.keys()]).toEqual([name]);
  stop();
});

it("pulses only working passages and stops when work ends or reduced motion is enabled", () => {
  const { highlights } = setup();
  const node = source();
  mocks.resolveRange.mockReturnValue(range());
  const anchor = { threadId: ThreadId.make("child"), citation, working: true };
  let stop = observeSidechatAnchors(node.root, [anchor], vi.fn());
  const name = [...highlights.keys()][0]!;
  expect(name).toMatch(/^t3-sidechat-\d-working$/);
  expect(node.animate).toHaveBeenCalledOnce();
  node.motion.matches = true;
  node.motionListeners.get("change")!();
  expect(node.cancel).toHaveBeenCalledOnce();
  expect(node.animate).toHaveBeenCalledOnce();
  node.motion.matches = false;
  node.motionListeners.get("change")!();
  expect(node.animate).toHaveBeenCalledTimes(2);
  stop();
  expect(node.cancel).toHaveBeenCalledTimes(2);
  expect(node.motionListeners.size).toBe(0);
  stop = observeSidechatAnchors(node.root, [{ ...anchor, active: true }], vi.fn());
  expect([...highlights.keys()]).toEqual([name.replace("-working", "-active-working")]);
  stop();
  const animations = node.animate.mock.calls.length;
  stop = observeSidechatAnchors(node.root, [{ ...anchor, working: false }], vi.fn());
  expect(node.animate).toHaveBeenCalledTimes(animations);
  expect([...highlights.keys()]).toEqual([name.replace("-working", "")]);
  stop();
});

it("keeps working marks visible without animation when reduced motion is requested", () => {
  setup();
  const node = source(true);
  mocks.resolveRange.mockReturnValue(range());
  const stop = observeSidechatAnchors(
    node.root,
    [{ threadId: ThreadId.make("child"), citation, working: true }],
    vi.fn(),
  );
  expect(node.animate).not.toHaveBeenCalled();
  stop();
});

it("distributes UUIDs across all eight colors and keeps those colors on remount", () => {
  const { highlights } = setup();
  const node = source();
  mocks.resolveRange.mockReturnValue(range());
  const anchors = Array.from({ length: 8 }, (_, index) => ({
    threadId: ThreadId.make(`00000000-0000-4000-8000-00000000000${index}`),
    citation,
  }));
  let stop = observeSidechatAnchors(node.root, anchors, vi.fn());
  const names = [...highlights.keys()];
  expect(new Set(names).size).toBe(8);
  stop();
  stop = observeSidechatAnchors(node.root, anchors, vi.fn());
  expect([...highlights.keys()]).toEqual(names);
  stop();
});

it("opens the anchored thread only when its highlighted text is clicked, preserving selections", () => {
  const { highlights } = setup();
  const node = source();
  const open = vi.fn();
  const selectedRange = range();
  mocks.resolveRange.mockReturnValue(selectedRange);
  const stop = observeSidechatAnchors(
    node.root,
    [{ threadId: ThreadId.make("child"), citation }],
    open,
  );
  expect([...highlights.values()][0]?.has(selectedRange)).toBe(true);
  node.click(100, 30);
  expect(open).not.toHaveBeenCalled();
  node.selection.text = "user is selecting text";
  node.click(30, 30);
  expect(open).not.toHaveBeenCalled();
  node.selection.text = "";
  node.click(30, 30);
  expect(open).toHaveBeenCalledExactlyOnceWith("child");
  stop();
  expect(highlights.size).toBe(0);
  expect(node.handlers.size).toBe(0);
});

it("repairs marks after a Markdown remount and does not remove another message's marks", () => {
  const { highlights, observers } = setup();
  const first = source();
  const second = source();
  const firstRange = range();
  const secondRange = range();
  const repairedRange = range();
  mocks.resolveRange
    .mockReturnValueOnce(firstRange)
    .mockReturnValueOnce(secondRange)
    .mockReturnValueOnce(repairedRange);
  const stopFirst = observeSidechatAnchors(
    first.root,
    [{ threadId: ThreadId.make("child"), citation }],
    vi.fn(),
  );
  const stopSecond = observeSidechatAnchors(
    second.root,
    [{ threadId: ThreadId.make("child"), citation }],
    vi.fn(),
  );
  observers[0]!.callback();
  const highlight = [...highlights.values()][0]!;
  expect(highlight.has(firstRange)).toBe(false);
  expect(highlight.has(repairedRange)).toBe(true);
  expect(highlight.has(secondRange)).toBe(true);
  stopFirst();
  expect(highlight.has(secondRange)).toBe(true);
  stopSecond();
  expect(highlights.size).toBe(0);
});

it("distinguishes repeated quotes and identical IDs in different environments", () => {
  expect(sameSidechatCitation(citation, { ...citation })).toBe(true);
  expect(sameSidechatCitation(citation, { ...citation, start: 10, end: 15 })).toBe(false);
  expect(
    sameSidechatCitation(citation, { ...citation, environmentId: EnvironmentId.make("remote") }),
  ).toBe(false);
});

it("shows a pointer only over the anchored range and restores the original cursor", () => {
  setup();
  const node = source();
  mocks.resolveRange.mockReturnValue(range());
  const stop = observeSidechatAnchors(
    node.root,
    [{ threadId: ThreadId.make("child"), citation }],
    vi.fn(),
  );
  const move = (x: number, y: number, interactive = false) =>
    node.handlers.get("pointermove")?.({
      clientX: x,
      clientY: y,
      target: { closest: () => (interactive ? {} : null) },
    } as unknown as Event);
  move(30, 30);
  expect(node.root.style.cursor).toBe("pointer");
  move(90, 30);
  expect(node.root.style.cursor).toBe("text");
  move(30, 30, true);
  expect(node.root.style.cursor).toBe("text");
  move(30, 30);
  node.handlers.get("pointerleave")?.({} as Event);
  expect(node.root.style.cursor).toBe("text");
  move(30, 30);
  stop();
  expect(node.root.style.cursor).toBe("text");
});
