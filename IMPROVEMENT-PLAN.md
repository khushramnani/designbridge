# DesignBridge — Improvement Plan (toward exact 1:1 fidelity)

Goal: the design a user builds in Claude Design appears in Figma **exactly** as rendered in the browser — and stays editable.

North-star metric: **pixel-diff score** between the browser screenshot and a Figma export of the imported frame (see Tier 4). Every change below should move that score.

---

## Tier 1 — Fidelity bugs in the current code (fix first, days)

These are concrete bugs found in the audit. Each one visibly breaks real designs today.

1. **Percentage border-radius breaks circles.** `px("50%")` → `50` px. Avatars/dots defined with `border-radius: 50%` come in wrong. Fix: detect `%` and resolve against width/height (`min(w,h)/2` for 50%).
2. **`white-space: pre` text is destroyed.** Capture collapses all whitespace (`replace(/\s+/g," ")`), so code blocks and multi-line text lose newlines/indentation. Fix: capture `cs.whiteSpace`; preserve raw text when `pre|pre-wrap|pre-line`.
3. **Pseudo-elements are invisible.** Claude Design uses `::before/::after` heavily (overlays, decorative gradients, icon bullets, dividers). Fix: read `getComputedStyle(el,"::before"/"::after")`; if `content` ≠ none, synthesize a child node (or flag parent for raster).
4. **Inputs/textareas/selects render empty.** They have no text nodes, so value/placeholder is lost. Fix: capture `el.value || el.placeholder` (with placeholder color) as the node's text.
5. **Only the top border is captured.** Per-side borders (e.g. `border-left` accent bars, divider `border-bottom`) vanish or apply to all sides. Fix: capture all 4 sides; in the plugin use Figma's per-side `strokeTopWeight/...` (or a thin rect fallback for mixed colors). Also capture `borderStyle` — raster or dash-pattern for dashed/dotted.
6. **z-index ignored.** Children are appended in DOM order; designs that rely on z-index stack wrong. Fix: capture `zIndex` + stacking-context info; sort siblings before build.
7. **Italic, text-transform, text-decoration, text-shadow never captured.** Fix: capture `fontStyle`, `textTransform`, `textDecoration*`, `textShadow`; map to Figma `fontName.style` italic variants, `textCase`, `textDecoration`, drop-shadow effect on text.
8. **`line-height: normal` becomes null** → Figma default metrics shift vertical rhythm. Fix: compute the used value (measure or 1.2×fontSize heuristic per UA).
9. **boxShadow with oklch colors** isn't normalized like gradients are. Run `normalizeGradient`-style oklch→rgba replacement on `boxShadow` too.
10. **Gradient transform is wrong in the plugin.** Rotation-only `gradientTransform` doesn't map CSS gradient geometry (CSS angles span the box corner-to-corner, account for aspect ratio, and `to top right` corner keywords aren't handled). Fix: compute the full affine transform (rotation + scale + translation in unit-square space) from angle + node w/h.
11. **`object-fit` / `background-size` ignored.** Images always import as `scaleMode:"FILL"`. Fix: capture `objectFit`/`backgroundSize/Position`; map contain→FIT, fill→STRETCH(crop), cover→FILL.
12. **SVG `<use href="#id">` breaks** when defs live elsewhere in the document; `resolveSvg` only inlines var()/currentColor. Fix: inline referenced `<defs>`/symbols into the serialized SVG; also inline computed `fill`/`stroke`/`stroke-width` per SVG child.

## Tier 2 — Raster path quality (the fidelity safety net must be trustworthy)

The confidence model (native-or-raster) is the right architecture. But today the raster output itself isn't faithful:

1. **Webfonts don't render inside foreignObject rasters.** The SVG image loads in an isolated context — text inside rasterized regions falls back to system fonts. Fix: fetch the page's `@font-face` sources (extension has host access), convert to data-URL `@font-face` rules, embed a `<style>` block in the SVG.
2. **Cross-origin images inside rasterized subtrees fail/taint.** Fix: pre-fetch each `<img>`/`background-image: url()` in the subtree via the extension (host or background-script fetch), swap to data URLs in the clone before serialization.
3. **Size cap (2200px) silently degrades** to a plain frame — the user loses the effect with no warning. Fix: tile-render large regions (render in slices onto one canvas), or at minimum report the degradation in the capture panel and plugin status.
4. **Fixed dpr=2** — use `window.devicePixelRatio` (min 2) so retina captures stay crisp.
5. **Raster more selectively.** `needsRaster` currently rasters the whole subtree for a single offending property. Improvements: handle simple `transform: translate/scale` natively (adjust x/y/w/h); support radial gradients natively (Figma has GRADIENT_RADIAL); support 2-layer stacked gradients (Figma fills are an array — stack them). Less rastered area = more editable layers.

