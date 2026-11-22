// The two repeating units of the app: a paper "story" and a funding opportunity card.
import { esc, safeUrl, icon, fmtDate, fmtTime, fmtMonth, daysTo, rel, left, people, parseDay, isoDay, today, store, download, brief, claudeLink } from './util.js';

// ── funder names ─────────────────────────────────────────────────────────────
const FUNDERS = [
  [/advanced research and invention agency/i, 'ARIA'],
  [/supergen offshore renewable energy/i, 'Supergen ORE Hub'],
  [/marie sk[lł]odowska/i, 'EU · MSCA'],
  [/european research council/i, 'ERC'],
  [/exhibition of 1851/i, '1851 Royal Commission'],
  [/office of naval research/i, 'ONR Global'],
  [/institution of civil engineers/i, 'ICE'],
  [/royal academy of engineering/i, 'RAEng'],
  [/daiwa/i, 'Daiwa Foundation'],
];
/** A funder name short enough for a tag; the full name stays in the tooltip. */
export function funderShort(name) {
  const n = String(name || '').trim();
  for (const [re, out] of FUNDERS) if (re.test(n)) return out;
  if (/international science partnerships fund/i.test(n)) return `${n.split(' (')[0]} · ISPF`;
  return n.replace(/\s*\([^)]*\)\s*$/, '');
}
/** The funder tag used on every funding card and row. */
export const funderTag = (name, cls = 'accent') => `<span class="tag clip ${cls}" title="${esc(name || '')}">${esc(funderShort(name))}</span>`;

// ── prompts handed to Claude (opened in a new session; you press send there) ──
function paperPrompt(p) {
  return `Read this paper and tell me, in five short bullets, what is new in it and how it bears on my own research. `
    + `My profile and interests are in config/researcher.toml in this repository.\n\n`
    + `"${p.title}"${p.venue ? ` — ${p.venue}` : ''}${p.year ? `, ${p.year}` : ''}\n${p.url || (p.doi ? `https://doi.org/${p.doi}` : '')}`;
}
function oppPrompt(o) {
  const when = o.closes ? ` The deadline is ${String(o.closes).slice(0, 10)}.` : '';
  return `Help me decide on, and then plan, an application to "${o.title}" (${o.funder}).${when}\n\n`
    + `The call: ${o.url}\nMy profile and priorities are in config/researcher.toml; the dashboard's own assessment of this call is in `
    + `data/grants.json under the id "${o.id}".\n\nStart with a go / no-go view in five bullets, then a week-by-week plan to the deadline `
    + `and a first outline of the case for support.`;
}

// ── profile numbers ──────────────────────────────────────────────────────────
/**
 * The line under the citations figure. Scholar's count only changes on days Scholar could be read,
 * so month-on-month movement is taken from OpenAlex, which is recorded every day, and labelled.
 */
export function citationTrend(profile) {
  const m = profile.metrics, hist = profile.history || [];
  const now = hist.at(-1);
  const then = [...hist].reverse().find((h) => daysTo(h.date) <= -27 && h.oa_citations != null);
  if (now?.oa_citations != null && then && now.oa_citations > then.oa_citations) {
    return `<b>+${(now.oa_citations - then.oa_citations).toLocaleString('en-GB')}</b> in the last month <span class="muted">(OpenAlex)</span>`;
  }
  return `<b>+${Number(m.citations_this_year || 0).toLocaleString('en-GB')}</b> in ${String(m.as_of || '').slice(0, 4)} so far`;
}
/** Days since Google Scholar was last read successfully. */
export const scholarAge = (profile) => { const d = daysTo(profile.metrics?.as_of); return d == null ? 0 : -d; };

// ── papers ───────────────────────────────────────────────────────────────────
export function paperDate(p) {
  if (p.in_press) return 'In press';
  const d = daysTo(p.news_date);
  if (d != null && d >= -6 && d <= 0) return d === 0 ? 'Today' : d === -1 ? 'Yesterday' : rel(d);
  return fmtDate(p.date);
}

/** Every paper rendered so far, by id — lets a tap on "save" find the object (incl. live search hits). */
export const paperIndex = new Map();

