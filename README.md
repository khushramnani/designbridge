# DesignBridge

One-click import of AI-generated designs (Claude Design first) into editable Figma layers.

**Status:** Phase 1 walking skeleton. The full pipe works end to end: capture in the browser → paste into Figma → layers rebuilt on canvas. No backend yet (transfer is via clipboard). Auto Layout, design tokens (Variables), Components, and real image embedding come in Phase 2.

```
extension/      Chrome MV3 extension — captures the rendered design as JSON
figma-plugin/   Figma plugin — rebuilds the JSON into frames/text on canvas
```

## How it works (architecture)

The Claude Design preview renders inside a cross-origin iframe on `*.claudeusercontent.com`. Code on `claude.ai` can't read it, so the content script is injected directly into that iframe (`all_frames: true`). It walks the **rendered** DOM and reads `getComputedStyle` for every element — this is the only reliable source of styling, because Claude Design keeps CSS in separate files the raw HTML only references. The capture becomes JSON; the Figma plugin maps that JSON to Figma nodes.

```
Claude Design preview (iframe, *.claudeusercontent.com)
   └─ content.js  →  capture DOM + computed styles  →  JSON  →  clipboard
                                                                  │
Figma plugin  ←  paste JSON  ←──────────────────────────────────┘
   └─ code.js  →  build frames / text / fills / radius / svg  →  canvas
```

## Run it locally

### Prerequisites
- Google Chrome
- Figma **desktop app** (plugin dev mode needs the desktop app, not the browser version)
- Node.js (only for the optional syntax checks / Phase 2 backend)

### 1. Load the Chrome extension
1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right) ON
3. Click **Load unpacked** → select the `extension/` folder
4. Open a design in Claude Design. A **“⬡ Send to Figma”** button appears at the bottom-right of the preview.
5. Click it → a panel shows the capture JSON and copies it to your clipboard.

> The button only appears on `*.claudeusercontent.com` frames (the design preview itself). If you don't see it, reload the Claude Design page after loading the extension.

### 2. Load the Figma plugin
1. In the Figma **desktop app**: menu → **Plugins → Development → Import plugin from manifest…**
2. Select `figma-plugin/manifest.json`
3. Run it: **Plugins → Development → DesignBridge — Import (dev)**
4. Paste the JSON from step 1 into the textarea → **Import to canvas**

The design appears as a hierarchy of frames with background colors, corner radii, borders, and text.

## Known limits in this skeleton (intentional — Phase 2 work)
- **Absolute positioning**, not Auto Layout yet (visually correct, not yet "responsive-editable").
- **Fonts** fall back to Inter (Regular/Bold). Real font matching is Phase 2.
- **Images** render as gray placeholders (embedding real bytes needs the backend + extension asset download).
- **Gradients / shadows / filters** not mapped yet.
- Transfer is **clipboard**, not the sync backend.

## Roadmap
- **Phase 2:** flexbox → Auto Layout, font matching, image embedding (backend + asset capture), gradients/shadows, color Variables, Component detection.
- **Phase 3:** accounts + paywall, polished in-app “Send to Figma” button, landing page.
- **Phase 4:** Figma Community + Chrome Web Store launch; add Stitch / v0 / Lovable capture adapters.

See the planning docs in the parent folder for the full plan, recon, and market analysis.

## Note
Reads only the design the signed-in user is currently viewing. Review against Anthropic's Terms of Service before any public launch.
