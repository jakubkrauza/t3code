import { flushSync } from "react-dom";

let activeTransition: ViewTransition | null = null;

/** Crossfade chat layouts instead of animating text reflow. */
export function runSidechatTransition(update: () => void): void {
  if (
    typeof document === "undefined" ||
    !document.startViewTransition ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }

  activeTransition?.skipTransition();
  const root = document.documentElement;
  const main = document.querySelector<HTMLElement>("[data-sidechat-main]");
  const previousWidth = main?.clientWidth;
  root.dataset.sidechatTransition = "true";
  let updated = false;
  const applyUpdate = () => {
    if (updated) return;
    updated = true;
    flushSync(update);
    root.dataset.sidechatResizing = String(main?.clientWidth !== previousWidth);
  };
  try {
    const transition = document.startViewTransition(applyUpdate);
    activeTransition = transition;
    void transition.ready.catch(() => {
      transition.skipTransition();
      applyUpdate();
    });
    void transition.finished.catch(applyUpdate).finally(() => {
      if (activeTransition !== transition) return;
      activeTransition = null;
      delete root.dataset.sidechatTransition;
      delete root.dataset.sidechatResizing;
    });
  } catch {
    delete root.dataset.sidechatTransition;
    applyUpdate();
    delete root.dataset.sidechatResizing;
  }
}
