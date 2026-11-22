// The masthead illustration: a small sea. Wave groups travel in from the left, come into phase and
// rise into one large crest — linear superposition of deep-water components (ω² = gk) with a touch of
// second-order sharpening — then disperse again, above a slower swell in a second colour. The large
// crest glows and throws a little spray; tap the water and a group focuses where you tapped.
// It is a nod to the subject of the research; it is decoration, not data.

const SPEED = 5.2;                       // wave time per second
const EVERY = 9.5 * SPEED;               // a new group focuses this often
const LEAD = 7.5 * SPEED;                // a group is drawn from this long before its focus…
const TAIL = 7.5 * SPEED;                // …until this long after it
const SPOTS = [0.5, 0.36, 0.62, 0.44, 0.58, 0.4, 0.66];     // where along the strip groups focus, in turn
const HEADROOM = 22;                     // px the drawing may use above the strip, for spray
const STEP = 3;                          // px between points of a line

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function mountWave(host) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  host.replaceChildren(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  // one group: a Gaussian band of components around k = 1
  const comps = [];
  for (let i = 0; i < 20; i++) {
    const k = 0.5 + i / 19;
    comps.push({ k, w: Math.sqrt(k), a: Math.exp(-((k - 1) ** 2) / (2 * 0.26 ** 2)), ph: 0 });
  }
  const norm = comps.reduce((s, c) => s + c.a, 0);
  for (const c of comps) c.a /= norm;

  // ── geometry and colour ────────────────────────────────────────────────────
  let W = 0, H = 0, ratio = 1, scale = 6, y0 = 0, amp = 0, count = 0;
  let xs = new Float32Array(0), front = new Float32Array(0), back = new Float32Array(0);
  function measure() {
    const w = host.clientWidth, h = host.clientHeight + HEADROOM;
    if (!w || !h) return false;
    ratio = Math.min(window.devicePixelRatio || 1, 3);
    if (w !== W || h !== H || canvas.width !== Math.round(w * ratio)) {
      W = w; H = h;
      canvas.width = Math.round(W * ratio);
      canvas.height = Math.round(H * ratio);
    }
    const strip = H - HEADROOM;
    scale = Math.min(7.5, Math.max(5.4, W / 68));          // px per unit of length: a phone shows about eleven wavelengths
    y0 = HEADROOM + strip * 0.66;                          // still water
    amp = strip * 0.4;                                     // px for a crest of height 1
    count = Math.ceil(W / STEP) + 1;
    if (xs.length !== count) { xs = new Float32Array(count); front = new Float32Array(count); back = new Float32Array(count); }
    for (let i = 0; i < count; i++) xs[i] = (i * STEP - W / 2) / scale;
    return true;
  }

  const probe = document.createElement('canvas').getContext('2d');
  const parse = (css, otherwise) => {
    probe.fillStyle = otherwise;
    if (css) probe.fillStyle = css;
    const v = String(probe.fillStyle);                     // "#rrggbb" or "rgba(r, g, b, a)"
    if (v[0] === '#') return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
    const m = v.match(/[\d.]+/g) || [0, 0, 0];
    return [Number(m[0]), Number(m[1]), Number(m[2])];
  };
  let ink = { one: [235, 104, 52], two: [27, 175, 122], still: [200, 200, 200], tip: [255, 255, 255] };
  function colours() {
    const s = getComputedStyle(host);
    const one = parse(s.getPropertyValue('--wave').trim(), '#eb6834');
    const two = parse(s.getPropertyValue('--wave-2').trim(), '#1baf7a');
    const still = parse(s.getPropertyValue('--line-2').trim(), '#cccccc');
    const dark = document.documentElement.getAttribute('data-mode') === 'dark';
    ink = { one, two, still, tip: dark ? one.map((v) => Math.round(v + (255 - v) * 0.65)) : one };
  }

  // ── the sea ────────────────────────────────────────────────────────────────
  let t = 0;                              // wave time
  let groups = [];                        // { x, t0, born, tap, fired }
  let nextFocus = 2.3 * SPEED;            // the first crest rises soon after the page opens
  let spot = 0;
  let rings = [], drops = [];
  let peak = { e: 0, x: 0, y: 0 };

  function gain(g) {
    const age = t - g.t0;
    const out = 1 - smooth((age - TAIL * 0.5) / (TAIL * 0.5));
    return (g.tap ? smooth((t - g.born) / (0.45 * SPEED)) : smooth((age + LEAD) / (LEAD * 0.32))) * out;
  }

  /** Fill front[] and back[] with the y of each line at each point; note the highest crest. */
  function surface(intro) {
    front.fill(0);
    for (const g of groups) {
      const gn = gain(g);
      if (gn < 0.004) continue;
      for (const c of comps) c.ph = -c.k * g.x - c.w * (t - g.t0);
      for (let i = 0; i < count; i++) {
        const x = xs[i];
        let e = 0;
        for (let j = 0; j < comps.length; j++) { const c = comps[j]; e += c.a * Math.cos(c.k * x + c.ph); }
        front[i] += gn * e;
      }
    }
    peak = { e: 0, x: 0, y: y0 };
    const swell = amp * 0.2, slow = t * 0.6;
    for (let i = 0; i < count; i++) {
      const x = xs[i];
      let e = front[i] + 0.03 * Math.cos(1.9 * x - 1.38 * t + 0.7) + 0.022 * Math.cos(1.3 * x - 1.14 * t + 2.1);   // never quite flat
      if (e > 1) e = 1 + 0.35 * Math.tanh((e - 1) / 0.35);                                                       // two groups at once stay in the picture
      e *= intro;
      const y = Math.max(2, y0 - (e + 0.32 * e * e) * amp);                                                      // crests sharper than troughs, like water
      if (e > peak.e) peak = { e, x: i * STEP, y };
      front[i] = y;
      back[i] = y0 + amp * 0.16 - swell * intro * (0.5 * Math.cos(0.33 * x - 0.574 * slow + 1.3) + 0.3 * Math.cos(0.21 * x - 0.458 * slow + 4.1) + 0.2 * Math.cos(0.52 * x - 0.72 * slow));
    }
  }
  const heightAt = (px) => front[Math.max(0, Math.min(count - 1, Math.round(px / STEP)))] || y0;

  function splash(px) {
    let top = heightAt(px), at = px;
    for (let dx = -18; dx <= 18; dx += STEP) { const y = heightAt(px + dx); if (y < top) { top = y; at = px + dx; } }
    rings.push({ x: at, y: top, age: 0, life: 0.9, from: 3, to: 30 });
    for (let i = 0; i < 12; i++) {
      drops.push({ x: at + (Math.random() - 0.5) * 8, y: top, vx: (Math.random() - 0.3) * 96, vy: -(34 + Math.random() * 62), age: 0, life: 0.55 + Math.random() * 0.5, r: 0.9 + Math.random() * 1.1 });
    }
  }

  function line(ys) {
    ctx.beginPath();
    ctx.moveTo(0, ys[0]);
    for (let i = 1; i < count; i++) ctx.lineTo(i * STEP, ys[i]);
  }
  function wash(ys, colour, strength) {
    line(ys);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const g = ctx.createLinearGradient(0, y0 - amp, 0, H);
    g.addColorStop(0, rgba(colour, strength)); g.addColorStop(1, rgba(colour, 0));
    ctx.fillStyle = g;
    ctx.fill();
  }

  function draw(dt, intro) {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    surface(intro);

    ctx.strokeStyle = rgba(ink.still, 0.9);                // still water
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Math.round(y0) + 0.5); ctx.lineTo(W, Math.round(y0) + 0.5); ctx.stroke();

    wash(back, ink.two, 0.2 * intro);                      // the slow swell behind
    line(back);
    ctx.strokeStyle = rgba(ink.two, 0.7 * intro); ctx.lineWidth = 1.4; ctx.stroke();

    wash(front, ink.one, 0.3 * intro);                     // the groups in front: wash, glow, line
    line(front);
    ctx.strokeStyle = rgba(ink.one, 0.16 * intro); ctx.lineWidth = 8; ctx.stroke();
    const lit = ctx.createLinearGradient(0, y0 - amp * 1.2, 0, y0);
    lit.addColorStop(0, rgba(ink.tip, intro)); lit.addColorStop(1, rgba(ink.one, intro));
    ctx.strokeStyle = lit; ctx.lineWidth = 2; ctx.stroke();

    const p = Math.min(1, Math.max(0, (peak.e - 0.26) / 0.7));       // the highest crest glows as it grows
    if (p > 0.02) {
      const r = 6 + 22 * p;
      const halo = ctx.createRadialGradient(peak.x, peak.y, 0, peak.x, peak.y, r);
      halo.addColorStop(0, rgba(ink.one, 0.16 + 0.44 * p)); halo.addColorStop(1, rgba(ink.one, 0));
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(peak.x, peak.y, r, 0, 6.2832); ctx.fill();
      ctx.fillStyle = rgba(ink.tip, 0.95);
      ctx.beginPath(); ctx.arc(peak.x, peak.y, 1.4 + 2 * p, 0, 6.2832); ctx.fill();
    }

    for (const r of rings) {                               // rings where a crest peaked or a finger landed
      r.age += dt;
      const u = r.age / r.life;
      if (u >= 1) continue;
      ctx.strokeStyle = rgba(ink.one, 0.6 * (1 - u) * (1 - u));
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.from + (r.to - r.from) * (1 - (1 - u) * (1 - u)), 0, 6.2832); ctx.stroke();
    }
    rings = rings.filter((r) => r.age < r.life);
    for (const d of drops) {                               // spray
      d.age += dt;
      d.vy += 250 * dt; d.x += d.vx * dt; d.y += d.vy * dt;
      const u = d.age / d.life;
      if (u >= 1 || d.y > heightAt(d.x) + 2) { d.age = d.life; continue; }
      ctx.fillStyle = rgba(ink.tip, 0.85 * (1 - u));
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 6.2832); ctx.fill();
    }
    drops = drops.filter((d) => d.age < d.life);
  }

  function schedule() {
    while (nextFocus - LEAD < t) {
      groups.push({ x: ((SPOTS[spot++ % SPOTS.length] - 0.5) * W) / scale, t0: nextFocus, born: t, tap: false, fired: false });
      nextFocus += EVERY;
    }
    groups = groups.filter((g) => t - g.t0 < TAIL);
    for (const g of groups) {
      if (!g.fired && t >= g.t0) { g.fired = true; if (gain(g) > 0.5) splash(W / 2 + g.x * scale); }
    }
  }

  // ── still picture for people who ask for less motion ───────────────────────
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const still = () => {
      if (!measure()) return;
      colours();
      t = 0; groups = [{ x: 0, t0: 0, born: -LEAD, tap: false, fired: true }];
      draw(0, 1);
    };
    still();
    const watch = new ResizeObserver(still);
    watch.observe(host);
    return () => watch.disconnect();
  }

  // ── run ────────────────────────────────────────────────────────────────────
  let raf = 0, last = 0, started = 0, frames = 0, seen = true, running = false;
  function frame(now) {
    raf = 0;
    if (!running) return;
    if (!host.isConnected) { stop(); return; }
    if (!started) started = now;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    if (frames++ % 24 === 0) { if (!measure()) { raf = requestAnimationFrame(frame); return; } colours(); }
    t += dt * SPEED;
    schedule();
    draw(dt, smooth((now - started) / 1400));
    raf = requestAnimationFrame(frame);
  }
  function play() {
    const should = seen && !document.hidden;
    if (should && !running) { running = true; last = 0; if (!raf) raf = requestAnimationFrame(frame); }
    else if (!should && running) { running = false; cancelAnimationFrame(raf); raf = 0; }
  }
  const onVisibility = () => play();
  const onTap = (e) => {
    if (!running || groups.filter((g) => g.tap).length >= 3) return;
    const box = canvas.getBoundingClientRect();
    const px = e.clientX - box.left;
    groups.push({ x: (px - W / 2) / scale, t0: t + 1.5 * SPEED, born: t, tap: true, fired: false });
    rings.push({ x: px, y: heightAt(px), age: 0, life: 0.7, from: 2, to: 22 });
  };
  const resize = new ResizeObserver(() => { measure(); });
  const inView = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => { seen = entries[entries.length - 1].isIntersecting; play(); }) : null;
  function stop() {
    running = false;
    cancelAnimationFrame(raf); raf = 0;
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('click', onTap);
    resize.disconnect();
    inView?.disconnect();
  }
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('click', onTap);
  resize.observe(host);
  inView?.observe(host);
  measure();
  colours();
  play();
  return stop;
}
