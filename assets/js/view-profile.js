// "Profile" — the researcher's own record: headline numbers, trends, themes, venues,
// collaborators and the full publication list.
import { esc, safeUrl, icon, num, initials, $, copyText, daysTo, fmtDate } from './util.js';
import { columns, stacked, dataTable, sparkline } from './charts.js';

const state = { tab: 'overview', q: '', type: 'all', theme: 'all', sort: 'year', tables: {} };
const TYPE_LABEL = { journal: 'Journal', conference: 'Conference', preprint: 'Preprint', thesis: 'Thesis', other: 'Other' };
const SERIES = [
  { key: 'journal', label: 'Journal articles', color: 'var(--series-1)' },
  { key: 'conference', label: 'Conference papers', color: 'var(--series-2)' },
  { key: 'preprint', label: 'Preprints', color: 'var(--series-3)' },
  { key: 'other', label: 'Other', color: 'var(--series-4)' },
];
const LINKS = [['scholar', 'Google Scholar'], ['orcid', 'ORCID'], ['university', 'Manchester profile'], ['website', 'Website'], ['github', 'GitHub'], ['linkedin', 'LinkedIn']];

export function renderProfile(root, D, ctx, sub) {
  const P = D.profile;
  if (!P) { root.innerHTML = '<div class="empty"><h3>Profile data is not available yet</h3></div>'; return; }
  if (sub === 'publications' || sub === 'overview') state.tab = sub;
  const r = P.researcher, m = P.metrics;

  const head = () => `
    <div class="profile-head">
      ${r.avatar ? `<img class="avatar" src="${esc(r.avatar)}" alt="" width="76" height="76">` : `<div class="avatar initials" aria-hidden="true">${esc(initials(r.short_name || r.name))}</div>`}
      <div><h1 class="profile-name">${esc(r.name)}</h1>
        <p class="profile-role">${esc(r.title)}<br>${esc(r.institution)}</p></div>
    </div>
    <div class="toolbar" style="position:static;padding-bottom:0">
      <div class="seg" role="tablist" aria-label="Profile sections">
        <button role="tab" type="button" data-tab="overview" aria-selected="${state.tab === 'overview'}">Overview</button>
        <button role="tab" type="button" data-tab="publications" aria-selected="${state.tab === 'publications'}">Publications <span class="n">${m.outputs}</span></button>
      </div>
    </div>`;

  const draw = () => {
    root.innerHTML = head() + (state.tab === 'overview' ? overviewHTML(P) : publicationsHTML(P));
    if (state.tab === 'overview') mountCharts(root, P);
  };

  root.onclick = (e) => {
    const t = e.target.closest('[data-tab],[data-set],[data-table],[data-cite],[data-bib],[data-clear]');
    if (!t) return;
    if (t.dataset.tab) state.tab = t.dataset.tab;
    else if (t.dataset.set) state[t.dataset.set] = t.dataset.val;
    else if (t.dataset.table) state.tables[t.dataset.table] = !state.tables[t.dataset.table];
    else if (t.dataset.cite) { copyText(reference(P.publications.find((p) => p.id === t.dataset.cite)), 'Reference copied'); return; }
    else if (t.dataset.bib) { copyText(bibtex(P.publications.find((p) => p.id === t.dataset.bib)), 'BibTeX copied'); return; }
    else if ('clear' in t.dataset) state.q = '';
    draw();
  };
  root.oninput = (e) => {
    if (e.target.name !== 'pq') return;
    state.q = e.target.value;
    clearTimeout(root._t);
    root._t = setTimeout(() => { draw(); const i = $('input[name=pq]', root); if (i) { i.focus(); i.setSelectionRange(state.q.length, state.q.length); } }, 200);
  };
  root.onsubmit = (e) => e.preventDefault();
  ctx.redraw = draw;
  draw();
}

