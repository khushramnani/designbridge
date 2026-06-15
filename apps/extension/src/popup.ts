// DesignBridge popup: stores relay URL + API key in chrome.storage.local, claims a pairing code,
// and tests connectivity. Extension pages with host_permissions can fetch the relay cross-origin,
// so no CORS handling is needed here.
const DEFAULT_BASE_URL = "http://localhost:8080";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const baseUrlInput = $<HTMLInputElement>("baseUrl");
const apiKeyInput = $<HTMLInputElement>("apiKey");
const codeInput = $<HTMLInputElement>("code");
const statusEl = $("status");

void (async function init() {
  const stored = await chrome.storage.local.get(["baseUrl", "apiKey"]);
  baseUrlInput.value = (stored.baseUrl as string) || DEFAULT_BASE_URL;
  apiKeyInput.value = (stored.apiKey as string) || "";
})();

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function baseUrl(): string {
  return (baseUrlInput.value.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function saveConfig(): Promise<void> {
  await chrome.storage.local.set({ baseUrl: baseUrl(), apiKey: apiKeyInput.value.trim() });
}

$("save").addEventListener("click", async () => {
  await saveConfig();
  setStatus("Saved ✓", "ok");
});

$("pair").addEventListener("click", async () => {
  await saveConfig();
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return setStatus("Enter the 6-character code shown in the Figma plugin.", "err");
  if (!apiKeyInput.value.trim()) return setStatus("Add your API key first.", "err");
  setStatus("Pairing…");
  try {
    const res = await fetch(`${baseUrl()}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKeyInput.value.trim()}` },
      body: JSON.stringify({ code }),
    });
    const json = await res.json();
    if (!res.ok) return setStatus(`Pairing failed: ${json.error?.code ?? res.status}`, "err");
    setStatus("Paired with Figma ✓ — you're ready to send designs.", "ok");
  } catch (err) {
    setStatus(`Could not reach the relay: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
});

$("test").addEventListener("click", async () => {
  await saveConfig();
  setStatus("Testing…");
  try {
    const res = await fetch(`${baseUrl()}/v1/channels`, {
      headers: { authorization: `Bearer ${apiKeyInput.value.trim()}` },
    });
    const json = await res.json();
    if (!res.ok) return setStatus(`Relay says: ${json.error?.code ?? res.status}`, "err");
    const online = (json.channels ?? []).filter((c: { online: boolean }) => c.online).length;
    const total = (json.channels ?? []).length;
    setStatus(`Connected ✓ — ${total} paired channel(s), ${online} online.`, "ok");
  } catch (err) {
    setStatus(`Could not reach the relay: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
});
