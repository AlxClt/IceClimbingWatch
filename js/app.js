"use strict";
const DATA_DAILY = "data/v_series_daily_21d.csv";
const DATA_BASEMAP = "data/basemap.json";
const MAX_SELECTED = 3;
const DEFAULT_SELECTED_NAMES = ["Chamonix", "Cogne", "Kandersteg"];   // used when present in the data

// ---- CSV (RFC 4180: quoted fields, "" escapes, CRLF/LF) -------------------------------
function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.filter(r => r.length > 1 || r[0] !== "").map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const TEXT_COLS = new Set(["location_name", "country", "timezone", "type", "source_name", "source_point_id", "model", "date_local", "first_date", "last_date"]);
function typed(o) { const t = {}; for (const [k, v] of Object.entries(o)) t[k] = TEXT_COLS.has(k) ? (v === "" ? null : v) : (v === "" ? null : Number(v)); return t; }
function need(rows, cols, file) { const miss = cols.filter(c => !(c in (rows[0] || {}))); if (miss.length) throw new Error(`${file}: missing column(s) ${miss.join(", ")}`); }

// ---- globals filled by init() -------------------------------------------------------------------
let LOCS = [], LOC = {}, BYKEY = {}, DAYS = [], ALT_OPTS = ["village"], DOM = {}, BASE = null;
const fmtD = d => new Date(d + "T00:00Z").toLocaleDateString("en-GB", {day: "numeric", month: "short", timeZone: "UTC"});
const fmtW = d => new Date(d + "T00:00Z").toLocaleDateString("en-GB", {weekday: "short", day: "numeric", month: "short", timeZone: "UTC"});
const nf1 = v => v == null ? "–" : v.toLocaleString("en-GB", {minimumFractionDigits: 1, maximumFractionDigits: 1});
const nf0 = v => v == null ? "–" : Math.round(v).toLocaleString("en-GB", {useGrouping: false});

function buildModel(daily) {
  need(daily, ["series_id", "location_id", "location_name", "latitude", "longitude", "ground_elevation_m", "type", "elevation_m", "point_latitude", "point_longitude", "point_elevation_m", "date_local", "n_hours", "t_min_c", "t_max_c", "hours_above_0c", "hours_air_le_0c", "precip_mm", "rain_mm", "snow_we_mm", "fl_min_m", "fl_mean_m", "fl_max_m", "hours_fl_below_alt", "night_clear_h", "night_partial_h", "night_cloudy_h", "night_cloud_mean_pct"], DATA_DAILY);
  const rows = daily.map(typed), fc = rows.filter(r => r.type === "forecast"), other = rows.length - fc.length;
  const srcNames = [...new Set(fc.map(r => r.source_name).filter(Boolean))];
  document.getElementById("srcnote").textContent = `Source: ${srcNames.join(", ") || "–"}` + (other ? ` · ${other} non-forecast daily rows ignored.` : "");
  const locMap = new Map();
  for (const r of fc) {
    if (!locMap.has(r.location_id)) locMap.set(r.location_id, {id: r.location_id, name: r.location_name, cc: r.country || "", lat: r.latitude, lon: r.longitude, ground: r.ground_elevation_m});
    const key = r.location_id + ":" + r.elevation_m;
    const s = BYKEY[key] ??= {id: r.series_id, loc: r.location_id, elev: r.elevation_m, plat: r.point_latitude, plon: r.point_longitude, celev: r.point_elevation_m, byDate: {}};
    if (s.id !== r.series_id) console.warn(`Two forecast series at ${key}: keeping series ${s.id}, ignoring ${r.series_id}`);
    else s.byDate[r.date_local] = {
      nh: r.n_hours, tmin: r.t_min_c, tmax: r.t_max_c, h0: r.hours_above_0c, hle0: r.hours_air_le_0c,
      p: r.precip_mm, liq: r.rain_mm, sol: r.snow_we_mm, flmin: r.fl_min_m, flmean: r.fl_mean_m, flmax: r.fl_max_m, fb: r.hours_fl_below_alt,
      clear: r.night_clear_h, partial: r.night_partial_h, cloudy: r.night_cloudy_h, cc: r.night_cloud_mean_pct};
  }
  LOCS = [...locMap.values()].sort((a, b) => a.id - b.id);
  LOC = Object.fromEntries(LOCS.map(l => [l.id, l]));
  DAYS = [...new Set(fc.map(r => r.date_local))].sort();           // union of all series' days
  for (const s of Object.values(BYKEY)) s.days = DAYS.map(d => s.byDate[d] || null);
  const lists = [...new Set(Object.values(BYKEY).filter(s => s.elev !== LOC[s.loc].ground).map(s => s.elev))].sort((a, b) => a - b);
  ALT_OPTS = ["village", ...lists];
  const all = Object.values(BYKEY).flatMap(s => s.days).filter(Boolean);
  const ext = (f, g) => { const v = all.map(f).filter(x => x != null); return v.length ? g(...v) : 0; };
  const niceDom = (lo, hi, step) => [Math.floor(lo / step) * step, Math.max(Math.ceil(hi / step) * step, Math.floor(lo / step) * step + step)];
  const maxH = Math.max(24, ext(d => d.nh, Math.max));
  DOM = { temp: niceDom(ext(d => d.tmin, Math.min), ext(d => d.tmax, Math.max), 5), h: [0, maxH],
          fl: niceDom(ext(d => d.flmin, Math.min), ext(d => d.flmax, Math.max), 500),
          precip: niceDom(0, ext(d => d.p, Math.max), 10),
          night: [0, Math.max(5, ext(d => (d.clear ?? 0) + (d.partial ?? 0) + (d.cloudy ?? 0), Math.max))] };
  document.getElementById("sub").textContent = `Updated daily - current view from ${fmtD(DAYS[0])} to ${fmtD(DAYS[DAYS.length - 1])} ${DAYS[0].slice(0, 4)}`;
}
const ticks = (d, step) => { const t = []; for (let v = d[0]; v <= d[1] + 1e-9; v += step) t.push(v); return t; };
const seriesFor = (locId, alt) => BYKEY[locId + ":" + (alt === "village" ? LOC[locId].ground : alt)] || null;
const altsOf = locId => Object.values(BYKEY).filter(s => s.loc === locId).map(s => s.elev).sort((a, b) => a - b);

