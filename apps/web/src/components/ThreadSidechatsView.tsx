import type { AssistantCitation, RunId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { MessageSquareIcon, QuoteIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

import ChatView from "./ChatView";
import { Button } from "./ui/button";
import { newThreadId } from "~/lib/utils";
import { sameSidechatCitation } from "~/lib/sidechats";
import { readThreadShell, waitForThreadShell } from "~/state/entities";
import { useComposerDraftStore } from "~/composerDraftStore";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useThreadSidechats } from "~/state/sidechats";
import { PreviewPanelShell } from "./preview/PreviewPanelShell";
import { usePreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { PanelTabCloseButton } from "./ui/panel-tab-close-button";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";

const MainChatView = memo(ChatView);

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
        throw new Error(
          "The sidechat was saved, but the connection is still catching up. Try again.",
        );
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
          setError(cause instanceof Error ? cause.message : "Could not open the sidechat.");
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
            Try again
          </Button>
        </>
      ) : (
        <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="sm" />
          Opening sidechat…
        </div>
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
  const [panel, setPanel] = useState<{
    parentKey: string;
    selection: SidechatSelection;
    open: boolean;
  } | null>(null);
  const [activePane, setActivePane] = useState<"main" | "side">("main");
  const selection = panel?.parentKey === parentKey ? panel.selection : null;
  const panelOpen = panel?.parentKey === parentKey && panel.open;
  const panelRef = useRef<HTMLElement | null>(null);
  const inlineSize = usePreviewPanelInlineSize(panelRef, {
    enabled: panelOpen,
    widthStorageKey: "t3code:sidechat-panel-width",
  });
  const sidechats = useThreadSidechats(parentRef);

  const openSidechat = useCallback(
    (threadId: ThreadId) => {
      const thread = readThreadShell(scopeThreadRef(parentRef.environmentId, threadId));
      if (
        thread?.sidechatSource?.parentThreadId !== parentRef.threadId ||
        thread.forkedFrom?.type !== "run"
      )
        return;
      setPanel({
        parentKey,
        open: true,
        selection: {
          citation: thread.sidechatSource.citation,
          runId: thread.forkedFrom.runId,
          threadId,
          created: true,
        },
      });
      setActivePane("side");
    },
    [parentKey, parentRef],
  );

  const closeSidechat = useCallback(() => {
    setPanel((current) => (current ? { ...current, open: false } : current));
    setActivePane("main");
  }, []);
  const markCreated = useCallback((threadId: ThreadId) => {
    setPanel((current) =>
      current?.selection.threadId === threadId
        ? { ...current, selection: { ...current.selection, created: true } }
        : current,
    );
  }, []);

  const ask = useCallback(
    (citation: AssistantCitation, runId: RunId) => {
      const existing = sidechats.find((sidechat) =>
        sameSidechatCitation(sidechat.citation, citation),
      );
      if (existing) {
        openSidechat(existing.threadId);
        return;
      }
      const threadId = newThreadId();
      setPanel((current) =>
        current?.parentKey === parentKey &&
        sameSidechatCitation(current.selection.citation, citation)
          ? { ...current, open: true }
          : { parentKey, open: true, selection: { citation, runId, threadId, created: false } },
      );
      setActivePane("side");
    },
    [sidechats, openSidechat, parentKey],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        onPointerDownCapture={(event) => {
          if (!(event.target as Element).closest("[data-sidechat-hovered]")) setActivePane("main");
        }}
        onFocusCapture={() => setActivePane("main")}
      >
        <MainChatView
          {...props}
          keyboardActive={!panelOpen || activePane === "main"}
          onAskAssistantText={ask}
          sidechats={sidechats}
          onOpenSidechat={openSidechat}
        />
      </div>
      {selection ? (
        <aside
          ref={panelRef}
          aria-label="Sidechat"
          aria-hidden={!panelOpen}
          inert={!panelOpen}
          className={cn(
            "absolute inset-0 z-30 min-h-0 min-w-0 md:static md:shrink-0",
            !panelOpen && "pointer-events-none invisible",
          )}
          onPointerDownCapture={() => setActivePane("side")}
          onFocusCapture={() => setActivePane("side")}
        >
          <PreviewPanelShell mode="inline" open={panelOpen} inlineSize={inlineSize}>
            <header
              className={cn(
                "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pr-28 pl-2",
                isElectron && "drag-region wco:pr-(--workspace-native-controls-inset)",
              )}
            >
              <div className="group/tab flex h-6 items-center gap-1.5 rounded-md bg-accent pr-2 pl-1.5 text-xs text-foreground [-webkit-app-region:no-drag]">
                <PanelTabCloseButton
                  label="Close sidechat"
                  tooltip="Close sidechat"
                  onClick={closeSidechat}
                >
                  <MessageSquareIcon className="size-3" />
                </PanelTabCloseButton>
                <span>Sidechat</span>
              </div>
            </header>
            <div className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
              <QuoteIcon className="mt-0.5 size-3.5 shrink-0" />
              <Tooltip>
                <TooltipTrigger
                  render={<span className="line-clamp-3 text-left whitespace-pre-wrap" />}
                >
                  {selection.citation.text}
                </TooltipTrigger>
                <TooltipPopup className="max-w-sm whitespace-pre-wrap">
                  {selection.citation.text}
                </TooltipPopup>
              </Tooltip>
            </div>
            <SidechatPanel
              key={`${parentKey}:${selection.threadId}`}
              parentRef={parentRef}
              selection={selection}
              keyboardActive={panelOpen && activePane === "side"}
              onCreated={markCreated}
            />
          </PreviewPanelShell>
        </aside>
      ) : null}
    </div>
  );
}
