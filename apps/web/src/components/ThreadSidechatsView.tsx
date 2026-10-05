import type { AssistantCitation, RunId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { XIcon } from "lucide-react";
import { useMemo, useRef, useState, type ComponentProps } from "react";

import ChatView from "./ChatView";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { newMessageId, newThreadId } from "~/lib/utils";
import { sameSidechatCitation } from "~/lib/sidechats";
import { readThreadShell, useThreadShells, waitForThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

type SidechatSelection = {
  citation: AssistantCitation;
  runId: RunId;
  threadId: ThreadId | null;
};

function SidechatPanel({
  parentRef,
  selection,
  keyboardActive,
  onCreated,
}: {
  parentRef: ScopedThreadRef;
  selection: SidechatSelection;
  keyboardActive: boolean;
  onCreated: (threadId: ThreadId) => void;
}) {
  const fork = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the same IDs on retry, including when a response is lost after a commit.
  const [ids] = useState(() => {
    const threadId = newThreadId();
    return {
      threadId,
      forkCommandId: CommandId.make(`sidechat:${threadId}:fork`),
      sendCommandId: CommandId.make(`sidechat:${threadId}:send`),
      messageId: newMessageId(),
    };
  });
  const sending = useRef(false);
  const [firstQuestion, setFirstQuestion] = useState<string | null>(null);

  async function send() {
    if (sending.current || !question.trim()) return;
    const parent = readThreadShell(parentRef);
    if (!parent) {
      setError("Główna rozmowa jest niedostępna. Połącz się ponownie.");
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    const submittedQuestion = firstQuestion ?? question.trim();
    setFirstQuestion(submittedQuestion);
    try {
      const forked = await fork({
        environmentId: parentRef.environmentId,
        input: {
          commandId: ids.forkCommandId,
          sourceThreadId: parentRef.threadId,
          targetThreadId: ids.threadId,
          runId: selection.runId,
          title: `Sidechat: ${selection.citation.text.replace(/\s+/g, " ").slice(0, 80)}`,
          sidechatSource: { parentThreadId: parentRef.threadId, citation: selection.citation },
        },
      });
      if (forked._tag === "Failure") throw squashAtomCommandFailure(forked);
      const ref = scopeThreadRef(parentRef.environmentId, ids.threadId);
      if (!(await waitForThreadShell(ref))) {
        throw new Error("Sidechat został zapisany, ale czekamy na połączenie. Spróbuj ponownie.");
      }
      const started = await startTurn({
        environmentId: parentRef.environmentId,
        input: {
          commandId: ids.sendCommandId,
          threadId: ids.threadId,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          message: {
            messageId: ids.messageId,
            role: "user",
            text: `Pytanie o fragment wcześniejszej odpowiedzi:\n\n${selection.citation.text}\n\n${submittedQuestion}`,
            attachments: [],
          },
        },
      });
      if (started._tag === "Failure") throw squashAtomCommandFailure(started);
      onCreated(ids.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się wysłać pytania.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  if (selection.threadId !== null) {
    return (
      <ChatView
        environmentId={parentRef.environmentId}
        threadId={selection.threadId}
        routeKind="server"
        embedded
        keyboardActive={keyboardActive}
        reserveTitleBarControlInset={false}
      />
    );
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Osobna rozmowa z kontekstem do zaznaczonej odpowiedzi.
      </p>
      <div className="mt-auto">
        <Textarea
          aria-label="Pytanie w sidechacie"
          placeholder="O co chcesz dopytać?"
          value={question}
          disabled={busy || firstQuestion !== null}
          autoFocus
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || !question.trim()}>
          {busy ? "Otwieranie…" : error ? "Spróbuj ponownie" : "Wyślij"}
        </Button>
      </div>
    </form>
  );
}

export function ThreadSidechatsView(props: ComponentProps<typeof ChatView>) {
  const parentRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const parentKey = scopedThreadKey(parentRef);
  const [panel, setPanel] = useState<{ parentKey: string; selection: SidechatSelection } | null>(
    null,
  );
  const [activePane, setActivePane] = useState<"main" | "side">("main");
  const selection = panel?.parentKey === parentKey ? panel.selection : null;
  const threads = useThreadShells();
  const sidechatThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.environmentId === parentRef.environmentId &&
          thread.sidechatSource?.parentThreadId === parentRef.threadId &&
          thread.deletedAt === null,
      ),
    [threads, parentRef],
  );
  const sidechats = useMemo(
    () =>
      sidechatThreads.map((thread) => ({
        threadId: thread.id,
        citation: thread.sidechatSource!.citation,
      })),
    [sidechatThreads],
  );

  function openSidechat(threadId: ThreadId) {
    const thread = sidechatThreads.find((candidate) => candidate.id === threadId);
    if (!thread?.sidechatSource || thread.forkedFrom?.type !== "run") return;
    setPanel({
      parentKey,
      selection: {
        citation: thread.sidechatSource.citation,
        runId: thread.forkedFrom.runId,
        threadId,
      },
    });
    setActivePane("side");
  }

  function ask(citation: AssistantCitation, runId: RunId) {
    const existing = sidechats.find((sidechat) =>
      sameSidechatCitation(sidechat.citation, citation),
    );
    if (existing) {
      openSidechat(existing.threadId);
      return;
    }
    setPanel({ parentKey, selection: { citation, runId, threadId: null } });
    setActivePane("side");
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        onPointerDownCapture={() => setActivePane("main")}
        onFocusCapture={() => setActivePane("main")}
      >
        <ChatView
          {...props}
          keyboardActive={selection === null || activePane === "main"}
          onAskAssistantText={ask}
          sidechats={sidechats}
          onOpenSidechat={openSidechat}
        />
      </div>
      {selection ? (
        <aside
          aria-label="Sidechat"
          className="absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col border-l bg-background md:static md:w-[44%] md:min-w-96 md:max-w-2xl"
          onPointerDownCapture={() => setActivePane("side")}
          onFocusCapture={() => setActivePane("side")}
        >
          <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 [-webkit-app-region:no-drag]">
            <span className="text-sm font-medium">Sidechat</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Zamknij sidechat"
              onClick={() => {
                setPanel(null);
                setActivePane("main");
              }}
            >
              <XIcon className="size-4" />
            </Button>
          </header>
          <blockquote className="max-h-32 shrink-0 overflow-auto border-b bg-muted/30 px-4 py-3 text-sm whitespace-pre-wrap">
            {selection.citation.text}
          </blockquote>
          <SidechatPanel
            key={`${parentKey}:${selection.threadId ?? `${selection.citation.messageId}:${selection.citation.start}:${selection.citation.end}`}`}
            parentRef={parentRef}
            selection={selection}
            keyboardActive={activePane === "side"}
            onCreated={(threadId) =>
              setPanel((current) =>
                current?.parentKey === parentKey && current.selection === selection
                  ? { parentKey, selection: { ...selection, threadId } }
                  : current,
              )
            }
          />
        </aside>
      ) : null}
    </div>
  );
}
