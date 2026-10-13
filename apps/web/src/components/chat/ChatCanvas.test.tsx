// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ChatCanvas } from "./ChatCanvas";
import { useChatCanvas } from "./ChatCanvasContext";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";

const resize = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock("../../lib/observeResize", () => ({
  observeResize: (_elements: unknown, callback: () => void) => {
    resize.callbacks.add(callback);
    return () => resize.callbacks.delete(callback);
  },
}));

let root: Root;
let container: HTMLDivElement;
let fontSize = 16;
let width = 1800;
let canvas: ReturnType<typeof useChatCanvas>;

function Preview({ x }: { x: number }) {
  const current = useChatCanvas();
  useLayoutEffect(() => {
    canvas = current;
  }, [current]);
  const reportPreview = current?.reportPreview;
  useLayoutEffect(() => {
    reportPreview?.({
      key: "browser:one",
      width: 240,
      source: { width: 240, height: 365 },
      position: { x, y: 12 },
      lastInteraction: "drag",
    });
  }, [reportPreview, x]);
  return null;
}

function DetailsCard() {
  const current = useChatCanvas()!;
  const placement = resolveThreadDetailsCardLayout({
    container: current.container,
    lane: current.lane,
    frame: null,
  });
  const left = placement?.x;
  const right = placement ? placement.x + placement.width : undefined;
  const reportDetailsCard = current.reportDetailsCard;
  useLayoutEffect(() => {
    reportDetailsCard(
      left !== undefined && right !== undefined ? { left, right, bottom: 250 } : null,
    );
  }, [reportDetailsCard, left, right]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fontSize = 16;
  width = 1800;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    // A nonzero canvas origin catches viewport coordinates used as canvas coordinates.
    if (this.hasAttribute("data-thread-find-bar")) {
      const gap = 0.75 * fontSize;
      return new DOMRect(
        200 + 1800 - gap - 17.5 * fontSize,
        100 + gap,
        17.5 * fontSize,
        2.25 * fontSize,
      );
    }
    return new DOMRect(200, 100, 1800, 1000);
  });
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    paddingLeft: "48px",
    width: "736px",
    minWidth: "640px",
  } as CSSStyleDeclaration);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  resize.callbacks.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderFind(open: boolean, previewX = 1548) {
  await act(() =>
    root.render(
      <ChatCanvas composerOverlayElement={null} detailsCardTopInset={open ? 48 : 0}>
        {open ? <div data-thread-find-bar /> : null}
        <Preview x={previewX} />
      </ChatCanvas>,
    ),
  );
}

it.each([16, 24])(
  "keeps a preview below Find and releases its space on close at a %spx root font",
  async (size) => {
    fontSize = size;
    await renderFind(false);
    expect(canvas?.layout.frame?.y).toBe(12);

    await renderFind(true);
    expect(canvas?.detailsCardTopInset).toBe(3 * size);
    expect(canvas?.layout.frame?.y).toBe(3 * size + 12);

    await renderFind(false);
    expect(canvas?.detailsCardTopInset).toBe(0);
    expect(canvas?.layout.frame?.y).toBe(12);

    await renderFind(true);
    expect(canvas?.layout.frame?.y).toBe(3 * size + 12);
  },
);

it("remeasures the open bar when its font size changes without resizing the canvas", async () => {
  await renderFind(true, 1200);
  expect(canvas?.layout.frame?.y).toBe(12);

  fontSize = 24;
  await act(() => {
    for (const callback of resize.callbacks) callback();
  });
  expect(canvas?.detailsCardTopInset).toBe(72);
  expect(canvas?.layout.frame?.y).toBe(84);
});

async function renderDetailsCard(revision = 0) {
  await act(() =>
    root.render(
      <ChatCanvas composerOverlayElement={null} layoutKey={revision}>
        <DetailsCard />
      </ChatCanvas>,
    ),
  );
}

function laneInset() {
  return container
    .querySelector<HTMLElement>("[data-chat-canvas]")!
    .style.getPropertyValue("--chat-lane-inset-end");
}

it("removes the workspace card inset during the parent commit that opens a narrow side panel", async () => {
  width = 1280;
  await renderDetailsCard();
  expect(Number.parseFloat(laneInset())).toBeGreaterThan(0);
  width = 600;
  await renderDetailsCard(1);
  // No resize delivery yet: the first paint must already use the new lane.
  expect(laneInset()).toBe("0px");
  width = 1280;
  await renderDetailsCard(2);
  expect(Number.parseFloat(laneInset())).toBeGreaterThan(0);
});

it("does not remeasure unchanged geometry when message content renders again", async () => {
  await renderDetailsCard();
  const measure = vi.mocked(window.getComputedStyle);
  measure.mockClear();
  await renderDetailsCard();
  expect(measure).not.toHaveBeenCalled();
});