## Tier 3 — Editability without losing exactness

Exact AND editable is the product promise ("editable Figma layers").

1. **Auto Layout v2.** Current flex→AL is opt-in and approximate. Plan: capture `flexWrap`, `flexGrow/Shrink/Basis`, `alignSelf`, `rowGap` vs `columnGap`, margins-as-spacing; map hug/fill sizing (`primaryAxisSizingMode AUTO` when content-sized); support absolutely-positioned children inside AL (`layoutPositioning: "ABSOLUTE"`). Validate per-container: build with AL, compare resulting child rects to captured rects, **fall back to absolute for that container if drift > 1–2px**. That makes AL safe to turn on by default.
2. **CSS Grid → Auto Layout** (rows of columns) using the same validate-or-fallback gate; retire the risky `normalizeGrids` snapping heuristic (it can corrupt healthy layouts).
3. **Design tokens → Figma Variables.** Capture the resolved CSS custom properties per node (`--color-*`, spacing, radius); create Figma Variables and bind fills/radii to them. Huge differentiator for "editable".
4. **Component detection.** Hash repeated subtrees (same structure + styles, differing text); convert to one Component + Instances with text overrides.
5. **Semantic layer names.** Use heading text, `aria-label`, button text, class hints — "Hero / CTA button" instead of `div`.

## Tier 4 — Verification harness (how we know it's "exact")

1. **Golden designs corpus**: 10–20 representative Claude Design outputs (landing page, dashboard, form, pricing table, code-heavy, gradient-heavy) saved as fixtures.
2. **Automated pixel-diff**: Playwright renders the fixture → screenshot A; capture JSON → import via plugin (Figma desktop with a test hook, or replay the builder logic) → export PNG via Figma REST API → screenshot B; diff with pixelmatch. Report % mismatch per fixture.
3. Run on every change; the score is the regression gate. (The `webapp-testing` skill covers the Playwright half.)

## Tier 5 — Transfer pipeline & UX

1. **Clipboard will not survive Phase 2.** Inline raster PNGs + embedded fonts make multi-MB JSON; clipboard and the paste-textarea both choke. Options, in order of effort:
   - a. **Compress**: gzip + base64 (pako in both ends) — buys 3–5×, zero infra.
   - b. **Local relay**: tiny localhost server or the extension's background service worker; Figma plugin `networkAccess: ["http://localhost:PORT"]` polls a pairing code. No cloud, works offline.
   - c. **Cloud relay** (Phase 2 backend per README): extension POSTs capture, plugin fetches by 6-digit code. Needed anyway for accounts/paywall (Phase 3).
   Recommend a → b now, c when accounts land.
2. **Capture panel v2**: show a fidelity report (N layers, N rasterized regions + why, N font substitutions, oversize warnings) instead of raw JSON.
3. **Plugin UX**: live progress (chunk the build with `setTimeout` yields so big imports don't freeze), import summary with warnings, "re-import replaces previous frame" option.
4. **Robustness**: re-show the button if Claude Design re-renders the iframe (MutationObserver); handle multiple artifacts per page; version-check capture JSON vs plugin and show a clear mismatch message.

---

## Suggested order of attack

| Sprint | Scope | Outcome |
|---|---|---|
| 1 ✅ done 2026-06-10 | Tier 1 items 1–9 (capture bugs) + Tier 4 harness skeleton (`test/`, 32 assertions green) + bonus: decorated-text nodes keep box AND text, flex-centered text, warnings surfaced in both UIs | Most common designs import visibly correct; we can measure |
| 2 | Tier 1 items 10–12 + Tier 2 (raster quality) | "Any design clones faithfully" becomes actually true |
| 3 | Tier 5.1a/b + capture panel v2 | Big captures stop failing; trust UX |
| 4 | Tier 3.1–3.2 (AL v2 with validate-or-fallback) | Editable by default, still exact |
| 5 | Tier 3.3–3.5 (Variables, Components, naming) | The "wow" differentiators |

Definition of done for "exact": ≥99% pixel match on the golden corpus at import time, with zero silent degradations (every compromise surfaced to the user).
