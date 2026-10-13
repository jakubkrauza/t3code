import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { runSidechatTransition } from "./sidechatTransition";

let dataset: Record<string, string>;
let updateSnapshot: () => void;
let finish: () => void;
let rejectReady: (reason: Error) => void;
let finished: Promise<void>;
let skip: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dataset = {};
  finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ready = new Promise<void>((_resolve, reject) => {
    rejectReady = reject;
  });
  skip = vi.fn();
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", {
    documentElement: { dataset },
    querySelector: () => null,
    startViewTransition: (update: () => void) => {
      updateSnapshot = update;
      return { ready, finished, skipTransition: skip };
    },
  });
});

afterEach(async () => {
  finish();
  await finished;
  // Allow the transition's cleanup chain to finish before restoring globals.
  await Promise.resolve();
  await Promise.resolve();
  vi.unstubAllGlobals();
});

it("updates once between snapshots and removes the animation scope when finished", async () => {
  let open = false;
  runSidechatTransition(() => {
    open = true;
  });
  expect(open).toBe(false);
  expect(dataset.sidechatTransition).toBe("true");
  updateSnapshot();
  expect(open).toBe(true);
  finish();
  await finished;
  await Promise.resolve();
  await Promise.resolve();
  expect(dataset.sidechatTransition).toBeUndefined();
});

it("still opens the panel if snapshot capture fails, without repeating a late update", async () => {
  let updates = 0;
  runSidechatTransition(() => {
    updates += 1;
  });
  rejectReady(new Error("Snapshot unavailable"));
  await Promise.resolve();
  expect(updates).toBe(1);
  expect(skip).toHaveBeenCalledOnce();
  updateSnapshot();
  expect(updates).toBe(1);
});

it("updates immediately when reduced motion is enabled", () => {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  let open = false;
  runSidechatTransition(() => {
    open = true;
  });
  expect(open).toBe(true);
  expect(dataset.sidechatTransition).toBeUndefined();
});

it("updates immediately when view transitions are unavailable", () => {
  vi.stubGlobal("document", { documentElement: { dataset } });
  let open = false;
  runSidechatTransition(() => {
    open = true;
  });
  expect(open).toBe(true);
  expect(dataset.sidechatTransition).toBeUndefined();
});
