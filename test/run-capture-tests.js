/* DesignBridge capture test harness (Tier 4 skeleton).
 * Renders a golden fixture in headless Chromium, injects the extension's
 * content script, runs the capture, and asserts each Tier 1 fidelity fix.
 *
 * Usage:  node test/run-capture-tests.js [path/to/content.js] [path/to/fixture.html]
 * Deps:   npm i playwright && npx playwright install chromium-headless-shell
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CONTENT_JS = process.argv[2] || path.join(__dirname, "..", "extension", "content.js");
const FIXTURE = process.argv[3] || path.join(__dirname, "fixtures", "golden-1.html");

// depth-first search over the capture tree
function find(node, pred) {
  if (!node) return null;
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}
function findAll(node, pred, out = []) {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : "  — " + (detail || "")));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
  await page.goto("file://" + path.resolve(FIXTURE));
  await page.addScriptTag({ content: fs.readFileSync(CONTENT_JS, "utf8") });
  const cap = await page.evaluate(() => window.__designbridge_test());
  await browser.close();

  const tree = cap.tree;
  console.log("\nCapture v" + cap.version + " — running Tier 1 assertions on " + path.basename(FIXTURE) + "\n");

  // 1. percentage border-radius -> real px (64px circle => radius 32)
  const avatar = find(tree, n => n.w === 64 && n.h === 64 && n.style.radius && n.style.radius[0] > 0);
  check("1. % border-radius resolves (50% of 64px => 32)",
    !!avatar && Math.abs(avatar.style.radius[0] - 32) <= 1,
    avatar ? "radius=" + avatar.style.radius[0] : "no 64x64 rounded node found");

  // 2. white-space:pre keeps newlines
  const code = find(tree, n => n.text && n.text.indexOf("function hi()") >= 0);
  check("2. white-space:pre preserves newlines",
    !!code && code.text.indexOf("\n") >= 0,
    code ? JSON.stringify(code.text.slice(0, 60)) : "code text not found");

  // 3. pseudo-elements captured
  const before = find(tree, n => n.tag === "::before");
  const after = find(tree, n => n.tag === "::after" && n.text === "NEW");
  check("3a. ::before captured (accent bar)", !!before && before.w === 6 && before.h === 120,
    before ? `w=${before.w} h=${before.h}` : "::before not found");
  check("3b. ::after captured with text", !!after, "::after 'NEW' not found");

  // 4. form fields: placeholder + value text
  const ph = find(tree, n => n.text === "Search projects...");
  const val = find(tree, n => n.text === "hello@figmenta.com");
  check("4a. input placeholder captured", !!ph, "placeholder text not in tree");
  check("4b. input value captured", !!val, "value text not in tree");

  // 5. per-side borders
  const quote = find(tree, n => n.style.border && n.style.border.l.w === 4 && n.style.border.t.w === 0);
  const dash = find(tree, n => n.style.border && n.style.border.b.w === 2 && n.style.border.b.s === "dashed");
  check("5a. left-only border captured per side", !!quote, "no node with border.l=4, border.t=0");
  check("5b. dashed bottom border style captured", !!dash, "no node with dashed bottom border");

  // 6. z-index captured
  const z5 = find(tree, n => n.style.zIndex === 5);
  const z1 = find(tree, n => n.style.zIndex === 1);
  check("6. z-index captured on stacked siblings", !!z5 && !!z1,
    `z5=${!!z5} z1=${!!z1}`);

  // 7. text styling flags
  const italic = find(tree, n => n.text === "Italic emphasis");
  const upper = find(tree, n => n.text === "Section label");
  const underline = find(tree, n => n.text === "A link-looking line");
  const hero = find(tree, n => n.text === "Hero with shadow");
  check("7a. font-style italic captured", !!italic && /italic/.test(italic.style.fontStyle), italic ? italic.style.fontStyle : "node missing");
  check("7b. text-transform uppercase captured", !!upper && upper.style.textTransform === "uppercase", upper ? upper.style.textTransform : "node missing");
  check("7c. text-decoration underline captured", !!underline && /underline/.test(underline.style.textDecoration || ""), underline ? String(underline.style.textDecoration) : "node missing");
  check("7d. text-shadow captured", !!hero && !!hero.style.textShadow, hero ? String(hero.style.textShadow) : "node missing");

  // 8. line-height normal resolves to a number
  const para = find(tree, n => n.text && n.text.indexOf("normal line-height") >= 0);
  check("8. line-height:normal resolves (> font-size)",
    !!para && typeof para.style.lineHeight === "number" && para.style.lineHeight > para.style.fontSize,
    para ? `lh=${para.style.lineHeight} fs=${para.style.fontSize}` : "para not found");

  // 9. oklch box-shadow normalized to rgba
  const shadows = findAll(tree, n => n.style.boxShadow);
  const anyOk = shadows.some(n => /okl/i.test(n.style.boxShadow));
  const okbox = shadows.find(n => n.w === 100 && n.h === 60);
  check("9. oklch box-shadow normalized to rgba", shadows.length > 0 && !anyOk && !!okbox,
    okbox ? okbox.style.boxShadow : "okbox shadow not captured");

  // 10. flex space-between: children stay separate spans
  const sb = find(tree, n => (n.children || []).length === 2 &&
    n.children[0].text === "LeftLabel" && n.children[1].text === "RightValue");
  check("10. space-between spans captured separately",
    !!sb && /flex/.test(sb.style.display) && sb.children[1].x - sb.children[0].x > 100,
    sb ? `dx=${sb.children[1].x - sb.children[0].x}` : "row not found");

  // 11. interleaved text fragments keep DOM order
  const range = find(tree, n => (n.children || []).some(c => c.tag === "#text" && c.text === "12:00"));
  const order = range ? range.children.map(c => c.text).join("|") : "";
  check("11. interleaved text order preserved (#text fragments)",
    order === "12:00|–|20:00", order || "range div not found");

  // 12. boundary spaces survive in fragments
  const credits = find(tree, n => (n.children || []).some(c => c.tag === "#text" && /Built by/.test(c.text || "")));
  const frag = credits && credits.children.find(c => c.tag === "#text" && /Built by/.test(c.text));
  check("12. trailing space kept on 'Built by '",
    !!frag && frag.text === "Built by ", frag ? JSON.stringify(frag.text) : "fragment not found");

  // 13. dot span keeps its bg in capture
  const dot = find(tree, n => n.w === 8 && n.h === 8 && n.style.bg && n.style.radius[0] > 3);
  check("13. status dot (inline span w/ bg) captured as box", !!dot, "8x8 bg dot not found");

  // structural sanity
  check("S. capture has warnings array", Array.isArray(cap.warnings), typeof cap.warnings);
  check("S. version bumped", cap.version === "0.6.0", cap.version);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
