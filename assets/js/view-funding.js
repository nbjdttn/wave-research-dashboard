// "Funding" — only calls that pass both tests (topic and career stage), each with its deadline,
// what to submit and how much work it is.
import { esc, icon, daysTo, num, fmtDate, $, store, toast, safeUrl, ago, splitSentence } from './util.js';
import { oppHTML, isLive, nextDate, dueClass, calendarFile, funderTag, EFFORT, TYPES } from './cards.js';
import { timeline } from './charts.js';

const state = { tab: 'deadline', kind: 'all', sort: 'date', savedOnly: false };

const KINDS = [
  ['all', 'All'],
  ['lead', 'Projects I lead', (o) => ['project_grant', 'innovation', 'other'].includes(o.analysis.opportunity_type) && ['lead', 'co_lead', 'any'].includes(o.analysis.role)],
  ['personal', 'Fellowships & prizes', (o) => ['fellowship', 'prize'].includes(o.analysis.opportunity_type) && o.analysis.role !== 'host'],
  ['collab', 'Networks & travel', (o) => ['network', 'travel_exchange'].includes(o.analysis.opportunity_type)],
  ['host', 'Host a fellow', (o) => o.analysis.role === 'host' || o.analysis.opportunity_type === 'hosting'],
  ['partner', 'Partner roles', (o) => o.analysis.role === 'partner'],
  ['compute', 'Compute', (o) => o.analysis.opportunity_type === 'compute_equipment'],
];

