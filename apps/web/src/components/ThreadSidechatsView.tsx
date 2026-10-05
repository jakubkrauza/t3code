import type { AssistantCitation, RunId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

import ChatView from "./ChatView";
import { Button } from "./ui/button";
import { newThreadId } from "~/lib/utils";
import { sameSidechatCitation } from "~/lib/sidechats";
import { useThreadShells, waitForThreadShell } from "~/state/entities";
import { useComposerDraftStore } from "~/composerDraftStore";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

type SidechatSelection = {
  citation: AssistantCitation;
  runId: RunId;
  threadId: ThreadId;
  created: boolean;
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
  const [ready, setReady] = useState(selection.created);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Reuse the in-flight operation in Strict Mode and the command ID on retry.
  const operation = useRef<{ attempt: number; promise: Promise<void> } | null>(null);

  useEffect(() => {
    if (ready) return;
    let active = true;
    async function createSidechat() {
      const forked = await fork({
        environmentId: parentRef.environmentId,
        input: {
          commandId: CommandId.make(`sidechat:${selection.threadId}:fork`),
          sourceThreadId: parentRef.threadId,
          targetThreadId: selection.threadId,
          runId: selection.runId,
          title: `Sidechat: ${selection.citation.text.replace(/\s+/g, " ").slice(0, 80)}`,
          sidechatSource: { parentThreadId: parentRef.threadId, citation: selection.citation },
        },
      });
      if (forked._tag === "Failure") throw squashAtomCommandFailure(forked);
      const ref = scopeThreadRef(parentRef.environmentId, selection.threadId);
      if (!(await waitForThreadShell(ref))) {
        throw new Error("Sidechat został zapisany, ale czekamy na połączenie. Spróbuj ponownie.");
      }
      const drafts = useComposerDraftStore.getState();
      if (!drafts.getComposerDraft(ref)?.prompt) {
        drafts.setPrompt(ref, `${serializeAssistantCitation(selection.citation)}\n\n`);
      }
    }
    if (operation.current?.attempt !== attempt) {
      operation.current = { attempt, promise: createSidechat() };
    }
    void operation.current.promise.then(
      () => {
        if (!active) return;
        setReady(true);
        onCreated(selection.threadId);
      },
      (cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Nie udało się otworzyć sidechatu.");
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, fork, onCreated, parentRef, ready, selection]);

  if (ready) {
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
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
      {error ? (
        <>
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            onClick={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            Spróbuj ponownie
          </Button>
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Otwieranie sidechatu…
        </p>
      )}
    </div>
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
        created: true,
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
    if (selection && sameSidechatCitation(selection.citation, citation)) {
      setActivePane("side");
      return;
    }
    setPanel({
      parentKey,
      selection: { citation, runId, threadId: newThreadId(), created: false },
    });
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
          <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b pr-3 pl-12 md:pl-3 [-webkit-app-region:no-drag]">
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
            <span className="text-sm font-medium">Sidechat</span>
          </header>
          <blockquote className="max-h-32 shrink-0 overflow-auto border-b bg-muted/30 px-4 py-3 text-sm whitespace-pre-wrap">
            {selection.citation.text}
          </blockquote>
          <SidechatPanel
            key={`${parentKey}:${selection.threadId}`}
            parentRef={parentRef}
            selection={selection}
            keyboardActive={activePane === "side"}
            onCreated={(threadId) =>
              setPanel((current) =>
                current?.parentKey === parentKey && current.selection === selection
                  ? { parentKey, selection: { ...selection, threadId, created: true } }
                  : current,
              )
            }
          />
        </aside>
      ) : null}
    </div>
  );
}
