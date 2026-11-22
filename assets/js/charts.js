// Small SVG charts drawn by hand: thin marks, hairline grid, a hover/tap/focus tooltip on every
// mark and a table twin for each chart. Colours come from CSS tokens (validated categorical order).
import { esc, num, showTip, hideTip, parseDay, today, fmtDate } from './util.js';

const mounted = [];
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => mounted.forEach((draw) => draw()), 120);
});
/** Forget charts from the previous screen. */
export function clearCharts() { mounted.length = 0; hideTip(); }

function mount(el, draw) {
  const safe = () => { if (el.isConnected && el.clientWidth > 0) draw(); };
  mounted.push(safe);
  safe();
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) || 10 * pow;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Column with a 4px rounded data-end and a square foot on the baseline. */
function columnPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function bindTips(svg, tipFor) {
  const show = (g, ev) => {
    const r = g.getBoundingClientRect();
    const x = ev && ev.clientX != null && ev.type !== 'focus' ? ev.clientX : r.left + r.width / 2;
    showTip(tipFor(+g.dataset.i), x, r.top + Number(g.dataset.top || 0));
  };
  svg.querySelectorAll('g.col').forEach((g) => {
    g.addEventListener('pointerenter', (e) => show(g, e));
    g.addEventListener('pointermove', (e) => show(g, e));
    g.addEventListener('pointerleave', hideTip);
    g.addEventListener('focus', (e) => show(g, e));
    g.addEventListener('blur', hideTip);
    g.addEventListener('click', (e) => { e.stopPropagation(); show(g, e); });
  });
}
document.addEventListener('click', () => { hideTip(); document.querySelectorAll('.chart .cross').forEach((c) => { c.hidden = true; }); });

/**
 * Single-series columns. data: [{label, value, partial?}]
 * Direct labels only on the latest and the tallest bar; everything else is in the tooltip/table.
 */
export function columns(el, { data, unit = '', height = 190, partialNote = '' }) {
  mount(el, () => {
    const W = el.clientWidth, H = height;
    const padL = 30, padR = 6, padT = 18, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = Math.max(1, ...data.map((d) => d.value));
    const ticks = niceTicks(max, 3);
    const top = ticks.at(-1);
    const band = plotW / data.length;
    const bw = Math.min(24, Math.max(6, band * 0.62));
    const y = (v) => padT + plotH - (v / top) * plotH;
    const iMax = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);
    const short = band < 34;
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="group" aria-label="Column chart">`;
    for (const t of ticks) {
      s += `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`;
      s += `<text x="${padL - 8}" y="${y(t) + 3.5}" text-anchor="end">${num(t)}</text>`;
    }
    data.forEach((d, i) => {
      const cx = padL + band * i + band / 2;
      const h = (d.value / top) * plotH;
      const yy = y(d.value);
      const label = short ? `’${String(d.label).slice(-2)}` : d.label;
      s += `<g class="col" tabindex="0" role="img" data-i="${i}" data-top="${yy}" aria-label="${esc(d.label)}: ${num(d.value)} ${esc(unit)}${d.partial ? ' so far' : ''}">`;
      s += `<rect class="hit" x="${cx - band / 2}" y="${padT}" width="${band}" height="${plotH + padB}"/>`;
      s += `<path class="mark" d="${columnPath(cx - bw / 2, yy, bw, h)}" fill="var(--series-1)"${d.partial ? ' opacity=".5"' : ''}/>`;
      if (i === iMax || i === data.length - 1) s += `<text class="val" x="${cx}" y="${yy - 6}" text-anchor="middle">${num(d.value)}</text>`;
      s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(label)}</text></g>`;
    });
    s += '</svg>';
    el.innerHTML = s;
    bindTips(el.firstChild, (i) => `<b>${esc(data[i].label)}${data[i].partial ? ` · ${esc(partialNote)}` : ''}</b>${num(data[i].value)} ${esc(unit)}`);
  });
}

/**
 * Stacked columns. data: [{label, values:{key:n}}], series: [{key,label,color}] in fixed order.
 * Segments are separated by a 2px surface gap; the legend is rendered by the caller.
 */