// ---- state --------------------------------------------------------------------------------
let selected = [], alt = "village";
function loadSel() {
  try { const s = JSON.parse(localStorage.getItem("iceSel") || "null"); if (Array.isArray(s) && s.length <= MAX_SELECTED && s.every(x => LOC[x])) return s; } catch (e) {}
  const byName = DEFAULT_SELECTED_NAMES.map(n => LOCS.find(l => l.name === n)).filter(Boolean).map(l => l.id);
  return (byName.length ? byName : LOCS.map(l => l.id)).slice(0, MAX_SELECTED);
}
function saveSel() { try { localStorage.setItem("iceSel", JSON.stringify(selected)); } catch (e) {} }

// ---- svg helpers ----------------------------------------------------------------------------
const NS = "http://www.w3.org/2000/svg";
function el(tag, attrs = {}, parent) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; }
const lin = (d0, d1, r0, r1) => v => r0 + (v - d0) / (d1 - d0) * (r1 - r0);
function barPath(x, w, yt, yb, r = 2) { const h = yb - yt; if (!(h > 0.5)) return ""; r = Math.min(r, w / 2, h); return `M${x},${yb}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + w - r}Q${x + w},${yt} ${x + w},${yt + r}V${yb}Z`; }
const tip = document.getElementById("tip");
function showTip(html, ev) { tip.innerHTML = html; tip.style.opacity = 1; const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight; let x = ev.clientX + pad, y = ev.clientY + pad; if (x + w > innerWidth - 8) x = ev.clientX - w - pad; if (y + h > innerHeight - 8) y = ev.clientY - h - pad; tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px"; }
function hideTip() { tip.style.opacity = 0; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const row = (k, v) => `<div class="r"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
const noData = i => `<b>${fmtW(DAYS[i])}</b><div>No data for this day</div>`;

function frame(container, height, dom, tks, unit, title) {
  const N = DAYS.length, W = Math.max(260, container.clientWidth);
  const m = {l: 42, r: 8, t: title ? 18 : 6, b: 20};
  const svg = el("svg", {width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": title || ""});
  const bw = (W - m.l - m.r) / N, y = lin(dom[0], dom[1], height - m.b, m.t);
  if (title) el("text", {x: m.l, y: 11, class: "ttl"}, svg).textContent = title;
  tks.forEach(v => { el("line", {x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: "var(--grid)"}, svg); el("text", {x: m.l - 6, y: y(v) + 3.5, "text-anchor": "end"}, svg).textContent = v.toLocaleString("en-GB", {useGrouping: false}) + (unit || ""); });
  el("line", {x1: m.l, x2: W - m.r, y1: height - m.b, y2: height - m.b, stroke: "var(--axis)"}, svg);
  const lab = [...new Set([0, ...Array.from({length: Math.floor((N - 1) / 7)}, (_, k) => (k + 1) * 7).filter(i => i < N - 3), N - 1])];
  lab.forEach(i => { const last = i === N - 1; el("text", {x: last ? W - m.r : m.l + (i + .5) * bw, y: height - 5, "text-anchor": last ? "end" : "middle"}, svg).textContent = fmtD(DAYS[i]); });
  const hl = el("rect", {y: m.t, height: height - m.b - m.t, width: bw, fill: "var(--hover)", opacity: 0, rx: 3}, svg);
  const marks = el("g", {}, svg);
  container.appendChild(svg);
  return { svg, marks, bw, y, m, W, x: i => m.l + i * bw, base: height - m.b,
    addHover(htmlFor) { const g = el("g", {}, svg); for (let i = 0; i < N; i++) { const r = el("rect", {x: m.l + i * bw, y: m.t, width: bw, height: height - m.b - m.t, fill: "transparent"}, g);
      const on = ev => { hl.setAttribute("x", m.l + i * bw); hl.setAttribute("opacity", 1); showTip(htmlFor(i), ev); };
      r.addEventListener("pointermove", on); r.addEventListener("pointerdown", on); r.addEventListener("pointerleave", () => { hl.setAttribute("opacity", 0); hideTip(); }); } } };
}
const has = v => v != null && !Number.isNaN(v);
// path through consecutive non-null points (gaps break the line)
function linePath(pts) { let d = "", pen = false; for (const p of pts) { if (!p) { pen = false; continue; } d += (pen ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1); pen = true; } return d; }

const DRAW = {
  temp(chart, s) {
    const d = s.days, f = frame(chart, 170, DOM.temp, ticks(DOM.temp, 5), "°", "Min–max °C");
    if (DOM.temp[0] < 0 && DOM.temp[1] > 0) el("line", {x1: f.m.l, x2: f.W - f.m.r, y1: f.y(0), y2: f.y(0), stroke: "var(--text-muted)", "stroke-dasharray": "3 3"}, f.marks);
    const w = Math.max(3, Math.min(10, f.bw * .5));
    d.forEach((r, i) => { if (!r || !has(r.tmin) || !has(r.tmax)) return; el("rect", {x: f.x(i) + (f.bw - w) / 2, width: w, y: f.y(r.tmax), height: Math.max(2, f.y(r.tmin) - f.y(r.tmax)), rx: Math.min(3, w / 2), fill: "var(--s1)"}, f.marks); });
    const tp = i => !d[i] ? noData(i) : `<b>${fmtW(DAYS[i])}</b>` + row("Min", nf1(d[i].tmin) + " °C") + row("Max", nf1(d[i].tmax) + " °C") + row("Hours > 0 °C", `${nf0(d[i].h0)} / ${nf0(d[i].nh)}`);
    f.addHover(tp);
    const g = frame(chart, 96, DOM.h, [0, 12, 24], "h", "Hours above 0 °C"), w2 = Math.max(3, g.bw - 2);
    d.forEach((r, i) => { if (!r || !has(r.h0)) return; const p = barPath(g.x(i) + (g.bw - w2) / 2, w2, g.y(r.h0), g.base); if (p) el("path", {d: p, fill: "var(--s2)"}, g.marks); });
    g.addHover(tp);
  },
  fl(chart, s) {
    const d = s.days, f = frame(chart, 190, DOM.fl, ticks(DOM.fl, DOM.fl[1] - DOM.fl[0] > 3000 ? 1000 : 500), "", "Metres above sea level"), cx = i => f.x(i) + f.bw / 2;
    // band drawn per run of consecutive days with data
    let run = [];
    const flush = () => { if (run.length > 1) el("path", {d: "M" + run.map(i => `${cx(i)},${f.y(d[i].flmax)}`).join("L") + "L" + run.slice().reverse().map(i => `${cx(i)},${f.y(d[i].flmin)}`).join("L") + "Z", fill: "var(--band)", opacity: .75}, f.marks); run = []; };
    d.forEach((r, i) => { if (r && has(r.flmin) && has(r.flmax)) run.push(i); else flush(); }); flush();
    el("path", {d: linePath(d.map((r, i) => r && has(r.flmean) ? [cx(i), f.y(r.flmean)] : null)), fill: "none", stroke: "var(--line)", "stroke-width": 2, "stroke-linejoin": "round"}, f.marks);
    if (s.elev >= DOM.fl[0] && s.elev <= DOM.fl[1]) {
      el("line", {x1: f.m.l, x2: f.W - f.m.r, y1: f.y(s.elev), y2: f.y(s.elev), stroke: "var(--s2)", "stroke-width": 2, "stroke-dasharray": "5 4"}, f.marks);
      el("text", {x: f.W - f.m.r, y: f.y(s.elev) - 5, "text-anchor": "end", style: "fill:var(--text-secondary);font-weight:600;stroke:var(--surface-1);stroke-width:3px;paint-order:stroke"}, f.marks).textContent = nf0(s.elev) + "m";
    }
    const tp = i => !d[i] ? noData(i) : `<b>${fmtW(DAYS[i])}</b>` + row("Min", nf0(d[i].flmin) + "m") + row("Mean", nf0(d[i].flmean) + "m") + row("Max", nf0(d[i].flmax) + "m") + row(`h 0 °C level < ${nf0(s.elev)}m`, `${nf0(d[i].fb)} / ${nf0(d[i].nh)}`) + row("h air ≤ 0 °C", `${nf0(d[i].hle0)} / ${nf0(d[i].nh)}`);
    f.addHover(tp);
    const g = frame(chart, 110, DOM.h, [0, 12, 24], "h", `Freezing hours at ${nf0(s.elev)}m`), w = Math.max(3, g.bw - 2);
    d.forEach((r, i) => { if (!r) return; const x = g.x(i) + (g.bw - w) / 2;
      if (has(r.fb)) { const p = barPath(x, w, g.y(r.fb), g.base); if (p) el("path", {d: p, fill: "var(--s1)"}, g.marks); }
      if (has(r.hle0)) el("rect", {x: x - 1, y: g.y(r.hle0) - 2.5, width: w + 2, height: 5, rx: 1.5, fill: "var(--s2)", stroke: "var(--surface-1)", "stroke-width": 1}, g.marks); });
    g.addHover(tp);
  },
  precip(chart, s) {
    const d = s.days, f = frame(chart, 180, DOM.precip, ticks(DOM.precip, DOM.precip[1] > 40 ? 20 : 10), "", "mm per day"), w = Math.max(3, f.bw - 2);
    d.forEach((r, i) => { if (!r || !has(r.p)) return; const x = f.x(i) + (f.bw - w) / 2;
      if (!has(r.liq)) { const p = barPath(x, w, f.y(r.p), f.base); if (p) el("path", {d: p, fill: "var(--text-muted)"}, f.marks); return; }   // phase unknown
      const sol = has(r.sol) ? r.sol : 0, yl = f.y(r.liq), yt = f.y(r.liq + sol);
      if (r.liq > 0 && f.base - yl > .3) el("path", {d: sol > 0 ? `M${x},${f.base}V${yl}H${x + w}V${f.base}Z` : barPath(x, w, yl, f.base), fill: "var(--s1)"}, f.marks);
      if (sol > 0) { const b = r.liq > 0 ? yl - 2 : f.base, p = barPath(x, w, Math.min(yt, b - 1), b); if (p) el("path", {d: p, fill: "var(--s3)"}, f.marks); } });
    f.addHover(i => { const r = d[i]; if (!r) return noData(i); return `<b>${fmtW(DAYS[i])}</b>` + row("Total", nf1(r.p) + " mm") + row("Rain", nf1(r.liq) + " mm") + row("Snow (w.e.)", nf1(r.sol) + " mm") + (r.p > 0 && has(r.sol) ? row("Snow share", nf0(100 * r.sol / r.p) + " %") : ""); });
  },
  night(chart, s) {
    const d = s.days, f = frame(chart, 160, DOM.night, ticks(DOM.night, 5), "h", "Night hours"), w = Math.max(3, f.bw - 2);
    d.forEach((r, i) => { if (!r) return; const x = f.x(i) + (f.bw - w) / 2; let acc = 0;
      const segs = [["clear", "var(--o1)"], ["partial", "var(--o2)"], ["cloudy", "var(--o3)"]].filter(([k]) => has(r[k]) && r[k] > 0);
      segs.forEach(([k, c], j) => { const yb = f.y(acc) - (acc > 0 ? 2 : 0), yt = f.y(acc + r[k]); acc += r[k];
        if (yb - yt > .3) el("path", {d: j === segs.length - 1 ? barPath(x, w, yt, yb) : `M${x},${yb}V${yt}H${x + w}V${yb}Z`, fill: c, stroke: "var(--axis)", "stroke-width": .75}, f.marks); }); });
    f.addHover(i => { const r = d[i]; if (!r) return noData(i); const n = new Date(Date.parse(DAYS[i] + "T00:00Z") + 864e5).toISOString().slice(0, 10);
      return `<b>Night ${fmtD(DAYS[i])} → ${fmtD(n)}</b>` + row("Clear", nf0(r.clear) + " h") + row("Partial", nf0(r.partial) + " h") + row("Cloudy", nf0(r.cloudy) + " h") + row("Mean cover", nf0(r.cc) + " %"); });
  }
};

let msgT;
function say(t) { const m = document.getElementById("msg"); m.textContent = t; clearTimeout(msgT); if (t) msgT = setTimeout(() => m.textContent = "", 4000); }
function toggle(id) {
  const i = selected.indexOf(id);
  if (i >= 0) { selected.splice(i, 1); say(""); }
  else if (selected.length >= MAX_SELECTED) { say(`Max ${MAX_SELECTED} sites: deselect one before adding ${LOC[id].name}.`); return; }
  else { selected.push(id); say(""); }
  saveSel(); hideTip(); drawMap();
  msvg.querySelector(`.pin[data-loc="${id}"]`)?.focus({preventScroll: true});
  renderSide(); render();
}
function renderSide() {
  const ul = document.getElementById("sellist"); ul.textContent = "";
  if (!selected.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "No site selected."; ul.appendChild(li); }
  selected.forEach((id, i) => { const l = LOC[id], li = document.createElement("li");
    const b = document.createElement("span"); b.className = "badge"; b.textContent = i + 1;
    const n = document.createElement("span"); n.textContent = l.name;
    const m = document.createElement("span"); m.className = "meta"; m.textContent = `${l.cc ? l.cc + " · " : ""}village ${nf0(l.ground)}m${inMap(l) ? "" : " · outside map"}`;
    const x = document.createElement("button"); x.type = "button"; x.className = "rm"; x.textContent = "×"; x.title = "Remove"; x.setAttribute("aria-label", "Remove " + l.name); x.addEventListener("click", () => toggle(id));
    li.append(b, n, m, x); ul.appendChild(li); });
  // sites outside the basemap extent can still be added from here
  const off = LOCS.filter(l => !inMap(l) && !selected.includes(l.id));
  off.forEach(l => { const li = document.createElement("li"); const n = document.createElement("span"); n.className = "meta"; n.textContent = `${l.name} (outside map)`;
    const x = document.createElement("button"); x.type = "button"; x.textContent = "Add"; x.addEventListener("click", () => toggle(l.id)); li.append(n, x); ul.appendChild(li); });
}

// ---- cards ----------------------------------------------------------------------------------
function render() {
  const todo = [];
  document.querySelectorAll(".grid").forEach(grid => {
    const kind = grid.dataset.kind; grid.textContent = "";
    if (!selected.length) { const p = document.createElement("p"); p.className = "desc"; p.textContent = `Select up to ${MAX_SELECTED} sites on the map.`; grid.appendChild(p); return; }
    selected.forEach((id, i) => {
      const l = LOC[id], s = seriesFor(id, alt), cellKind = kind === "precip" || kind === "night";
      const card = document.createElement("div"); card.className = "card"; card.id = `${kind}-${l.id}`;
      const h = document.createElement("h3"); const b = document.createElement("span"); b.className = "badge"; b.textContent = i + 1;
      const n = document.createElement("span"); n.textContent = !s ? `${l.name} · ${nf0(alt === "village" ? l.ground : alt)}m` : cellKind ? `${l.name} · grid cell ${nf0(s.celev)}m` : `${l.name} · ${nf0(s.elev)}m`; h.append(b, n);
      card.appendChild(h);
      if (!s) { const na = document.createElement("div"); na.className = "na";
        na.textContent = (alt !== "village" && alt < l.ground ? `No data at ${nf0(alt)}m: it is below the village (${nf0(l.ground)}m).` : `No data at ${nf0(alt === "village" ? l.ground : alt)}m.`) + ` Available: ${altsOf(id).map(a => nf0(a) + "m").join(", ")}.`;
        card.appendChild(na); grid.appendChild(card); return; }
      const gap = document.createElement("div"); gap.className = "gap";
      const chart = document.createElement("div"); chart.className = "chart";
      const c = document.createElement("div"); c.className = "cell"; c.textContent = `Grid cell altitude: ${nf0(s.celev)}m`;
      card.append(gap, chart); if (!cellKind) card.appendChild(c); grid.appendChild(card);
      todo.push(() => DRAW[kind](chart, s));
    });
  });
  todo.forEach(f => f());
}

// ---- altitude control ---------------------------------------------------------------------------
const seg = document.getElementById("altSeg");
function buildAltButtons() {
  seg.textContent = "";
  ALT_OPTS.forEach(a => { const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "radio"); b.dataset.alt = a; b.textContent = a === "village" ? "Village" : nf0(a) + "m";
    b.addEventListener("click", () => setAlt(a, true));
    b.addEventListener("keydown", e => { const k = ALT_OPTS.indexOf(alt), n = ALT_OPTS.length;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setAlt(ALT_OPTS[(k + 1) % n], true); seg.children[(k + 1) % n].focus(); }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setAlt(ALT_OPTS[(k + n - 1) % n], true); seg.children[(k + n - 1) % n].focus(); } });
    seg.appendChild(b); });
}
function setAlt(a, push) { alt = a; [...seg.children].forEach(b => { const on = b.dataset.alt === String(a); b.setAttribute("aria-checked", on); b.tabIndex = on ? 0 : -1; });
  if (push) { try { history.replaceState(null, "", "#alt-" + a); } catch (e) {} }
  hideTip(); renderSide(); render(); }
function fromHash() { const m = /^#alt-(village|\d+)$/.exec(location.hash); if (!m) return "village"; return m[1] === "village" ? "village" : (ALT_OPTS.includes(+m[1]) ? +m[1] : "village"); }

// ---- boot ---------------------------------------------------------------------------------------
async function fetchText(url) { const r = await fetch(url, {cache: "no-cache"}); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.text(); }
async function init() {
  try {
    const [d, b] = await Promise.all([fetchText(DATA_DAILY), fetchText(DATA_BASEMAP)]);
    BASE = JSON.parse(b);
    initMapGeometry(BASE);
    buildModel(parseCSV(d));
    if (!LOCS.length) throw new Error(`${DATA_DAILY}: no forecast rows`);
  } catch (e) {
    const box = document.getElementById("loaderr"); box.hidden = false;
    box.textContent = `Could not load the data (${e.message}).` + (location.protocol === "file:" ? " Browsers block loading files from a page opened with file://; serve the folder over HTTP, e.g. `python3 -m http.server`, or use GitHub Pages." : "");
    document.getElementById("sub").textContent = "";
    return;
  }
  selected = loadSel();
  buildAltButtons();
  addEventListener("hashchange", () => setAlt(fromHash(), false));
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { drawMap(); render(); }, 120); });
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => drawMap()); } catch (e) {}
  try { new MutationObserver(() => drawMap()).observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]}); } catch (e) {}
  drawMap(); setAlt(fromHash(), false);
}
init();
