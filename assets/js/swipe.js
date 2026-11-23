// Swipe a card sideways with a finger to uncover a button; tap the button to do the thing.
// Swiping alone never acts: a card that slid by accident just shows its button, and a tap anywhere
// else (or a swipe back) closes it again.
// The page marks what can be swiped (data-swipe) and says what each side offers; this file follows the
// finger, holds the card open, and plays it out when it leaves. Up-and-down movement is left to the
// page: a swipe only begins once the finger has clearly moved sideways, and then the page is held still.

const REVEAL = 96;                               // px a card slides to show its button
const OPEN_AT = 36;                              // px of swipe after which letting go leaves it open
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** The strip behind a card: a button at each end, its label level with the finger. */
function underlay(el, sides, fingerY) {
  const u = document.createElement('div');
  u.className = 'swipe-under';
  const end = (side, cls) => (sides[side]
    ? `<button type="button" class="swipe-do ${cls}" data-do="${side}">${sides[side].icon || ''}<b>${sides[side].label}</b></button>`
    : `<span class="swipe-do ${cls}"></span>`);
  u.innerHTML = end('right', 'at-left') + end('left', 'at-right');     // a swipe to the right uncovers the left end
  const height = el.offsetHeight, edge = Math.min(34, height / 2);
  const at = Math.max(edge, Math.min(height - edge, fingerY - el.getBoundingClientRect().top));
  u.classList.toggle('short', height < 96);
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
 * `sides(el)` → { right?, left? }, each { label, icon, leaves } — the button a swipe to that side
 * uncovers (`leaves`: the card goes away when it is tapped). `act(el, side)` runs on that tap.
 */
export function enableSwipe(area, { sides, act }) {
  let g = null;                                   // the gesture under way
  let open = null;                                // the card held open, showing a button: { el, under, sides, x }

  function slide(el, x, then) {
    if (calm()) { el.style.transition = ''; el.style.transform = `translate3d(${x}px,0,0)`; then?.(); return; }
    el.style.transition = 'transform .22s cubic-bezier(.2, .8, .2, 1)';
    el.style.transform = `translate3d(${x}px,0,0)`;
    setTimeout(() => then?.(), 230);
  }
  /** Put a card back; its strip goes once it is back, unless it has been taken up again meanwhile. */
  function shut(el, under) {
    under.classList.remove('open');
    slide(el, 0, () => { if (open?.el !== el && g?.el !== el) tidy(el, under); });
  }
  function close() {
    const o = open;
    open = null;
    if (!o) return;
    if (o.el.isConnected) shut(o.el, o.under); else o.under.remove();
  }

  /** A finger that swiped, or tapped a card only to close it, must not also press what is under it. */
  function swallowTap(el) {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 400);
  }

  /** The uncovered button was tapped: this is the confirmation. */
  function press(e) {
    const b = e.target.closest('[data-do]');
    const o = open;
    if (!b || !o || !o.under.contains(b)) return;
    const side = b.dataset.do, offered = o.sides[side];
    open = null;
    if (!offered) { shut(o.el, o.under); return; }
    if (offered.leaves) sendOff(o.el, side, o.under).then(() => act(o.el, side));
    else { act(o.el, side); shut(o.el, o.under); }
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
      if (!g.under) {
        g.sides = sides(g.el) || {};
        g.under = underlay(g.el, g.sides, g.y);
        g.under.addEventListener('click', press);
      }
      g.el.classList.add('swiping');
      g.el.style.transition = '';
    }
    if (e.cancelable) e.preventDefault();          // sideways now: the page stays still
    if (e.timeStamp > g.lastT) { g.v = (t.clientX - g.lastX) / (e.timeStamp - g.lastT); g.lastX = t.clientX; g.lastT = e.timeStamp; }
    const min = g.sides.left ? -REVEAL : 0, max = g.sides.right ? REVEAL : 0;
    let x = g.base + dx;
    if (x < min) x = min + (x - min) * 0.22;      // past the button the card barely gives: there is nothing further
    else if (x > max) x = max + (x - max) * 0.22;
    g.at = x;
    g.el.style.transform = `translate3d(${x}px,0,0)`;
    if (x) g.under.dataset.side = x > 0 ? 'right' : 'left';
  }

  function finish(cancelled) {
    const s = g;
    g = null;
    if (!s) return;
    s.el.removeEventListener('touchmove', move);
    s.el.removeEventListener('touchend', lifted);
    s.el.removeEventListener('touchcancel', dropped);
    if (!s.on) {                                   // a tap, or a scroll that began on the card
      if (open?.el === s.el) { close(); if (!cancelled) swallowTap(s.el); }
      return;
    }
    swallowTap(s.el);
    const flick = Math.abs(s.v) > 0.5;
    let rest = 0;                                  // where the card comes to rest: shut, or open on one side
    if (!cancelled) {
      if (s.base === 0) {
        if (s.sides.left && (s.at <= -OPEN_AT || (flick && s.v < 0 && s.at < -12))) rest = -REVEAL;
        else if (s.sides.right && (s.at >= OPEN_AT || (flick && s.v > 0 && s.at > 12))) rest = REVEAL;
      } else {
        const back = (s.at - s.base) * -Math.sign(s.base);            // how far it was pushed back towards shut
        rest = back > 24 || (flick && Math.sign(s.v) !== Math.sign(s.base) && back > 8) ? 0 : s.base;
      }
    } else if (s.base !== 0) rest = s.base;
    if (rest === 0) {
      if (open?.el === s.el) open = null;
      shut(s.el, s.under);
    } else {
      open = { el: s.el, under: s.under, sides: s.sides, x: rest };
      s.under.dataset.side = rest > 0 ? 'right' : 'left';
      s.under.classList.add('open');
      slide(s.el, rest);
    }
  }
  function lifted(e) { if (g && finger(e.changedTouches, g.id)) finish(false); }
  function dropped(e) { if (g && finger(e.changedTouches, g.id)) finish(true); }

  area.addEventListener('touchstart', (e) => {
    if (g && !g.el.isConnected) finish(true);     // the list was redrawn under the finger
    if (open && !open.el.isConnected) { open.under.remove(); open = null; }
    if (open && open.under.contains(e.target)) return;                // the button itself: let the tap through
    const el = e.target.closest?.('[data-swipe]');
    if (open && open.el !== el) close();           // a touch anywhere else puts the open card back
    if (g || e.touches.length !== 1 || !el || !area.contains(el) || e.target.closest('input, textarea, select, .chart')) return;
    const held = open?.el === el ? open : null;
    if (!held && el.classList.contains('swiping')) return;            // still sliding back
    const t = e.touches[0];
    g = { el, id: t.identifier, x: t.clientX, y: t.clientY, base: held ? held.x : 0, at: held ? held.x : 0,
      under: held ? held.under : null, sides: held ? held.sides : null, lastX: t.clientX, lastT: e.timeStamp, v: 0, on: false };
    // Touches keep reporting to the element they began on, so the rest of the gesture is heard there.
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', lifted);
    el.addEventListener('touchcancel', dropped);
  }, { passive: true });

  // With a mouse or keyboard nothing swipes; a click away still closes a card left open by touch.
  document.addEventListener('click', (e) => { if (open && !open.under.contains(e.target) && !open.el.contains(e.target)) close(); });
}
