/* DesignBridge content script — runs INSIDE the *.claudeusercontent.com iframe
 * Phase 6.0: capture rendered DOM + computed styles, with a CONFIDENCE MODEL.
 * Native-safe nodes (solid/linear-gradient fills, text, svg, images, borders,
 * radius, shadows) are rebuilt as editable Figma layers. Anything we can't
 * reproduce exactly (transforms, filters, blend modes, clip-path/mask,
 * radial/conic/url/repeating backgrounds, canvas/video) is RASTERIZED to a
 * pixel-perfect PNG via SVG foreignObject so ANY design clones faithfully.
 *
 * 6.0 inline-text fidelity: mixed content (text interleaved with inline
 * elements) is captured as ORDERED "#text" fragments with measured rects, so
 * "12:00<span>–</span>20:00" keeps its order and "Built by <a>X</a> for <b>Y</b>"
 * keeps its spaces. Earlier fixes: %-radius, white-space:pre, ::before/::after,
 * form fields, per-side borders, z-index, italic/transform/decoration/shadow.
 */
(function () {
  if (window.__designbridge_injected) return;
  window.__designbridge_injected = true;
  if (!document.body || document.body.children.length === 0) return;

  var _cv = document.createElement("canvas");
  var _ctx = _cv.getContext("2d");
  var RASTER = []; // {node, el} queued for rasterization (els kept off the JSON)
  var WARN = [];   // human-readable fidelity warnings, shipped in the capture

  // ---- OKLab/OKLCH -> sRGB ------------------------------------------------
  function oklabToRgb(L, a, b, alpha) {
    var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    var s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    var R =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    var G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    var B = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    function gam(x) { x = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; return Math.min(1, Math.max(0, x)); }
    return { r: gam(R), g: gam(G), b: gam(B), a: alpha == null ? 1 : alpha };
  }
  function num(t, ref) { t = t.trim(); if (t === "none") return 0; return t.charAt(t.length - 1) === "%" ? parseFloat(t) / 100 * (ref || 1) : parseFloat(t); }
  function parseOkAlpha(parts) { return parts[1] ? num(parts[1]) : 1; }
  function parseOklch(s) {
    var m = s.match(/oklch\(([^)]+)\)/i); if (!m) return null;
    var parts = m[1].split("/"); var c = parts[0].trim().split(/\s+/);
    var L = num(c[0]), C = num(c[1]), H = c[2] ? parseFloat(c[2]) : 0;
    var h = H * Math.PI / 180;
    return oklabToRgb(L, C * Math.cos(h), C * Math.sin(h), parseOkAlpha(parts));
  }
  function parseOklab(s) {
    var m = s.match(/oklab\(([^)]+)\)/i); if (!m) return null;
    var parts = m[1].split("/"); var c = parts[0].trim().split(/\s+/);
    return oklabToRgb(num(c[0]), parseFloat(c[1]), parseFloat(c[2]), parseOkAlpha(parts));
  }
  function toColor(str) {
    if (!str) return null;
    var s = str.trim();
    if (s === "transparent" || s === "none") return null;
    if (/oklch\(/i.test(s)) return parseOklch(s);
    if (/oklab\(/i.test(s)) return parseOklab(s);
    _ctx.fillStyle = "#000000"; _ctx.fillStyle = s; var a1 = _ctx.fillStyle;
    _ctx.fillStyle = "#ffffff"; _ctx.fillStyle = s; var a2 = _ctx.fillStyle;
    if (a1 !== a2) return null;
    var norm = a1;
    if (norm.charAt(0) === "#") {
      return { r: parseInt(norm.slice(1,3),16)/255, g: parseInt(norm.slice(3,5),16)/255, b: parseInt(norm.slice(5,7),16)/255, a: 1 };
    }
    var m = norm.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    var p = m[1].split(",").map(function (x) { return parseFloat(x.trim()); });
    var a = p.length > 3 ? p[3] : 1;
    if (a === 0) return null;
    return { r: p[0]/255, g: p[1]/255, b: p[2]/255, a: a };
  }
  function px(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  // border-radius computed values can be "12px", "50%", or "8px 16px"
  // (horizontal vertical). Percentages resolve against the element's own box —
  // parseFloat("50%") = 50px broke every circle avatar/dot before this.
  function radiusPx(v, w, h) {
    if (!v) return 0;
    var parts = String(v).trim().split(/\s+/);
    function one(t, ref) {
      if (t.charAt(t.length - 1) === "%") return (parseFloat(t) || 0) / 100 * ref;
      var n = parseFloat(t); return isNaN(n) ? 0 : n;
    }
    var rh = one(parts[0], w), rv = one(parts[1] || parts[0], h);
    return Math.min(rh, rv);
  }
  function rgbaStr(c) { if (!c) return "rgba(0,0,0,0)"; var a = c.a == null ? 1 : c.a; return "rgba(" + Math.round(c.r*255) + "," + Math.round(c.g*255) + "," + Math.round(c.b*255) + "," + a + ")"; }
  // Replace oklch()/oklab() colors with rgba() anywhere in a CSS value string
  // (gradients, box-shadow, text-shadow) so the plugin's parsers can read them.
  function normalizeColors(str) {
    if (!str) return str;
    return str.replace(/okl(?:ch|ab)\([^)]*\)/gi, function (m) {
      var c = /oklch/i.test(m) ? parseOklch(m) : parseOklab(m);
      return c ? rgbaStr(c) : m;
    });
  }

  // ---- CONFIDENCE: can we reproduce this node natively, or must we raster?
  function isIdentity(t) { return !t || t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)"; }
  function needsRaster(el, cs) {
    var tag = el.tagName.toLowerCase();
    if (tag === "canvas" || tag === "video") return true;
    if (!isIdentity(cs.transform)) return true;
    if (cs.filter && cs.filter !== "none") return true;
    if ((cs.backdropFilter && cs.backdropFilter !== "none") || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== "none")) return true;
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") return true;
    if (cs.clipPath && cs.clipPath !== "none") return true;
    if ((cs.maskImage && cs.maskImage !== "none") || (cs.webkitMaskImage && cs.webkitMaskImage !== "none")) return true;
    var bgi = cs.backgroundImage;
    if (bgi && bgi !== "none") {
      // Plain single linear-gradient is reproduced natively; everything else rasters.
      if (/radial-gradient|conic-gradient|repeating-|url\(/.test(bgi)) return true;
      if ((bgi.match(/gradient\(/g) || []).length > 1) return true; // multiple stacked gradients
    }
    return false;
  }

  // ---- dom-to-image: render a live element to PNG via SVG foreignObject ----
  function inlineAll(src, dst) {
    var cs = getComputedStyle(src);
    var str = "";
    for (var i = 0; i < cs.length; i++) { var k = cs[i]; str += k + ":" + cs.getPropertyValue(k) + ";"; }
    dst.style.cssText = str;
    var s = src.children, d = dst.children;
    for (var j = 0; j < s.length; j++) if (d[j]) inlineAll(s[j], d[j]);
  }
  function rasterize(el) {
    var r = el.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w > 2200 || h > 2200) return Promise.resolve(null); // too big to bake; keep native
    var clone = el.cloneNode(true);
    try { inlineAll(el, clone); } catch (e) {}
    clone.style.margin = "0"; clone.style.transform = "none";
    var html = new XMLSerializer().serializeToString(clone);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
      '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + w + 'px;height:' + h + 'px;overflow:hidden">' +
      html + '</div></foreignObject></svg>';
    var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var dpr = Math.max(2, window.devicePixelRatio || 1), c = document.createElement("canvas");
          c.width = w * dpr; c.height = h * dpr;
          var ctx = c.getContext("2d"); ctx.scale(dpr, dpr); ctx.drawImage(img, 0, 0);
          resolve(c.toDataURL("image/png"));
        } catch (e) { resolve(null); } // tainted canvas etc.
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }
  async function rasterizeAll() {
    for (var i = 0; i < RASTER.length; i++) {
      var item = RASTER[i];
      try {
        var data = await rasterize(item.el);
        if (data) { item.node.imgData = data; }
        else {
          item.node.raster = false; // failed -> degrade to plain frame
          WARN.push("Could not rasterize <" + item.node.tag + "> (" + item.node.w + "x" + item.node.h + ") — imported as a plain frame, effects lost.");
        }
      } catch (e) { item.node.raster = false; WARN.push("Rasterization error on <" + item.node.tag + ">: " + e.message); }
    }
  }

  function hexOf(c){ if(!c) return null; function h(x){ x=Math.max(0,Math.min(255,Math.round(x*255))); return (x<16?"0":"")+x.toString(16); } return "#"+h(c.r)+h(c.g)+h(c.b); }
  // Resolve var(--token), currentColor and oklch/oklab inside an SVG so Figma
  // (which can't read the page's CSS custom properties) renders real colors.
  function resolveSvg(el){
    var cs = getComputedStyle(el);
    var s = el.outerHTML;
    s = s.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,[^()]*)?\)/gi, function(m, name){
      var v = cs.getPropertyValue(name); v = v && v.trim(); return v || m;
    });
    var cc = toColor(cs.color); if (cc) s = s.replace(/currentColor/gi, hexOf(cc));
    s = s.replace(/okl(?:ch|ab)\([^)]*\)/gi, function(m){
      var c = /oklch/i.test(m) ? parseOklch(m) : parseOklab(m); return c ? hexOf(c) : m;
    });
    return s;
  }

  // ---- style extraction (shared by elements and pseudo-elements) ----------
  function borderSide(wv, cv, sv) { return { w: px(wv), c: toColor(cv), s: sv || "none" }; }
  function styleOf(cs, w, h) {
    var bgImg = cs.backgroundImage && cs.backgroundImage.indexOf("gradient") >= 0 ? normalizeColors(cs.backgroundImage) : null;
    var z = parseInt(cs.zIndex, 10);
    return {
      display: cs.display, flexDirection: cs.flexDirection,
      gap: px(cs.columnGap) || px(cs.gap) || 0,
      justifyContent: cs.justifyContent, alignItems: cs.alignItems,
      padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
      bg: toColor(cs.backgroundColor), bgImage: bgImg, color: toColor(cs.color),
      overflow: (cs.overflowX !== "visible" || cs.overflowY !== "visible") ? "clip" : "visible",
      whiteSpace: cs.whiteSpace,
      fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
      fontSize: px(cs.fontSize), fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      textTransform: cs.textTransform,
      textDecoration: cs.textDecorationLine && cs.textDecorationLine !== "none" ? cs.textDecorationLine : null,
      textShadow: cs.textShadow && cs.textShadow !== "none" ? normalizeColors(cs.textShadow) : null,
      // "normal" line-height resolves to NaN; ~1.2x font-size is the UA default
      lineHeight: px(cs.lineHeight) || Math.round(px(cs.fontSize) * 1.2) || null,
      letterSpacing: px(cs.letterSpacing) || 0,
      textAlign: cs.textAlign,
      radius: [
        radiusPx(cs.borderTopLeftRadius, w, h), radiusPx(cs.borderTopRightRadius, w, h),
        radiusPx(cs.borderBottomRightRadius, w, h), radiusPx(cs.borderBottomLeftRadius, w, h)
      ],
      border: {
        t: borderSide(cs.borderTopWidth, cs.borderTopColor, cs.borderTopStyle),
        r: borderSide(cs.borderRightWidth, cs.borderRightColor, cs.borderRightStyle),
        b: borderSide(cs.borderBottomWidth, cs.borderBottomColor, cs.borderBottomStyle),
        l: borderSide(cs.borderLeftWidth, cs.borderLeftColor, cs.borderLeftStyle)
      },
      // legacy fields (kept so an old plugin still imports a new capture)
      borderWidth: px(cs.borderTopWidth), borderColor: toColor(cs.borderTopColor),
      boxShadow: cs.boxShadow && cs.boxShadow !== "none" ? normalizeColors(cs.boxShadow) : null,
      opacity: parseFloat(cs.opacity),
      zIndex: isNaN(z) ? 0 : z, position: cs.position
    };
  }
  function zeroBorder() { var z = { w: 0, c: null, s: "none" }; return { t: z, r: z, b: z, l: z }; }
  // A bare text-style clone (no box decoration) for synthesized text children.
  function textStyleFrom(s, color) {
    return {
      display: "inline", flexDirection: "row", gap: 0, justifyContent: "normal", alignItems: "normal",
      padding: [0,0,0,0], bg: null, bgImage: null, color: color || s.color, overflow: "visible",
      whiteSpace: s.whiteSpace, fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
      fontStyle: s.fontStyle, textTransform: s.textTransform, textDecoration: null, textShadow: null,
      lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, textAlign: s.textAlign,
      radius: [0,0,0,0], border: zeroBorder(), borderWidth: 0, borderColor: null,
      boxShadow: null, opacity: 1, zIndex: 0, position: "static"
    };
  }

  // matrix(1,0,0,1,tx,ty) is a pure translation — representable by shifting x/y.
  function parseTranslate(t) {
    var m = t && t.match(/^matrix\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/);
    if (!m) return null;
    if (parseFloat(m[1]) !== 1 || parseFloat(m[2]) !== 0 || parseFloat(m[3]) !== 0 || parseFloat(m[4]) !== 1) return null;
    return { x: parseFloat(m[5]), y: parseFloat(m[6]) };
  }

  // ---- pseudo-elements ----------------------------------------------------
  // Claude Design leans on ::before/::after for overlays, accents and icons.
  // Returns a synthetic node, the string "raster" (parent must be baked to
  // keep fidelity), or null (nothing visible).
  function capturePseudo(el, which, parentRect, rootRect) {
    var cs;
    try { cs = getComputedStyle(el, which); } catch (e) { return null; }
    if (!cs || cs.content === "none" || cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return null;
    var text = null;
    var cm = cs.content.match(/^"([\s\S]*)"$/);
    if (cm && cm[1]) text = cm[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    var w = parseFloat(cs.width), h = parseFloat(cs.height);
    if (isNaN(w) || isNaN(h)) {
      if (!text) return null; // auto-sized decorative box we can't measure
      var fs = px(cs.fontSize) || 14;
      w = Math.ceil(text.length * fs * 0.62); h = Math.ceil(px(cs.lineHeight) || fs * 1.2);
    }
    var bg = toColor(cs.backgroundColor);
    var bgi = cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage : null;
    var hasBorder = px(cs.borderTopWidth) > 0 || px(cs.borderRightWidth) > 0 || px(cs.borderBottomWidth) > 0 || px(cs.borderLeftWidth) > 0;
    var hasShadow = cs.boxShadow && cs.boxShadow !== "none";
    if (!text && !bg && !bgi && !hasBorder && !hasShadow) return null;
    if (w < 1 || h < 1) return null;
    // Un-representable pseudo -> bake the parent
    var trOff = null;
    if (!isIdentity(cs.transform)) { trOff = parseTranslate(cs.transform); if (!trOff) return "raster"; }
    if (cs.filter && cs.filter !== "none") return "raster";
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") return "raster";
    if (cs.clipPath && cs.clipPath !== "none") return "raster";
    if (bgi && (/radial-gradient|conic-gradient|repeating-|url\(/.test(bgi) || (bgi.match(/gradient\(/g) || []).length > 1)) return "raster";
    // Geometry. Containing block ≈ parent rect (decorative pseudos almost
    // always sit on a position:relative parent).
    var x, y;
    if (cs.position === "absolute" || cs.position === "fixed") {
      var L = parseFloat(cs.left), R = parseFloat(cs.right), T = parseFloat(cs.top), B = parseFloat(cs.bottom);
      x = !isNaN(L) ? parentRect.x + L : (!isNaN(R) ? parentRect.x + parentRect.width - R - w : parentRect.x);
      y = !isNaN(T) ? parentRect.y + T : (!isNaN(B) ? parentRect.y + parentRect.height - B - h : parentRect.y);
    } else {
      var pcs = getComputedStyle(el);
      x = parentRect.x + px(pcs.borderLeftWidth) + px(pcs.paddingLeft);
      y = parentRect.y + px(pcs.borderTopWidth) + px(pcs.paddingTop);
    }
    if (trOff) { x += trOff.x; y += trOff.y; }
    return {
      tag: which,
      x: Math.round(x - rootRect.x), y: Math.round(y - rootRect.y),
      w: Math.round(w), h: Math.round(h),
      style: styleOf(cs, w, h),
      text: text,
      children: []
    };
  }

  // ---- text fragments -------------------------------------------------------
  // When an element mixes text with inline children ("12:00<span>–</span>20:00",
  // "Built by <a>X</a> for <b>Y</b>"), each text node becomes an ordered
  // "#text" fragment with a measured rect, so order AND boundary spaces survive.
  function captureTextFragment(tn, parentNode, preserve, rootRect) {
    var raw = tn.textContent;
    if (!raw) return null;
    // Collapse runs of whitespace to ONE space but KEEP boundary spaces —
    // trimming them is what produced "Built byKhushforFigmenta".
    var t = preserve ? raw.replace(/^\n/, "") : raw.replace(/\s+/g, " ");
    if (!t) return null;
    var rr = null;
    try {
      var rg = document.createRange();
      rg.selectNodeContents(tn);
      rr = rg.getBoundingClientRect();
    } catch (e) { return null; }
    if (!rr || (rr.width === 0 && rr.height === 0)) {
      // fully collapsed whitespace (e.g. formatting newlines between blocks)
      return null;
    }
    if (!t.trim() && rr.width < 1) return null; // invisible whitespace
    return {
      tag: "#text",
      x: Math.round(rr.x - rootRect.x), y: Math.round(rr.y - rootRect.y),
      w: Math.max(1, Math.round(rr.width)), h: Math.max(1, Math.round(rr.height)),
      style: textStyleFrom(parentNode.style, parentNode.style.color),
      text: t, children: []
    };
  }

  // ---- form fields ----------------------------------------------------------
  var NO_TEXT_INPUTS = ["checkbox","radio","range","file","color","hidden","image"];
  function formFieldText(el, node) {
    var tag = node.tag;
    var val = "", ph = false;
    if (tag === "select") {
      try { var oi = el.selectedIndex; val = oi >= 0 ? (el.options[oi].text || "") : ""; } catch (e) {}
    } else {
      var itype = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "text";
      if (NO_TEXT_INPUTS.indexOf(itype) >= 0) return;
      val = el.value != null ? String(el.value) : "";
      if (itype === "password" && val) val = val.replace(/./g, "•");
      if (!val && el.placeholder) { val = el.placeholder; ph = true; }
    }
    val = val.replace(/\s+/g, " ").trim();
    if (!val) return;
    var color = node.style.color;
    if (ph) {
      try { var pc = toColor(getComputedStyle(el, "::placeholder").color); if (pc) color = pc; } catch (e) {}
    }
    var fs = node.style.fontSize || 14;
    var lh = node.style.lineHeight || Math.round(fs * 1.2);
    var b = node.style.border, pad = node.style.padding;
    var tx = node.x + b.l.w + pad[3];
    var tw = Math.max(1, node.w - b.l.w - b.r.w - pad[1] - pad[3]);
    var ty = node.y + Math.max(0, Math.round((node.h - lh) / 2));
    node.children = [{
      tag: "span",
      x: tx, y: ty, w: tw, h: Math.min(node.h, Math.round(lh)),
      style: textStyleFrom(node.style, color),
      text: val, children: []
    }];
  }

  function captureNode(el, rootRect) {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return null;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    // white-space:pre / pre-wrap (code blocks!) must keep newlines + indentation
    var preserve = /pre/.test(cs.whiteSpace);
    var hasElemKids = el.children.length > 0;
    var node = {
      tag: el.tagName.toLowerCase(),
      x: Math.round(r.x - rootRect.x), y: Math.round(r.y - rootRect.y),
      w: Math.round(r.width), h: Math.round(r.height),
      style: styleOf(cs, r.width, r.height),
      text: null,
      children: []
    };
    // Pure text leaf: keep the fast path (single concatenated, trimmed string)
    if (!hasElemKids) {
      var directText = Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; })
        .map(function (n) { return n.textContent; }).join("");
      directText = preserve
        ? directText.replace(/^\n/, "").replace(/\s+$/, "")
        : directText.replace(/\s+/g, " ").trim();
      node.text = directText || null;
    }
    if (el.tagName === "IMG") {
      node.src = el.currentSrc || el.src || null;
      try {
        var iw = el.naturalWidth || Math.round(r.width), ih = el.naturalHeight || Math.round(r.height);
        var scale = Math.min(1, 1400 / Math.max(iw, ih || 1));
        var ic = document.createElement("canvas");
        ic.width = Math.max(1, Math.round(iw * scale)); ic.height = Math.max(1, Math.round(ih * scale));
        ic.getContext("2d").drawImage(el, 0, 0, ic.width, ic.height);
        node.imgData = ic.toDataURL("image/png");
      } catch (e) { node.imgData = null; }
      return node;
    }
    if (el.tagName.toLowerCase() === "svg") { node.svg = resolveSvg(el); return node; }

    // Form fields: the value/placeholder is not a DOM text node — synthesize one.
    if (node.tag === "input" || node.tag === "textarea" || node.tag === "select") {
      formFieldText(el, node);
      return node;
    }

    var pseudoBefore = capturePseudo(el, "::before", r, rootRect);
    var pseudoAfter = capturePseudo(el, "::after", r, rootRect);
    var pseudoRaster = pseudoBefore === "raster" || pseudoAfter === "raster";

    // CONFIDENCE GATE: un-representable node (or pseudo) -> rasterize subtree.
    if (needsRaster(el, cs) || (pseudoRaster && node.w <= 2200 && node.h <= 2200)) {
      node.raster = true; node.text = null; node.children = [];
      RASTER.push({ node: node, el: el });
      return node;
    }
    if (pseudoRaster) WARN.push("Dropped a complex ::before/::after on <" + node.tag + "> (region too large to rasterize).");

    if (pseudoBefore && pseudoBefore !== "raster") node.children.push(pseudoBefore);
    // Walk childNodes IN ORDER: elements recurse; text nodes (only when mixed
    // with elements) become "#text" fragments so interleaving is preserved.
    for (var i = 0; i < el.childNodes.length; i++) {
      var cn = el.childNodes[i];
      if (cn.nodeType === 1) {
        var c = captureNode(cn, rootRect);
        if (c) node.children.push(c);
      } else if (cn.nodeType === 3 && hasElemKids) {
        var tf = captureTextFragment(cn, node, preserve, rootRect);
        if (tf) node.children.push(tf);
      }
    }
    if (pseudoAfter && pseudoAfter !== "raster") node.children.push(pseudoAfter);

    var hasVisual = node.style.bg || node.style.bgImage || node.style.boxShadow ||
      node.style.border.t.w > 0 || node.style.border.r.w > 0 || node.style.border.b.w > 0 || node.style.border.l.w > 0;
    if (!node.children.length && !node.text && !hasVisual && (node.w < 1 || node.h < 1)) return null;
    return node;
  }

  function capture() {
    RASTER = []; WARN = [];
    var root = document.body;
    var rootRect = root.getBoundingClientRect();
    return {
      _designbridge: true, version: "0.6.0", capturedAt: new Date().toISOString(),
      sourceUrl: location.href,
      viewport: { w: window.innerWidth, h: Math.round(rootRect.height) },
      warnings: WARN,
      tree: captureNode(root, rootRect)
    };
  }

  var btn = document.createElement("button");
  btn.textContent = "Send to Figma";
  btn.style.cssText = "position:fixed;z-index:2147483647;bottom:20px;right:20px;padding:12px 18px;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:10px;font:600 14px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.35)";
  document.documentElement.appendChild(btn);

  function showPanel(json, rasterCount, warnings) {
    var wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;z-index:2147483647;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    var box = document.createElement("div");
    box.style.cssText = "width:min(680px,90vw);background:#161616;color:#eee;border-radius:14px;padding:18px;font:14px system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5)";
    var head = '<div style="font-weight:700;margin-bottom:8px">Capture ready (v0.6.0)</div><div style="opacity:.7;margin-bottom:10px">Copied to clipboard. ' + (rasterCount ? rasterCount + " region(s) rasterized for fidelity. " : "") + 'If paste fails, copy the text below.</div>';
    if (warnings && warnings.length) {
      head += '<div style="color:#fc6;margin-bottom:10px;font-size:12px">' + warnings.map(function (w) { return "⚠ " + w; }).join("<br>") + "</div>";
    }
    box.innerHTML = head;
    var ta = document.createElement("textarea");
    ta.value = json;
    ta.style.cssText = "width:100%;height:220px;background:#0c0c0c;color:#9fe;border:1px solid #333;border-radius:8px;padding:10px;font:12px ui-monospace,monospace;resize:vertical";
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px";
    var copy = document.createElement("button"); copy.textContent = "Copy again";
    var close = document.createElement("button"); close.textContent = "Close";
    [copy, close].forEach(function (b) { b.style.cssText = "padding:9px 14px;border-radius:8px;border:1px solid #444;background:#222;color:#fff;cursor:pointer;font-weight:600"; });
    copy.onclick = function () { ta.select(); if (navigator.clipboard) navigator.clipboard.writeText(json).catch(function () {}); };
    close.onclick = function () { wrap.remove(); };
    row.appendChild(copy); row.appendChild(close);
    box.appendChild(ta); box.appendChild(row); wrap.appendChild(box);
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    document.documentElement.appendChild(wrap);
    ta.select();
  }

  btn.onclick = async function () {
    btn.textContent = "Capturing...";
    try {
      var data = capture();
      if (RASTER.length) { btn.textContent = "Rasterizing..."; await rasterizeAll(); }
      var json = JSON.stringify(data);
      if (navigator.clipboard) navigator.clipboard.writeText(json).catch(function () {});
      // Notify any host shell (extension content script) so it can submit to the relay.
      // Clipboard + panel stay as the offline/unpaired fallback regardless.
      try { window.dispatchEvent(new CustomEvent("designbridge:capture", { detail: data })); } catch (e) {}
      showPanel(json, RASTER.length, data.warnings);
    } catch (err) {
      alert("DesignBridge capture failed: " + err.message);
    } finally {
      btn.textContent = "Send to Figma";
    }
  };

  // Programmatic capture API. Used by the translation worker (headless) and available to host
  // shells. Returns the native capture object (rasters resolved).
  window.__designbridge_capture = async function () {
    var data = capture();
    if (RASTER.length) await rasterizeAll();
    return data;
  };

  // Test hook for the automated Playwright harness (alias of the capture API).
  window.__designbridge_test = window.__designbridge_capture;
})();