export function stacked(el, { data, series, height = 190, unit = 'outputs' }) {
  mount(el, () => {
    const W = el.clientWidth, H = height;
    const padL = 30, padR = 6, padT = 18, padB = 22, gap = 2;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const totals = data.map((d) => series.reduce((a, s) => a + (d.values[s.key] || 0), 0));
    const ticks = niceTicks(Math.max(1, ...totals), 3);
    const top = ticks.at(-1);
    const band = plotW / data.length;
    const bw = Math.min(24, Math.max(6, band * 0.62));
    const short = band < 34;
    const iMax = totals.reduce((best, v, i) => (v > totals[best] ? i : best), 0);
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="group" aria-label="Stacked column chart">`;
    for (const t of ticks) {
      const yy = padT + plotH - (t / top) * plotH;
      s += `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text x="${padL - 8}" y="${yy + 3.5}" text-anchor="end">${num(t)}</text>`;
    }
    data.forEach((d, i) => {
      const cx = padL + band * i + band / 2;
      let base = padT + plotH;
      const parts = series.filter((sr) => (d.values[sr.key] || 0) > 0);
      const desc = parts.map((sr) => `${d.values[sr.key]} ${sr.label.toLowerCase()}`).join(', ') || 'none';
      const topY = padT + plotH - (totals[i] / top) * plotH;
      s += `<g class="col" tabindex="0" role="img" data-i="${i}" data-top="${topY}" aria-label="${esc(d.label)}: ${esc(desc)}">`;
      s += `<rect class="hit" x="${cx - band / 2}" y="${padT}" width="${band}" height="${plotH + padB}"/>`;
      parts.forEach((sr, k) => {
        const h = (d.values[sr.key] / top) * plotH;
        const last = k === parts.length - 1;
        const hh = Math.max(1, h - (last ? 0 : gap));
        const yy = base - h + (last ? 0 : gap);
        s += last
          ? `<path class="mark" d="${columnPath(cx - bw / 2, base - h, bw, h)}" fill="${sr.color}"/>`
          : `<rect class="mark" x="${cx - bw / 2}" y="${yy}" width="${bw}" height="${hh}" fill="${sr.color}"/>`;
        base -= h;
      });
      if (i === iMax || i === data.length - 1) s += `<text class="val" x="${cx}" y="${topY - 6}" text-anchor="middle">${num(totals[i])}</text>`;
      s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(short ? `’${String(d.label).slice(-2)}` : d.label)}</text></g>`;
    });
    s += '</svg>';
    el.innerHTML = s;
    bindTips(el.firstChild, (i) => `<b>${esc(data[i].label)} · ${num(totals[i])} ${esc(unit)}</b>` + series
      .filter((sr) => data[i].values[sr.key])
      .map((sr) => `<span class="k"><span><i style="background:${sr.color}"></i>${esc(sr.label)}</span><span>${data[i].values[sr.key]}</span></span>`).join(''));
  });
}

/**
 * Emphasis lines: one series is the point (accent), an optional picked one is second (next hue), the
 * rest are grey context; the cohort's middle half is a band and its median a line. A crosshair snaps
 * to the nearest x and one tooltip reads every emphasised series there.
 * series:  [{ id, label, role: 'focus' | 'pick' | 'context', points: [[x, y], …] }]
 * summary: [{ x, lo, mid, hi, min, max, n }]
 */
