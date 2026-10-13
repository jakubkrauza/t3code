import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type AssistantCitation,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ threads: null as unknown, read: vi.fn() }));
vi.mock("./threads", () => ({
  environmentThreadShells: { environmentThreadsAtom: () => mocks.threads },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: unknown) => mocks.read(atom) }));

import { useThreadSidechats } from "./sidechats";

const parent = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("parent"));
const citation: AssistantCitation = {
  version: 1,
  environmentId: parent.environmentId,
  threadId: parent.threadId,
  messageId: MessageId.make("message"),
  text: "quote",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};

it("updates marks on start/stop while keeping them stable throughout streaming", () => {
  type Shell = Pick<
    OrchestrationV2ThreadShell,
    "id" | "sidechatSource" | "deletedAt" | "status" | "title" | "itemCount"
  >;
  let child: Shell = {
    id: ThreadId.make("child"),
    sidechatSource: { parentThreadId: parent.threadId, citation },
    deletedAt: null,
    status: "idle",
    title: "Sidechat",
    itemCount: 0,
  };
  const threads = Atom.make<ReadonlyArray<Shell>>([child]);
  mocks.threads = threads;
  const registry = AtomRegistry.make();
  mocks.read.mockImplementation((atom: Atom.Atom<unknown>) => registry.get(atom));
  const read = () => useThreadSidechats(parent);
  // Keep the derived atom mounted just as useAtomValue does in the client.
  read();
  const unmount = registry.mount(mocks.read.mock.calls.at(-1)![0]);
  const update = (changes: Partial<Shell>) => {
    child = { ...child, ...changes };
    registry.set(threads, [child]);
    return read();
  };
  try {
    const idle = read();
    expect(idle[0]!.working).toBe(false);
    const working = update({ status: "preparing" });
    expect(working[0]!.working).toBe(true);
    expect(working).not.toBe(idle);
    expect(update({ status: "starting" })).toBe(working);
    expect(update({ status: "running" })).toBe(working);
    expect(update({ title: "Streaming title", itemCount: 10 })).toBe(working);
    expect(update({ title: "Updated title", itemCount: 11 })).toBe(working);
    const stopped = update({ status: "completed" });
    expect(stopped[0]!.working).toBe(false);
    expect(stopped).not.toBe(working);
    expect(update({ status: "interrupted" })).toBe(stopped);
    expect(update({ status: "failed" })).toBe(stopped);
    expect(update({ deletedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z") })).toEqual([]);
  } finally {
    unmount();
    registry.dispose();
    mocks.read.mockReset();
  }
});
