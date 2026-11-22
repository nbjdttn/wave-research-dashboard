// Hand a request to an agent of your choice: one of your own (for example a Claude Code session
// working on your Mac), the Claude app, or simply the clipboard / the phone's share sheet.
// Every choice that opens something copies the request first, so it is ready to paste on arrival:
// the Claude app does not fill a request in from a link. Your list of agents is kept on this device only.
import { esc, icon, store, toast } from './util.js';

const OK_LINK = /^(https:\/\/|claude:\/\/|claude-cli:\/\/|sms:)/i;      // nothing else is ever opened
const newSession = (q) => `https://claude.ai/code/new?q=${encodeURIComponent(q)}`;   // "q" fills the request in where that is supported

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

/** Where a request can go, most recently used first. Each entry: { id, name, hint, href? }. */
function destinations(request) {
  const mine = agents.all().map((a) => (a.link.includes('{q}')
    ? { id: a.id, name: a.name, hint: 'Opens with the request filled in — copied as well', href: a.link.replace('{q}', encodeURIComponent(request)) }
    : { id: a.id, name: a.name, hint: 'Copies the request and opens it — paste and send', href: a.link }));
  const list = [
    ...mine,
    { id: 'new', name: 'Claude app', hint: 'Copies the request and opens a new session — paste and send', href: newSession(request) },
    { id: 'copy', name: 'Copy only', hint: 'Paste it into any agent — on your Mac too, if Handoff is on' },
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
        ? `<a class="agent" href="${esc(d.href)}" target="_blank" rel="noopener" data-agent="${esc(d.id)}">${inner}</a>`
        : `<button class="agent" type="button" data-agent="${esc(d.id)}">${inner}</button>`;
    }).join('')}</div>
    <details class="fold" style="margin-top:14px"><summary>The request</summary><div class="fold-body"><p class="request">${esc(request)}</p></div></details>
    <p style="margin-top:14px"><button class="btn sm" type="button" data-manage-agents>${icon('plus', 'xs')}Add or remove agents</button></p>`;
}

/**
 * Put text on the clipboard during the tap itself, so it is already there when another app comes to
 * the front. The older, immediate way is tried first; the newer one covers browsers without it.
 * Resolves to true when the text was copied.
 */
function copyNow(text) {
  let done = false;
  try {
    const held = document.activeElement;
    const box = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px';
    document.body.appendChild(box);
    box.focus({ preventScroll: true });
    box.setSelectionRange(0, text.length);
    done = document.execCommand('copy');
    box.remove();
    held?.focus?.({ preventScroll: true });
  } catch { /* not available: the newer way below */ }
  if (done) return Promise.resolve(true);
  return navigator.clipboard?.writeText ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);
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
  // Copy before anything opens. A link opens by itself: this is a real tap on it, which is what lets
  // the phone hand it to the Claude app.
  const copied = await copyNow(request);
  if (copied) toast(id === 'copy' ? 'Request copied' : 'Request copied — paste it there');
  else toast('Copying is not available here — open “The request” and copy it by hand');
  return copied || id !== 'copy';
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