export function lines(el, { series, summary = [], xFormat = String, tipTitle = String, unit = '', height = 232, mark = null }) {
  mount(el, () => {
    const W = el.clientWidth, H = height, padL = 36, padR = 14, padT = 22, padB = 24;
    const xs = [...new Set(series.flatMap((sr) => sr.points.map((pt) => pt[0])))].sort((a, b) => a - b);
    if (!xs.length) { el.innerHTML = ''; return; }
    const x0 = xs[0], x1 = xs.at(-1);
    const ticks = niceTicks(Math.max(1, ...series.flatMap((sr) => sr.points.map((pt) => pt[1]))), 4);
    const top = ticks.at(-1);
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const X = (v) => padL + (x1 === x0 ? plotW / 2 : ((v - x0) / (x1 - x0)) * plotW);
    const Y = (v) => padT + plotH - (v / top) * plotH;
    const path = (pts) => pts.map((pt, i) => `${i ? 'L' : 'M'}${X(pt[0]).toFixed(1)},${Y(pt[1]).toFixed(1)}`).join('');
    const focus = series.find((sr) => sr.role === 'focus'), pick = series.find((sr) => sr.role === 'pick');
    const band = summary.filter((q) => q.n >= 3);
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="group" aria-label="Line chart" style="touch-action:pan-y">`;
    for (const t of ticks) s += `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${padL - 8}" y="${Y(t) + 3.5}" text-anchor="end">${num(t)}</text>`;
    const step = Math.max(1, Math.ceil((xs.length * 30) / plotW));
    xs.forEach((v, i) => { if ((v - (mark ?? x0)) % step === 0 || i === xs.length - 1 && step === 1) s += `<text x="${X(v)}" y="${H - 6}" text-anchor="middle"${v === mark ? ' class="val"' : ''}>${esc(xFormat(v))}</text>`; });
    if (mark != null && mark >= x0 && mark <= x1) s += `<line class="markline" x1="${X(mark)}" x2="${X(mark)}" y1="${padT}" y2="${padT + plotH}"/>`;
    if (band.length > 1) s += `<path class="band" d="${path(band.map((q) => [q.x, q.hi]))}L${[...band].reverse().map((q) => `${X(q.x).toFixed(1)},${Y(q.lo).toFixed(1)}`).join('L')}Z"/>`;
    for (const sr of series.filter((x) => x.role === 'context')) s += `<path class="ln ctx" d="${path(sr.points)}"/>`;
    if (summary.length > 1) s += `<path class="ln median" d="${path(summary.map((q) => [q.x, q.mid]))}"/>`;
    if (pick) s += `<path class="ln pick" d="${path(pick.points)}"/>`;
    if (focus) {
      const [ex, ey] = focus.points.at(-1);
      s += `<path class="ln focus" d="${path(focus.points)}"/><circle class="dot focus" cx="${X(ex)}" cy="${Y(ey)}" r="4.5"/>`;
      s += `<text class="val" x="${X(ex) - 9}" y="${Math.max(12, Y(ey) - 9)}" text-anchor="end">${esc(focus.label)} ${num(ey)}</text>`;
    }
    s += `<g class="cross" hidden><line x1="0" x2="0" y1="${padT}" y2="${padT + plotH}"/><circle class="dot median" r="4"/><circle class="dot pick" r="4"/><circle class="dot focus" r="4.5"/></g>`;
    s += `<rect class="hit" tabindex="0" role="img" aria-label="Line chart; use the arrow keys to read values" x="${padL}" y="${padT}" width="${plotW}" height="${plotH + padB}"/></svg>`;
    el.innerHTML = s;

    const svg = el.firstChild, cross = svg.querySelector('.cross'), hit = svg.querySelector('.hit');
    const at = (sr, v) => sr?.points.find((pt) => pt[0] === v)?.[1];
    const key = (cls, label, value) => `<span class="k"><span><i class="line ${cls}"></i>${esc(label)}</span><span>${value}</span></span>`;
    let idx = xs.length - 1;
    const show = (i, clientX) => {
      idx = Math.max(0, Math.min(xs.length - 1, i));
      const v = xs[idx], q = summary.find((z) => z.x === v), fy = at(focus, v), py = at(pick, v);
      cross.hidden = false;
      cross.querySelector('line').setAttribute('x1', X(v));
      cross.querySelector('line').setAttribute('x2', X(v));
      const place = (sel, y) => { const c = cross.querySelector(sel); c.style.display = y == null ? 'none' : ''; if (y != null) { c.setAttribute('cx', X(v)); c.setAttribute('cy', Y(y)); } };
      place('.dot.focus', fy); place('.dot.pick', py); place('.dot.median', q?.mid);
      const r = svg.getBoundingClientRect();
      showTip(`<b>${esc(tipTitle(v))}</b>${fy != null ? key('focus', focus.label, num(fy)) : ''}${py != null ? key('pick', pick.label, num(py)) : ''}`
        + (q ? key('median', 'Peer median', num(q.mid)) + key('ctx', `${q.n} peers`, `${num(q.min)}–${num(q.max)}`) : '')
        + (unit ? `<span class="k"><span>${esc(unit)}</span><span></span></span>` : ''),
        clientX ?? r.left + X(v), r.top + padT);
    };
    const nearest = (e) => { const r = svg.getBoundingClientRect(); const v = x0 + ((e.clientX - r.left - padL) / plotW) * (x1 - x0); return xs.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(xs[best] - v) ? i : best), 0); };
    const hide = () => { cross.hidden = true; hideTip(); };
    hit.addEventListener('pointerdown', (e) => show(nearest(e), e.clientX));
    hit.addEventListener('pointermove', (e) => show(nearest(e), e.clientX));
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    hit.addEventListener('click', (e) => e.stopPropagation());
    hit.addEventListener('focus', () => show(idx));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(idx + (e.key === 'ArrowLeft' ? -1 : 1)); } });
  });
}

