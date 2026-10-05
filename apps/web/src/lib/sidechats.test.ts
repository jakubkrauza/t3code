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

function source() {
  const handlers = new Map<string, EventListener>();
  const selection = { text: "" };
  const root = {
    ownerDocument: { getSelection: () => ({ toString: () => selection.text }) },
    addEventListener: (name: string, callback: EventListener) => handlers.set(name, callback),
    removeEventListener: (name: string) => handlers.delete(name),
  } as unknown as HTMLElement;
  return {
    root,
    handlers,
    selection,
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
