import { act, useEffect, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shells: [] as unknown[],
  fork: vi.fn(),
  drafts: new Map<string, string>(),
  setPrompt: vi.fn(),
  mounts: new Map<string, number>(),
  wait: vi.fn(),
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { fork: "fork" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => state.fork,
}));
vi.mock("~/state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) =>
    state.shells.find((value) => (value as { id: string }).id === ref.threadId),
  waitForThreadShell: state.wait,
}));
vi.mock("~/state/sidechats", () => ({
  useThreadSidechats: () =>
    state.shells.map((value) => {
      const thread = value as { id: string; sidechatSource: { citation: AssistantCitation } };
      return { threadId: thread.id, citation: thread.sidechatSource.citation };
    }),
}));
vi.mock("~/hooks/usePreviewPanelInlineSize", () => ({
  usePreviewPanelInlineSize: () => ({ width: 540, handlers: {} }),
}));
vi.mock("./preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ui/panel-tab-close-button", () => ({
  PanelTabCloseButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button aria-label={label} onClick={onClick} />
  ),
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: () => null,
}));
vi.mock("./ui/spinner", () => ({ Spinner: () => <span /> }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("Disconnected"),
}));
vi.mock("./ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    children,
    ...props
  }: {
    size?: string;
    variant?: string;
    children: ReactNode;
  }) => <button {...props}>{children}</button>,
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: (ref: { threadId: string }) => ({
        prompt: state.drafts.get(ref.threadId) ?? "",
      }),
      setPrompt: state.setPrompt,
    }),
  },
}));
vi.mock("./ChatView", () => ({
  default: ({
    threadId,
    onAskAssistantText,
  }: {
    threadId: string;
    onAskAssistantText?: (
      citation: AssistantCitation,
      sourcePoint: { type: "run"; runId: RunId },
    ) => void;
  }) => {
    useEffect(() => {
      state.mounts.set(threadId, (state.mounts.get(threadId) ?? 0) + 1);
    }, [threadId]);
    return (
      <div data-chat-thread={threadId}>
        {onAskAssistantText ? (
          <button onClick={() => onAskAssistantText(citation, { type: "run", runId })}>
            Select passage
          </button>
        ) : (
          "Child conversation"
        )}
      </div>
    );
  },
}));

import { ThreadSidechatsView } from "./ThreadSidechatsView";

const environmentId = EnvironmentId.make("local");
const parentId = ThreadId.make("parent");
const runId = RunId.make("source-run");
const citation: AssistantCitation = {
  version: 1,
  environmentId,
  threadId: parentId,
  messageId: MessageId.make("source-message"),
  text: "Use a fork",
  start: 0,
  end: 10,
  prefix: "",
  suffix: ".",
};
let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.shells = [];
  state.fork.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
  state.drafts.clear();
  state.mounts.clear();
  state.setPrompt
    .mockReset()
    .mockImplementation((ref: { threadId: string }, prompt: string) =>
      state.drafts.set(ref.threadId, prompt),
    );
  state.wait.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function openDraft() {
  await act(async () => {
    renderer = create(
      <ThreadSidechatsView environmentId={environmentId} threadId={parentId} routeKind="server" />,
    );
  });
  await act(async () => renderer.root.findByProps({ children: "Select passage" }).props.onClick());
}
it("opens a fork in the regular chat view without sending or remounting the main chat", async () => {
  await openDraft();
  expect(state.fork).toHaveBeenCalledTimes(1);
  const forkInput = state.fork.mock.calls[0]![0].input;
  expect(forkInput.sourcePoint).toEqual({ type: "run", runId });
  expect(forkInput.sidechatSource).toEqual({ parentThreadId: parentId, citation });
  expect(state.drafts.get(forkInput.targetThreadId)).toContain("[Assistant quote](");
  expect(
    renderer.root.findAllByProps({ "data-chat-thread": forkInput.targetThreadId }),
  ).toHaveLength(1);
  // Selecting the same passage while its shell propagates preserves the mounted editor.
  await act(async () => renderer.root.findByProps({ children: "Select passage" }).props.onClick());
  expect(state.fork).toHaveBeenCalledTimes(1);
  expect(state.mounts.get(parentId)).toBe(1);
  expect(state.mounts.get(forkInput.targetThreadId)).toBe(1);
});

