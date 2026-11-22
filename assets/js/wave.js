// The masthead illustration: a dispersive wave group focusing into one large crest and dispersing
// again — linear superposition of deep-water components (ω² = gk) that come into phase at the centre.
// It is a small nod to the subject of the research; it is decoration, not data.

export function mountWave(host) {
  const N = 22, POINTS = 150;
  const k0 = 1, spread = 0.26;
  const comps = [];
  for (let i = 0; i < N; i++) {
    const k = k0 * (0.5 + (i / (N - 1)) * 1.0);
    const a = Math.exp(-((k - k0) ** 2) / (2 * spread ** 2));
    comps.push({ k, w: Math.sqrt(k), a });
  }
  const norm = comps.reduce((s, c) => s + c.a, 0);
  host.innerHTML = `<svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="wave-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--hero-accent);stop-opacity:.30"/><stop offset="1" style="stop-color:var(--hero-accent);stop-opacity:0"/>
    </linearGradient></defs>
    <line class="w-line w-still" x1="0" x2="600" y1="70" y2="70" vector-effect="non-scaling-stroke"/>
    <path class="w-fill"/><path class="w-line" vector-effect="non-scaling-stroke"/></svg>`;
  const line = host.querySelector('path.w-line'), fill = host.querySelector('path.w-fill');
  const L = 34;                                  // half-width of the window, in units of 1/k0
  const T = 46;                                  // the group focuses at t = 0, in a loop from −T to +T

  function draw(t) {
    let d = '';
    for (let i = 0; i <= POINTS; i++) {
      const x = -L + (2 * L * i) / POINTS;
      let eta = 0;
      for (const c of comps) eta += c.a * Math.cos(c.k * x - c.w * t);
      // crests are sharpened slightly (a second-order bound term) so the big wave looks like water
      const e1 = eta / norm;
      const y = 70 - (e1 + 0.32 * e1 * e1) * 52;
      d += `${i ? 'L' : 'M'}${((i / POINTS) * 600).toFixed(1)},${y.toFixed(1)}`;
    }
    line.setAttribute('d', d);
    fill.setAttribute('d', `${d}L600,120L0,120Z`);
  }

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) { draw(0); return () => {}; }

  let raf = 0, last = 0, t = -T * 0.55, running = true;
  const frame = (now) => {
    if (!running) return;
    if (!host.isConnected) { running = false; return; }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    t += dt * 5.2;
    if (t > T) t = -T;
    draw(t);
    raf = requestAnimationFrame(frame);
  };
  const onVis = () => {
    if (document.hidden) { running = false; cancelAnimationFrame(raf); }
    else if (!running && host.isConnected) { running = true; last = 0; raf = requestAnimationFrame(frame); }
  };
  document.addEventListener('visibilitychange', onVis);
  raf = requestAnimationFrame(frame);
  return () => { running = false; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); };
}
