// capture-core ships a side-effecting IIFE bundle with no type declarations; importing it for
// its side effects (injects the capture button, exposes window.__designbridge_capture, dispatches
// the "designbridge:capture" event) needs only module resolution, not types.
declare module "@designbridge/capture-core";
