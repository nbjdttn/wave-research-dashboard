// Profile → Peers: your citation growth beside researchers at a similar career stage, in the same
// field, at leading universities — every curve counted from the PhD year. The group is yours to
// shape: swipe a row left to take someone out, swipe a row in "Not included" right to bring them in.
import { esc, num, icon, store, toast } from './util.js';
import { lines, dataTable } from './charts.js';

const state = { metric: 'total', axis: 'phd', pick: null, table: false };
const METRICS = { total: ['Citations', 'citations in total'], year: ['Per year', 'citations in the year'], papers: ['Papers', 'papers in total'] };
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4]}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };

/** [[x, y], …] for one person under the current metric and axis. */
function points(person, metric, axis) {
  let run = 0;
  return person.by_year.map((row) => {
    const v = metric === 'papers' ? row.works : row.cites;
    run += v;
    return [axis === 'phd' ? row.year - person.phd_year : row.year, metric === 'year' ? v : run];
  }).filter((pt) => axis !== 'phd' || pt[0] >= -3);
}
const valueAt = (person, age) => person.by_year.filter((r) => r.year <= person.phd_year + age).reduce((a, r) => a + r.cites, 0);

/** Who is in the comparison: the suggested group, minus those swiped out, plus those swiped in. */
function groups(D) {
  const out = new Set(store.get('peers.out', [])), inn = new Set(store.get('peers.in', []));
  const all = [...D.peers.peers.map((p) => ({ ...p, suggested: true })), ...(D.peers.bench || []).map((p) => ({ ...p, suggested: false }))];
  return { active: all.filter((p) => (p.suggested ? !out.has(p.id) : inn.has(p.id))), rest: all.filter((p) => (p.suggested ? out.has(p.id) : !inn.has(p.id))), changed: out.size + inn.size > 0 };
}
function move(D, id, into) {
  const person = [...D.peers.peers, ...(D.peers.bench || [])].find((p) => p.id === id);
  if (!person) return;
  const suggested = D.peers.peers.some((p) => p.id === id);
  const out = new Set(store.get('peers.out', [])), inn = new Set(store.get('peers.in', []));
  if (suggested) { if (into) out.delete(id); else out.add(id); } else if (into) inn.add(id); else inn.delete(id);
  store.set('peers.out', [...out]);
  store.set('peers.in', [...inn]);
  if (state.pick === id && !into) state.pick = null;
  toast(into ? `${person.name} added` : `${person.name} removed`);
}

const phd = (p) => `PhD ${p.phd_source === 'estimate' ? '~' : ''}${p.phd_year}`;
function row(p, i, inGroup) {
  const cls = p.you ? ' you' : state.pick === p.id ? ' picked' : '';
  const body = `<span class="prank">${p.you || inGroup ? i + 1 : ''}</span>
      <span class="pwho"><b>${esc(p.name)}</b><span>${p.you ? 'You' : esc(p.institution || '')} · ${phd(p)}${p.coauthor ? ' · co-author' : ''}</span></span>
      <span class="pfig"><b>${num(p.citations)}</b><span>h ${num(p.h_index)}</span></span>`;
  if (p.you) return `<li class="prow you"><div class="swipe-body">${body}<span class="pact"></span></div></li>`;
  return `<li class="swipe${cls}" data-id="${esc(p.id)}" data-dir="${inGroup ? 'left' : 'right'}">
    <span class="swipe-bg" aria-hidden="true">${inGroup ? 'Remove' : 'Add'}</span>
    <div class="swipe-body"${inGroup ? ` data-pick="${esc(p.id)}"` : ''}>${body}
      <button class="pact" type="button" data-move="${esc(p.id)}" data-into="${inGroup ? '0' : '1'}" aria-label="${inGroup ? 'Remove' : 'Add'} ${esc(p.name)}">${icon(inGroup ? 'x' : 'plus', 'sm')}</button></div></li>`;
}