/**
 * Heat grid: one row per year, one cell per month; one hue, more is stronger (five steps).
 * rows: [{ label, cells: [{ label, value } | null] }], cols: ['J', 'F', …]
 */
export function heatgrid(el, { rows, cols, unit = '' }) {
  mount(el, () => {
    const W = el.clientWidth, padL = 34, gap = 3;
    const cell = Math.min(26, (W - padL - gap * (cols.length - 1)) / cols.length);
    const H = 16 + rows.length * (cell + gap);
    const max = Math.max(1, ...rows.flatMap((r) => r.cells.map((c) => c?.value || 0)));
    const step = (v) => (v <= 0 ? 0 : Math.min(5, 1 + Math.floor((v / max) * 4.999)));
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="group" aria-label="Heat map">`;
    cols.forEach((c, i) => { s += `<text x="${padL + i * (cell + gap) + cell / 2}" y="10" text-anchor="middle">${esc(c)}</text>`; });
    rows.forEach((r, j) => {
      const y = 16 + j * (cell + gap);
      s += `<text x="${padL - 8}" y="${y + cell / 2 + 3.5}" text-anchor="end">${esc(r.label)}</text>`;
      r.cells.forEach((c, i) => {
        if (!c) return;
        s += `<g class="col" tabindex="0" role="img" data-i="${j}-${i}" data-top="${y}" aria-label="${esc(c.label)}: ${num(c.value)} ${esc(unit)}">`
          + `<rect class="mark heat h${step(c.value)}" x="${padL + i * (cell + gap)}" y="${y}" width="${cell}" height="${cell}" rx="5"/></g>`;
      });
    });
    el.innerHTML = `${s}</svg>`;
    el.querySelectorAll('g.col').forEach((g) => {
      const [j, i] = g.dataset.i.split('-').map(Number), c = rows[j].cells[i];
      const show = () => { const r = g.getBoundingClientRect(); showTip(`<b>${esc(c.label)}</b>${num(c.value)} ${esc(unit)}`, r.left + r.width / 2, r.top); };
      g.addEventListener('pointerenter', show);
      g.addEventListener('pointerleave', hideTip);
      g.addEventListener('focus', show);
      g.addEventListener('blur', hideTip);
      g.addEventListener('click', (e) => { e.stopPropagation(); show(); });
    });
  });
}

/** Table twin for a chart. columns: [{key,label}], rows: [{…}] */
export function dataTable(cols, rows) {
  return `<div class="table-wrap"><table class="data"><thead><tr>${cols.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof r[c.key] === 'number' ? num(r[c.key]) : r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

/** 12-point style sparkline for a stat tile: neutral line, the current point in the accent. */
export function sparkline(values, w = 120, h = 28) {
  if (!values || values.length < 2) return '';
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [3 + (i / (values.length - 1)) * (w - 8), h - 4 - ((v - min) / span) * (h - 9)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const [lx, ly] = pts.at(-1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path class="spark-line" d="${d}"/><circle class="spark-now" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5"/></svg>`;
}

/**
 * Deadline timeline. items: [{id,title,date,kind:'deadline'|'expected',status}]
 * Dots carry a 2px surface ring; expected rounds are hollow rings so they never read as fixed dates.
 */
export function timeline(el, { items, onPick }) {
  mount(el, () => {
    const W = el.clientWidth, padX = 10, H = 86, axisY = 56;
    const t0 = today();
    const start = new Date(t0.getFullYear(), t0.getMonth(), 1);
    const lastDate = items.reduce((m, it) => { const d = parseDay(it.date); return d && d > m ? d : m; }, new Date(t0.getFullYear(), t0.getMonth() + 5, 1));
    const months = Math.min(14, Math.max(6, (lastDate.getFullYear() - start.getFullYear()) * 12 + lastDate.getMonth() - start.getMonth() + 1));
    const end = new Date(start.getFullYear(), start.getMonth() + months, 1);
    const x = (d) => padX + ((d - start) / (end - start)) * (W - padX * 2);
    const M = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    const MM = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const wide = (W - padX * 2) / months > 38;
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="group" aria-label="Timeline of deadlines">`;
    s += `<line class="tl-axis" x1="${padX}" x2="${W - padX}" y1="${axisY}" y2="${axisY}"/>`;
    for (let i = 0; i <= months; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const xx = x(d);
      s += `<line class="tl-tick" x1="${xx}" x2="${xx}" y1="${axisY}" y2="${axisY + 5}"/>`;
      if (i < months) {
        const mid = x(new Date(d.getFullYear(), d.getMonth(), 15));
        const lab = wide ? MM[d.getMonth()] : M[d.getMonth()];
        s += `<text x="${mid}" y="${axisY + 17}" text-anchor="middle">${lab}</text>`;
        if (d.getMonth() === 0 || i === 0) s += `<text x="${mid}" y="${axisY + 29}" text-anchor="middle" style="font-weight:600">${d.getFullYear()}</text>`;
      }
    }
    s += `<line class="tl-today" x1="${x(t0)}" x2="${x(t0)}" y1="${axisY - 44}" y2="${axisY}"/><text x="${Math.min(W - 24, x(t0) + 4)}" y="${axisY - 38}" style="fill:var(--accent-strong);font-weight:600">Today</text>`;
    const placed = [];
    const colour = { critical: 'var(--critical)', serious: 'var(--serious)', warning: 'var(--warning)', ok: 'var(--good)' };
    [...items].filter((it) => parseDay(it.date) && parseDay(it.date) >= start && parseDay(it.date) < end)
      .sort((a, b) => a.date.localeCompare(b.date)).forEach((it) => {
        const xx = x(parseDay(it.date));
        const level = placed.filter((p) => Math.abs(p.x - xx) < 13).length;
        placed.push({ x: xx });
        const cy = axisY - 9 - level * 13;
        const lbl = `${it.title} — ${it.kind === 'expected' ? 'expected around ' : ''}${fmtDate(it.date, { year: true })}`;
        s += `<g class="col" tabindex="0" role="button" data-i="${esc(it.id)}" data-top="${cy - 8}" aria-label="${esc(lbl)}">`;
        s += `<circle class="hit" cx="${xx}" cy="${cy}" r="12"/>`;
        s += it.kind === 'expected'
          ? `<circle class="tl-prep mark" cx="${xx}" cy="${cy}" r="4.5"/>`
          : `<circle class="tl-dot mark" cx="${xx}" cy="${cy}" r="6" fill="${colour[it.status] || 'var(--ink-3)'}"/>`;
        s += '</g>';
      });
    s += '</svg>';
    el.innerHTML = s;
    const byId = Object.fromEntries(items.map((it) => [it.id, it]));
    el.querySelectorAll('g.col').forEach((g) => {
      const it = byId[g.dataset.i];
      const show = () => { const r = g.getBoundingClientRect(); showTip(`<b>${esc(it.title)}</b>${it.kind === 'expected' ? 'Expected around ' : 'Closes '}${fmtDate(it.date, { year: true })}`, r.left + r.width / 2, r.top); };
      g.addEventListener('pointerenter', show);
      g.addEventListener('pointerleave', hideTip);
      g.addEventListener('focus', show);
      g.addEventListener('blur', hideTip);
      g.addEventListener('click', (e) => { e.stopPropagation(); show(); onPick?.(it.id); });
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick?.(it.id); } });
    });
  });
}
