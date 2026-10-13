import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type AssistantCitation,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Legacy from "./legacy/LegacyV1ThreadImporter.ts";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const sourceThreadId = ThreadId.make("sidechat-parent");
const targetThreadId = ThreadId.make("sidechat-child");
const sourceRunId = RunId.make("sidechat-source-run");
const messageId = MessageId.make("sidechat-source-message");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("local"),
  threadId: sourceThreadId,
  messageId,
  text: "Use a fork",
  start: 0,
  end: 10,
  prefix: "",
  suffix: ".",
};
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "anchored-sidechat" },
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("This test does not start provider execution"),
    },
  ]),
  { runEffectWorker: false },
);

const seed = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("sidechat-create-parent"),
    threadId: sourceThreadId,
    projectId: ProjectId.make("sidechat-project"),
    title: "Parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* sink.write({
    events: [
      {
        id: EventId.make("sidechat-source-run-event"),
        type: "run.created",
        threadId: sourceThreadId,
        runId: sourceRunId,
        occurredAt: now,
        payload: {
          id: sourceRunId,
          threadId: sourceThreadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("source-user"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          queuePosition: null,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        id: EventId.make("sidechat-source-message-event"),
        type: "turn-item.updated",
        threadId: sourceThreadId,
        runId: sourceRunId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("sidechat-source-item"),
          threadId: sourceThreadId,
          runId: sourceRunId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId,
          text: "Use a fork.",
          streaming: false,
        },
      },
      {
        id: EventId.make("sidechat-conversation-message-event"),
        type: "message.updated",
        threadId: sourceThreadId,
        runId: sourceRunId,
        occurredAt: now,
        payload: {
          id: messageId,
          threadId: sourceThreadId,
          runId: sourceRunId,
          nodeId: null,
          createdBy: "agent",
          creationSource: "provider",
          role: "assistant",
          text: "Use a fork.",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
  });
  return orchestrator;
});

function forkCommand(quote = citation): Extract<OrchestrationV2Command, { type: "thread.fork" }> {
  return {
    type: "thread.fork",
    commandId: CommandId.make("sidechat-fork"),
    sourceThreadId,
    targetThreadId,
    sourcePoint: { type: "run", runId: sourceRunId },
    sidechatSource: { parentThreadId: sourceThreadId, citation: quote },
    createdBy: "user",
    creationSource: "web",
  };
}

it.effect("persists a sidechat anchor in both thread detail and shell, and retries one fork", () =>
  Effect.gen(function* () {
    const orchestrator = yield* seed;
    const result = yield* orchestrator.dispatch(forkCommand());
    const retry = yield* orchestrator.dispatch(forkCommand());
    assert.equal(retry.sequence, result.sequence);
    const detail = yield* orchestrator.getThreadProjection(targetThreadId);
    const shell = yield* orchestrator.getThreadShell(targetThreadId);
    assert.deepEqual(detail.thread.sidechatSource, { parentThreadId: sourceThreadId, citation });
    assert.deepEqual(shell?.sidechatSource, detail.thread.sidechatSource);
    const snapshot = yield* orchestrator.getShellSnapshot();
    assert.deepEqual(
      snapshot.threads.find((thread) => thread.id === targetThreadId)?.sidechatSource,
      detail.thread.sidechatSource,
    );
    assert.equal(detail.contextTransfers.length, 1);
    assert.equal(detail.thread.runtimeMode, "approval-required");
    assert.equal(detail.thread.interactionMode, "default");
    assert.deepEqual(detail.thread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
    const parent = yield* orchestrator.getThreadProjection(sourceThreadId);
    assert.isUndefined(parent.thread.sidechatSource);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects a citation from a different message instead of attaching it to the wrong fork",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* seed;
      const error = yield* orchestrator
        .dispatch(forkCommand({ ...citation, messageId: MessageId.make("unrelated") }))
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.isNull(yield* orchestrator.getThreadShell(targetThreadId));
    }).pipe(Effect.provide(layer)),
);

it.effect("deletes anchored children with their parent, preserving ordinary forks", () =>
  Effect.gen(function* () {
    const orchestrator = yield* seed;
    yield* orchestrator.dispatch(forkCommand());
    const ordinaryId = ThreadId.make("ordinary-fork");
    const { sidechatSource: _anchor, ...ordinary } = forkCommand();
    yield* orchestrator.dispatch({
      ...ordinary,
      commandId: CommandId.make("ordinary-fork"),
      targetThreadId: ordinaryId,
    });
    const command = {
      type: "thread.delete" as const,
      commandId: CommandId.make("delete-parent"),
      threadId: sourceThreadId,
    };
    const result = yield* orchestrator.dispatch(command);
    assert.equal((yield* orchestrator.dispatch(command)).sequence, result.sequence);
    assert.isNotNull((yield* orchestrator.getThreadProjection(sourceThreadId)).thread.deletedAt);
    assert.isNotNull((yield* orchestrator.getThreadProjection(targetThreadId)).thread.deletedAt);
    assert.isNull((yield* orchestrator.getThreadProjection(ordinaryId)).thread.deletedAt);
    const error = yield* orchestrator
      .dispatch({
        ...forkCommand(),
        commandId: CommandId.make("fork-deleted"),
        targetThreadId: ThreadId.make("late-child"),
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "OrchestratorDispatchError");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "cancels a running sidechat when the parent is deleted and rejects access escalation",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* seed;
      yield* orchestrator.dispatch(forkCommand());
      const escalation = yield* orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("escalate-sidechat"),
          threadId: targetThreadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.equal(escalation._tag, "OrchestratorDispatchError");
      const source = yield* orchestrator.getThreadProjection(sourceThreadId);
      const run = {
        ...source.runs[0]!,
        id: RunId.make("sidechat-active-run"),
        threadId: targetThreadId,
        status: "running" as const,
        completedAt: null,
      };
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            type: "run.created",
            id: EventId.make("sidechat-active-run-event"),
            threadId: targetThreadId,
            runId: run.id,
            occurredAt: now,
            payload: run,
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-active-sidechat-parent"),
        threadId: sourceThreadId,
      });
      const child = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(child.runs.find((item) => item.id === run.id)?.status, "cancelled");
      assert.isNotNull(child.thread.deletedAt);
    }).pipe(Effect.provide(layer)),
);