export function renderFunding(root, D, ctx, sub) {
  const G = D.grants || {};
  const all = (G.opportunities || []).filter(isLive);
  const byId = Object.fromEntries(all.map((o) => [o.id, o]));
  if (sub && byId[sub]) { state.tab = byId[sub].bucket; state.kind = 'all'; }
  if (sub && byId[sub]) state.savedOnly = false;
  if (!all.some((o) => o.bucket === state.tab)) state.tab = ['deadline', 'rolling', 'prepare'].find((b) => all.some((o) => o.bucket === b)) || 'deadline';

  const draw = (focusId) => {
    const savedIds = new Set(ctx.grants.all().map((o) => o.id));
    if (!savedIds.size) state.savedOnly = false;
    const inTab = all.filter((o) => o.bucket === state.tab && (!state.savedOnly || savedIds.has(o.id)));
    const kinds = KINDS.filter(([key, , test]) => key === 'all' || inTab.some(test));
    if (!kinds.some(([k]) => k === state.kind)) state.kind = 'all';
    const test = KINDS.find(([k]) => k === state.kind)?.[2];
    let list = test ? inTab.filter(test) : inTab;
    const lvl = (o) => (EFFORT[o.analysis.effort.level] || [2])[0];
    list = [...list].sort((a, b) => (
      state.sort === 'fit' ? b.analysis.fit_score - a.analysis.fit_score
        : state.sort === 'effort' ? lvl(a) - lvl(b) || b.analysis.fit_score - a.analysis.fit_score
          : (nextDate(a) || '9999').localeCompare(nextDate(b) || '9999') || b.analysis.fit_score - a.analysis.fit_score));

    const n = (b) => all.filter((o) => o.bucket === b).length;
    const c = G.counts || {};
    const scanned = c.scanned ? c.scanned.ukri_open + c.scanned.ukri_past + c.scanned.eu + c.scanned.schemes : 0;
    const chip = (key, value, label) => `<button class="chip" type="button" data-set="${key}" data-val="${value}" aria-pressed="${state[key] === value}">${label}</button>`;
    const marks = all.filter((o) => o.bucket !== 'rolling' && nextDate(o)).map((o) => ({
      id: o.id, title: o.title, date: nextDate(o), kind: o.bucket === 'deadline' ? 'deadline' : 'expected',
      status: o.bucket === 'deadline' ? dueClass(daysTo(o.closes)) : null }));

    root.innerHTML = `
      <h1 class="page-title">Funding</h1>
      <p class="page-sub">${all.length ? `<b>${num(all.length)}</b> selected · topic and career stage both fit${scanned ? ` · ${num(scanned)} scanned` : ''}` : 'Nothing selected yet'}</p>
      ${aiNotice(G)}
      ${marks.length ? `<section class="card timeline" style="margin-top:16px" aria-label="Deadlines ahead">
        <div class="chart" id="tl"></div>
        <div class="legend" style="margin-top:6px">
          <span><i class="round" style="background:var(--critical)"></i>2 weeks</span>
          <span><i class="round" style="background:var(--serious)"></i>5 weeks</span>
          <span><i class="round" style="background:var(--warning)"></i>11 weeks</span>
          <span><i class="round" style="background:var(--good)"></i>later</span>
          <span><i class="ring"></i>expected</span>
        </div>
        <div class="opp-actions" style="margin-top:12px">
          <a class="btn sm" href="${calendarUrl()}">${icon('cal', 'sm')}Add all to my calendar</a>
        </div></section>` : ''}
      <div class="toolbar">
        <div class="seg" role="tablist" aria-label="Funding lists">
          <button role="tab" type="button" data-tab="deadline" aria-selected="${state.tab === 'deadline'}">Deadlines <span class="n">${n('deadline')}</span></button>
          <button role="tab" type="button" data-tab="rolling" aria-selected="${state.tab === 'rolling'}">Always open <span class="n">${n('rolling')}</span></button>
          <button role="tab" type="button" data-tab="prepare" aria-selected="${state.tab === 'prepare'}">Prepare ahead <span class="n">${n('prepare')}</span></button>
        </div>
        ${inTab.length > 1 || savedIds.size ? `<div class="chips" role="group" aria-label="Filters">
          ${savedIds.size ? `<button class="chip" type="button" data-saved aria-pressed="${state.savedOnly}">${icon('save', 'xs')}Shortlist <span class="n">${savedIds.size}</span></button><span style="flex:none;width:1px;background:var(--line-2);margin:6px 2px"></span>` : ''}
          ${kinds.length > 2 ? kinds.map(([k, label]) => chip('kind', k, label)).join('') + '<span style="flex:none;width:1px;background:var(--line-2);margin:6px 2px"></span>' : ''}
          ${chip('sort', 'date', state.tab === 'rolling' ? 'Best fit' : 'Soonest')}${state.tab === 'rolling' ? '' : chip('sort', 'fit', 'Best fit')}${chip('sort', 'effort', 'Least effort')}
        </div>` : ''}
      </div>
      ${tabIntro(state.tab)}
      <div class="opps two" id="opp-list">${list.length ? list.map((o) => oppHTML(o, { saved: savedIds.has(o.id), open: o.id === focusId })).join('')
        : `<div class="empty" style="grid-column:1/-1"><h3>${state.savedOnly ? 'Nothing shortlisted in this list' : 'Nothing in this list right now'}</h3>
           </div>`}</div>
      ${unreviewedHTML(G)}
      ${filteredHTML(G)}
      <p class="scan">${c.scanned ? `<span>UKRI live <b>${num(c.scanned.ukri_open)}</b></span><span>UKRI past <b>${num(c.scanned.ukri_past)}</b></span><span>EU <b>${num(c.scanned.eu)}</b></span><span>Schemes <b>${num(c.scanned.schemes)}</b></span>` : ''}
        ${G.generated_at ? `<span>Updated ${esc(ago(G.generated_at))}</span>` : ''}</p>`;

    const tl = $('#tl', root);
    if (tl) timeline(tl, { items: marks, onPick: (id) => { const o = byId[id]; if (o) { state.tab = o.bucket; state.kind = 'all'; draw(id); } } });
    if (focusId) requestAnimationFrame(() => document.getElementById(`opp-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  root.onclick = (e) => {
    const t = e.target.closest('[data-tab],[data-set],[data-cal],[data-saved]');
    if (!t) return;
    if ('saved' in t.dataset) { state.savedOnly = !state.savedOnly; draw(); return; }
    if (t.dataset.cal) {
      const o = byId[t.dataset.cal];
      toast(o && calendarFile(o) ? 'Calendar entry downloaded' : 'No date to add yet');
      return;
    }
    if (t.dataset.tab) { state.tab = t.dataset.tab; state.kind = 'all'; if (state.tab === 'rolling' && state.sort === 'fit') state.sort = 'date'; }
    else state[t.dataset.set] = t.dataset.val;
    draw();
  };
  root.onchange = (e) => {
    const box = e.target.closest('[data-check]');
    if (!box) return;
    const key = `check.${box.dataset.check}`;
    const done = new Set(store.get(key, []));
    box.checked ? done.add(+box.dataset.i) : done.delete(+box.dataset.i);
    store.set(key, [...done]);
    box.closest('li').classList.toggle('done', box.checked);
  };
  ctx.redraw = () => draw();
  draw(sub && byId[sub] ? sub : undefined);
}

/** webcal:// makes phones offer "subscribe", so the calendar follows the daily updates. */
function calendarUrl() {
  const url = new URL('data/deadlines.ics', location.href);
  return esc(location.protocol === 'https:' ? url.href.replace(/^https:/, 'webcal:') : url.href);
}

function tabIntro(tab) {
  return tab === 'prepare' ? '<p class="small muted" style="margin:14px 0 12px">Not open yet. “~” = estimated from earlier rounds.</p>' : '<div style="height:14px"></div>';
}

function aiNotice(G) {
  const ai = G.ai || {};
  if (ai.errors?.length) {
    return `<div class="notice warn" style="margin-top:14px">${icon('alert', 'sm')}<span><b>Claude review problem.</b> ${esc(splitSentence(ai.errors[0])[0])}</span></div>`;
  }
  const pending = G.counts?.awaiting_review || 0;
  if (!ai.key_present && pending) {
    return `<div class="notice" style="margin-top:14px">${icon('spark', 'sm')}<span><b>${num(pending)} new calls await review.</b> Add the <code>ANTHROPIC_API_KEY</code> secret to review them daily.</span></div>`;
  }
  return '';
}

function unreviewedHTML(G) {
  const list = G.unreviewed || [];
  if (!list.length) return '';
  return `<section class="section"><div class="section-head"><h2 class="eyebrow">Awaiting review<span class="count">${list.length}</span></h2></div>
    <p class="small muted" style="margin-bottom:10px">Matched your keywords; not yet assessed.</p>
    <div class="card pad">${list.map((u) => `<a class="rowlink" href="${safeUrl(u.url)}" target="_blank" rel="noopener">
      <h3>${esc(u.title)}</h3><div class="right">${u.closes ? `<b>${fmtDate(u.closes)}</b>` : `<b>${esc(u.closes_note || '')}</b>`}</div>
      <div class="meta">${funderTag(u.funder)}</div></a>`).join('')}</div></section>`;
}

function filteredHTML(G) {
  const list = G.filtered || [];
  if (!list.length) return '';
  return `<section class="section"><details class="fold" style="border-top:1px solid var(--ink)">
    <summary>Read and left out <span class="n">${list.length}</span></summary>
    <div class="fold-body">
      ${list.map((f) => `<div class="rowlink"><h3 style="font-size:.9375rem"><a href="${safeUrl(f.url)}" target="_blank" rel="noopener">${esc(f.title)}</a></h3>
        <div class="meta">${funderTag(f.funder)}<span>${esc(splitSentence(f.reason)[0])}</span></div></div>`).join('')}
    </div></details></section>`;
}