export function peersHTML(D) {
  const P = D.peers;
  if (!P?.you) return '<div class="empty"><h3>No comparison yet</h3><p>It is built on the next daily update.</p></div>';
  const { active, rest, changed } = groups(D);
  const you = P.you, age = new Date().getFullYear() - you.phd_year;
  const mine = valueAt(you, age);
  const reached = active.filter((p) => p.phd_year + age <= new Date().getFullYear()).map((p) => valueAt(p, age));
  const rank = 1 + reached.filter((v) => v > mine).length;
  const ranked = [...active, { ...you, you: true, name: you.name, institution: '' }].sort((a, b) => b.citations - a.citations);
  const chip = (key, val, label) => `<button class="chip" type="button" data-pset="${key}" data-val="${val}" aria-pressed="${state[key] === val}">${label}</button>`;
  return `
    <section class="section" aria-label="Where you stand">
      <div class="kpis">
        <div class="card kpi"><div class="kpi-label">You · PhD+${age}</div><div class="kpi-value">${num(mine)}</div><div class="kpi-delta">citations so far</div></div>
        <div class="card kpi"><div class="kpi-label">Peer median · PhD+${age}</div><div class="kpi-value">${reached.length ? num(Math.round(median(reached))) : '–'}</div><div class="kpi-delta">${reached.length} peers that far on</div></div>
        <div class="card kpi"><div class="kpi-label">Your rank</div><div class="kpi-value">${reached.length ? ordinal(rank) : '–'}</div><div class="kpi-delta">of ${reached.length + 1} at the same stage</div></div>
        <div class="card kpi"><div class="kpi-label">Group</div><div class="kpi-value">${active.length}</div><div class="kpi-delta">PhD ${P.cohort.stage_window[0]}–${P.cohort.stage_window[1]}</div></div>
      </div>
    </section>
    <section class="card chart-card section" aria-label="Growth since the PhD">
      <div class="chart-head"><div><h3>Growth since the PhD</h3><p>${esc(METRICS[state.metric][1])}</p></div>
        <button class="act" type="button" data-ptable aria-pressed="${state.table}" aria-label="Show as a ${state.table ? 'chart' : 'table'}">${icon(state.table ? 'chart' : 'table', 'sm')}</button></div>
      <div class="chips" role="group" aria-label="What to plot" style="margin-bottom:12px">
        ${chip('metric', 'total', 'Citations')}${chip('metric', 'year', 'Per year')}${chip('metric', 'papers', 'Papers')}
        <span style="flex:none;width:1px;background:var(--line-2);margin:6px 2px"></span>
        ${chip('axis', 'phd', 'Since PhD')}${chip('axis', 'year', 'By year')}
      </div>
      <div class="legend" style="margin-bottom:8px"><span><i class="line focus"></i>You</span><span><i class="line median"></i>Peer median</span>
        <span><i class="line ctx"></i>Each peer</span><span><i class="band"></i>Middle half</span>${state.pick ? `<span><i class="line pick"></i>${esc(active.find((p) => p.id === state.pick)?.name || '')}</span>` : ''}</div>
      <div class="chart" id="chart-peers"></div>
    </section>
    <section class="section" aria-label="Comparison group">
      <div class="section-head"><h2 class="eyebrow">Comparison group<span class="count">${active.length}</span></h2>
        ${changed ? '<button class="more" type="button" data-preset>Reset</button>' : ''}</div>
      <p class="small muted" style="margin:-4px 0 10px">Swipe left to remove · tap to highlight</p>
      <ol class="plist card">${ranked.map((p, i) => row(p, i, true)).join('')}</ol>
    </section>
    ${rest.length ? `<section class="section" aria-label="Not included">
      <details class="fold"${state.openRest ? ' open' : ''} data-rest><summary>Not included <span class="n">${rest.length}</span></summary>
        <div class="fold-body"><p class="small muted" style="margin-bottom:10px">Swipe right to add</p>
          <ol class="plist card">${rest.map((p, i) => row(p, i, false)).join('')}</ol></div></details></section>` : ''}
    <p class="scan"><span><b>OpenAlex</b> counts · this year is to date</span><span>~ PhD year estimated from the first paper</span></p>`;
}

