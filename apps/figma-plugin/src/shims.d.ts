// figma-builder ships a side-effecting IIFE bundle (calls figma.showUI and registers the "import"
// message handler) with no type declarations. We import it for side effects, then wrap the handler.
declare module "@designbridge/figma-builder";
