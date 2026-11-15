"use strict";
// Site map: shaded relief (canvas), borders, country labels, scale bar and clickable site pins (SVG).
// Loaded before app.js; shares its globals (BASE, LOCS, selected, el, showTip, toggle, …) at call time.
const mapEl = document.getElementById("map"), canvas = document.getElementById("relief"), msvg = document.getElementById("mapsvg");
let KX = 1, ASPECT = 1, EGRID = [];
// Decode the basemap terrain and derive the projection constants (equirectangular, x scaled by cos(mid-latitude)).
function initMapGeometry(base) {
  EGRID = Array.from(base.terrain, c => base.alphabet.indexOf(c) * base.quantum_m);
  KX = Math.cos((base.lat0 + base.lat1) / 2 * Math.PI / 180);
  ASPECT = (base.lon1 - base.lon0) * KX / (base.lat1 - base.lat0);
}
function cssVar(n) { return getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(n).trim(); }
function hex2rgb(h) { h = h.replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
const inMap = l => l.lon >= BASE.lon0 && l.lon <= BASE.lon1 && l.lat >= BASE.lat0 && l.lat <= BASE.lat1;
function drawRelief() {
  const {nx, ny} = BASE, lo = hex2rgb(cssVar("--relief-lo")), hi = hex2rgb(cssVar("--relief-hi"));
  const small = document.createElement("canvas"); small.width = nx; small.height = ny;
  const sctx = small.getContext("2d"), img = sctx.createImageData(nx, ny);
  const z = (i, j) => EGRID[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const cell = BASE.step * 111000;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const e = z(i, j), t = Math.min(1, Math.max(0, (e - 300) / 3300));
    const dzdx = (z(i + 1, j) - z(i - 1, j)) / (2 * cell * KX), dzdy = (z(i, j - 1) - z(i, j + 1)) / (2 * cell);
    const a = -dzdx * 3, b = -dzdy * 3, len = Math.hypot(a, b, 1), lx = -0.5, ly = 0.6, lz = 0.62, ll = Math.hypot(lx, ly, lz);
    const k = 0.55 + 0.55 * Math.max(0, (a * lx + b * ly + lz) / (len * ll)), p = (j * nx + i) * 4;
    for (let c = 0; c < 3; c++) img.data[p + c] = Math.max(0, Math.min(255, (lo[c] + (hi[c] - lo[c]) * t) * k));
    img.data[p + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const W = mapEl.clientWidth, H = mapEl.clientHeight, dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  const hx = BASE.step / 2 * W / (BASE.lon1 - BASE.lon0) * dpr, hy = BASE.step / 2 * H / (BASE.lat1 - BASE.lat0) * dpr;
  ctx.drawImage(small, -hx, -hy, canvas.width + 2 * hx, canvas.height + 2 * hy);
}
function drawMap() {
  const W = mapEl.clientWidth; mapEl.style.height = Math.round(W / ASPECT) + "px"; const H = mapEl.clientHeight;
  const proj = (lon, lat) => [(lon - BASE.lon0) / (BASE.lon1 - BASE.lon0) * W, (BASE.lat1 - lat) / (BASE.lat1 - BASE.lat0) * H];
  drawRelief();
  msvg.setAttribute("viewBox", `0 0 ${W} ${H}`); msvg.textContent = "";
  (BASE.borders || "").split("|").filter(Boolean).forEach(l => { const pts = l.split(" ").map(p => p.split(",").map(v => +v / 100)).map(([lo, la]) => proj(lo, la));
    el("path", {d: "M" + pts.map(p => p.map(v => v.toFixed(1)).join(",")).join("L"), fill: "none", stroke: "var(--border-line)", "stroke-width": 1.2, "stroke-dasharray": "6 3 1.5 3", opacity: .8}, msvg); });
  (BASE.labels || []).forEach(([t, lo, la]) => { const [x, y] = proj(lo, la); el("text", {x, y, class: "maptxt", "text-anchor": "middle", "letter-spacing": "2"}, msvg).textContent = t; });
  const km = 100, dlon = km / (111.32 * KX), [x0, y0] = proj(BASE.lon0 + 0.08, BASE.lat0 + 0.12), [x1] = proj(BASE.lon0 + 0.08 + dlon, BASE.lat0);
  el("line", {x1: x0, x2: x1, y1: y0, y2: y0, stroke: "var(--text-muted)", "stroke-width": 2}, msvg);
  el("text", {x: (x0 + x1) / 2, y: y0 - 5, class: "scale", "text-anchor": "middle"}, msvg).textContent = km + " km";
  const pins = LOCS.filter(inMap).map(l => {
    const [x, y] = proj(l.lon, l.lat), idx = selected.indexOf(l.id), on = idx >= 0, r = on ? 7.5 : 4.5;
    const g = el("g", {class: "pin" + (on ? " on" : ""), tabindex: 0, role: "button", "aria-pressed": on, "data-loc": l.id, "aria-label": `${l.name}, village ${l.ground}m${on ? ", selected " + (idx + 1) : ""}`}, msvg);
    el("circle", {class: "hit", cx: x, cy: y, r: 16}, g);
    el("circle", {class: "dot", cx: x, cy: y, r}, g);
    if (on) el("text", {class: "num", x, y: y + 3.3, "text-anchor": "middle"}, g).textContent = idx + 1;
    g.addEventListener("click", () => toggle(l.id));
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(l.id); } });
    g.addEventListener("pointermove", ev => showTip(`<b>${esc(l.name)}</b>${l.cc ? " (" + esc(l.cc) + ")" : ""}` + row("Village", nf0(l.ground) + "m") + row("Series", altsOf(l.id).map(a => nf0(a) + "m").join(", ")) + `<div style="margin-top:4px;opacity:.75">${on ? "Click to deselect" : "Click to select"}</div>`, ev));
    g.addEventListener("pointerleave", hideTip);
    return {l, x, y, r, on, g};
  });
  placeLabels(pins, W, H);
}
// Greedy label placement: selected sites first, then top to bottom; each label takes the first
// candidate position that overlaps no dot, no earlier label and stays inside the map, else the least bad one.
function placeLabels(pins, W, H) {
  const LH = 12, PAD = 2;
  const boxes = pins.map(p => ({x0: p.x - p.r - PAD, y0: p.y - p.r - PAD, x1: p.x + p.r + PAD, y1: p.y + p.r + PAD}));
  const ov = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const out = b => Math.max(0, -b.x0) + Math.max(0, b.x1 - W) + Math.max(0, -b.y0) + Math.max(0, b.y1 - H);
  [...pins].sort((a, b) => b.on - a.on || a.y - b.y).forEach(p => {
    const t = el("text", {class: "lbl"}, p.g); t.textContent = p.l.name;
    const w = t.getComputedTextLength() || p.l.name.length * 6, d = p.r + 3, dg = p.r - 1, far = p.r + 14;
    // [dx, dy of label centre line, anchor, leader line?]
    const cands = [[d, 0, "start"], [-d, 0, "end"], [dg, -LH * .8, "start"], [dg, LH * .8, "start"], [-dg, -LH * .8, "end"], [-dg, LH * .8, "end"],
      [0, -(p.r + 6), "middle"], [0, p.r + 7, "middle"], [far, -LH * 1.7, "start", 1], [far, LH * 1.7, "start", 1], [-far, -LH * 1.7, "end", 1], [-far, LH * 1.7, "end", 1]];
    let best = null;
    cands.forEach(([dx, dy, anchor, lead], k) => {
      const lx = p.x + dx, cy = p.y + dy, x0 = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
      const b = {x0: x0 - PAD, y0: cy - LH / 2, x1: x0 + w + PAD, y1: cy + LH / 2};
      const own = pins.indexOf(p);   // a label may touch its own dot's clearance box
      const cost = boxes.reduce((s, o, j) => s + (j === own ? 0 : ov(b, o)), 0) + out(b) * 50 + k * 2 + (lead ? 80 : 0);
      if (!best || cost < best.cost) best = {cost, lx, cy, anchor, lead, b};
    });
    t.setAttribute("x", best.lx); t.setAttribute("y", best.cy + 4); t.setAttribute("text-anchor", best.anchor);
    if (best.lead) { const tx = best.anchor === "end" ? best.b.x1 : best.b.x0, ang = Math.atan2(best.cy - p.y, tx - p.x);
      p.g.insertBefore(el("line", {x1: p.x + Math.cos(ang) * (p.r + 1), y1: p.y + Math.sin(ang) * (p.r + 1), x2: tx, y2: best.cy, stroke: "var(--text-muted)", "stroke-width": 1}), t); }
    boxes.push(best.b);
  });
}