export function storyHTML(p, { lead = false, saved = false, ownTitle = null, abstract = true, showNew = true, plain = false } = {}) {
  // `plain` (the Today screen): every card the same size, bullet points only, no abstract
  paperIndex.set(p.id, p);
  const venue = p.venue ? `<span class="venue">${esc(p.venue)}</span><span class="sep">·</span>` : '';
  const cites = (p.cites || []).map((id) => ownTitle?.(id)).filter(Boolean);
  return `<article class="story${lead ? ' lead' : ''}" data-paper="${esc(p.id)}">
    <div class="kicker">${venue}<span>${esc(paperDate(p))}</span>
      ${showNew && p.is_new ? '<span class="tag new">New</span>' : ''}
      ${p.coauthor ? `<span class="tag accent">Co-author: ${esc(p.coauthor)}</span>` : ''}
    </div>
    <h3 class="story-title"><a href="${safeUrl(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a></h3>
    <p class="byline">${people(p.authors, p.author_count, 2)}</p>
    ${p.bullets?.length ? `<ul class="bullets">${p.bullets.slice(0, 3).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    ${p.abstract && !plain ? `<p class="abstract" data-toggle="abstract"${lead && abstract && !p.bullets?.length ? '' : ' hidden'}>${esc(p.abstract)}</p>` : ''}
    ${cites.length ? `<div class="cites-you">${icon('quote', 'sm')}<span>Cites <i>${esc(cites[0])}</i>${cites.length > 1 ? ` +${cites.length - 1}` : ''}</span></div>` : ''}
    <div class="story-foot">
      <span class="match" title="How close this is to your own papers"><span class="meter" style="--v:${Number(p.score) || 0}"></span>${Number(p.score) || 0}%</span>
      <span class="story-actions">
        ${p.abstract && !plain && !(lead && abstract && !p.bullets?.length) ? `<button class="act" type="button" data-abs aria-expanded="false">Abstract</button>` : ''}
        ${p.pdf_url ? `<a class="act" href="${safeUrl(p.pdf_url)}" target="_blank" rel="noopener">${icon('pdf', 'sm')}PDF</a>` : ''}
        <a class="act" href="${safeUrl(claudeLink(paperPrompt(p)))}" target="_blank" rel="noopener" aria-label="Send to Claude" title="Send to Claude">${icon('spark', 'sm')}</a>
        <button class="act" type="button" data-save-paper="${esc(p.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from reading list' : 'Save to reading list'}">${icon('save', 'sm')}</button>
      </span>
    </div>
  </article>`;
}

// ── funding ──────────────────────────────────────────────────────────────────
export const EFFORT = { light: [1, 'Light'], moderate: [2, 'Moderate'], heavy: [3, 'Heavy'], major: [4, 'Major'] };
const TOPIC = { core: 'core', strong: 'strong', open_call: 'open topic', partial: 'partial', off_topic: 'off topic' };
const STAGE = { ideal: 'ideal', suitable: 'suitable', stretch: 'stretch', not_applicable: 'host / partner', too_early: 'too early', too_senior: 'too junior a scheme' };
const ELIG = { eligible: 'yes', likely: 'likely', check: 'check', not_eligible: 'no' };
export const TYPES = {
  project_grant: 'Project grant', fellowship: 'Fellowship', network: 'Network', travel_exchange: 'Travel & exchange',
  prize: 'Prize', innovation: 'Innovation', hosting: 'Host a fellow', compute_equipment: 'Compute & equipment', other: 'Other',
};
const CADENCE = { annual: 'every year', twice_yearly: 'twice a year', quarterly: 'quarterly', rolling: 'always open', irregular: 'irregularly', one_off: 'one-off', unknown: '' };

/** Urgency of a deadline — a state, so it uses the reserved status colours with a label. */
export function dueClass(days) {
  if (days == null) return '';
  return days <= 14 ? 'critical' : days <= 35 ? 'serious' : days <= 75 ? 'warning' : 'ok';
}
/** Is the round still running on the reader's own calendar (data can be a day old)? */
export const isLive = (o) => !(o.bucket === 'deadline' && daysTo(o.closes) < 0);
export const nextDate = (o) => (o.bucket === 'deadline' ? o.closes : o.bucket === 'prepare' ? (o.analysis.recurrence.next_expected_close || o.analysis.recurrence.next_expected_open || o.opens) : null);

function deadlineFact(o) {
  const a = o.analysis, r = a.recurrence || {};
  if (o.bucket === 'deadline') {
    const d = daysTo(o.closes);
    const time = fmtTime(o.closes);
    return `<div class="fact"><div class="fact-label">Deadline</div>
      <div class="fact-value">${fmtDate(o.closes, { year: true })}</div>
      <div class="fact-sub"><span class="due ${dueClass(d)}">${esc(left(d))}</span>${time ? ` · ${time} UK` : ''}</div></div>`;
  }
  if (o.bucket === 'rolling') {
    return `<div class="fact"><div class="fact-label">Deadline</div><div class="fact-value">Always open</div>
      <div class="fact-sub">${esc(a.round?.stage || 'Apply any time')}</div></div>`;
  }
  const close = r.next_expected_close, open = r.next_expected_open || (o.opens ? o.opens.slice(0, 7) : null);
  const when = close ? `${r.is_estimate ? '~' : ''}${fmtMonth(close)}` : open ? `Opens ${r.is_estimate ? '~' : ''}${fmtMonth(open)}` : 'To be announced';
  return `<div class="fact"><div class="fact-label">Next round</div><div class="fact-value">${esc(when)}</div>
    <div class="fact-sub">${close && open ? `opens ${r.is_estimate ? '~' : ''}${esc(fmtMonth(open))} · ` : ''}${r.is_estimate ? 'estimate' : 'announced'}</div></div>`;
}

function startBy(o) {
  const s = o.analysis.effort?.start_by;
  if (!s || o.bucket === 'rolling') return '';
  const d = daysTo(s);
  if (d == null) return '';
  const monthOnly = o.bucket === 'prepare';
  const when = monthOnly ? fmtMonth(s) : fmtDate(s, { year: true });
  const text = d < 0
    ? `<b>Start now</b> — the suggested start was ${esc(when)}`
    : `Start ${monthOnly ? 'preparing in' : 'by'} <b>${esc(when)}</b> <span class="nowrap">(${esc(rel(d))})</span>`;
  return `<div class="startby">${icon('clock', 'sm')}<span>${text}</span></div>`;
}

function verdicts(a) {
  const pill = (label, value, ok) => `<span class="verdict${ok ? '' : ' check'}">${icon(ok ? 'check' : 'alert', 'xs')}${label}: <b>${esc(value)}</b></span>`;
  return `<div class="verdicts">
    ${pill('Topic', TOPIC[a.topic_fit.verdict] || a.topic_fit.verdict, true)}
    ${pill('Stage', STAGE[a.career_stage.verdict] || a.career_stage.verdict, a.career_stage.verdict !== 'stretch')}
    ${pill('Eligible', ELIG[a.eligibility.verdict] || a.eligibility.verdict, a.eligibility.verdict !== 'check')}
  </div>`;
}

function checklist(o) {
  const done = new Set(store.get(`check.${o.id}`, []));
  return `<ul class="checklist">${o.analysis.requirements.map((r, i) => `
    <li class="${done.has(i) ? 'done' : ''}"><input type="checkbox" id="c-${esc(o.id)}-${i}" data-check="${esc(o.id)}" data-i="${i}" ${done.has(i) ? 'checked' : ''}>
      <label for="c-${esc(o.id)}-${i}"><b>${esc(r.item)}</b>${r.detail ? `<span>${brief(r.detail)}</span>` : ''}</label></li>`).join('')}</ul>`;
}

function datesBlock(o) {
  const a = o.analysis, r = a.recurrence || {}, rnd = a.round || {};
  const row = (k, v) => (v ? `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>` : '');
  const stamp = (s) => (s ? `${fmtDate(s, { year: true })}${fmtTime(s) ? `, ${fmtTime(s)}` : ''}` : '');
  const past = o.closes && daysTo(o.closes) < 0;       // a finished round, shown for reference
  let html = '<dl class="dates">';
  html += row(past ? 'Last round opened' : 'Opens', stamp(o.opens));
  html += row(past ? 'Last round closed' : 'Closes', o.closes ? stamp(o.closes) : (o.bucket === 'rolling' ? 'No closing date' : ''));
  if (!o.closes && o.last_round?.closed) html += row(`Last round${o.last_round.label ? ` (${esc(o.last_round.label)})` : ''} closed`, fmtDate(o.last_round.closed, { year: true }));
  if (o.bucket === 'prepare' && r.next_expected_open) html += row('Next round opens', `${r.is_estimate ? '~' : ''}${fmtMonth(r.next_expected_open)}`);
  if (o.bucket === 'prepare' && r.next_expected_close) html += row('Next round closes', `${r.is_estimate ? '~' : ''}${fmtMonth(r.next_expected_close)}`);
  if (o.eu?.action_type) html += row('Type of action', esc(o.eu.action_type));
  if (o.eu?.deadline_model) html += row('Submission', esc(o.eu.deadline_model));
  html += row('Stage', esc(rnd.stage || ''));
  for (const d of rnd.other_dates || []) html += row(d.label, /^\d{4}-\d{2}/.test(d.date) ? fmtDate(d.date, { year: true }) : esc(d.date));
  html += row('Award', esc(a.award_summary?.amount || o.award?.award_range || o.award?.max_award || ''));
  html += row('Duration', esc(a.award_summary?.duration || ''));
  html += row('Total fund', esc(o.award?.total_fund || ''));
  html += row('Repeats', esc(CADENCE[r.cadence] || ''));
  html += '</dl>';
  if (rnd.notes) html += `<p style="margin-top:10px">${brief(rnd.notes)}</p>`;
  if (r.evidence && o.bucket === 'prepare') html += `<h4>Why another round is expected</h4><p>${brief(r.evidence)}</p>`;
  if (o.history?.length) {
    html += `<h4>Earlier rounds</h4><dl class="dates">${o.history.map((h) => `<div><dt>${esc(h.title)}</dt><dd>closed ${fmtDate(h.closes, { year: true })}</dd></div>`).join('')}</dl>`;
  }
  return html;
}

export function oppHTML(o, { saved = false, open = false } = {}) {
  const a = o.analysis;
  const [lvl, word] = EFFORT[a.effort.level] || [2, 'Moderate'];
  const host = a.role === 'host' || a.opportunity_type === 'hosting';
  const canCal = o.bucket === 'deadline' || (o.bucket === 'prepare' && a.effort.start_by);
  return `<article class="card opp" id="opp-${esc(o.id)}" data-opp="${esc(o.id)}">
    <div class="opp-head">
      ${funderTag(o.funder)}
      <span class="tag">${host ? icon('host', 'xs') : ''}${esc(TYPES[a.opportunity_type] || 'Funding')}</span>
      ${a.role === 'partner' ? '<span class="tag">As partner</span>' : ''}
      ${o.bucket === 'prepare' ? `<span class="tag sand">${icon('repeat', 'xs')}Not open yet</span>` : ''}
      ${o.is_new ? '<span class="tag new">New</span>' : ''}
    </div>
    <button class="act opp-save" type="button" data-save-opp="${esc(o.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from shortlist' : 'Add to shortlist'}">${icon('save', 'sm')}</button>
    <h3 class="opp-title"><a href="${safeUrl(o.url)}" target="_blank" rel="noopener">${esc(o.title)}</a></h3>
    <div class="facts">
      ${deadlineFact(o)}
      <div class="fact"><div class="fact-label">Effort</div>
        <div class="fact-value"><span class="effort l${lvl}" aria-hidden="true"><i></i><i></i><i></i><i></i></span> ${word}</div>
        <div class="fact-sub">${esc(a.effort.prep_time || '')}</div></div>
      <div class="fact"><div class="fact-label">Fit</div>
        <div class="fact-value">${a.fit_score}<span class="muted" style="font-weight:500">/100</span></div>
        <div class="fact-sub">${esc(a.fit_label)}</div></div>
    </div>
    ${startBy(o)}
    ${verdicts(a)}
    <p class="opp-summary">${brief(a.summary)}</p>
    <details class="fold"${open ? ' open' : ''}>
      <summary>What you need <span class="n">${a.requirements.length}</span></summary>
      <div class="fold-body">
        ${checklist(o)}
        ${a.effort.drivers?.length ? `<h4>Why this much effort${a.effort.person_days ? ` · about ${esc(a.effort.person_days)} days` : ''}</h4><ul class="points">${a.effort.drivers.map((d) => `<li>${brief(d)}</li>`).join('')}</ul>` : ''}
      </div>
    </details>
    <details class="fold">
      <summary>Why it fits</summary>
      <div class="fold-body"><ul class="points">
        <li><b>Fit</b>${brief(a.why_fit)}</li>
        <li><b>Topic</b>${brief(a.topic_fit.notes)}</li>
        <li><b>Stage</b>${brief(a.career_stage.notes)}</li>
        <li><b>Eligible</b>${brief(a.eligibility.notes)}</li>
        ${a.concerns ? `<li class="warn"><b>Watch</b>${brief(a.concerns)}</li>` : ''}
      </ul></div>
    </details>
    <details class="fold">
      <summary>Dates and award</summary>
      <div class="fold-body">${datesBlock(o)}</div>
    </details>
    ${a.next_steps?.length ? `<details class="fold"><summary>Next steps</summary><div class="fold-body"><ol class="steps">${a.next_steps.slice(0, 3).map((x) => `<li><span>${brief(x)}</span></li>`).join('')}</ol></div></details>` : ''}
    <div class="opp-actions">
      <a class="btn primary" href="${safeUrl(o.url)}" target="_blank" rel="noopener">Open the call ${icon('ext', 'sm')}</a>
      ${canCal ? `<button class="btn" type="button" data-cal="${esc(o.id)}">${icon('cal', 'sm')}Add to calendar</button>` : ''}
      <a class="btn" href="${safeUrl(claudeLink(oppPrompt(o)))}" target="_blank" rel="noopener">${icon('spark', 'sm')}Plan it with Claude</a>
    </div>
    <div class="opp-foot">${icon('spark', 'xs')}Reviewed by Claude · ${fmtDate(o.analysed?.at)}</div>
  </article>`;
}

/** One-line version for the front page. */
export function oppRow(o) {
  const a = o.analysis;
  const d = o.bucket === 'deadline' ? daysTo(o.closes) : null;
  const right = o.bucket === 'deadline'
    ? `<b>${fmtDate(o.closes)}</b><span class="due ${dueClass(d)}">${esc(left(d))}</span>`
    : o.bucket === 'rolling' ? '<b>Always open</b><span class="muted">no deadline</span>'
      : `<b>${a.recurrence.is_estimate ? '~' : ''}${esc(fmtMonth(nextDate(o)) || 'TBA')}</b><span class="muted">next round</span>`;
  return `<a class="rowlink" href="#funding/${esc(o.id)}">
    <h3>${esc(o.title)}</h3>
    <div class="right">${right}</div>
    <div class="meta">${funderTag(o.funder)}
      <span><span class="effort l${(EFFORT[a.effort.level] || [2])[0]}" aria-hidden="true"><i></i><i></i><i></i><i></i></span> ${esc((EFFORT[a.effort.level] || [0, 'Moderate'])[1])}</span>
      <span>Fit ${a.fit_score}</span>${o.is_new ? '<span class="tag new">New</span>' : ''}</div>
  </a>`;
}

// ── calendar export ──────────────────────────────────────────────────────────
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsDay = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

export function calendarFile(o) {
  const a = o.analysis;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const events = [];
  const add = (uid, day, summary, desc, alarmDays) => {
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    events.push(['BEGIN:VEVENT', `UID:${uid}@wave-research`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDay(day)}`, `DTEND;VALUE=DATE:${icsDay(end)}`,
      `SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(desc)}`, `URL:${o.url}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, `TRIGGER:-P${alarmDays}D`, 'END:VALARM', 'END:VEVENT'].join('\r\n'));
  };
  const need = a.requirements.map((r) => `• ${r.item}${r.detail ? ` — ${r.detail}` : ''}`).join('\n');
  if (o.bucket === 'deadline' && parseDay(o.closes)) {
    const t = fmtTime(o.closes);
    add(`${o.id}-deadline`, parseDay(o.closes), `Deadline${t ? ` ${t} UK` : ''}: ${o.title} (${o.funder})`,
      `${a.summary}\n\nWhat you need:\n${need}\n\n${o.url}`, 7);
  }
  const start = parseDay(a.effort.start_by);
  if (start && start >= today()) {
    add(`${o.id}-start`, start, `Start preparing: ${o.title} (${o.funder})`,
      `Effort: ${a.effort.level} — ${a.effort.prep_time}.\n\nWhat you need:\n${need}\n\n${o.url}`, 1);
  }
  if (!events.length) return false;
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wave Research//Funding//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
  download(`${o.id}.ics`, body, 'text/calendar');
  return true;
}

export { isoDay };
