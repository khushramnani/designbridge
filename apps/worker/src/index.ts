export {
  translateJob,
  makeTranslateHandler,
  externalizeAssets,
  loadCaptureBundle,
  type TranslateJob,
  type TranslatorOptions,
  type WorkerStore,
  type WorkerStorage,
  type WorkerQueue,
} from "./translate.js";
export { assertSafeUrl, isBlockedIp, BlockedUrlError, type DnsLookup } from "./ssrf.js";

export const workerAppName = "designbridge-worker";

async function main(): Promise<void> {
  // Standalone worker needs the pg-boss queue + a Supabase Storage client (Phase 2 infra, pending).
  // Until then the worker runs in-process with the relay (see the dev wiring / integration tests).
  console.error(
    "designbridge-worker: standalone mode requires pg-boss + Supabase Storage (not yet wired). " +
      "Run the in-process dev wiring instead.",
  );
  process.exit(1);
}

const invokedDirectly = process.argv[1]?.endsWith("index.js");
if (invokedDirectly) void main();
