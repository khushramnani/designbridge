/* DesignBridge Figma plugin — Phase 3.2 converter (production, design-agnostic).
 * DEFAULT: pixel-perfect absolute positioning (exact x/y/w/h from capture).
 * OPTIONAL: Auto Layout for flex containers (editable, less exact) via toggle.
 * Robust to complex apps: true-bbox root sizing (no content loss), oklch
 * gradients, per-node clipping, rich text, font matching, shadows, images.
 */
figma.showUI(__html__, { width: 340, height: 420 });

var INTER_R = { family: "Inter", style: "Regular" };
var INTER_B = { family: "Inter", style: "Bold" };
var INTER_M = { family: "Inter", style: "Medium" };
var MAXDIM = 100000;
var count = 0;
var fontMap = {};
var OUTLINE = false; // flatten text to vector outlines

// ---- generic helpers ----------------------------------------------------
var INLINE = ["span","a","b","i","em","strong","small","sub","sup","mark","u","label","abbr","time","code","s","del","ins","q","cite","var","kbd","samp","big","tt"];
function isInline(tag){ return INLINE.indexOf(tag) >= 0 || tag === "br"; }
function allInline(node){
  if (!node.children || !node.children.length) return true;
  return node.children.every(function(c){ return isInline(c.tag) && allInline(c); });
}
function collectText(node){
  var t = node.text ? node.text + " " : "";
  for (var i = 0; i < (node.children||[]).length; i++) t += collectText(node.children[i]);
  return t;
}
function clamp(n){ return Math.max(1, Math.min(MAXDIM, n || 1)); }
function solid(c){ if (!c) return null; return { type:"SOLID", color:{ r:c.r, g:c.g, b:c.b }, opacity: c.a == null ? 1 : c.a }; }

// True bounding box of the whole tree (root-relative coords) so the root frame
// covers ALL content, even when a child grid/section overflows its parent.
function treeBBox(node, acc){
  var r = node.x + node.w, b = node.y + node.h;
  if (r > acc.maxX) acc.maxX = r;
  if (b > acc.maxY) acc.maxY = b;
  for (var i=0;i<(node.children||[]).length;i++) treeBBox(node.children[i], acc);
  return acc;
}

// Shift a node and its whole subtree by (dx,dy) — keeps internal layout intact.
function shiftSubtree(node, dx, dy){
  node.x += dx; node.y += dy;
  var ch = node.children || [];
  for (var i=0;i<ch.length;i++) shiftSubtree(ch[i], dx, dy);
}
// Detect display:grid containers whose cells overflow the container width
// (a common quirk of generated designs) and snap the cells back into uniform
// columns sized to the container. Healthy grids (no overflow) are untouched.
function normalizeGrids(node){
  var fixed = 0;
  var kids = node.children || [];
  if ((node.style.display || "").indexOf("grid") >= 0 && kids.length >= 2){
    var pad = node.style.padding || [0,0,0,0];
    var padL = pad[3], padR = pad[1], gap = node.style.gap || 0;
    var maxRight = 0;
    for (var i=0;i<kids.length;i++) maxRight = Math.max(maxRight, kids[i].x + kids[i].w);
    if (maxRight > node.x + node.w + 8){
      var xs = kids.map(function(k){ return k.x; }).slice().sort(function(a,b){ return a-b; });
      var groups = [], cur = [xs[0]];
      for (var j=1;j<xs.length;j++){ if (xs[j]-xs[j-1] > 40){ groups.push(cur); cur=[xs[j]]; } else cur.push(xs[j]); }
      groups.push(cur);
      var centers = groups.map(function(g){ var s=0; for (var k=0;k<g.length;k++) s+=g[k]; return s/g.length; });
      var N = centers.length;
      var contentX = node.x + padL, contentW = node.w - padL - padR;
      var colW = (contentW - (N-1)*gap) / N;
      if (N >= 2 && colW > 4){
        for (var m=0;m<kids.length;m++){
          var kd = kids[m], ci = 0, bd = Infinity;
          for (var c=0;c<N;c++){ var d = Math.abs(centers[c]-kd.x); if (d<bd){ bd=d; ci=c; } }
          shiftSubtree(kd, (contentX + ci*(colW+gap)) - kd.x, 0);
          kd.w = colW; kd._clip = true;
        }
        fixed++;
      }
    }
  }
  for (var n=0;n<kids.length;n++) fixed += normalizeGrids(kids[n]);
  return fixed;
}

