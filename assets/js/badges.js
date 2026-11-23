// Coloured name labels. Every funder and journal gets its own colour, so cards can be told apart at
// a glance. These are plain labels in colours chosen here — not the organisations' logos.
import { esc } from './util.js';

const FUNDERS = [                       // first match wins
  [/epsrc/i, '#a3156f'],
  [/nerc/i, '#00756a'],
  [/stfc/i, '#1d4fd8'],
  [/innovate uk/i, '#6a2c91'],
  [/ukri|research and innovation/i, '#2e2d62'],
  [/royal society/i, '#b3122d'],
  [/royal academy of engineering|raeng/i, '#8a5a00'],
  [/leverhulme/i, '#00594c'],
  [/european research council|\berc\b/i, '#b54708'],
  [/marie|msca|horizon|european commission|\beu\b/i, '#003399'],
  [/british council/i, '#3a1a78'],
  [/advanced research and invention|\baria\b/i, '#1f1f24'],
  [/civil engineers|\bice\b/i, '#0064b0'],
  [/lloyd/i, '#00539b'],
  [/naval research|\bonr\b/i, '#0b3d91'],
  [/daiwa/i, '#a3003a'],
  [/1851/i, '#7a1f3d'],
  [/supergen/i, '#00707a'],
];
const VENUES = [
  [/journal of fluid mechanics/i, '#0b5cad'],
  [/coastal engineering/i, '#2e7d32'],
  [/applied ocean research/i, '#00707a'],
  [/ocean engineering/i, '#00756a'],
  [/physics of fluids/i, '#6a1b9a'],
  [/physical review/i, '#283593'],
  [/arxiv/i, '#b31b1b'],
  [/nature/i, '#b3122d'],
  [/geophysical research/i, '#1565c0'],
  [/physical oceanography|ocean modelling|ocean dynamics/i, '#00695c'],
  [/renewable energy|energy/i, '#a85100'],
  [/marine structures|fluids and structures/i, '#455a64'],
  [/royal society/i, '#7a1f3d'],
  [/computational physics|applied mechanics/i, '#4527a0'],
];
const SPARE = ['#0b5cad', '#00756a', '#6a1b9a', '#b3122d', '#a85100', '#2e7d32', '#283593', '#00707a', '#a3156f', '#455a64'];

function colourFor(name, table) {
  const hit = table.find(([re]) => re.test(name));
  if (hit) return hit[1];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;       // the same name always gets the same colour
  return SPARE[h % SPARE.length];
}

/** The colour a funder's label is drawn in. */
export const funderColour = (name) => colourFor(String(name || ''), FUNDERS);

/** A bold coloured label: <span class="badge" …>Name</span>. `full` is kept as the tooltip. */
export function badge(label, { kind = 'venue', full = label } = {}) {
  if (!label) return '';
  return `<span class="badge" style="background:${colourFor(String(full), kind === 'funder' ? FUNDERS : VENUES)}" title="${esc(full)}">${esc(label)}</span>`;
}
