/* DesignBridge content script — runs INSIDE the *.claudeusercontent.com iframe
 * Phase 4.0: capture rendered DOM + computed styles, with a CONFIDENCE MODEL.
 * Native-safe nodes (solid/linear-gradient fills, text, svg, images, borders,
 * radius, shadows) are rebuilt as editable Figma layers. Anything we can't
 * reproduce exactly (transforms, filters, blend modes, clip-path/mask,
 * radial/conic/url/repeating backgrounds, canvas/video) is RASTERIZED to a
 * pixel-perfect PNG via SVG foreignObject so ANY design clones faithfully.
 */
(function () {
  if (window.__designbridge_injected) return;
  window.__designbridge_injected = true;
  if (!document.body || document.body.children.length === 0) return;

  var _cv = document.createElement("canvas");
  var _ctx = _cv.getContext("2d");
  var RASTER = []; // {node, el} queued for rasterization (els kept off the JSON)

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
  function rgbaStr(c) { if (!c) return "rgba(0,0,0,0)"; var a = c.a == null ? 1 : c.a; return "rgba(" + Math.round(c.r*255) + "," + Math.round(c.g*255) + "," + Math.round(c.b*255) + "," + a + ")"; }
  function normalizeGradient(str) {
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
          var dpr = 2, c = document.createElement("canvas");
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
        else { item.node.raster = false; } // failed -> degrade to plain frame
      } catch (e) { item.node.raster = false; }
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

  function captureNode(el, rootRect) {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return null;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    var directText = Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; })
      .map(function (n) { return n.textContent; }).join("").replace(/\s+/g, " ").trim();
    var bgImg = cs.backgroundImage && cs.backgroundImage.indexOf("gradient") >= 0 ? normalizeGradient(cs.backgroundImage) : null;
    var shadow = cs.boxShadow && cs.boxShadow !== "none" ? cs.boxShadow : null;
    var node = {
      tag: el.tagName.toLowerCase(),
      x: Math.round(r.x - rootRect.x), y: Math.round(r.y - rootRect.y),
      w: Math.round(r.width), h: Math.round(r.height),
      style: {
        display: cs.display, flexDirection: cs.flexDirection,
        gap: px(cs.columnGap) || px(cs.gap) || 0,
        justifyContent: cs.justifyContent, alignItems: cs.alignItems,
        padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
        bg: toColor(cs.backgroundColor), bgImage: bgImg, color: toColor(cs.color),
        overflow: (cs.overflowX !== "visible" || cs.overflowY !== "visible") ? "clip" : "visible",
        fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
        fontSize: px(cs.fontSize), fontWeight: cs.fontWeight,
        lineHeight: px(cs.lineHeight) || null, letterSpacing: px(cs.letterSpacing) || 0,
        textAlign: cs.textAlign,
        radius: [px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius), px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius)],
        borderWidth: px(cs.borderTopWidth), borderColor: toColor(cs.borderTopColor),
        boxShadow: shadow, opacity: parseFloat(cs.opacity)
      },
      text: directText || null,
      children: []
    };
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

    // CONFIDENCE GATE: un-representable node -> rasterize (bake subtree to image).
    if (needsRaster(el, cs)) {
      node.raster = true; node.text = null; node.children = [];
      RASTER.push({ node: node, el: el });
      return node;
    }

    for (var i = 0; i < el.children.length; i++) {
      var c = captureNode(el.children[i], rootRect);
      if (c) node.children.push(c);
    }
    var hasVisual = node.style.bg || node.style.bgImage || node.style.boxShadow || (node.style.borderWidth > 0);
    if (!node.children.length && !node.text && !hasVisual && (node.w < 1 || node.h < 1)) return null;
    return node;
  }

  function capture() {
    RASTER = [];
    var root = document.body;
    var rootRect = root.getBoundingClientRect();
    return {
      _designbridge: true, version: "0.4.0", capturedAt: new Date().toISOString(),
      sourceUrl: location.href,
      viewport: { w: window.innerWidth, h: Math.round(rootRect.height) },
      tree: captureNode(root, rootRect)
    };
  }

  var btn = document.createElement("button");
  btn.textContent = "Send to Figma";
  btn.style.cssText = "position:fixed;z-index:2147483647;bottom:20px;right:20px;padding:12px 18px;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:10px;font:600 14px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.35)";
  document.documentElement.appendChild(btn);

  function showPanel(json, rasterCount) {
    var wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;z-index:2147483647;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    var box = document.createElement("div");
    box.style.cssText = "width:min(680px,90vw);background:#161616;color:#eee;border-radius:14px;padding:18px;font:14px system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5)";
    box.innerHTML = '<div style="font-weight:700;margin-bottom:8px">Capture ready</div><div style="opacity:.7;margin-bottom:10px">Copied to clipboard. ' + (rasterCount ? rasterCount + " region(s) rasterized for fidelity. " : "") + 'If paste fails, copy the text below.</div>';
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
      showPanel(json, RASTER.length);
    } catch (err) {
      alert("DesignBridge capture failed: " + err.message);
    } finally {
      btn.textContent = "Send to Figma";
    }
  };
})();