export function mountPeers(root, D, redraw) {
  const P = D.peers;
  if (!P?.you) return;
  const { active } = groups(D);
  const you = { ...P.you, id: 'you' };
  const sincePhd = state.axis === 'phd';
  const el = root.querySelector('#chart-peers');
  const series = [
    ...active.map((p) => ({ id: p.id, label: p.name, role: p.id === state.pick ? 'pick' : 'context', points: points(p, state.metric, state.axis) })),
    { id: 'you', label: 'You', role: 'focus', points: points(you, state.metric, state.axis) },
  ];
  const xs = [...new Set(series.flatMap((s) => s.points.map((pt) => pt[0])))].sort((a, b) => a - b);
  const summary = xs.map((x) => {
    const vals = series.filter((s) => s.role !== 'focus').map((s) => s.points.find((pt) => pt[0] === x)?.[1]).filter((v) => v != null);
    return vals.length ? { x, n: vals.length, mid: Math.round(median(vals)), lo: quantile(vals, 0.25), hi: quantile(vals, 0.75), min: Math.min(...vals), max: Math.max(...vals) } : null;
  }).filter((q) => q && q.n >= 2);
  const label = (x) => (sincePhd ? (x === 0 ? 'PhD' : x > 0 ? `+${x}` : `−${-x}`) : `’${String(x).slice(-2)}`);
  const title = (x) => (sincePhd ? (x === 0 ? 'PhD year' : x > 0 ? `${x} year${x === 1 ? '' : 's'} after the PhD` : `${-x} year${x === -1 ? '' : 's'} before the PhD`) : String(x));
  if (state.table) {
    el.innerHTML = dataTable([{ key: 'x', label: sincePhd ? 'Year' : 'Year' }, { key: 'you', label: 'You' }, { key: 'mid', label: 'Median' }, { key: 'range', label: 'Peers' }],
      xs.map((x) => { const q = summary.find((z) => z.x === x); return { x: label(x), you: series.at(-1).points.find((pt) => pt[0] === x)?.[1] ?? '', mid: q?.mid ?? '', range: q ? `${num(q.min)}–${num(q.max)}` : '' }; }));
  } else {
    lines(el, { series, summary, xFormat: label, tipTitle: title, unit: METRICS[state.metric][1], mark: sincePhd ? 0 : null });
  }

  // one handler for chips, table toggle, row buttons, highlight and reset
  const lists = root.querySelectorAll('.plist');
  root.querySelectorAll('[data-pset]').forEach((b) => b.addEventListener('click', () => { state[b.dataset.pset] = b.dataset.val; redraw(); }));
  root.querySelector('[data-ptable]')?.addEventListener('click', () => { state.table = !state.table; redraw(); });
  root.querySelector('[data-preset]')?.addEventListener('click', () => { store.set('peers.out', []); store.set('peers.in', []); state.pick = null; redraw(); });
  root.querySelector('[data-rest]')?.addEventListener('toggle', (e) => { state.openRest = e.target.open; });
  let swiped = 0;
  lists.forEach((list) => {
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-move]');
      if (b) { move(D, b.dataset.move, b.dataset.into === '1'); redraw(); return; }
      const r = e.target.closest('[data-pick]');
      if (r && Date.now() - swiped > 350) { state.pick = state.pick === r.dataset.pick ? null : r.dataset.pick; redraw(); }
    });
    swipeRows(list, (id, dir) => { swiped = Date.now(); move(D, id, dir === 'right'); redraw(); }, () => { swiped = Date.now(); });
  });
}

/** Horizontal swipe on .swipe rows (vertical scrolling stays native: the rows use touch-action: pan-y). */
function swipeRows(list, onSwipe, onStart) {
  let s = null;
  list.addEventListener('pointerdown', (e) => {
    const rowEl = e.target.closest('.swipe');
    if (!rowEl || e.target.closest('button, a') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    s = { row: rowEl, body: rowEl.querySelector('.swipe-body'), x: e.clientX, y: e.clientY, dx: 0, on: false, dir: rowEl.dataset.dir === 'right' ? 1 : -1, id: e.pointerId };
  });
  list.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { s = null; return; }
      if (Math.abs(dx) < 10) return;
      if (Math.sign(dx) !== s.dir) { s = null; return; }
      s.on = true;
      onStart?.();
      try { s.row.setPointerCapture(e.pointerId); } catch { /* not capturable: carry on */ }
      s.row.classList.add('swiping');
    }
    s.dx = s.dir * Math.max(0, s.dir * dx);
    s.body.style.transform = `translateX(${s.dx}px)`;
    s.row.classList.toggle('armed', Math.abs(s.dx) > s.row.offsetWidth * 0.3);
  });
  const end = () => {
    if (!s) return;
    const { row: rowEl, body, dx, on } = s;
    s = null;
    if (!on) return;
    onStart?.();
    body.style.transition = 'transform .18s ease-out';
    if (Math.abs(dx) > rowEl.offsetWidth * 0.3) {
      body.style.transform = `translateX(${Math.sign(dx) * rowEl.offsetWidth}px)`;
      setTimeout(() => onSwipe(rowEl.dataset.id, rowEl.dataset.dir), 170);
    } else {
      body.style.transform = '';
      rowEl.classList.remove('armed', 'swiping');
      setTimeout(() => { body.style.transition = ''; }, 200);
    }
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
}