it("reopens a saved sidechat without creating another fork or replacing its draft", async () => {
  state.shells = [
    {
      id: ThreadId.make("saved-child"),
      environmentId,
      deletedAt: null,
      sidechatSource: { parentThreadId: parentId, citation },
      forkedFrom: { type: "run", threadId: parentId, runId },
    },
  ];
  state.drafts.set("saved-child", "Unsent question");
  await openDraft();
  expect(renderer.root.findAllByProps({ "data-chat-thread": "saved-child" })).toHaveLength(1);
  expect(state.drafts.get("saved-child")).toBe("Unsent question");
  expect(state.fork).not.toHaveBeenCalled();
  expect(state.setPrompt).not.toHaveBeenCalled();
});

it("retries opening with the same fork and command IDs", async () => {
  state.fork.mockResolvedValueOnce({ _tag: "Failure" }).mockResolvedValueOnce({ _tag: "Success" });
  await openDraft();
  expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["Disconnected"]);
  await act(async () => renderer.root.findByProps({ children: "Try again" }).props.onClick());
  expect(state.fork).toHaveBeenCalledTimes(2);
  expect(state.fork.mock.calls[1]![0]).toEqual(state.fork.mock.calls[0]![0]);
  expect(state.mounts.get(state.fork.mock.calls[0]![0].input.targetThreadId)).toBe(1);
});

it("does not reopen a panel closed while the fork was being saved", async () => {
  let resolve!: (value: unknown) => void;
  state.fork.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await openDraft();
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Close sidechat" }).props.onClick(),
  );
  await act(async () => resolve({ _tag: "Success", value: { sequence: 1 } }));
  expect(renderer.root.findByType("aside").props["aria-hidden"]).toBe(true);
  expect(state.mounts.get(parentId)).toBe(1);
});

it("keeps the sidechat editor mounted through closing and reopening the panel", async () => {
  state.shells = [
    {
      id: ThreadId.make("saved-child"),
      environmentId,
      deletedAt: null,
      sidechatSource: { parentThreadId: parentId, citation },
      forkedFrom: { type: "run", threadId: parentId, runId },
    },
  ];
  await openDraft();
  const child = renderer.root.findByProps({ "data-chat-thread": "saved-child" });
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Close sidechat" }).props.onClick(),
  );
  expect(renderer.root.findByType("aside").props["aria-hidden"]).toBe(true);
  await act(async () => renderer.root.findByProps({ children: "Select passage" }).props.onClick());
  expect(renderer.root.findByType("aside").props["aria-hidden"]).toBe(false);
  expect(renderer.root.findByProps({ "data-chat-thread": "saved-child" })).toBe(child);
  expect(state.mounts.get("saved-child")).toBe(1);
  expect(state.mounts.get(parentId)).toBe(1);
});

it("reopens an imported-message sidechat after closing it without requiring a source run", async () => {
  const childId = ThreadId.make("imported-child");
  state.shells = [
    { id: childId, sidechatSource: { parentThreadId: parentId, citation }, forkedFrom: null },
  ];
  await openDraft();
  expect(state.fork).not.toHaveBeenCalled();
  expect(renderer.root.findAllByProps({ "data-chat-thread": childId })).toHaveLength(1);
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Close sidechat" }).props.onClick();
  });
  await act(async () => {
    renderer.root.findByProps({ children: "Select passage" }).props.onClick();
  });
  expect(state.fork).not.toHaveBeenCalled();
  expect(state.mounts.get(childId)).toBe(1);
});
