/* Colour palettes. This small script runs before first paint, so the palette you chose is applied
   without a flash. Every palette has a light and a dark set; text contrast is checked for both.
   To add your own, copy a block, rename it, and change the hex values. */
(function () {
  var TOKENS = {
    bg: '--bg', bg2: '--bg-2', surface: '--surface', surface2: '--surface-2', ink: '--ink', ink2: '--ink-2', ink3: '--ink-3',
    line: '--line', line2: '--line-2', accent: '--accent', accentStrong: '--accent-strong', accentSoft: '--accent-soft',
    onAccent: '--on-accent', sand: '--sand', sandSoft: '--sand-soft', brandA: '--brand-a', hero1: '--hero-1', hero2: '--hero-2',
    hero3: '--hero-3', heroInk: '--hero-ink', heroInk2: '--hero-ink-2', heroAccent: '--hero-accent', raise_: '--raise'
  };
  var PALETTES = {
    ocean: {"name":"Ocean","light":{"bg":"#f3f6f7","bg2":"#e8eef1","surface":"#ffffff","surface2":"#f5f8f9","ink":"#0b2233","ink2":"#3d5364","ink3":"#52687a","line":"#dde6ea","line2":"#c9d5dc","accent":"#0a7480","accentStrong":"#065a64","accentSoft":"#e1f1f2","onAccent":"#ffffff","sand":"#875608","sandSoft":"#faf0dc","brandA":"#0a5d73","hero1":"#06283a","hero2":"#0a4a5e","hero3":"#0b6170","heroInk":"#f1f8fa","heroInk2":"#d5e9ee","heroAccent":"#9fe3dc"},"dark":{"bg":"#06141d","bg2":"#0a1c28","surface":"#0e2231","surface2":"#132a3b","ink":"#e9f1f5","ink2":"#aabeca","ink3":"#8097a5","line":"#1b3445","line2":"#284558","accent":"#5fd4cc","accentStrong":"#93e6e0","accentSoft":"rgba(95,212,204,.13)","onAccent":"#04222a","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)","brandA":"#0d6c80","hero1":"#041a27","hero2":"#083547","hero3":"#0b5b68","heroInk":"#f1f8fa","heroInk2":"#d5e9ee","heroAccent":"#9fe3dc","raise_":"#1c3a4e"}},
    coast: {"name":"Coast","light":{"bg":"#f6f3ee","bg2":"#ebe6dd","surface":"#fffdfa","surface2":"#f9f6f0","ink":"#1f2a2e","ink2":"#47545a","ink3":"#5a676d","line":"#e4ded3","line2":"#d3cabb","accent":"#1b6c66","accentStrong":"#124f4b","accentSoft":"#dcefea","onAccent":"#ffffff","sand":"#7d4f07","sandSoft":"#f8ecd3","brandA":"#1b6c66","hero1":"#0f3335","hero2":"#175150","hero3":"#1f6b66","heroInk":"#f3faf8","heroInk2":"#d3ebe6","heroAccent":"#a8ecdc"},"dark":{"bg":"#101618","bg2":"#151c1f","surface":"#1a2326","surface2":"#202b2f","ink":"#f1ede5","ink2":"#b8c2c4","ink3":"#8f9b9e","line":"#283336","line2":"#364448","accent":"#6fd0c3","accentStrong":"#a4e6dc","accentSoft":"rgba(111,208,195,.13)","onAccent":"#06201d","sand":"#efbe6a","sandSoft":"rgba(239,190,106,.13)","brandA":"#1f6b66","hero1":"#0a2224","hero2":"#123b3b","hero3":"#1a5753","heroInk":"#f3faf8","heroInk2":"#d3ebe6","heroAccent":"#a8ecdc","raise_":"#2a383d"}},
    midnight: {"name":"Midnight","light":{"bg":"#f4f4fb","bg2":"#e8e8f5","surface":"#ffffff","surface2":"#f7f7fd","ink":"#15163a","ink2":"#40426b","ink3":"#585a84","line":"#dfdff0","line2":"#cdcde5","accent":"#4840c4","accentStrong":"#352e9e","accentSoft":"#e7e6fb","onAccent":"#ffffff","sand":"#875608","sandSoft":"#faf0dc","brandA":"#4840c4","hero1":"#12123a","hero2":"#24226f","hero3":"#3d37a8","heroInk":"#f4f4ff","heroInk2":"#d6d4f7","heroAccent":"#c3bfff"},"dark":{"bg":"#0a0a1c","bg2":"#0f0f26","surface":"#151531","surface2":"#1b1b3c","ink":"#ecebfb","ink2":"#b5b4d8","ink3":"#8f8eb8","line":"#24244a","line2":"#32325f","accent":"#a09aff","accentStrong":"#c5c1ff","accentSoft":"rgba(160,154,255,.15)","onAccent":"#100e33","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)","brandA":"#3d37a8","hero1":"#0c0c2c","hero2":"#1b1a55","hero3":"#2f2a85","heroInk":"#f4f4ff","heroInk2":"#d6d4f7","heroAccent":"#c3bfff","raise_":"#26264f"}},
    kelp: {"name":"Kelp","light":{"bg":"#f3f6f1","bg2":"#e6ece3","surface":"#ffffff","surface2":"#f6f9f4","ink":"#132417","ink2":"#3d5343","ink3":"#52675a","line":"#dce6d9","line2":"#c8d5c4","accent":"#1f6f3a","accentStrong":"#16562c","accentSoft":"#dff0e3","onAccent":"#ffffff","sand":"#875608","sandSoft":"#faf0dc","brandA":"#1f6f3a","hero1":"#0c2815","hero2":"#154426","hero3":"#1f6537","heroInk":"#f2faf3","heroInk2":"#d0e8d5","heroAccent":"#a9eebb"},"dark":{"bg":"#09130c","bg2":"#0e1b12","surface":"#122318","surface2":"#172c1f","ink":"#e9f3ea","ink2":"#adc2b1","ink3":"#869b8c","line":"#1e3425","line2":"#2a4634","accent":"#6fd58d","accentStrong":"#a3e8b6","accentSoft":"rgba(111,213,141,.13)","onAccent":"#062310","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)","brandA":"#1f6537","hero1":"#08200f","hero2":"#11381f","hero3":"#1a532e","heroInk":"#f2faf3","heroInk2":"#d0e8d5","heroAccent":"#a9eebb","raise_":"#223c2c"}},
    coral: {"name":"Coral","light":{"bg":"#faf5f1","bg2":"#f0e7e0","surface":"#ffffff","surface2":"#fcf8f5","ink":"#2b1c19","ink2":"#58453f","ink3":"#6d5851","line":"#ebe0d8","line2":"#dbccc1","accent":"#b0412c","accentStrong":"#8c301d","accentSoft":"#fbe5de","onAccent":"#ffffff","sand":"#7d4f07","sandSoft":"#f9edd6","brandA":"#b0412c","hero1":"#33120f","hero2":"#6b241b","hero3":"#93372a","heroInk":"#fff6f2","heroInk2":"#f7ddd3","heroAccent":"#ffcbb6"},"dark":{"bg":"#161010","bg2":"#1d1514","surface":"#241a18","surface2":"#2c201d","ink":"#f6ece7","ink2":"#cdbab2","ink3":"#a59189","line":"#372925","line2":"#483631","accent":"#ff9e7d","accentStrong":"#ffc3ad","accentSoft":"rgba(255,158,125,.14)","onAccent":"#3a140a","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)","brandA":"#93372a","hero1":"#2a0f0c","hero2":"#561d15","hero3":"#7d2e20","heroInk":"#fff6f2","heroInk2":"#f7ddd3","heroAccent":"#ffcbb6","raise_":"#3a2a26"}},
    slate: {"name":"Slate","light":{"bg":"#f5f6f7","bg2":"#e9ebee","surface":"#ffffff","surface2":"#f8f9fa","ink":"#15181c","ink2":"#434a53","ink3":"#59616c","line":"#e0e3e7","line2":"#ced3d9","accent":"#1d5bcb","accentStrong":"#1747a0","accentSoft":"#e3ecfb","onAccent":"#ffffff","sand":"#875608","sandSoft":"#faf0dc","brandA":"#23282f","hero1":"#13161a","hero2":"#20252c","hero3":"#313844","heroInk":"#f4f6f8","heroInk2":"#cfd6de","heroAccent":"#a8c7ff"},"dark":{"bg":"#0c0e11","bg2":"#111418","surface":"#171b20","surface2":"#1d2228","ink":"#eef0f3","ink2":"#b4bac3","ink3":"#8c939e","line":"#252b33","line2":"#333a44","accent":"#7fb0ff","accentStrong":"#aecdff","accentSoft":"rgba(127,176,255,.14)","onAccent":"#071a3a","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)","brandA":"#313844","hero1":"#0e1013","hero2":"#191d23","hero3":"#262c35","heroInk":"#f4f6f8","heroInk2":"#cfd6de","heroAccent":"#a8c7ff","raise_":"#2a3038"}},
    paper: {"name":"Paper","light":{"bg":"#f5f4f0","bg2":"#ebe9e3","surface":"#ffffff","surface2":"#faf9f6","ink":"#141413","ink2":"#44433f","ink3":"#5f5e59","line":"#e6e4dd","line2":"#d4d1c8","accent":"#1f1e1c","accentStrong":"#000000","accentSoft":"#e7e5de","onAccent":"#ffffff","sand":"#875608","sandSoft":"#f8eed6","brandA":"#1f1e1c","hero1":"#1f1e1c","hero2":"#33312d","hero3":"#4a4741","heroInk":"#f7f6f2","heroInk2":"#d9d6cd","heroAccent":"#f0b27a"},"dark":{"bg":"#151514","bg2":"#1c1c1a","surface":"#222220","surface2":"#292927","ink":"#f2f1ec","ink2":"#bdbbb3","ink3":"#94928a","line":"#2e2e2b","line2":"#3d3d39","accent":"#e8e6df","accentStrong":"#ffffff","accentSoft":"rgba(232,230,223,.13)","onAccent":"#1a1a18","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)","brandA":"#3a3935","hero1":"#1c1c1a","hero2":"#2a2a27","hero3":"#3a3935","heroInk":"#f7f6f2","heroInk2":"#d9d6cd","heroAccent":"#f0b27a","raise_":"#33332f"}},
    graphite: {"name":"Graphite","light":{"bg":"#f4f3f7","bg2":"#e9e7ef","surface":"#ffffff","surface2":"#f8f7fb","ink":"#17151f","ink2":"#454254","ink3":"#5d5a6e","line":"#e2e0ea","line2":"#cfccdb","accent":"#6a45c9","accentStrong":"#5233a6","accentSoft":"#ece6fa","onAccent":"#ffffff","sand":"#875608","sandSoft":"#faf0dc","brandA":"#6a45c9","hero1":"#1b1530","hero2":"#33235f","hero3":"#4f3791","heroInk":"#f6f3ff","heroInk2":"#dcd3f5","heroAccent":"#d3bcff"},"dark":{"bg":"#131316","bg2":"#1a1a1e","surface":"#212126","surface2":"#28282e","ink":"#f1f0f5","ink2":"#b9b7c4","ink3":"#908e9d","line":"#2c2c33","line2":"#3b3b44","accent":"#c7a8ff","accentStrong":"#dcc7ff","accentSoft":"rgba(199,168,255,.15)","onAccent":"#1e1238","sand":"#f0b85a","sandSoft":"rgba(240,184,90,.13)","brandA":"#4f3791","hero1":"#17121f","hero2":"#2a1f4a","hero3":"#402d73","heroInk":"#f6f3ff","heroInk2":"#dcd3f5","heroAccent":"#d3bcff","raise_":"#313138"}}
  };
  var root = document.documentElement;
  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  function stored() { try { return localStorage.getItem('wave.palette'); } catch (e) { return null; } }
  function mode() {
    var t = root.getAttribute('data-theme');
    return t === 'light' || t === 'dark' ? t : (dark.matches ? 'dark' : 'light');
  }
  function apply(name) {
    if (!PALETTES[name]) name = PALETTES[stored()] ? stored() : 'ocean';
    var set = PALETTES[name][mode()];
    for (var key in TOKENS) {
      if (set[key]) root.style.setProperty(TOKENS[key], set[key]); else root.style.removeProperty(TOKENS[key]);
    }
    root.style.setProperty('--grid', set.line);
    root.setAttribute('data-palette', name);
    root.setAttribute('data-mode', mode());
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', set.bg);
    return name;
  }
  window.WavePalettes = {
    all: PALETTES,
    apply: apply,
    mode: mode,
    current: function () { return root.getAttribute('data-palette') || 'ocean'; },
    choose: function (name) { try { localStorage.setItem('wave.palette', name); } catch (e) { /* private mode */ } return apply(name); }
  };
  apply();
  if (dark.addEventListener) dark.addEventListener('change', function () { apply(); });
  else if (dark.addListener) dark.addListener(function () { apply(); });
})();
