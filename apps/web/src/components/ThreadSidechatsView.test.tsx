import { act, type ReactNode } from "react";
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
  start: vi.fn(),
  wait: vi.fn(),
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { forkFromRun: "fork", startTurn: "start" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "fork" ? state.fork : state.start),
}));
vi.mock("~/state/entities", () => ({
  useThreadShells: () => state.shells,
  readThreadShell: () => ({ runtimeMode: "full-access", interactionMode: "default" }),
  waitForThreadShell: state.wait,
}));
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
vi.mock("./ui/textarea", () => ({ Textarea: (props: object) => <textarea {...props} /> }));
vi.mock("./ChatView", () => ({
  default: ({
    threadId,
    onAskAssistantText,
  }: {
    threadId: string;
    onAskAssistantText?: (citation: AssistantCitation, runId: RunId) => void;
  }) => (
    <div data-chat-thread={threadId}>
      {onAskAssistantText ? (
        <button onClick={() => onAskAssistantText(citation, runId)}>Select passage</button>
      ) : (
        "Child conversation"
      )}
    </div>
  ),
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
  state.start.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 2 } });
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
async function askQuestion() {
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "Why?" } }),
  );
  await act(async () => {
    const submit = renderer.root.findByType("form").props.onSubmit;
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
  });
}

it("creates one fork only on first send and keeps the main conversation mounted", async () => {
  await openDraft();
  expect(state.fork).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
  await askQuestion();
  expect(state.fork).toHaveBeenCalledTimes(1);
  expect(state.start).toHaveBeenCalledTimes(1);
  const forkInput = state.fork.mock.calls[0]![0].input;
  expect(forkInput.runId).toBe(runId);
  expect(forkInput.sidechatSource).toEqual({ parentThreadId: parentId, citation });
  expect(state.start.mock.calls[0]![0].input.message.text).toContain("Use a fork\n\nWhy?");
  expect(renderer.root.findAllByProps({ "data-chat-thread": parentId })).toHaveLength(1);
  expect(
    renderer.root.findAllByProps({ "data-chat-thread": forkInput.targetThreadId }),
  ).toHaveLength(1);
});

it("reopens a saved sidechat after remounting instead of creating another fork", async () => {
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
  expect(renderer.root.findAllByProps({ "data-chat-thread": "saved-child" })).toHaveLength(1);
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  expect(state.fork).not.toHaveBeenCalled();
});

it("retries a failed first send with the same fork, message and command IDs", async () => {
  state.start.mockResolvedValueOnce({ _tag: "Failure" }).mockResolvedValueOnce({ _tag: "Success" });
  await openDraft();
  await askQuestion();
  expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["Disconnected"]);
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(state.fork).toHaveBeenCalledTimes(2);
  expect(state.start).toHaveBeenCalledTimes(2);
  expect(state.fork.mock.calls[1]![0]).toEqual(state.fork.mock.calls[0]![0]);
  expect(state.start.mock.calls[1]![0]).toEqual(state.start.mock.calls[0]![0]);
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
});
