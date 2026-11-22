/* Palettes. Each one follows an app the owner likes: its colours, its typeface and how heavy its
   headings and figures are. This small script runs before first paint, so the palette you chose is
   applied without a flash. A palette has a home mode (the look it was taken from) and a companion
   for the other mode; text contrast is checked for both.
   To add your own, copy a block, rename it, and change the values. */
(function () {
  var TOKENS = {
    bg: '--bg', bg2: '--bg-2', surface: '--surface', surface2: '--surface-2', ink: '--ink', ink2: '--ink-2', ink3: '--ink-3',
    line: '--line', line2: '--line-2', edge: '--edge', accent: '--accent', accentStrong: '--accent-strong', accentSoft: '--accent-soft',
    onAccent: '--on-accent', sand: '--sand', sandSoft: '--sand-soft', raise_: '--raise', tab: '--tab', tabOn: '--tab-on',
    tabOnBg: '--tab-on-bg', pill: '--pill', onPill: '--on-pill', wave: '--wave', wave2: '--wave-2', glow: '--glow'
  };
  var TYPE = {
    font: '--sans', num: '--num', wTitle: '--w-title', wHead: '--w-head', wNum: '--w-num', wFig: '--w-fig',
    lsTitle: '--ls-title', lsHead: '--ls-head', lsNum: '--ls-num'
  };
  var DEFAULT = 'paper';
  var EARLIER = { graphite: 'lilac', slate: 'charcoal', coast: 'paper', coral: 'paper' };    // names of palettes that no longer exist
  var PALETTES = {
    paper: {"name":"Paper","face":"Inter","home":"light","file":"assets/fonts/inter-var.woff2","type":{"font":"\"Inter\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif","wTitle":"800","wHead":"700","wNum":"800","wFig":"750","lsTitle":"-.04em","lsHead":"-.022em","lsNum":"-.055em"},"light":{"bg":"#f4f4f1","bg2":"#e9e9e4","surface":"#fcfcfb","surface2":"#f5f5f2","ink":"#0b0b0b","ink2":"#52514e","ink3":"#676560","line":"#ebebe7","line2":"#d2d1ce","edge":"#e6e6e5","accent":"#0b0b0b","accentStrong":"#0b0b0b","accentSoft":"#e9e9e4","onAccent":"#fcfcfb","raise_":"#fcfcfb","tab":"#fcfcfb","tabOn":"#0b0b0b","tabOnBg":"#e9e9e4","pill":"#0b0b0b","onPill":"#fcfcfb","wave":"#eb6834","wave2":"#1baf7a","sand":"#875608","sandSoft":"#f8eed6"},"dark":{"bg":"#111110","bg2":"#262624","surface":"#1b1b19","surface2":"#222220","ink":"#f4f4f1","ink2":"#bdbcb7","ink3":"#9a9892","line":"#2b2b28","line2":"#3d3d39","edge":"#2b2b28","accent":"#f4f4f1","accentStrong":"#ffffff","accentSoft":"rgba(244,244,241,.12)","onAccent":"#111110","raise_":"#3a3a36","tab":"#1b1b19","tabOn":"#ffffff","tabOnBg":"rgba(244,244,241,.12)","pill":"#f4f4f1","onPill":"#111110","wave":"#f07a48","wave2":"#2cc38d","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)"}},
    charcoal: {"name":"Charcoal","face":"Open Sans","home":"dark","file":"assets/fonts/open-sans-var.woff2","type":{"font":"\"Open Sans\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif","num":"\"Wave Numerals\", \"Open Sans\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif","wTitle":"600","wHead":"600","wNum":"360","wFig":"400","lsTitle":"-.018em","lsHead":"-.008em","lsNum":"-.012em"},"dark":{"bg":"#121212","bg2":"#2e2e2d","surface":"#21201f","surface2":"#2a2928","ink":"#d5d5d5","ink2":"#bab9b8","ink3":"#9d9c9b","line":"#3d3c3b","line2":"#4b4a49","edge":"#2b2a29","accent":"#c2deae","accentStrong":"#d0ebbb","accentSoft":"rgba(194,222,174,.14)","onAccent":"#492c10","raise_":"#403f3e","tab":"#333333","tabOn":"#d0ebbb","tabOnBg":"#191919","pill":"#94c3f5","onPill":"#121212","wave":"#c2deae","wave2":"#69c8d7","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)"},"light":{"bg":"#f3f2f0","bg2":"#e6e5e2","surface":"#ffffff","surface2":"#f7f6f4","ink":"#21201f","ink2":"#4a4947","ink3":"#666563","line":"#e6e5e2","line2":"#d0cfcc","edge":"#e6e5e2","accent":"#3c6e2f","accentStrong":"#2c5522","accentSoft":"#e1efd6","onAccent":"#ffffff","raise_":"#ffffff","tab":"#ffffff","tabOn":"#2c5522","tabOnBg":"#e1efd6","pill":"#94c3f5","onPill":"#121212","wave":"#3c6e2f","wave2":"#2a8fa0","sand":"#875608","sandSoft":"#f8eed6"}},
    lilac: {"name":"Lilac","face":"Figtree","home":"dark","file":"assets/fonts/figtree-var.woff2","type":{"font":"\"Figtree\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif","wTitle":"700","wHead":"600","wNum":"800","wFig":"750","lsTitle":"-.02em","lsHead":"-.01em","lsNum":"-.03em"},"dark":{"bg":"#121212","bg2":"#2d2d2d","surface":"#1e1e1e","surface2":"#272727","ink":"#ffffff","ink2":"#cccecf","ink3":"#a3a5a7","line":"#313131","line2":"#434343","edge":"#2b2b2b","accent":"#b89ae0","accentStrong":"#ccaef5","accentSoft":"rgba(184,154,224,.16)","onAccent":"#121212","raise_":"#414141","tab":"#313131","tabOn":"#ccaef5","tabOnBg":"#3b265d","pill":"#2e6cde","onPill":"#ffffff","wave":"#b89ae0","wave2":"#5b93f0","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)"},"light":{"bg":"#f5f4f8","bg2":"#e8e6ee","surface":"#ffffff","surface2":"#f8f7fb","ink":"#17161a","ink2":"#46444d","ink3":"#5f5d68","line":"#e5e3ec","line2":"#cfccd9","edge":"#e5e3ec","accent":"#5a287d","accentStrong":"#42145f","accentSoft":"#efe6f8","onAccent":"#ffffff","raise_":"#ffffff","tab":"#ffffff","tabOn":"#42145f","tabOnBg":"#efe6f8","pill":"#2e6cde","onPill":"#ffffff","wave":"#5a287d","wave2":"#2e6cde","sand":"#875608","sandSoft":"#f8eed6"}},
    midnight: {"name":"Midnight","face":"Inter","home":"dark","file":"assets/fonts/inter-var.woff2","type":{"font":"\"Inter\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif","wTitle":"700","wHead":"700","wNum":"700","wFig":"650","lsTitle":"-.032em","lsHead":"-.025em","lsNum":"-.045em"},"dark":{"bg":"#0e0b1f","bg2":"#29234e","surface":"#1b1738","surface2":"#221c45","ink":"#eeeafe","ink2":"#cfcaea","ink3":"#a19dc0","line":"#2f2a4e","line2":"#3f3a5f","edge":"#2f2a4c","accent":"#a99bff","accentStrong":"#c3b9ff","accentSoft":"rgba(169,155,255,.16)","onAccent":"#130f2e","raise_":"#3d3670","tab":"#17122e","tabOn":"#c3b9ff","tabOnBg":"rgba(169,155,255,.18)","pill":"#a99bff","onPill":"#130f2e","wave":"#a99bff","wave2":"#f28b82","glow":"rgba(169,155,255,.17)","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)"},"light":{"bg":"#f5f4fc","bg2":"#e8e6f6","surface":"#ffffff","surface2":"#f8f7fd","ink":"#17143a","ink2":"#433f6b","ink3":"#5b5784","line":"#e3e1f2","line2":"#cdcae6","edge":"#e3e1f2","accent":"#5746d6","accentStrong":"#4333b0","accentSoft":"#e9e6fd","onAccent":"#ffffff","raise_":"#ffffff","tab":"#ffffff","tabOn":"#4333b0","tabOnBg":"#e9e6fd","pill":"#5746d6","onPill":"#ffffff","wave":"#5746d6","wave2":"#d4526e","glow":"rgba(87,70,214,.13)","sand":"#875608","sandSoft":"#f8eed6"}}
  };
  var root = document.documentElement;
  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function stored() { var s = read('wave.palette'); return PALETTES[s] ? s : (PALETTES[EARLIER[s]] ? EARLIER[s] : null); }
  function mode() {
    var t = root.getAttribute('data-theme');
    return t === 'light' || t === 'dark' ? t : (dark.matches ? 'dark' : 'light');
  }
  function apply(name) {
    if (!PALETTES[name]) name = stored() || DEFAULT;
    var pal = PALETTES[name], set = pal[mode()], key;
    for (key in TOKENS) {
      if (set[key]) root.style.setProperty(TOKENS[key], set[key]); else root.style.removeProperty(TOKENS[key]);
    }
    for (key in TYPE) {
      if (pal.type[key]) root.style.setProperty(TYPE[key], pal.type[key]); else root.style.removeProperty(TYPE[key]);
    }
    root.style.setProperty('--grid', set.line);
    root.setAttribute('data-palette', name);
    root.setAttribute('data-mode', mode());
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', set.bg);
    return name;
  }
  /** Choosing a palette shows it as drawn on its swatch: in its home mode. "Light or dark" can then change that. */
  function choose(name) {
    if (!PALETTES[name]) return apply();
    write('wave.palette', name);
    if (mode() !== PALETTES[name].home) {
      root.setAttribute('data-theme', PALETTES[name].home);
      write('wave.theme', PALETTES[name].home);
    }
    return apply(name);
  }
  window.WavePalettes = {
    all: PALETTES,
    apply: apply,
    mode: mode,
    current: function () { return root.getAttribute('data-palette') || DEFAULT; },
    choose: choose
  };
  var first = apply();
  try {                                                   // fetch this palette's typeface straight away
    var link = document.createElement('link');
    link.rel = 'preload'; link.as = 'font'; link.type = 'font/woff2'; link.crossOrigin = 'anonymous';
    link.href = PALETTES[first].file;
    document.head.appendChild(link);
  } catch (e) { /* the stylesheet loads it anyway */ }
  if (dark.addEventListener) dark.addEventListener('change', function () { apply(); });
  else if (dark.addListener) dark.addListener(function () { apply(); });
})();