function weightStyle(w){
  var n = parseInt(w, 10);
  if (w === "bold") n = 700;
  if (w === "normal" || isNaN(n)) n = 400;
  var map = {100:"Thin",200:"Extra Light",300:"Light",400:"Regular",500:"Medium",600:"Semi Bold",700:"Bold",800:"Extra Bold",900:"Black"};
  var keys = [100,200,300,400,500,600,700,800,900];
  var nearest = keys.reduce(function(p,c){ return Math.abs(c-n) < Math.abs(p-n) ? c : p; }, 400);
  return map[nearest];
}
function fontKey(style){ return (style.fontFamily || "Inter") + "|" + weightStyle(style.fontWeight); }

function parseCSSColor(str){
  if (!str) return null;
  str = str.trim();
  if (str.charAt(0) === "#"){
    var h = str.slice(1);
    if (h.length === 3) h = h.split("").map(function(x){return x+x;}).join("");
    return { r:parseInt(h.slice(0,2),16)/255, g:parseInt(h.slice(2,4),16)/255, b:parseInt(h.slice(4,6),16)/255, a: h.length>=8?parseInt(h.slice(6,8),16)/255:1 };
  }
  var m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  var p = m[1].split(",").map(function(x){return parseFloat(x);});
  return { r:p[0]/255, g:p[1]/255, b:p[2]/255, a: p.length>3?p[3]:1 };
}
function splitTop(str){
  var out=[], d=0, cur="";
  for (var i=0;i<str.length;i++){ var ch=str[i];
    if (ch==="(") d++; if (ch===")") d--;
    if (ch==="," && d===0){ out.push(cur); cur=""; } else cur+=ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function parseShadows(str){
  if (!str || str === "none") return [];
  var segs = splitTop(str), effects = [];
  for (var i=0;i<segs.length;i++){
    var seg = segs[i].trim();
    var inset = /inset/.test(seg);
    var cm = seg.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
    var col = cm ? parseCSSColor(cm[0]) : { r:0, g:0, b:0, a:0.2 };
    var rest = (cm ? seg.replace(cm[0], "") : seg).replace("inset", "");
    var nums = (rest.match(/-?\d*\.?\d+px/g) || []).map(function(n){ return parseFloat(n); });
    if (!nums.length) continue;
    effects.push({
      type: inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color: { r:col.r, g:col.g, b:col.b, a: col.a==null?0.2:col.a },
      offset: { x: nums[0]||0, y: nums[1]||0 },
      radius: Math.abs(nums[2]||0), spread: nums[3]||0,
      blendMode: "NORMAL", visible: true
    });
  }
  return effects;
}
function parseLinearGradient(bgImage){
  if (!bgImage || bgImage.indexOf("linear-gradient") < 0) return null;
  if (bgImage.indexOf("repeating-") >= 0) return null; // repeating hatch: Figma can't tile; skip overlay
  try {
    var inner = bgImage.slice(bgImage.indexOf("(")+1, bgImage.lastIndexOf(")"));
    var parts = splitTop(inner);
    var angle = 180, start = 0;
    if (/deg|to /.test(parts[0])){
      var a = parts[0].trim();
      var dm = a.match(/(-?\d*\.?\d+)deg/);
      if (dm) angle = parseFloat(dm[1]);
      else if (/to right/.test(a)) angle = 90;
      else if (/to left/.test(a)) angle = 270;
      else if (/to top/.test(a)) angle = 0;
      else if (/to bottom/.test(a)) angle = 180;
      start = 1;
    }
    var stops = [];
    for (var i=start;i<parts.length;i++){
      var seg = parts[i].trim();
      var cm = seg.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
      if (!cm) continue;
      var col = parseCSSColor(cm[0]) || { r:0.5, g:0.5, b:0.5, a:1 };
      var pm = seg.match(/(\d*\.?\d+)%/);
      var pos = pm ? parseFloat(pm[1])/100 : (stops.length===0 ? 0 : 1);
      stops.push({ color:{ r:col.r, g:col.g, b:col.b, a: col.a==null?1:col.a }, position: Math.max(0, Math.min(1, pos)) });
    }
    if (stops.length < 2) return null;
    var rad = (angle - 90) * Math.PI / 180;
    var c = Math.cos(rad), s = Math.sin(rad);
    return { type:"GRADIENT_LINEAR", gradientTransform: [[c, s, 0], [-s, c, 0]], gradientStops: stops };
  } catch (e) { return null; }
}
function dataURLtoBytes(d){
  var b64 = (d.split(",")[1]) || "";
  if (typeof figma.base64Decode === "function") return figma.base64Decode(b64);
  var bin = atob(b64), arr = new Uint8Array(bin.length);
  for (var i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function mapPrimary(j){
  if (j === "center") return "CENTER";
  if (j === "flex-end" || j === "end") return "MAX";
  if (j === "space-between" || j === "space-around" || j === "space-evenly") return "SPACE_BETWEEN";
  return "MIN";
}
function mapCounter(a){
  if (a === "center") return "CENTER";
  if (a === "flex-end" || a === "end") return "MAX";
  if (a === "baseline") return "BASELINE";
  return "MIN";
}

// ---- fonts (category-aware, zero-install substitution) ------------------
var SUBS = {}; // wantedFamily -> actualFamily (for reporting)

function inferCat(fam){
  var f = (fam || "").toLowerCase();
  if (f.indexOf("mono") >= 0 || f.indexOf("courier") >= 0 || f.indexOf("consol") >= 0) return "mono";
  var serifs = ["newsreader","georgia","times","playfair","merriweather","lora","pt serif","noto serif",
                "garamond","baskerville","source serif","dm serif","libre baskerville","libre caslon",
                "spectral","cormorant","crimson","frank ruhl","bitter","zilla","tinos","slab","roslindale","fraunces"];
  for (var i=0;i<serifs.length;i++) if (f.indexOf(serifs[i]) >= 0) return "serif";
  return "sans";
}
function collectFonts(node, set){
  if (node.text){ set[fontKey(node.style)] = { family: node.style.fontFamily || "Inter", style: weightStyle(node.style.fontWeight) }; }
  for (var i=0;i<(node.children||[]).length;i++) collectFonts(node.children[i], set);
}
async function resolveFonts(tree){
  SUBS = {}; fontMap = {};
  var needed = {};
  collectFonts(tree, needed);

  // map of available families -> { style: true }
  var famStyles = {};
  try {
    var avail = await figma.listAvailableFontsAsync();
    for (var i=0;i<avail.length;i++){ var fn=avail[i].fontName; (famStyles[fn.family]=famStyles[fn.family]||{})[fn.style]=true; }
  } catch (e) {}
  if (!famStyles["Inter"]) famStyles["Inter"] = { Regular:true, Medium:true, Bold:true };

  function resolveFam(fam){
    if (famStyles[fam]) return fam;
    var cat = inferCat(fam);
    var prefs = cat === "mono"
      ? ["JetBrains Mono","Roboto Mono","Source Code Pro","IBM Plex Mono","Space Mono","Courier New","Courier","Menlo","Consolas"]
      : cat === "serif"
      ? ["Georgia","Times New Roman","Times","PT Serif","Noto Serif","Lora","Merriweather","Source Serif Pro"]
      : ["Inter","Helvetica Neue","Helvetica","Arial","Roboto","Noto Sans"];
    for (var i=0;i<prefs.length;i++) if (famStyles[prefs[i]]) return prefs[i];
    return "Inter";
  }
  function pickStyle(fam, want){
    var st = famStyles[fam]; if (!st) return "Regular";
    if (st[want]) return want;
    var heavy = ["Bold","Semi Bold","Extra Bold","Black"].indexOf(want) >= 0;
    var order = heavy ? ["Bold","Semi Bold","Extra Bold","Black","Medium","Regular"]
              : want === "Medium" ? ["Medium","Regular","Semi Bold","Bold"]
              : ["Regular","Medium","Book","Light"];
    for (var i=0;i<order.length;i++) if (st[order[i]]) return order[i];
    for (var k in st) return k; // any
    return "Regular";
  }

  // resolve every needed font to an available {family,style}
  var toLoad = {};
  for (var key in needed){
    var want = needed[key];
    var fam = resolveFam(want.family);
    if (fam !== want.family) SUBS[want.family] = fam;
    var resolved = { family: fam, style: pickStyle(fam, want.style) };
    fontMap[key] = resolved;
    toLoad[resolved.family + "|" + resolved.style] = resolved;
  }
  toLoad["Inter|Regular"] = INTER_R;

  // load all; if any fails, repoint affected entries to Inter Regular
  var okay = {};
  for (var lk in toLoad){
    try { await figma.loadFontAsync(toLoad[lk]); okay[lk] = true; }
    catch (e) {}
  }
  try { await figma.loadFontAsync(INTER_R); okay["Inter|Regular"] = true; } catch (e) {}
  for (var key2 in fontMap){
    var fm = fontMap[key2];
    if (!okay[fm.family + "|" + fm.style]) fontMap[key2] = INTER_R;
  }
}

// ---- rich text ----------------------------------------------------------
function flattenRuns(node, out){
  if (node.text){
    var t = node.text.replace(/\s+/g, " ");
    if (t) out.push({ text: t, style: node.style });
  }
  for (var i=0;i<(node.children||[]).length;i++){
    var c = node.children[i];
    if (c.tag === "br"){ out.push({ text: "\n", style: c.style }); continue; }
    flattenRuns(c, out);
  }
  return out;
}
function makeText(node){
  var runs = flattenRuns(node, []);
  var full = runs.map(function(r){ return r.text; }).join("");
  var t = figma.createText();
  t.fontName = fontMap[fontKey(node.style)] || INTER_R;
  t.fontSize = clamp(node.style.fontSize || 16);
  t.characters = full;
  var idx = 0;
  for (var i=0;i<runs.length;i++){
    var r = runs[i], len = r.text.length;
    if (len > 0){
      var s = idx, e = idx + len;
      try { t.setRangeFontName(s, e, fontMap[fontKey(r.style)] || INTER_R); } catch (err) {}
      try { t.setRangeFontSize(s, e, clamp(r.style.fontSize || node.style.fontSize || 16)); } catch (err) {}
      var fill = solid(r.style.color);
      if (fill) { try { t.setRangeFills(s, e, [fill]); } catch (err) {} }
      if (r.style.letterSpacing) { try { t.setRangeLetterSpacing(s, e, { value: r.style.letterSpacing, unit:"PIXELS" }); } catch (err) {} }
    }
    idx += len;
  }
  if (node.style.lineHeight) { try { t.lineHeight = { value: node.style.lineHeight, unit:"PIXELS" }; } catch (e) {} }
  if (node.style.textAlign === "center") t.textAlignHorizontal = "CENTER";
  else if (node.style.textAlign === "right") t.textAlignHorizontal = "RIGHT";
  else if (node.style.textAlign === "justify") t.textAlignHorizontal = "JUSTIFIED";
  // Sizing: a substituted font has different metrics than the captured one, so a
  // FIXED box makes text wrap and overlap. Single-line text hugs its content
  // (never wraps); we re-anchor it by its original alignment in build(). Real
  // multi-line paragraphs keep the captured width and grow in height.
  var fs = clamp(node.style.fontSize || 16);
  var singleLine = full.indexOf("\n") < 0 && node.h <= fs * 1.8;
  var anchor = null;
  if (singleLine) {
    t.textAutoResize = "WIDTH_AND_HEIGHT";
    anchor = { align: node.style.textAlign, ow: node.w };
  } else {
    t.textAutoResize = "HEIGHT";
    try { t.resize(clamp(node.w), Math.max(1, t.height)); } catch (e) {}
  }
  var nm = (full.replace(/\s+/g, " ").trim().slice(0, 32)) || "text";
  t.name = nm;
  count++;
  if (OUTLINE) {
    try {
      var v = t.outlineText();
      if (v) { v.name = nm; try { t.remove(); } catch (e2) {} if (anchor) TEXT_ANCHOR.set(v, anchor); return v; }
    } catch (e) { /* keep editable text on failure */ }
  }
  if (anchor) TEXT_ANCHOR.set(t, anchor);
  return t;
}

// ---- frame decoration ---------------------------------------------------
function applyFills(f, node){
  var grad = node.style.bgImage ? parseLinearGradient(node.style.bgImage) : null;
  if (grad) { f.fills = [grad]; return; }
  var bg = solid(node.style.bg);
  f.fills = bg ? [bg] : [];
}
function setRadius(f, radius){
  if (!radius) return;
  var tl = radius[0], tr = radius[1], br = radius[2], bl = radius[3];
  if (tl === tr && tr === br && br === bl) { if (tl > 0) f.cornerRadius = Math.min(tl, 9999); }
  else { f.topLeftRadius = tl; f.topRightRadius = tr; f.bottomRightRadius = br; f.bottomLeftRadius = bl; }
}
function isTextLike(node){
  if (node.tag === "svg") return false;
  var leaf = !node.children || !node.children.length;
  if (node.text && leaf) return true;
  if (node.children && node.children.length && allInline(node) && collectText(node).trim()) return true;
  return false;
}

// ---- main recursive build ----------------------------------------------
// Figma nodes are non-extensible (you can't attach custom props to them), so
// single-line re-anchor info is stored in a Map keyed by the node, not on it.
var TEXT_ANCHOR = new Map();
function build(node, useAuto){
  // Raster safety net: nodes we can't reproduce natively arrive pre-baked as a
  // pixel-perfect PNG. Render them as an image fill at the exact rect.
  if (node.raster && node.imgData){
    var rf = figma.createFrame();
    rf.name = "raster"; rf.clipsContent = true;
    try { rf.resize(clamp(node.w), clamp(node.h)); } catch (e) {}
    setRadius(rf, node.style.radius);
    try {
      var rim = figma.createImage(dataURLtoBytes(node.imgData));
      rf.fills = [{ type:"IMAGE", scaleMode:"FILL", imageHash: rim.hash }];
    } catch (e) { rf.fills = [{ type:"SOLID", color:{ r:0.9, g:0.9, b:0.92 } }]; }
    if (node.style.opacity != null && node.style.opacity < 1) rf.opacity = node.style.opacity;
    count++;
    return rf;
  }
  if (isTextLike(node)) return makeText(node);

  if (node.tag === "svg" && node.svg){
    try {
      var v = figma.createNodeFromSvg(node.svg);
      v.resize(clamp(node.w), clamp(node.h));
      v.name = "icon";
      count++;
      return v;
    } catch (e) {}
  }

  var f = figma.createFrame();
  f.name = node.tag;
  // Clip only where the source clips (overflow hidden/auto/scroll); let
  // overflowing grids/sections spill so nothing is hidden by accident.
  f.clipsContent = node.style.overflow === "clip" || node._clip === true;
  try { f.resize(clamp(node.w), clamp(node.h)); } catch (e) {}
  applyFills(f, node);
  setRadius(f, node.style.radius);
  if (node.style.borderWidth > 0 && node.style.borderColor){
    f.strokes = [solid(node.style.borderColor)];
    f.strokeWeight = node.style.borderWidth;
    f.strokeAlign = "INSIDE";
  }
  var fx = parseShadows(node.style.boxShadow);
  if (fx.length) f.effects = fx;
  if (node.style.opacity != null && node.style.opacity < 1) f.opacity = node.style.opacity;
  count++;

  if (node.tag === "img"){
    if (node.imgData){
      try {
        var im = figma.createImage(dataURLtoBytes(node.imgData));
        f.fills = [{ type:"IMAGE", scaleMode:"FILL", imageHash: im.hash }];
        f.name = "image";
      } catch (e) { f.fills = [{ type:"SOLID", color:{ r:0.9, g:0.9, b:0.92 } }]; f.name = "image (failed)"; }
    } else { f.fills = [{ type:"SOLID", color:{ r:0.9, g:0.9, b:0.92 } }]; f.name = "image (placeholder)"; }
    return f;
  }

  var disp = node.style.display || "";
  var kids = node.children || [];

  if (useAuto && disp.indexOf("flex") >= 0){
    // ---- Auto Layout (opt-in; editable, approximate) ----
    f.layoutMode = (node.style.flexDirection && node.style.flexDirection.indexOf("column") >= 0) ? "VERTICAL" : "HORIZONTAL";
    f.itemSpacing = node.style.gap || 0;
    f.paddingTop = node.style.padding[0]; f.paddingRight = node.style.padding[1];
    f.paddingBottom = node.style.padding[2]; f.paddingLeft = node.style.padding[3];
    f.primaryAxisAlignItems = mapPrimary(node.style.justifyContent);
    f.counterAxisAlignItems = mapCounter(node.style.alignItems);
    f.primaryAxisSizingMode = "FIXED";
    f.counterAxisSizingMode = "FIXED";
    var stretch = node.style.alignItems === "stretch" || node.style.alignItems === "normal";
    for (var i=0;i<kids.length;i++){
      var c = build(kids[i], useAuto);
      if (!c) continue;
      f.appendChild(c);
      if (stretch) { try { c.layoutAlign = "STRETCH"; } catch (e) {} }
    }
    try { f.resize(clamp(node.w), clamp(node.h)); } catch (e) {}
  } else {
    // ---- Absolute positioning (default; pixel-perfect) ----
    for (var j=0;j<kids.length;j++){
      var ch = build(kids[j], useAuto);
      if (!ch) continue;
      f.appendChild(ch);
      ch.x = kids[j].x - node.x;
      ch.y = kids[j].y - node.y;
      var a = TEXT_ANCHOR.get(ch);
      if (a){
        var slack = a.ow - ch.width;
        if (a.align === "right" || a.align === "end") ch.x += slack;
        else if (a.align === "center") ch.x += slack / 2;
      }
    }
  }
  return f;
}

// ---- entry --------------------------------------------------------------
figma.ui.onmessage = async function (msg){
  if (msg.type !== "import") return;
  count = 0; fontMap = {};
  try {
    if (!msg.data || !msg.data.tree) throw new Error("No design tree in capture.");
    var useAuto = !!msg.autoLayout;
    OUTLINE = !!msg.outline;
    await resolveFonts(msg.data.tree);
    var data = msg.data;
    var gridsFixed = normalizeGrids(data.tree);
    var root = build(data.tree, useAuto);
    root.name = "DesignBridge — " + (data.sourceUrl ? decodeURIComponent(data.sourceUrl.split("/").pop().split("?")[0]) : "import");
    if (root.type === "FRAME" && (!root.fills || root.fills.length === 0))
      root.fills = [{ type:"SOLID", color:{ r:0.98, g:0.98, b:0.97 }, opacity:1 }];

    // Size root to cover ALL content. Width is clamped to the captured viewport
    // (so a design that overflows horizontally — like its own broken grid —
    // is clipped exactly as the browser shows it), height spans every row so
    // nothing below the fold is lost.
    var bb = treeBBox(data.tree, { maxX: 0, maxY: 0 });
    var vw = data.viewport && data.viewport.w ? data.viewport.w : bb.maxX;
    var rw = clamp(Math.min(bb.maxX, vw));
    var rh = clamp(bb.maxY);
    if (root.type === "FRAME"){
      try { root.resize(rw, rh); } catch (e) {}
      root.clipsContent = true;
    }
    root.x = Math.round(figma.viewport.center.x - rw / 2);
    root.y = Math.round(figma.viewport.center.y - rh / 2);
    figma.currentPage.appendChild(root);
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
    var subs = []; for (var sk in SUBS) subs.push(sk + " → " + SUBS[sk]);
    figma.ui.postMessage({ type:"done", count: count, subs: subs, grids: gridsFixed });
  } catch (e) {
    figma.ui.postMessage({ type:"error", message: e.message });
  }
};
