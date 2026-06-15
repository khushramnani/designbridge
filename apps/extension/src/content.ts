// DesignBridge content script.
// Pulls in the capture-core engine (injects the "⬡ Send to Figma" button, clipboard fallback,
// and dispatches a "designbridge:capture" DOM event after each capture), then bridges that event
// to the background service worker, which submits the capture to the relay.
import "@designbridge/capture-core";

interface SubmitResult {
  ok: boolean;
  status?: string;
  renderId?: string;
  reason?: string;
  message?: string;
}

window.addEventListener("designbridge:capture", (event) => {
  const native = (event as CustomEvent).detail;
  chrome.runtime.sendMessage({ type: "db_submit", native }, (res: SubmitResult | undefined) => {
    if (chrome.runtime.lastError || !res) {
      toast("Copied to clipboard — relay unreachable. Paste into the Figma plugin.", "warn");
      return;
    }
    if (!res.ok) {
      if (res.reason === "not_configured") {
        toast("Copied to clipboard. Add your API key in the DesignBridge popup to send live.", "warn");
      } else {
        toast(`Relay error (${res.message ?? "unknown"}). Clipboard fallback ready.`, "warn");
      }
      return;
    }
    toast("Sent to Figma ✓ — building on your canvas…", "ok");
  });
});

let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;
function toast(text: string, kind: "ok" | "warn"): void {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.cssText =
      "position:fixed;z-index:2147483647;bottom:78px;right:20px;max-width:320px;padding:11px 14px;" +
      "border-radius:10px;font:600 13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35)";
    document.documentElement.appendChild(toastEl);
  }
  toastEl.style.background = kind === "ok" ? "#0d7a3a" : "#8a5a00";
  toastEl.textContent = text;
  toastEl.style.opacity = "1";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (toastEl) toastEl.style.opacity = "0";
  }, 5000);
}