// ── overview ─────────────────────────────────────────────────────────────────
function overviewHTML(P) {
  const r = P.researcher, m = P.metrics;
  const year = new Date().getFullYear();
  const hist = P.history || [];
  const monthAgo = [...hist].reverse().find((h) => daysTo(h.date) <= -28);
  const delta = monthAgo ? m.citations - monthAgo.citations : null;
  const top = [...P.publications].sort((a, b) => b.citations - a.citations).slice(0, 5);
  const themeMax = Math.max(1, ...P.themes.map((t) => t.count));
  const venueMax = Math.max(1, ...P.venues.map((v) => v.count));
  const chartCard = (id, title, sub, extra = '') => `<section class="card chart-card" aria-label="${esc(title)}">
      <div class="chart-head"><div><h3>${esc(title)}</h3><p>${sub}</p></div>
        <button class="act" type="button" data-table="${id}" aria-pressed="${!!state.tables[id]}" aria-label="Show ${esc(title)} as a ${state.tables[id] ? 'chart' : 'table'}">${icon(state.tables[id] ? 'chart' : 'table', 'sm')}</button></div>
      ${extra}<div class="chart" id="chart-${id}"></div></section>`;

  return `
    <p class="profile-bio">${esc(r.bio)}</p>
    <div class="links">${LINKS.filter(([k]) => r.links?.[k]).map(([k, label]) => `<a class="btn sm" href="${safeUrl(r.links[k])}" target="_blank" rel="noopener me">${esc(label)} ${icon('ext', 'xs')}</a>`).join('')}</div>

    <section class="section" aria-label="Headline numbers">
      <div class="kpis">
        <div class="card kpi"><div class="kpi-label">Citations</div><div class="kpi-value">${num(m.citations)}</div>
          <div class="kpi-delta">${delta != null && delta > 0 ? `<b>+${num(delta)}</b> in the last month` : `<b>+${num(m.citations_this_year)}</b> in ${year} so far`}</div>
          ${sparkline(P.citations_by_year.map((c) => c.count))}</div>
        <div class="card kpi"><div class="kpi-label">h-index</div><div class="kpi-value">${num(m.h_index)}</div>
          <div class="kpi-delta">${num(m.h_index)} papers with at least ${num(m.h_index)} citations · ${m.m_index} per active year</div></div>
        <div class="card kpi"><div class="kpi-label">i10-index</div><div class="kpi-value">${num(m.i10_index)}</div>
          <div class="kpi-delta">papers cited 10 times or more</div></div>
        <div class="card kpi"><div class="kpi-label">Outputs</div><div class="kpi-value">${num(m.outputs)}</div>
          <div class="kpi-delta">${num(m.journal_articles)} journal articles · ${num(m.conference_papers)} conference papers</div></div>
      </div>
      <p class="scan"><span>Source: <b>${esc(m.source)}</b>, ${fmtDate(m.as_of, { year: true })}</span>
        ${m.openalex ? `<span>OpenAlex cross-check: <b>${num(m.openalex.cited_by_count)}</b> citations, h-index <b>${num(m.openalex.h_index)}</b></span>` : ''}</p>
    </section>

    <div class="cols half section">
      ${chartCard('cites', 'Citations per year', `${year} is the year to date`)}
      ${chartCard('outputs', 'Outputs per year', 'By type of output',
        `<div class="legend" style="margin-bottom:10px">${SERIES.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`)}
    </div>

    <div class="cols half section">
      <section class="card chart-card" aria-label="Research themes">
        <div class="chart-head"><div><h3>Research themes</h3><p>Outputs per theme — one output can sit in several</p></div></div>
        <div class="rows">${P.themes.slice().sort((a, b) => b.count - a.count).map((t) => `<div class="rowbar">
          <span class="name">${esc(t.label)}</span><span class="fig">${t.count} <span>· ${num(t.citations)} cites</span></span>
          <span class="bar" style="width:${(t.count / themeMax) * 100}%"></span></div>`).join('')}</div>
      </section>
      <section class="card chart-card" aria-label="Where you publish">
        <div class="chart-head"><div><h3>Where you publish</h3><p>Journal articles per journal</p></div></div>
        <div class="rows">${P.venues.slice(0, 8).map((v) => `<div class="rowbar">
          <span class="name">${esc(v.name)}</span><span class="fig">${v.count} <span>· ${num(v.citations)} cites</span></span>
          <span class="bar" style="width:${(v.count / venueMax) * 100}%"></span></div>`).join('')}</div>
      </section>
    </div>

    <section class="section" aria-labelledby="h-top">
      <div class="section-head"><h2 class="eyebrow" id="h-top">Most cited</h2><button class="more" type="button" data-tab="publications">All publications ${icon('arrow', 'xs')}</button></div>
      <div class="pubs">${top.map((p) => pubHTML(p, false)).join('')}</div>
    </section>

    <section class="section" aria-labelledby="h-co">
      <div class="section-head"><h2 class="eyebrow" id="h-co">Collaborators<span class="count">${num(m.coauthors)}</span></h2></div>
      <div class="people">${P.coauthors.slice(0, 12).map((c) => `<div class="person"><span class="ini" aria-hidden="true">${esc(initials(c.name))}</span>
        <div><b>${esc(c.name)}</b><span>${c.count} joint ${c.count === 1 ? 'output' : 'outputs'}</span></div></div>`).join('')}</div>
      <p class="scan"><span>First author on <b>${num(m.first_author)}</b></span><span>Senior (last) author on <b>${num(m.senior_author)}</b></span>
        <span><b>${Math.round(m.ml_share * 100)}%</b> of outputs use machine learning</span>
        ${P.countries?.length ? `<span>Co-authors in <b>${P.countries.length}</b> countries</span>` : ''}</p>
    </section>`;
}

function mountCharts(root, P) {
  const year = new Date().getFullYear();
  const cites = P.citations_by_year.map((c) => ({ label: String(c.year), value: c.count, partial: c.year === year }));
  const el1 = $('#chart-cites', root);
  if (state.tables.cites) el1.innerHTML = dataTable([{ key: 'label', label: 'Year' }, { key: 'value', label: 'Citations' }], cites);
  else columns(el1, { data: cites, unit: 'citations', partialNote: 'year to date' });

  const outs = P.publications_by_year.map((y) => ({ label: String(y.year), values: { journal: y.journal, conference: y.conference, preprint: y.preprint, other: (y.other || 0) + (y.thesis || 0) } }));
  const el2 = $('#chart-outputs', root);
  if (state.tables.outputs) {
    el2.innerHTML = dataTable([{ key: 'label', label: 'Year' }, ...SERIES.map((s) => ({ key: s.key, label: s.label }))], outs.map((o) => ({ label: o.label, ...o.values })));
  } else stacked(el2, { data: outs, series: SERIES });
}

// ── publications ─────────────────────────────────────────────────────────────
function authorsHTML(p) {
  const list = p.authors || [];
  const me = p.me_index;
  const fmt = (name, i) => (i === me ? `<b>${esc(name)}</b>` : esc(name));
  if (list.length <= 7) return list.map(fmt).join(', ') + (p.authors_truncated ? ', …' : '');
  const out = list.slice(0, 3).map(fmt);
  if (me != null && me >= 3 && me < list.length - 1) out.push('…', fmt(list[me], me));
  out.push('…', fmt(list.at(-1), list.length - 1));
  return `${out.join(', ').replace(/, …,/g, ' …')} <span class="muted">(${list.length} authors)</span>`;
}

function pubHTML(p, withActions = true) {
  const link = p.url || p.scholar_url;
  return `<article class="pub">
    <h3>${link ? `<a href="${safeUrl(link)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</h3>
    <div class="cite-n"><b>${num(p.citations)}</b><span>cites</span></div>
    <p class="byline">${authorsHTML(p)}</p>
    <p class="where">${p.venue ? `<i>${esc(p.venue)}</i>` : ''}${p.venue_detail ? `<span>${esc(p.venue_detail)}</span>` : ''}<span>${p.year || ''}</span>
      ${p.type !== 'journal' ? `<span class="tag">${esc(TYPE_LABEL[p.type] || p.type)}</span>` : ''}${p.oa_url ? '<span class="tag accent">Open access</span>' : ''}</p>
    ${withActions ? `${p.abstract ? `<p class="abstract" data-toggle="abstract">${esc(p.abstract)}</p>` : ''}
    <div class="pub-actions">
      ${p.oa_url ? `<a class="act" href="${safeUrl(p.oa_url)}" target="_blank" rel="noopener">${icon('pdf', 'sm')}Read</a>` : ''}
      ${p.scholar_url ? `<a class="act" href="${safeUrl(p.scholar_url)}" target="_blank" rel="noopener">Scholar</a>` : ''}
      <button class="act" type="button" data-cite="${esc(p.id)}">${icon('copy', 'sm')}Reference</button>
      <button class="act" type="button" data-bib="${esc(p.id)}">BibTeX</button>
    </div>` : ''}
  </article>`;
}

function publicationsHTML(P) {
  const q = state.q.trim().toLowerCase();
  const types = ['journal', 'conference', 'preprint', 'other'];
  const count = (t) => P.publications.filter((p) => (t === 'other' ? ['other', 'thesis'].includes(p.type) : p.type === t)).length;
  let list = P.publications.filter((p) => {
    if (state.type !== 'all' && !(state.type === 'other' ? ['other', 'thesis'].includes(p.type) : p.type === state.type)) return false;
    if (state.theme !== 'all' && !p.themes.includes(state.theme)) return false;
    if (q && !`${p.title} ${(p.authors || []).join(' ')} ${p.venue || ''} ${p.year}`.toLowerCase().includes(q)) return false;
    return true;
  });
  list = [...list].sort((a, b) => (state.sort === 'cites' ? b.citations - a.citations || (b.year || 0) - (a.year || 0) : (b.year || 0) - (a.year || 0) || b.citations - a.citations));
  const chip = (key, value, label) => `<button class="chip" type="button" data-set="${key}" data-val="${value}" aria-pressed="${state[key] === value}">${label}</button>`;
  let body = '';
  if (!list.length) body = '<div class="empty"><h3>No publications match</h3><p>Clear the search or filters.</p></div>';
  else if (state.sort === 'year') {
    const years = [...new Set(list.map((p) => p.year))];
    body = years.map((y) => { const part = list.filter((p) => p.year === y); return `<h2 class="year-head">${y || 'Undated'}<span>${part.length} ${part.length === 1 ? 'output' : 'outputs'}</span></h2><div class="pubs">${part.map((p) => pubHTML(p)).join('')}</div>`; }).join('');
  } else body = `<div class="pubs" style="margin-top:8px">${list.map((p) => pubHTML(p)).join('')}</div>`;

  return `<div class="toolbar">
      <form class="search" role="search">${icon('search')}
        <input type="search" name="pq" value="${esc(state.q)}" placeholder="Search title, author, journal or year" aria-label="Search publications" autocomplete="off">
        ${state.q ? `<button type="button" data-clear aria-label="Clear search">${icon('x', 'sm')}</button>` : ''}</form>
      <div class="chips" role="group" aria-label="Filters">
        ${chip('type', 'all', `All <span class="n">${P.publications.length}</span>`)}${types.map((t) => chip('type', t, `${TYPE_LABEL[t]} <span class="n">${count(t)}</span>`)).join('')}
        <span style="flex:none;width:1px;background:var(--line-2);margin:6px 2px"></span>
        ${chip('sort', 'year', 'Newest')}${chip('sort', 'cites', 'Most cited')}
      </div>
      <div class="chips" role="group" aria-label="Themes">
        ${chip('theme', 'all', 'All themes')}${P.themes.map((t) => chip('theme', t.id, esc(t.label))).join('')}
      </div>
    </div>
    <p class="small muted" style="margin-top:12px">${list.length} of ${P.publications.length} outputs · ${num(list.reduce((a, p) => a + p.citations, 0))} citations</p>
    ${body}`;
}

function reference(p) {
  if (!p) return '';
  const authors = (p.authors || []).join(', ') + (p.authors_truncated ? ', et al.' : '');
  return `${authors} (${p.year || 'n.d.'}). ${p.title}. ${[p.venue, p.venue_detail].filter(Boolean).join(', ')}.${p.doi ? ` https://doi.org/${p.doi}` : ''}`.replace(/\s+\./g, '.');
}

function bibtex(p) {
  if (!p) return '';
  const first = ((p.authors || ['anon'])[0].split(/\s+/).pop() || 'anon').toLowerCase().replace(/[^a-z]/g, '');
  const word = (p.title.split(/\s+/).find((w) => w.length > 3) || 'paper').toLowerCase().replace(/[^a-z]/g, '');
  const kind = p.type === 'journal' ? 'article' : p.type === 'conference' ? 'inproceedings' : p.type === 'thesis' ? 'phdthesis' : 'misc';
  const venueKey = kind === 'article' ? 'journal' : kind === 'inproceedings' ? 'booktitle' : kind === 'phdthesis' ? 'school' : 'howpublished';
  const rows = [['title', `{${p.title}}`], ['author', (p.authors || []).join(' and ')], [venueKey, p.venue], ['year', p.year], ['doi', p.doi]]
    .filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
  return `@${kind}{${first}${p.year || ''}${word},\n${rows}\n}`;
}
