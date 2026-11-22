// Hand a request to an agent of your choice: one of your own (for example a Claude Code session
// working on your Mac), a new session, or simply the clipboard / the phone's share sheet.
// Your list of agents is kept on this device only.
import { esc, icon, store, toast, repoSlug } from './util.js';

const OK_LINK = /^(https:\/\/|claude:\/\/|claude-cli:\/\/|sms:)/i;      // nothing else is ever opened
const newSession = (q, repo) => `https://claude.ai/code/new?q=${encodeURIComponent(q)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`;

export const agents = {
  all: () => store.get('agents', []).filter((a) => a && a.name && OK_LINK.test(a.link || '')),
  add(name, link) {
    name = String(name || '').trim().slice(0, 40);
    link = String(link || '').trim();
    if (!name) return 'Give the agent a name';
    if (!OK_LINK.test(link)) return 'The link must start with https://, claude://, claude-cli:// or sms:';
    store.set('agents', [...this.all(), { id: `a${Date.now().toString(36)}`, name, link }]);
    return null;
  },
  remove(id) { store.set('agents', this.all().filter((a) => a.id !== id)); },
};

/** Where a request can go, most recently used first. Each entry: { id, name, hint, href?, copy? }. */
function destinations(request) {
  const repo = repoSlug();
  const mine = agents.all().map((a) => (a.link.includes('{q}')
    ? { id: a.id, name: a.name, hint: 'Opens with the request filled in', href: a.link.replace('{q}', encodeURIComponent(request)) }
    : { id: a.id, name: a.name, hint: 'Copies the request, then opens it — paste and send', href: a.link, copy: true }));
  const list = [
    ...mine,
    { id: 'new', name: 'New Claude session', hint: 'A new session in the Claude app, with the request filled in', href: newSession(request) },
    ...(repo ? [{ id: 'cloud', name: 'New cloud session on the dashboard’s files', hint: 'Can read your profile and the funding data', href: newSession(request, repo) }] : []),
    { id: 'copy', name: 'Copy the request', hint: 'Paste it into any agent — on your Mac too, if Handoff is on' },
    ...(navigator.share ? [{ id: 'share', name: 'Share…', hint: 'AirDrop, Messages, Mail and other apps' }] : []),
  ];
  const last = store.raw('agent.last');
  return list.sort((a, b) => (b.id === last) - (a.id === last));
}

/** The chooser, drawn into the bottom sheet. */
export function agentSheetHTML(request, subject) {
  return `
    <p class="small muted" style="margin-top:2px">${esc(subject)}</p>
    <div class="agent-list">${destinations(request).map((d) => {
      const inner = `<span class="agent-ico">${icon(d.id === 'copy' ? 'copy' : d.id === 'share' ? 'ext' : 'spark', 'sm')}</span><span><b>${esc(d.name)}</b><span>${esc(d.hint)}</span></span>`;
      return d.href
        ? `<a class="agent" href="${esc(d.href)}" target="_blank" rel="noopener" data-agent="${esc(d.id)}"${d.copy ? ' data-copy' : ''}>${inner}</a>`
        : `<button class="agent" type="button" data-agent="${esc(d.id)}">${inner}</button>`;
    }).join('')}</div>
    <details class="fold" style="margin-top:14px"><summary>The request</summary><div class="fold-body"><p class="request">${esc(request)}</p></div></details>
    <p style="margin-top:14px"><button class="btn sm" type="button" data-manage-agents>${icon('plus', 'xs')}Add or remove agents</button></p>`;
}

/** Call from the sheet's click handler. Returns true when the click was a destination (close the sheet). */
export async function agentClick(e, request) {
  const el = e.target.closest('[data-agent]');
  if (!el) return false;
  const id = el.dataset.agent;
  store.raw('agent.last', id);
  if (id === 'share') {
    e.preventDefault();
    try { await navigator.share({ text: request }); } catch { /* dismissed */ }
    return true;
  }
  if (id === 'copy' || 'copy' in el.dataset) {             // the link (if any) opens by itself: this is a real tap on it
    try { await navigator.clipboard.writeText(request); toast(id === 'copy' ? 'Request copied' : 'Request copied — paste it there'); }
    catch { toast('Copying is not available here — open “The request” and copy it by hand'); return id !== 'copy'; }
  }
  return true;
}

/** Settings → Agents: the list and the form to add one. */
export function agentSettingsHTML() {
  const list = agents.all();
  return `
    ${list.length ? `<div class="srcs">${list.map((a) => `<div class="src agent-row"><b style="font-weight:500">${esc(a.name)}</b>
      <button class="icon-btn sm" type="button" data-agent-remove="${esc(a.id)}" aria-label="Remove ${esc(a.name)}">${icon('x', 'sm')}</button></div>`).join('')}</div>` : ''}
    <form class="agent-form" id="agent-form">
      <input name="name" placeholder="Name, e.g. MacBook – waves" aria-label="Agent name" autocomplete="off" maxlength="40">
      <input name="link" placeholder="Link to it (https://claude.ai/code/…)" aria-label="Link to the agent" autocomplete="off" inputmode="url">
      <button class="btn sm" type="submit">Add</button>
    </form>
    <p class="small muted" style="margin-top:8px">A session on your Mac: run <b>/remote-control</b> in Claude Code there and paste the link it shows. Sending copies the request and opens that session — paste and send.</p>
    <p class="small muted" style="margin-top:6px">Put <b>{q}</b> in a link to have the request filled in, e.g. on the Mac itself <b>claude-cli://open?cwd=/path/to/project&amp;q={q}</b>.</p>`;
}