it.effect("forks an imported response with its preceding context and no later messages", () =>
  Effect.gen(function* () {
    const orchestrator = yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-07T12:00:00.000Z";
    const parent = ThreadId.make("imported-parent");
    const response = MessageId.make("imported-answer");
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${parent}, 'sidechat-project', 'Imported', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', ${now}, ${now})`;
    const messages = [
      { id: "imported-question", role: "user", text: "The app is Fridge Roulette." },
      { id: response, role: "assistant", text: "Use a fork." },
      { id: "later-question", role: "user", text: "LATER_CONTEXT_MUST_NOT_LEAK" },
      { id: "later-answer", role: "assistant", text: "Later answer." },
    ];
    for (const [index, message] of messages.entries()) {
      const time = `2026-10-07T12:00:0${index}.000Z`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${message.id}, ${parent}, ${message.role}, ${message.text}, 0, ${time}, ${time})`;
    }
    const legacy = yield* Legacy.LegacyV1ThreadImporter;
    yield* legacy.reconcileShells;
    yield* legacy.ensureTranscript(parent);
    const quote = { ...citation, threadId: parent, messageId: response };
    const command = {
      ...forkCommand(quote),
      sourceThreadId: parent,
      sourcePoint: { type: "imported_message" as const, messageId: response },
      sidechatSource: { parentThreadId: parent, citation: quote },
    };
    const result = yield* orchestrator.dispatch(command);
    assert.equal((yield* orchestrator.dispatch(command)).sequence, result.sequence);
    const detail = yield* orchestrator.getThreadProjection(targetThreadId);
    assert.deepEqual(
      detail.messages.map((message) => message.text),
      messages.slice(0, 2).map((message) => message.text),
    );
    assert.deepEqual(detail.thread.sidechatSource, command.sidechatSource);
    assert.equal(detail.thread.runtimeMode, "approval-required");
    assert.equal(detail.thread.historyOrigin, "v1_import");
    assert.lengthOf((yield* orchestrator.getThreadProjection(parent)).messages, 4);
    assert.lengthOf((yield* orchestrator.getThreadProjection(parent)).runs, 0);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("ask-imported-sidechat"),
      threadId: targetThreadId,
      messageId: MessageId.make("sidechat-question"),
      text: "Which app are we discussing?",
      dispatchMode: { type: "start_immediately" },
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    });
    const started = yield* orchestrator.getThreadProjection(targetThreadId);
    assert.lengthOf(started.contextHandoffs, 1);
    assert.include(started.contextHandoffs[0]!.summaryText, "Fridge Roulette");
    assert.include(started.contextHandoffs[0]!.summaryText, "Use a fork.");
    assert.notInclude(started.contextHandoffs[0]!.summaryText, "LATER_CONTEXT_MUST_NOT_LEAK");
    const invalid = yield* orchestrator
      .dispatch({
        ...command,
        commandId: CommandId.make("invalid-imported-citation"),
        targetThreadId: ThreadId.make("invalid-child"),
        sourcePoint: { type: "imported_message", messageId: MessageId.make("later-question") },
      })
      .pipe(Effect.flip);
    assert.equal(invalid._tag, "OrchestratorDispatchError");
    assert.isNull(yield* orchestrator.getThreadShell(ThreadId.make("invalid-child")));
  }).pipe(
    Effect.provide(Legacy.layer),
    Effect.provide(Layer.mergeAll(layer, SqlitePersistence.layerMemory)),
  ),
);
