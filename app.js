// ETF 持股進出：讀 data/index.json，任選兩天比較。
"use strict";

const S = {
  index: null, dayCache: {}, stockCache: {},
  scope: "active", tab: "focus", etfFilter: "changed",
  start: null, end: null,   // 使用者選的期間（含頭含尾的交易日）
  A: null, B: null,         // 實際比對的兩份持股：A＝起日前一個交易日收盤、B＝迄日收盤
  stock: null, etf: null,
};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const LOT = 1000;   // 1 張 = 1000 股

// ── 格式 ─────────────────────────────────────────────
const fmt0 = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const fmt1 = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 1 });
const fmt2 = new Intl.NumberFormat("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lots = (sh) => sh == null ? "—" : fmt0.format(sh / LOT);
function signed(x, f = fmt0) {
  if (x == null || !isFinite(x)) return "—";
  const s = f.format(Math.abs(x));
  if (/^0([.,]0+)?$/.test(s)) return s;          // 四捨五入後是 0 就不加正負號
  return (x > 0 ? "+" : "−") + s;
}
const cls = (x) => x > 0 ? "up" : x < 0 ? "down" : "";
function money(x) {        // 元 → 億／萬
  if (x == null || !isFinite(x)) return "—";
  const a = Math.abs(x), s = x > 0 ? "+" : x < 0 ? "−" : "";
  if (a >= 1e8) return s + fmt2.format(a / 1e8) + " 億";
  if (a >= 1e4) return s + fmt0.format(a / 1e4) + " 萬";
  return s + fmt0.format(a);
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const stockName = (c) => S.index.stocks[c] || "";
const etfName = (e) => (S.index.etfs[e] || {}).name || e;

// ── 資料 ─────────────────────────────────────────────
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}
// 單一 HTML 版：build_site 把資料塞在 window.EMBED，不需要伺服器
const EMBED = window.EMBED || null;
async function day(d) {
  if (EMBED) return EMBED.days[d];
  if (!S.dayCache[d]) S.dayCache[d] = await getJSON(`data/day/${d}.json`);
  return S.dayCache[d];
}
async function stockSeries(c) {
  if (EMBED && !(c in S.stockCache)) {        // 從每日資料算出這檔股票在各 ETF 的張數
    const out = {};
    for (const d of S.index.days) {
      const dd = EMBED.days[d];
      for (const [e, x] of Object.entries(dd.etfs)) {
        if (x.d !== d) continue;
        const h = x.h.find((r) => r[0] === c);
        if (h) (out[e] = out[e] || []).push([d, h[1]]);
      }
    }
    S.stockCache[c] = out;
  }
  if (!(c in S.stockCache)) {
    try { S.stockCache[c] = await getJSON(`data/stock/${c.replace(/ /g, "_")}.json`); }
    catch { S.stockCache[c] = {}; }
  }
  return S.stockCache[c];
}
function inScope(e) {
  const info = S.index.etfs[e];
  if (!info) return false;
  return S.scope === "all" || (S.scope === "active") === !!info.active;
}

// 一檔 ETF 在 A→B 之間每檔股票的變化
function diffEtf(e, a, b) {
  const ea = a.etfs[e], eb = b.etfs[e];
  if (!eb && !ea) return null;
  const stale = ea && eb && ea.d === eb.d;      // 兩天用的是同一份 → 投信沒更新
  const ma = new Map((ea ? ea.h : []).map((x) => [x[0], x]));
  const mb = new Map((eb ? eb.h : []).map((x) => [x[0], x]));
  const ratio = ea && eb && ea.units && eb.units ? eb.units / ea.units : null;
  const rows = [];
  for (const code of new Set([...ma.keys(), ...mb.keys()])) {
    const xa = ma.get(code), xb = mb.get(code);
    const sa = xa ? xa[1] : 0, sb = xb ? xb[1] : 0;
    const wa = xa ? xa[2] : null, wb = xb ? xb[2] : null;
    // 起始日沒有這檔 ETF 的資料（還沒上市或歷史沒回補到）→ 不能算變化
    const d = ea ? sb - sa : null;
    // 價格：收盤價，沒有就用 權重×規模÷股數 反推（海外股票）
    let px = b.px[code] ?? a.px[code];
    if (px == null && xb && wb != null && eb.aum && sb) px = (wb / 100) * eb.aum / sb;
    if (px == null && xa && wa != null && ea.aum && sa) px = (wa / 100) * ea.aum / sa;
    // 加碼／減碼看「實際張數」：台股至少 1 張（1000 股）才算；海外股票股數小，有變就算
    const minMove = /^\d/.test(code) ? LOT : 1;
    const status = !ea ? "" : sa === 0 && sb > 0 ? "new" : sb === 0 && sa > 0 ? "exit"
      : Math.abs(d) >= minMove ? (d > 0 ? "add" : "cut") : "";
    rows.push({ etf: e, code, sa, sb, wa, wb, d, px, value: px != null && d != null ? d * px : null, status });
  }
  return { e, rows, stale, ea, eb, ratio, noA: !ea };
}

async function diffAll() {
  const [a, b] = await Promise.all([day(S.A), day(S.B)]);
  const out = [];
  for (const e of Object.keys(b.etfs)) if (inScope(e)) out.push(diffEtf(e, a, b));
  return { a, b, list: out.filter(Boolean) };
}

// ── 表格 ─────────────────────────────────────────────
// cols: [{h, f(row)->html, l(左對齊), sort(row)->值}]
function table(el, cols, rows, opt = {}) {
  if (!rows.length) { el.innerHTML = `<div class="empty">${opt.empty || "沒有資料"}</div>`; return; }
  let sortI = opt.sortBy ? cols.findIndex((c) => c.h.replace(/<[^>]+>/g, "").startsWith(opt.sortBy)) : null, desc = true;
  if (sortI < 0 || (sortI != null && !cols[sortI].sort)) sortI = null;
  const draw = () => {
    let rs = rows;
    if (sortI != null && cols[sortI].sort) {
      const k = cols[sortI].sort;
      rs = [...rows].sort((x, y) => { const p = k(x) ?? -Infinity, q = k(y) ?? -Infinity; return (p > q ? 1 : p < q ? -1 : 0) * (desc ? -1 : 1); });
    }
    if (opt.limit) rs = rs.slice(0, opt.limit);
    el.innerHTML = `<div class="tbl-wrap"><table><thead><tr>${cols.map((c, i) =>
      `<th class="${c.l ? "l" : ""}" data-i="${i}">${c.h}${i === sortI ? (desc ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>${
      rs.map((r) => `<tr>${cols.map((c) => `<td class="${c.l ? "l" : ""}">${c.f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    el.querySelectorAll("th").forEach((th) => th.onclick = () => {
      const i = +th.dataset.i; if (!cols[i].sort) return;
      desc = sortI === i ? !desc : true; sortI = i; draw();
    });
  };
  draw();
}
const stockLink = (c) => `<a data-stock="${esc(c)}">${esc(c)} ${esc(stockName(c))}</a>`;
const etfLink = (e) => `<a data-etf="${esc(e)}">${esc(e)} ${esc(etfName(e))}</a>`;
const BADGE = { new: ["new", "新進"], exit: ["exit", "出清"], add: ["add", "加碼"], cut: ["cut", "減碼"] };
const badge = (s) => s ? `<span class="badge ${BADGE[s][0]}">${BADGE[s][1]}</span>` : "";
document.addEventListener("click", (ev) => {
  const s = ev.target.closest("[data-stock]"), e = ev.target.closest("[data-etf]");
  if (s) go({ tab: "stock", stock: s.dataset.stock });
  if (e) go({ tab: "etf", etf: e.dataset.etf });
});

// ── 焦點 ─────────────────────────────────────────────
async function renderFocus() {
  const { list } = await diffAll();
  const agg = new Map();
  const news = [], exits = [];
  for (const d of list) {
    if (d.stale || d.noA) continue;
    for (const r of d.rows) {
      if (!r.status) continue;
      const g = agg.get(r.code) || { code: r.code, nb: 0, ns: 0, value: 0, etfsB: [], etfsS: [] };
      if (r.status === "add" || r.status === "new") { g.nb++; g.etfsB.push(r.etf); }
      if (r.status === "cut" || r.status === "exit") { g.ns++; g.etfsS.push(r.etf); }
      g.value += r.value || 0;
      agg.set(r.code, g);
      if (r.status === "new") news.push(r);
      if (r.status === "exit") exits.push(r);
    }
  }
  const all = [...agg.values()];
  const etfList = (es) => es.map((e) => `<a data-etf="${e}">${e}</a>`).join(" ");
  table($("#f-together"), [
    { h: "股票", l: 1, f: (g) => stockLink(g.code) },
    { h: "加碼檔數", f: (g) => g.nb, sort: (g) => g.nb },
    { h: "合計金額", f: (g) => `<span class="${cls(g.value)}">${money(g.value)}</span>`, sort: (g) => g.value },
    { h: "ETF", l: 1, f: (g) => etfList(g.etfsB) },
  ], all.filter((g) => g.nb >= 2).sort((x, y) => y.nb - x.nb || y.value - x.value), { limit: 20, empty: "沒有 2 檔以上同時加碼的股票" });
  table($("#f-together-sell"), [
    { h: "股票", l: 1, f: (g) => stockLink(g.code) },
    { h: "減碼檔數", f: (g) => g.ns, sort: (g) => g.ns },
    { h: "合計金額", f: (g) => `<span class="${cls(g.value)}">${money(g.value)}</span>`, sort: (g) => g.value },
    { h: "ETF", l: 1, f: (g) => etfList(g.etfsS) },
  ], all.filter((g) => g.ns >= 2).sort((x, y) => y.ns - x.ns || x.value - y.value), { limit: 20, empty: "沒有 2 檔以上同時減碼的股票" });
  const valCols = [
    { h: "股票", l: 1, f: (g) => stockLink(g.code) },
    { h: "合計金額", f: (g) => `<span class="${cls(g.value)}">${money(g.value)}</span>`, sort: (g) => g.value },
    { h: "加碼/減碼檔數", f: (g) => `${g.nb} / ${g.ns}` },
  ];
  table($("#f-buy"), valCols, all.filter((g) => g.value > 0).sort((x, y) => y.value - x.value), { limit: 20 });
  table($("#f-sell"), valCols, all.filter((g) => g.value < 0).sort((x, y) => x.value - y.value), { limit: 20 });
  const ne = [
    { h: "股票", l: 1, f: (r) => stockLink(r.code) },
    { h: "ETF", l: 1, f: (r) => etfLink(r.etf) },
    { h: "張數", f: (r) => lots(r.sb || r.sa), sort: (r) => r.sb || r.sa },
    { h: "金額", f: (r) => money(r.value), sort: (r) => Math.abs(r.value || 0) },
  ];
  table($("#f-new"), ne, news.sort((x, y) => (y.value || 0) - (x.value || 0)), { empty: "沒有新進持股" });
  table($("#f-exit"), ne, exits.sort((x, y) => (x.value || 0) - (y.value || 0)), { empty: "沒有出清持股" });
}

// ── 個股 ─────────────────────────────────────────────
async function renderStock() {
  const c = S.stock;
  if (!c) { $("#stockHead").innerHTML = `<p class="hint">輸入股票後，會列出持有它的 ETF 與期間內的加減碼。</p>`; $("#stockTable").innerHTML = ""; $("#stockChartCard").hidden = true; return; }
  const { list, b } = await diffAll();
  const rows = [];
  for (const d of list) {
    const r = d.rows.find((x) => x.code === c);
    if (r && (r.sb > 0 || r.sa > 0)) rows.push({ ...r, stale: d.stale, noA: d.noA, date: d.eb ? d.eb.d : "" });
  }
  const tot = rows.reduce((s, r) => s + r.sb, 0), totD = rows.reduce((s, r) => s + (r.stale || r.d == null ? 0 : r.d), 0);
  $("#stockHead").innerHTML = `<div class="summary"><span><b>${esc(c)} ${esc(stockName(c))}</b></span>
    <span>持有 ETF <b>${rows.filter((r) => r.sb > 0).length}</b> 檔</span>
    <span>合計 <b>${lots(tot)}</b> 張</span>
    <span>期間合計 <b class="${cls(totD)}">${signed(totD / LOT)}</b> 張</span></div>`;
  table($("#stockTable"), [
    { h: "ETF", l: 1, f: (r) => etfLink(r.etf) },
    { h: "", l: 1, f: (r) => r.noA ? `<span class="badge stale">期初無資料</span>`
        : r.stale ? `<span class="badge stale">投信未更新</span>`
        : (r.date < S.B ? `<span class="badge stale">資料至 ${r.date.slice(5)}</span> ` : "") + badge(r.status) },
    { h: "持有張數", f: (r) => lots(r.sb), sort: (r) => r.sb },
    { h: "權重", f: (r) => r.wb == null ? "—" : fmt2.format(r.wb) + "%", sort: (r) => r.wb },
    { h: "張數變化", f: (r) => `<span class="${cls(r.d)}">${signed(r.d / LOT)}</span>`, sort: (r) => r.d },
    { h: "買賣金額", f: (r) => `<span class="${cls(r.value)}">${money(r.value)}</span>`, sort: (r) => r.value },
    { h: "資料日", f: (r) => r.date },
  ], rows, { sortBy: "持有張數", empty: "目前範圍內沒有 ETF 持有這檔股票（可切換「全部」看被動式）" });
  await drawStockChart(c);
}

async function drawStockChart(c) {
  const ser = await stockSeries(c);
  const etfs = Object.keys(ser).filter(inScope);
  if (!etfs.length) { $("#stockChartCard").hidden = true; return; }
  $("#stockChartCard").hidden = false;
  // 依最新張數排序，取前 7 檔，其餘併成「其他」
  const lastOf = (e) => (ser[e].at(-1) || [0, 0])[1];
  etfs.sort((x, y) => lastOf(y) - lastOf(x));
  const top = etfs.slice(0, 7), rest = etfs.slice(7);
  const days = S.index.days.filter((d) => d <= S.B);
  const lookup = (e) => { const m = new Map(ser[e]); return days.map((d) => m.has(d) ? m.get(d) / LOT : null); };
  const series = top.map((e, i) => ({ key: e, label: `${e} ${etfName(e)}`, color: `var(--series-${i + 1})`, v: lookup(e) }));
  if (rest.length) {
    const vs = rest.map(lookup);
    series.push({ key: "其他", label: `其他 ${rest.length} 檔`, color: "var(--series-8)", v: days.map((_, i) => { const xs = vs.map((v) => v[i]).filter((x) => x != null); return xs.length ? xs.reduce((s, x) => s + x, 0) : null; }) });
  }
  $("#stockChartTitle").textContent = `${c} ${stockName(c)}：各 ETF 持有張數`;
  const hidden = S.hiddenSeries || (S.hiddenSeries = new Set());
  const lg = $("#stockLegend");
  lg.innerHTML = series.map((s) => `<span data-k="${esc(s.key)}" class="${hidden.has(s.key) ? "off" : ""}"><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("");
  lg.querySelectorAll("span").forEach((sp) => sp.onclick = () => { const k = sp.dataset.k; hidden.has(k) ? hidden.delete(k) : hidden.add(k); drawStockChart(c); });
  lineChart($("#stockChart"), days, series.filter((s) => !hidden.has(s.key)), (v) => fmt0.format(v) + " 張");
}

// 單軸折線圖＋十字線 tooltip
function lineChart(el, xs, series, fmtV) {
  const W = Math.max(320, el.clientWidth || 800), H = 260, m = { l: 56, r: 12, t: 8, b: 26 };
  const vals = series.flatMap((s) => s.v.filter((x) => x != null));
  if (!vals.length) { el.innerHTML = `<div class="empty">期間內沒有資料</div>`; return; }
  const max = Math.max(...vals) * 1.05 || 1;
  const x = (i) => m.l + (xs.length < 2 ? 0 : i * (W - m.l - m.r) / (xs.length - 1));
  const y = (v) => m.t + (H - m.t - m.b) * (1 - v / max);
  const ticks = 4, grid = [...Array(ticks + 1)].map((_, i) => (max / ticks) * i);
  const xt = [0, Math.floor(xs.length / 3), Math.floor(2 * xs.length / 3), xs.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  const path = (v) => { let d = "", pen = false; v.forEach((p, i) => { if (p == null) { pen = false; return; } d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(p).toFixed(1); pen = true; }); return d; };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="持有張數折線圖">
    <g class="axis">${grid.map((g) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(g)}" y2="${y(g)}"/><text x="${m.l - 6}" y="${y(g) + 4}" text-anchor="end">${fmt0.format(g)}</text>`).join("")}
    ${xt.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === xs.length - 1 ? "end" : "middle"}">${xs[i].slice(2)}</text>`).join("")}</g>
    ${series.map((s) => `<path class="line" d="${path(s.v)}" stroke="${s.color}"/>`).join("")}
    <line class="cross" y1="${m.t}" y2="${H - m.b}" x1="-10" x2="-10"/>
    <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>
  </svg>`;
  const svg = el.querySelector("svg"), cross = svg.querySelector(".cross"), tip = $("#tip");
  svg.onmousemove = (ev) => {
    const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(xs.length - 1, Math.round((px - m.l) / ((W - m.l - m.r) / Math.max(1, xs.length - 1)))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    const items = series.map((s) => ({ s, v: s.v[i] })).filter((o) => o.v != null).sort((p, q) => q.v - p.v);
    tip.innerHTML = `<b>${xs[i]}</b>` + items.map((o) => `<div class="row"><span><i style="background:${o.s.color}"></i>${esc(o.s.label)}</span><span>${fmtV(o.v)}</span></div>`).join("");
    tip.hidden = false;
    tip.style.left = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = (ev.clientY + 14) + "px";
  };
  svg.onmouseleave = () => { tip.hidden = true; cross.setAttribute("x1", -10); cross.setAttribute("x2", -10); };
}

// ── ETF ──────────────────────────────────────────────
async function renderEtf() {
  const e = S.etf;
  if (!e) return;
  const [a, b] = await Promise.all([day(S.A), day(S.B)]);
  const d = diffEtf(e, a, b);
  if (!d || !d.eb) { $("#etfHead").innerHTML = `<p class="hint">${esc(e)} 在 ${S.B} 沒有資料。</p>`; $("#etfTable").innerHTML = ""; return; }
  const unitsChg = d.ratio != null ? (d.ratio - 1) * 100 : null;
  // 申贖淨流入：累計值（build_site 用 單位數變化×當日淨值 逐日加總）在兩個資料日相減
  const fl = (S.index.flows || {})[e] || {};
  const flow = d.ea && fl[d.ea.d] != null && fl[d.eb.d] != null ? fl[d.eb.d] - fl[d.ea.d] : null;
  $("#etfHead").innerHTML = `<div class="summary">
    <span><b>${esc(e)} ${esc(etfName(e))}</b>（${esc((S.index.etfs[e] || {}).issuer || "")}）</span>
    <span>資料日 <b>${d.ea ? d.ea.d : "—"}</b> → <b>${d.eb.d}</b></span>
    ${d.eb.aum ? `<span>規模 <b>${fmt1.format(d.eb.aum / 1e8)}</b> 億</span>` : ""}
    ${flow != null ? `<span title="受益權單位數變化 × 當日每單位淨值，逐日加總；不含股價漲跌">申贖淨流入 <b class="${cls(flow)}">${money(flow)}</b>${unitsChg != null ? `（單位數 ${signed(unitsChg, fmt2)}%）` : ""}</span>`
      : `<span class="muted">申贖淨流入：投信沒提供單位數，無法計算</span>`}
    ${d.stale ? `<span class="badge stale">投信還沒更新，這段期間看不到變化</span>`
      : d.eb.d < S.B ? `<span class="badge stale">投信資料只到 ${d.eb.d}</span>` : ""}</div>`;
  let rows = d.rows;
  if (S.etfFilter === "changed") rows = rows.filter((r) => r.status);
  if (S.etfFilter === "new") rows = rows.filter((r) => r.status === "new");
  if (S.etfFilter === "exit") rows = rows.filter((r) => r.status === "exit");
  table($("#etfTable"), [
    { h: "股票", l: 1, f: (r) => stockLink(r.code) },
    { h: "", l: 1, f: (r) => badge(r.status) },
    { h: `期初張數<br><span class="muted">${S.A.slice(5)} 收盤</span>`, f: (r) => lots(r.sa), sort: (r) => r.sa },
    { h: `期末張數<br><span class="muted">${S.B.slice(5)} 收盤</span>`, f: (r) => lots(r.sb), sort: (r) => r.sb },
    { h: "張數變化", f: (r) => `<span class="${cls(r.d)}">${signed(r.d / LOT)}</span>`, sort: (r) => r.d },
    { h: "權重", f: (r) => r.wb == null ? "—" : fmt2.format(r.wb) + "%", sort: (r) => r.wb },
    { h: "權重變化", f: (r) => r.wb == null || r.wa == null ? "—" : `<span class="${cls(r.wb - r.wa)}">${signed(r.wb - r.wa, fmt2)}</span>`, sort: (r) => (r.wb ?? 0) - (r.wa ?? 0) },
    { h: "買賣金額", f: (r) => `<span class="${cls(r.value)}">${money(r.value)}</span>`, sort: (r) => r.value },   // 帶正負號：由大到小＝加碼最多在上、減碼最多在下
  ], rows, { sortBy: S.etfFilter === "all" ? "權重" : "買賣金額", empty: d.stale ? "投信還沒更新，這段期間看不到變化" : "這段期間沒有符合條件的變動" });
}

// ── 資料狀態 ─────────────────────────────────────────
function renderStatus() {
  const rows = Object.entries(S.index.etfs).map(([e, i]) => ({ e, ...i }))
    .filter((r) => S.scope === "all" || (S.scope === "active") === !!r.active);
  table($("#statusTable"), [
    { h: "ETF", l: 1, f: (r) => etfLink(r.e), sort: (r) => r.e },
    { h: "投信", l: 1, f: (r) => esc(r.issuer), sort: (r) => r.issuer },
    { h: "台股比重", f: (r) => r.active ? `<span class="muted">主動式</span>` : r.tw_ratio == null ? "—" : fmt1.format(r.tw_ratio * 100) + "%", sort: (r) => r.tw_ratio },
    { h: "最新資料日", f: (r) => r.last || "—", sort: (r) => r.last },
    { h: "歷史起始", f: (r) => r.first || "—", sort: (r) => r.first },
    { h: "天數", f: (r) => r.n, sort: (r) => r.n },
    { h: "最近一次抓取", l: 1, f: (r) => r.ok == null ? "—" : r.ok ? `<span class="ok">✓ 成功</span>` : `<span class="bad">✗ 失敗</span> <span class="muted">${esc(r.error)}</span>`, sort: (r) => r.ok ? 1 : 0 },
  ], rows, { sortBy: "最近一次抓取" });
}

// ── 控制 ─────────────────────────────────────────────
function fillDates() {
  const ds = S.index.days;
  const opts = (list) => [...list].reverse().map((d) => `<option value="${d}">${d}</option>`).join("");
  $("#dateA").innerHTML = opts(ds.slice(1));      // 第一天沒有前一天可比，不能當起日
  $("#dateB").innerHTML = opts(ds.slice(1));
  $("#dateA").value = S.start; $("#dateB").value = S.end;
}
// 期間 [起日, 迄日] 的進出 ＝ 迄日收盤持股 − 起日前一個交易日收盤持股
function setRange(start, end) {
  const ds = S.index.days;
  if (start > end) [start, end] = [end, start];
  S.start = start; S.end = end;
  S.A = ds[Math.max(0, ds.indexOf(start) - 1)]; S.B = end;
  $("#dateA").value = start; $("#dateB").value = end;
  const isToday = start === end && end === ds.at(-1);
  $("#today").classList.toggle("on", isToday);
  const md = (d) => d.slice(5).replace("-", "/");
  $("#rangeNote").textContent = start === end
    ? `${md(end)} 當天的進出（${md(S.A)} 收盤 → ${md(end)} 收盤）`
    : `${md(start)}～${md(end)} 合計進出（${md(S.A)} 收盤 → ${md(end)} 收盤）`;
}
// 分頁、個股、ETF 記在網址 # 後面（例：#etf/00981A、#stock/2330），瀏覽器「上一頁」就能退回前一個畫面
const TABS = ["focus", "stock", "etf", "status"];
function hashOf(p) {
  const arg = p.tab === "stock" ? p.stock : p.tab === "etf" ? p.etf : "";
  return "#" + p.tab + (arg ? "/" + encodeURIComponent(arg) : "");
}
function go(p) {
  const h = hashOf({ tab: S.tab, stock: S.stock, etf: S.etf, ...p });
  if (location.hash === h) applyHash(); else location.hash = h;   // 改網址 → hashchange → applyHash
}
function applyHash() {
  const [t, raw] = location.hash.slice(1).split("/");
  const arg = raw ? decodeURIComponent(raw) : "";
  S.tab = TABS.includes(t) ? t : "focus";
  if (S.tab === "stock" && arg && arg !== S.stock) {
    S.stock = arg; S.hiddenSeries = new Set();
    if (!$("#stockInput").value.trim().startsWith(arg)) $("#stockInput").value = `${arg} ${stockName(arg)}`;
  }
  if (S.tab === "etf" && arg && S.index.etfs[arg]) { S.etf = arg; $("#etfSelect").value = arg; }
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
  $$(".tab").forEach((s) => s.classList.toggle("on", s.id === "tab-" + S.tab));
  render();
}
const pickEtf = (code) => go({ tab: "etf", etf: code });
const pickStock = (code) => go({ tab: "stock", stock: code });
async function render() {
  try {
    if (S.tab === "focus") await renderFocus();
    if (S.tab === "stock") await renderStock();
    if (S.tab === "etf") await renderEtf();
    if (S.tab === "status") renderStatus();
  } catch (err) { console.error(err); }
}

async function init() {
  S.index = EMBED ? EMBED.index : await getJSON("data/index.json");
  const ds = S.index.days;
  fillDates();
  setRange(ds.at(-1), ds.at(-1));
  $("#updated").textContent = `資料更新：${S.index.generated_at.replace("T", " ")}　共 ${ds.length} 個交易日（${ds[0]} 起）`;
  $("#stockList").innerHTML = Object.entries(S.index.stocks).map(([c, n]) => `<option value="${esc(c)} ${esc(n)}">`).join("");
  const etfs = Object.entries(S.index.etfs).sort((x, y) => (y[1].active - x[1].active) || x[0].localeCompare(y[0]));
  // ETF 搜尋清單：主動式在前；輸入代號或名稱的一部分都能找
  // ETF：下拉選單（主動式在前）＋ 搜尋框，兩個同步
  const opt = ([e, i]) => `<option value="${e}">${e} ${esc(i.name)}</option>`;
  $("#etfSelect").innerHTML = `<optgroup label="主動式">${etfs.filter((x) => x[1].active).map(opt).join("")}</optgroup>
    <optgroup label="被動式">${etfs.filter((x) => !x[1].active).map(opt).join("")}</optgroup>`;
  $("#etfSearchList").innerHTML = etfs.map(([e, i]) => `<option value="${e} ${esc(i.name)}">`).join("");
  S.etf = (etfs.find(([e]) => e === "00981A") || etfs[0])[0];
  $("#etfSelect").value = S.etf;

  $("#dateA").onchange = (ev) => { setRange(ev.target.value, S.end); render(); };
  $("#dateB").onchange = (ev) => { setRange(S.start, ev.target.value); render(); };
  $("#today").onclick = () => { setRange(S.index.days.at(-1), S.index.days.at(-1)); render(); };
  $$(".seg[aria-label='ETF 範圍'] button").forEach((b) => b.onclick = () => {
    S.scope = b.dataset.scope; $$(".seg[aria-label='ETF 範圍'] button").forEach((x) => x.classList.toggle("on", x === b)); render();
  });
  $$("[data-ef]").forEach((b) => b.onclick = () => { S.etfFilter = b.dataset.ef; $$("[data-ef]").forEach((x) => x.classList.toggle("on", x === b)); render(); });
  $$(".tabs button").forEach((b) => b.onclick = () => go({ tab: b.dataset.tab }));
  $("#etfSelect").onchange = (ev) => pickEtf(ev.target.value);
  // 搜尋框：打字時一對到就切換（不用按 Enter）；完整代號或從清單點選都算
  const findEtf = (raw) => {
    const v = raw.trim().toUpperCase(), code = v.split(/\s+/)[0];
    const ids = Object.keys(S.index.etfs);
    if (ids.includes(code)) return code;
    const hits = ids.filter((e) => (e + " " + etfName(e)).toUpperCase().includes(v));
    return v && hits.length === 1 ? hits[0] : null;      // 名稱只剩一檔符合時才切換
  };
  $("#etfSearch").oninput = (ev) => { const hit = findEtf(ev.target.value); if (hit && hit !== S.etf) pickEtf(hit); };
  $("#etfSearch").onchange = (ev) => { const hit = findEtf(ev.target.value); if (hit) { pickEtf(hit); ev.target.value = ""; } };
  $("#stockInput").onfocus = (ev) => ev.target.select();
  $("#stockInput").onchange = (ev) => {
    const v = ev.target.value.trim(), code = v.split(/\s+/)[0];
    const hit = S.index.stocks[code] !== undefined ? code
      : Object.keys(S.index.stocks).find((c) => S.index.stocks[c] === v || S.index.stocks[c].includes(v));
    if (hit || code) pickStock(hit || code);
  };
  // 打完完整代號（或從清單點選）就立刻切換，不用按 Enter
  $("#stockInput").oninput = (ev) => {
    const code = ev.target.value.trim().split(/\s+/)[0];
    if (S.index.stocks[code] !== undefined && code !== S.stock) pickStock(code);
  };
  addEventListener("resize", () => { if (S.tab === "stock" && S.stock) drawStockChart(S.stock); });
  addEventListener("hashchange", applyHash);
  applyHash();          // 重新整理時停在原本的分頁
}
init().catch((e) => { document.querySelector("main").innerHTML = `<div class="card">讀不到資料：${esc(e.message)}<br>請雙擊「ETF持股進出.html」或「開啟報告.vbs」開啟，或先執行 run_daily.bat。</div>`; });
