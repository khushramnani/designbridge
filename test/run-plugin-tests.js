/* DesignBridge plugin test — runs the REAL capture (from the Playwright
 * harness) through the REAL plugin converter (code.js) against a stubbed
 * Figma API, and asserts the rebuilt node tree.
 *
 * Usage: node test/run-plugin-tests.js [code.js] [content.js] [fixture.html]
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { chromium } = require("playwright");

const CODE_JS = process.argv[2] || path.join(__dirname, "..", "figma-plugin", "code.js");
const CONTENT_JS = process.argv[3] || path.join(__dirname, "..", "extension", "content.js");
const FIXTURE = process.argv[4] || path.join(__dirname, "fixtures", "golden-1.html");

// ---- minimal Figma API stub ----------------------------------------------
function stubNode(type) {
  const n = {
    type, name: "", children: [], fills: [], strokes: [], effects: [],
    x: 0, y: 0, width: 100, height: 100, _props: {},
    appendChild(c) { this.children.push(c); c.parent = this; },
    resize(w, h) { this.width = w; this.height = h; },
  };
  return n;
}
function makeStub() {
  const fonts = [];
  ["Inter", "Arial", "Helvetica", "Georgia", "Roboto Mono"].forEach(family => {
    ["Thin","Extra Light","Light","Regular","Medium","Semi Bold","Bold","Extra Bold","Black"].forEach(style => {
      fonts.push({ fontName: { family, style } });
      fonts.push({ fontName: { family, style: style === "Regular" ? "Italic" : style + " Italic" } });
    });
  });
  const ui = { onmessage: null, postMessage(m) { stub._lastMessage = m; } };
  const stub = {
    _lastMessage: null,
    showUI() {}, ui,
    createFrame: () => stubNode("FRAME"),
    createRectangle: () => stubNode("RECTANGLE"),
    createText: () => {
      const t = stubNode("TEXT");
      t.characters = ""; t.fontName = null; t.fontSize = 16;
      t.setRangeFontName = () => {}; t.setRangeFontSize = () => {};
      t.setRangeFills = () => {}; t.setRangeLetterSpacing = () => {};
      t.setRangeTextCase = (s, e, v) => { t._rangeCase = v; };
      t.setRangeTextDecoration = (s, e, v) => { t._rangeDeco = v; };
      t.outlineText = () => null;
      return t;
    },
    createImage: (bytes) => ({ hash: "img" + bytes.length }),
    createNodeFromSvg: () => stubNode("FRAME"),
    listAvailableFontsAsync: async () => fonts,
    loadFontAsync: async () => {},
    base64Decode: (b64) => Buffer.from(b64, "base64"),
    currentPage: Object.assign(stubNode("PAGE"), { selection: [] }),
    viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
  };
  return stub;
}

function find(n, pred) {
  if (!n) return null;
  if (pred(n)) return n;
  for (const c of n.children || []) { const h = find(c, pred); if (h) return h; }
  return null;
}
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : "  — " + (detail || "")));
}

(async () => {
  // 1) real capture via headless chromium
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
  await page.goto("file://" + path.resolve(FIXTURE));
  await page.addScriptTag({ content: fs.readFileSync(CONTENT_JS, "utf8") });
  const cap = await page.evaluate(() => window.__designbridge_test());
  await browser.close();

  // 2) run the real plugin code against the stub
  const figma = makeStub();
  const ctx = vm.createContext({ figma, __html__: "", console, atob: s => Buffer.from(s, "base64").toString("binary") });
  vm.runInContext(fs.readFileSync(CODE_JS, "utf8"), ctx, { filename: "code.js" });
  await figma.ui.onmessage({ type: "import", data: cap, autoLayout: false, outline: false });

  console.log("\nPlugin build assertions (" + path.basename(CODE_JS) + ")\n");
  const m = figma._lastMessage;
  check("P0. import completed without error", m && m.type === "done", m && m.message);
  if (!m || m.type !== "done") { process.exit(1); }
  const root = figma.currentPage.children[0];

  // circle radius applied
  const circle = find(root, n => n.type === "FRAME" && n.cornerRadius === 32);
  check("P1. 50% radius circle -> cornerRadius 32", !!circle, "no frame with cornerRadius 32");

  // code block kept newlines
  const code = find(root, n => n.type === "TEXT" && /function hi\(\)/.test(n.characters));
  check("P2. code block text keeps newlines", !!code && code.characters.includes("\n"),
    code ? JSON.stringify(code.characters.slice(0, 50)) : "text missing");

  // input stays a frame with synthesized text child
  const inputFrame = find(root, n => n.type === "FRAME" && n.name === "input" &&
    find(n, c => c.type === "TEXT" && c.characters === "Search projects..."));
  check("P3. input -> frame + placeholder text child (not collapsed)", !!inputFrame, "input frame w/ text child missing");

  // per-side border -> strokeLeftWeight
  const quote = find(root, n => n.type === "FRAME" && n.strokeLeftWeight === 4 && (n.strokeTopWeight === 0));
  check("P4. left-only border -> per-side stroke weights", !!quote, "no frame with strokeLeftWeight=4/top=0");

  // dashed border -> dashPattern
  const dash = find(root, n => n.type === "FRAME" && Array.isArray(n.dashPattern) && n.dashPattern.length === 2);
  check("P5. dashed border -> dashPattern", !!dash, "no frame with dashPattern");

  // z-order: blue (z=5) must come AFTER red (z=1) among its siblings
  const stack = find(root, n => n.type === "FRAME" &&
    n.children.filter(c => c.type === "FRAME" && c.width === 120 && c.height === 80).length === 2);
  let zOk = false, zDetail = "stack not found";
  if (stack) {
    const boxes = stack.children.filter(c => c.width === 120 && c.height === 80);
    const blueIdx = boxes.findIndex(b => b.fills[0] && b.fills[0].color && b.fills[0].color.b > 0.5);
    const redIdx = boxes.findIndex(b => b.fills[0] && b.fills[0].color && b.fills[0].color.r > 0.5);
    zOk = blueIdx > redIdx; zDetail = `redIdx=${redIdx} blueIdx=${blueIdx}`;
  }
  check("P6. z-index 5 paints above z-index 1 (appended later)", zOk, zDetail);

  // pseudo-element became a real layer
  const accent = find(root, n => n.name === "::before");
  check("P7. ::before accent bar becomes a layer", !!accent, "::before frame missing");

  // italic resolved to an Italic font style
  const italic = find(root, n => n.type === "TEXT" && n.characters === "Italic emphasis");
  check("P8. italic text -> Italic font style", !!italic && /Italic/.test(italic.fontName && italic.fontName.style),
    italic ? JSON.stringify(italic.fontName) : "text missing");

  // uppercase via textCase
  const upper = find(root, n => n.type === "TEXT" && n.characters === "Section label");
  check("P9. uppercase -> textCase UPPER", !!upper && (upper.textCase === "UPPER" || upper._rangeCase === "UPPER"),
    upper ? String(upper.textCase) : "text missing");

  // underline
  const link = find(root, n => n.type === "TEXT" && /link-looking/.test(n.characters || ""));
  check("P10. underline -> textDecoration UNDERLINE", !!link && (link.textDecoration === "UNDERLINE" || link._rangeDeco === "UNDERLINE"),
    link ? String(link.textDecoration) : "text missing");

  // text-shadow -> drop shadow effect on text
  const hero = find(root, n => n.type === "TEXT" && /Hero with shadow/.test(n.characters || ""));
  check("P11. text-shadow -> DROP_SHADOW effect", !!hero && hero.effects.length === 1 && hero.effects[0].type === "DROP_SHADOW",
    hero ? JSON.stringify(hero.effects) : "text missing");

  // oklch box-shadow -> effect with sensible color
  const ok = find(root, n => n.type === "FRAME" && n.effects && n.effects.length &&
    n.effects[0].type === "DROP_SHADOW" && n.effects[0].radius === 12);
  check("P12. oklch box-shadow -> parsed DROP_SHADOW (blur 12)", !!ok, "shadow effect missing");

  // decorated text keeps BOTH its box and its text
  const quoteText = find(root, n => n.type === "FRAME" && n.strokeLeftWeight === 4 &&
    find(n, c => c.type === "TEXT" && /Quoted wisdom/.test(c.characters || "")));
  check("P13. bordered blockquote keeps border AND text child", !!quoteText, "frame+text combo missing");
  const badge = find(root, n => n.type === "FRAME" && n.fills[0] && n.fills[0].color && n.fills[0].color.r > 0.8 &&
    find(n, c => c.type === "TEXT" && c.characters === "NEW"));
  check("P14. ::after badge keeps red bg AND text child", !!badge, "badge frame+text missing");

  // inline-merging regressions from the Carryover capture
  const rangeText = find(root, n => n.type === "TEXT" && n.characters === "12:00–20:00");
  check("P15. interleaved text rebuilt in order ('12:00–20:00')", !!rangeText, "merged text wrong/missing");

  const creditsText = find(root, n => n.type === "TEXT" && n.characters === "Built by Khush for Figmenta");
  check("P16. boundary spaces kept ('Built by Khush for Figmenta')", !!creditsText, "spaces lost in merge");

  const left = find(root, n => n.type === "TEXT" && n.characters === "LeftLabel");
  const right = find(root, n => n.type === "TEXT" && n.characters === "RightValue");
  check("P17. space-between spans stay separate text nodes",
    !!left && !!right, `left=${!!left} right=${!!right}`);

  const dotFrame = find(root, n => n.type === "FRAME" && n.width === 8 && n.height === 8 &&
    n.fills[0] && n.fills[0].color && n.fills[0].color.g > 0.5);
  const dotLabel = find(root, n => n.type === "TEXT" && n.characters === "Not started");
  check("P18. status dot survives next to its label", !!dotFrame && !!dotLabel,
    `dot=${!!dotFrame} label=${!!dotLabel}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
