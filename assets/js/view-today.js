// "Today" — the front page: what is new in papers and funding since you last looked.
import { esc, icon, longToday, daysTo, num, plural } from './util.js';
import { storyHTML, oppRow, isLive, citationTrend } from './cards.js';
import { sparkline } from './charts.js';
import { mountWave } from './wave.js';

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

export function renderToday(root, D, ctx) {
  const { profile, papers, grants } = D;
  const feed = papers?.papers || [];
  const newDays = papers?.new_days || 10;
  const isNew = (p) => { const d = daysTo(p.news_date); return d != null && d >= -newDays; };
  const fresh = feed.filter(isNew).sort((a, b) => b.score - a.score);
  const stories = fresh.filter((p) => !p.cites?.length);
  const citing = feed.filter((p) => p.cites?.length).sort((a, b) => (b.news_date || '').localeCompare(a.news_date || '') || b.score - a.score);
  const citingNew = citing.filter(isNew);
  const opps = (grants?.opportunities || []).filter(isLive);
  const deadlines = opps.filter((o) => o.bucket === 'deadline').sort((a, b) => a.closes.localeCompare(b.closes));
  const newOpps = opps.filter((o) => o.is_new);
  const prepare = opps.filter((o) => o.bucket === 'prepare');
  const next = deadlines[0];
  const nextDays = next ? daysTo(next.closes) : null;
  const m = profile?.metrics;
  const first = (profile?.researcher?.short_name || '').split(' ')[0];
  const own = Object.fromEntries((profile?.publications || []).map((p) => [p.id, p.title]));
  const ownTitle = (id) => own[id];

  const lead = stories[0];
  const rest = stories.slice(1, 6);
  root.innerHTML = `
    <header class="masthead">
      <div class="mast-date">${esc(longToday())}</div>
      <h1 class="mast-title">Wave Research <em>Daily</em></h1>
      <p class="mast-sub">${esc(greeting())}${first ? `, ${esc(first)}` : ''}.</p>
      <div class="mast-wave" id="mast-wave"></div>
      <nav class="ticker" aria-label="Today at a glance">
        <a href="#papers"><b>${num(stories.length)}</b><span>new papers</span></a>
        <a href="#papers/citing"><b>${num(citingNew.length || citing.length)}</b><span>${citingNew.length ? 'new citations' : 'recent citations'}</span></a>
        <a href="#funding"><b>${num(opps.length)}</b><span>funding calls</span></a>
        <a href="#funding">${next ? `<b>${nextDays === 0 ? 'Today' : `${num(nextDays)} d`}</b><span>next deadline</span>` : '<b>–</b><span>no deadline</span>'}</a>
      </nav>
    </header>

    <div class="cols split">
      <div>
        <section class="section" aria-labelledby="h-stories">
          <div class="section-head"><h2 class="eyebrow" id="h-stories">New papers<span class="count">${num(stories.length)}</span></h2><a class="more" href="#papers">All papers ${icon('arrow', 'xs')}</a></div>
          ${lead ? `<div class="stories">${storyHTML(lead, { lead: true, saved: ctx.papers.has(lead.id), ownTitle, showNew: false })}${rest.map((p) => storyHTML(p, { saved: ctx.papers.has(p.id), ownTitle, abstract: false, showNew: false })).join('')}</div>`
            : `<div class="empty"><h3>No new papers this week</h3></div>`}
        </section>
      </div>

      <div>
        <section class="section" aria-labelledby="h-fund">
          <div class="section-head"><h2 class="eyebrow" id="h-fund">Funding desk</h2><a class="more" href="#funding">All funding ${icon('arrow', 'xs')}</a></div>
          ${fundingDesk(newOpps, deadlines, prepare, opps, grants)}
        </section>

        ${citing.length ? `<section class="section" aria-labelledby="h-cite">
          <div class="section-head"><h2 class="eyebrow" id="h-cite">Citing your work<span class="count">${num(citing.length)}</span></h2><a class="more" href="#papers/citing">All ${icon('arrow', 'xs')}</a></div>
          <div class="stories">${citing.slice(0, 3).map((p) => storyHTML(p, { saved: ctx.papers.has(p.id), ownTitle, abstract: false })).join('')}</div>
        </section>` : ''}

        ${m ? `<section class="section" aria-labelledby="h-num">
          <div class="section-head"><h2 class="eyebrow" id="h-num">Your numbers</h2><a class="more" href="#profile">Profile ${icon('arrow', 'xs')}</a></div>
          <div class="kpis" style="grid-template-columns:repeat(2,minmax(0,1fr))">
            <div class="card kpi"><div class="kpi-label">Citations</div><div class="kpi-value">${num(m.citations)}</div>
              <div class="kpi-delta">${citationTrend(profile)}</div>
              ${sparkline((profile.citations_by_year || []).map((c) => c.count))}</div>
            <div class="card kpi"><div class="kpi-label">h-index</div><div class="kpi-value">${num(m.h_index)}</div>
              <div class="kpi-delta">i10 ${num(m.i10_index)} · ${num(m.outputs)} outputs</div></div>
          </div>
          ${D.citations ? `<p class="scan"><a class="more" href="#profile/citations">${num(D.citations.totals.last_12_months)} citing papers this year · ${num(D.citations.totals.countries)} countries ${icon('arrow', 'xs')}</a></p>` : ''}
        </section>` : ''}
      </div>
    </div>

    <p class="scan" style="margin-top:28px">${esc(ctx.updatedLine || '')}</p>`;

  const stop = mountWave(root.querySelector('#mast-wave'));
  ctx.onLeave(stop);
}

function fundingDesk(newOpps, deadlines, prepare, opps, grants) {
  if (!opps.length) {
    const pending = grants?.counts?.awaiting_review || 0;
    return `<div class="card pad"><div class="notice">${icon('info', 'sm')}<span>${pending
      ? `<b>${pending} calls awaiting review.</b>`
      : '<b>No calls selected yet.</b>'}</span></div></div>`;
  }
  const seen = new Set();
  const take = (list, n) => list.filter((o) => !seen.has(o.id)).slice(0, n).map((o) => { seen.add(o.id); return o; });
  const blocks = [];
  const a = take(deadlines, 3);
  if (a.length) blocks.push(['Next deadlines', a]);
  const b = take(newOpps, 3);
  if (b.length) blocks.push(['New', b]);
  const c = take(prepare.slice().sort((x, y) => (x.analysis.recurrence.next_expected_close || '9').localeCompare(y.analysis.recurrence.next_expected_close || '9')), 2);
  if (c.length) blocks.push(['Prepare ahead', c]);
  if (!blocks.length) blocks.push(['Always open', take(opps, 3)]);
  return `<div class="card pad">${blocks.map(([title, list], i) => `
    <h3 class="fact-label" style="margin:${i ? '18px' : '0'} 0 10px">${esc(title)}</h3>
    <div>${list.map(oppRow).join('')}</div>`).join('')}</div>`;
}
