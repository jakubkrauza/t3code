import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { sameSidechatCitation, type SidechatAnchor } from "~/lib/sidechats";
import { environmentThreadShells } from "./threads";

// Only starting/stopping work changes the marks; streaming tokens and titles do not.
const sidechatAnchorsAtom = Atom.family((key: string) => {
  const parent = parseScopedThreadKey(key)!;
  let previous: ReadonlyArray<SidechatAnchor> = [];
  return Atom.make((get) => {
    const next = get(environmentThreadShells.environmentThreadsAtom(parent.environmentId))
      .filter(
        (thread) =>
          thread.deletedAt === null && thread.sidechatSource?.parentThreadId === parent.threadId,
      )
      .map((thread) => ({
        threadId: thread.id,
        citation: thread.sidechatSource!.citation,
        working:
          thread.status === "preparing" ||
          thread.status === "starting" ||
          thread.status === "running",
      }));
    if (
      next.length === previous.length &&
      next.every(
        (anchor, index) =>
          anchor.threadId === previous[index]!.threadId &&
          anchor.working === previous[index]!.working &&
          sameSidechatCitation(anchor.citation, previous[index]!.citation),
      )
    )
      return previous;
    previous = next;
    return next;
  });
});

export function useThreadSidechats(parent: ScopedThreadRef): ReadonlyArray<SidechatAnchor> {
  return useAtomValue(sidechatAnchorsAtom(scopedThreadKey(parent)));
}
