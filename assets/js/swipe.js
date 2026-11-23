// Swipe a card sideways with a finger: one way saves it, the other puts it away.
// The page marks what can be swiped (data-swipe) and says what each direction does; this file only
// follows the finger, shows what letting go will do, and plays the card out when it leaves.
// Up-and-down movement is left to the page, so scrolling works as before: a swipe only begins once the
// finger has clearly moved sideways, and from then on the page is held still.

const ARM = 84;                                  // px past which letting go acts
const armAt = (width) => Math.min(ARM, width * 0.3);
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** The strip shown behind a card while it slides: a label at each end, level with the finger. */
function underlay(el, sides, fingerY) {
  const u = document.createElement('div');
  u.className = 'swipe-under';
  u.setAttribute('aria-hidden', 'true');
  const end = (side, cls) => (side ? `<span class="${cls}">${side.icon || ''}<b>${side.label}</b></span>` : `<span class="${cls}"></span>`);
  u.innerHTML = end(sides.right, 'swipe-right') + end(sides.left, 'swipe-left');
  const height = el.offsetHeight;
  const at = Math.max(Math.min(26, height / 2), Math.min(height - Math.min(26, height / 2), fingerY - el.getBoundingClientRect().top));
  u.style.cssText = `top:${el.offsetTop}px;left:${el.offsetLeft}px;width:${el.offsetWidth}px;height:${height}px;border-radius:${getComputedStyle(el).borderRadius};--at:${Math.round(at)}px`;
  el.parentNode.insertBefore(u, el);
  return u;
}

function tidy(el, under) {
  under?.remove();
  el.classList.remove('swiping');
  el.style.transition = el.style.transform = '';
}

/**
 * Slide a card off to one side and close the gap it leaves. Resolves when it is gone from view.
 * The card itself stays in the page (collapsed): the caller redraws the list.
 */
export async function sendOff(el, side = 'left', under = null) {
  if (calm() || !el.isConnected) { tidy(el, under); return; }
  const width = el.offsetWidth, height = el.offsetHeight;
  const gap = parseFloat(getComputedStyle(el.parentNode).rowGap) || 0;
  el.classList.add('swiping');
  el.style.transition = 'transform .2s ease-in, opacity .2s ease-in';
  el.style.transform = `translate3d(${(side === 'left' ? -1 : 1) * (width + 48)}px,0,0)`;
  el.style.opacity = '0';
  await wait(200);
  for (const box of [el, under]) {
    if (!box) continue;
    box.style.overflow = 'hidden';
    box.style.height = `${height}px`;
  }
  void el.offsetHeight;                           // start the closing from the full height
  const closing = 'height .22s ease, margin .22s ease, padding .22s ease, opacity .22s ease';
  el.style.transition = closing;
  el.style.height = '0';
  el.style.minHeight = '0';
  el.style.paddingTop = el.style.paddingBottom = '0';
  el.style.borderTopWidth = el.style.borderBottomWidth = '0';
  el.style.marginBottom = `${-gap}px`;
  if (under) { under.style.transition = closing; under.style.height = '0'; under.style.opacity = '0'; }
  await wait(230);
  under?.remove();
}

/**
 * Follow sideways swipes on [data-swipe] elements inside `area`.
 * `sides(el)` → { right?, left? }, each { label, icon, leaves } — what a swipe to that side does
 * (`leaves`: the card goes away). `act(el, side)` is called when the reader lets go far enough.
 */
export function enableSwipe(area, { sides, act }) {
  let g = null;                                   // the gesture under way

  function back(s) {
    if (calm()) { tidy(s.el, s.under); return; }
    s.el.style.transition = 'transform .24s cubic-bezier(.2, .8, .2, 1)';
    s.el.style.transform = 'translate3d(0,0,0)';
    setTimeout(() => tidy(s.el, s.under), 250);
  }

  /** A finger that swiped must not also count as a tap on the link or button under it. */
  function swallowTap(el) {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 400);
  }

  const finger = (list, id) => { for (const t of list) if (t.identifier === id) return t; return null; };

  function move(e) {
    if (!g) return;
    const t = finger(e.touches, g.id);
    if (!t || e.touches.length > 1) { finish(true); return; }                            // a second finger: not a swipe
    const dx = t.clientX - g.x, dy = t.clientY - g.y;
    if (!g.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { finish(true); return; }   // the page is scrolling
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      g.on = true;
      g.sides = sides(g.el) || {};
      g.w = g.el.offsetWidth;
      g.under = underlay(g.el, g.sides, g.y);
      g.el.classList.add('swiping');
    }
    if (e.cancelable) e.preventDefault();          // sideways now: the page stays still
    if (e.timeStamp > g.lastT) { g.v = (t.clientX - g.lastX) / (e.timeStamp - g.lastT); g.lastX = t.clientX; g.lastT = e.timeStamp; }
    const side = dx > 0 ? 'right' : 'left';
    const offered = g.sides[side];
    g.side = offered ? side : null;
    g.dx = offered ? dx : dx * 0.2;               // nothing on that side: the card barely gives
    g.el.style.transform = `translate3d(${g.dx}px,0,0)`;
    g.under.dataset.side = side;
    g.under.classList.toggle('armed', !!offered && Math.abs(dx) >= armAt(g.w));
  }

  function finish(cancelled) {
    const s = g;
    g = null;
    if (!s) return;
    s.el.removeEventListener('touchmove', move);
    s.el.removeEventListener('touchend', lifted);
    s.el.removeEventListener('touchcancel', dropped);
    if (!s.on) return;
    swallowTap(s.el);
    const flick = Math.abs(s.v) > 0.55 && Math.abs(s.dx) > 40 && Math.sign(s.v) === Math.sign(s.dx);
    const offered = s.side && s.sides[s.side];
    if (cancelled || !offered || !(Math.abs(s.dx) >= armAt(s.w) || flick)) { back(s); return; }
    if (offered.leaves) sendOff(s.el, s.side, s.under).then(() => act(s.el, s.side));
    else { act(s.el, s.side); back(s); }
  }
  function lifted(e) { if (g && finger(e.changedTouches, g.id)) finish(false); }
  function dropped(e) { if (g && finger(e.changedTouches, g.id)) finish(true); }

  area.addEventListener('touchstart', (e) => {
    if (g && !g.el.isConnected) finish(true);     // the list was redrawn under the finger
    if (g || e.touches.length !== 1) return;
    const el = e.target.closest?.('[data-swipe]');
    if (!el || !area.contains(el) || el.classList.contains('swiping') || e.target.closest('input, textarea, select, .chart')) return;
    const t = e.touches[0];
    g = { el, id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, side: null, lastX: t.clientX, lastT: e.timeStamp, v: 0, on: false };
    // Touches keep reporting to the element they began on, so the rest of the gesture is heard there.
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', lifted);
    el.addEventListener('touchcancel', dropped);
  }, { passive: true });
}
