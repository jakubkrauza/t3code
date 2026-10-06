// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ChatCanvas } from "./ChatCanvas";
import { useChatCanvas } from "./ChatCanvasContext";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";

let root: Root;
let host: HTMLDivElement;
let width: number;
let notifyResize: () => void;

function DetailsCard() {
  const canvas = useChatCanvas()!;
  const placement = resolveThreadDetailsCardLayout({
    container: canvas.container,
    lane: canvas.lane,
    frame: null,
  });
  const left = placement?.x;
  const right = placement ? placement.x + placement.width : undefined;
  const reportDetailsCard = canvas.reportDetailsCard;
  useLayoutEffect(() => {
    reportDetailsCard(
      left !== undefined && right !== undefined ? { left, right, bottom: 250 } : null,
    );
  }, [reportDetailsCard, left, right]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  width = 1280;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
  vi.stubGlobal("getComputedStyle", () => {
    const styles = document.createElement("div").style;
    styles.paddingLeft = "20px";
    styles.width = "768px";
    styles.minWidth = "640px";
    return styles;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notifyResize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(revision = 0) {
  await act(async () => {
    root.render(
      <ChatCanvas composerOverlayElement={null} layoutKey={revision}>
        <DetailsCard />
      </ChatCanvas>,
    );
  });
}

function laneInset() {
  return host
    .querySelector<HTMLElement>("[data-chat-canvas]")!
    .style.getPropertyValue("--chat-lane-inset-end");
}

it("removes the workspace card inset during the parent commit that opens a narrow side panel", async () => {
  await render();
  expect(Number.parseFloat(laneInset())).toBeGreaterThan(0);
  width = 600;
  await render(1);
  // No ResizeObserver delivery yet: the first paint must already use the new lane.
  expect(laneInset()).toBe("0px");
  width = 1280;
  await render(2);
  expect(Number.parseFloat(laneInset())).toBeGreaterThan(0);
});

it("commits an external resize before the observer returns, without waiting for another frame", async () => {
  await render();
  width = 600;
  act(() => {
    notifyResize();
    // Check inside act, before its usual end-of-batch flush.
    expect(laneInset()).toBe("0px");
  });
  width = 1280;
  act(() => {
    notifyResize();
    expect(Number.parseFloat(laneInset())).toBeGreaterThan(0);
  });
});

it("does not remeasure unchanged geometry when message content renders again", async () => {
  await render();
  const measure = vi.spyOn(globalThis, "getComputedStyle");
  measure.mockClear();
  await render();
  expect(measure).not.toHaveBeenCalled();
});
