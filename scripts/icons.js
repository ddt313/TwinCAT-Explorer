// Writes the icons of the TwinCAT views, media/icons/light/<name>.svg and media/icons/dark/<name>.svg: one
// per kind of node, drawn on the 16 px grid of a tree row in the manner of XAE's Solution Explorer. Run it
// again after changing an icon or a colour.
// Usage: node scripts/icons.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// The light variant shows in light and high contrast light themes, the dark one in dark and high contrast
// dark themes. `soft` colours fill the outlined shapes.
const PALETTES = {
  light: {
    ink: '#424242', paper: '#FFFFFF', pages: '#FFFFFF',
    blue: '#1A69B8', blueSoft: '#DCEBFA',
    teal: '#13838A', tealSoft: '#D5EFF0',
    purple: '#6B3FA0', purpleSoft: '#ECE3F7', cubeTop: '#B48AE0', cubeLeft: '#8656C0', cubeRight: '#5E3391',
    orange: '#C8690A', orangeSoft: '#FCE6CC',
    green: '#2D7D32', greenSoft: '#DBEFDC',
    amber: '#D18B00',
    slate: '#52677C', slateSoft: '#E3E9EF',
    folderBack: '#C9A04F', folderFront: '#E5C070',
    tileBlue: '#1F6FC5', tileOrange: '#D9661F', glyph: '#FFFFFF',
  },
  dark: {
    ink: '#C5C5C5', paper: '#1E1E1E', pages: '#D4D4D4',
    blue: '#62A8EA', blueSoft: '#1D3550',
    teal: '#3DBDB4', tealSoft: '#173A3A',
    purple: '#B48AE0', purpleSoft: '#352646', cubeTop: '#D2B6F2', cubeLeft: '#A57AD8', cubeRight: '#7D52B0',
    orange: '#EE9D3F', orangeSoft: '#45301A',
    green: '#7BC47F', greenSoft: '#213B25',
    amber: '#F2C232',
    slate: '#9DB1C5', slateSoft: '#2A3440',
    folderBack: '#B08A3E', folderFront: '#D2AC5E',
    tileBlue: '#2F7FD3', tileOrange: '#E07A30', glyph: '#FFFFFF',
  },
};

const round = n => Math.round(n * 100) / 100;

/** A gear centred on (cx, cy): `teeth` teeth between radius `inner` and `outer`. */
function gear(cx, cy, outer, inner, teeth) {
  const step = (2 * Math.PI) / teeth;
  const tip = step * 0.18;
  const base = step * 0.3;
  const points = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    for (const [r, d] of [[inner, -base], [outer, -tip], [outer, tip], [inner, base]]) {
      points.push(`${round(cx + r * Math.cos(a + d))} ${round(cy + r * Math.sin(a + d))}`);
    }
  }
  return `M${points.join('L')}Z`;
}

/** A function block's box: a header, two inputs on the left and `outputs` (1 or 2) on the right. */
function block(color, soft, outputs) {
  const pins = ['M1 6.5h2', 'M1 10.5h2', ...(outputs === 1 ? ['M13 8.5h2'] : ['M13 6.5h2', 'M13 10.5h2'])];
  return `<path d="${pins.join('')}" stroke="${color}"/>`
    + `<rect x="3.5" y="2.5" width="9" height="11" fill="${soft}" stroke="${color}"/>`
    + `<rect x="3" y="2" width="10" height="3" fill="${color}"/>`;
}

/** A property's Get (an arrow out of it) or Set (an arrow into it). */
function accessor(c, get) {
  const arrow = get ? 'M1 8l4-4v3h6v2H5v3z' : 'M10 8L6 4v3H1v2h5v3z';
  return `<rect x="10.5" y="3.5" width="4" height="9" rx="1" fill="${c.slateSoft}" stroke="${c.slate}"/>`
    + `<path d="${arrow}" fill="${get ? c.green : c.orange}"/>`;
}

const ICONS = {
  // The .tsproj: a TwinCAT project, its system configuration.
  'twincat-project': c => `<rect x="1" y="1" width="14" height="14" rx="2.5" fill="${c.tileBlue}"/>`
    + `<path d="${gear(8, 8, 5.6, 4, 8)}" fill="${c.glyph}"/><circle cx="8" cy="8" r="1.8" fill="${c.tileBlue}"/>`,
  // A PLC project: the PLC's chip.
  'plc-project': c => `<rect x="1" y="1" width="14" height="14" rx="2.5" fill="${c.tileOrange}"/>`
    + `<path d="M5 2.5h1v2H5zM10 2.5h1v2h-1zM5 11.5h1v2H5zM10 11.5h1v2h-1z" fill="${c.glyph}"/>`
    + `<path d="M2.5 5h2v1h-2zM2.5 10h2v1h-2zM11.5 5h2v1h-2zM11.5 10h2v1h-2z" fill="${c.glyph}"/>`
    + `<rect x="4" y="4" width="8" height="8" rx="1" fill="${c.glyph}"/>`
    + `<rect x="6" y="6" width="4" height="4" fill="${c.tileOrange}"/>`,
  // References: books on a shelf; a library: one book.
  references: c => `<path d="M2.5 3.5h3v10h-3zM5.5 2.5h3v11h-3z" fill="${c.slateSoft}" stroke="${c.slate}"/>`
    + `<path d="M9.6 4.1l2.9-.78 2.59 9.66-2.9.78z" fill="${c.slateSoft}" stroke="${c.slate}"/>`
    + `<path d="M3 6h2M6 5h2M3 11h2M6 11h2" stroke="${c.slate}"/>`,
  library: c => `<path d="M3.5 12.5v-10a1 1 0 0 1 1-1h8v11" fill="${c.blue}" stroke="${c.blue}"/>`
    + `<path d="M12.5 12.5h-8a1 1 0 0 0 0 2h8z" fill="${c.pages}" stroke="${c.blue}"/>`
    + `<rect x="6" y="4" width="5" height="2" fill="${c.glyph}"/>`,
  folder: c => `<path d="M1 3.5A1.5 1.5 0 0 1 2.5 2H6l2 2h5.5A1.5 1.5 0 0 1 15 5.5V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"`
    + ` fill="${c.folderBack}"/><path d="M1 6h14v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z" fill="${c.folderFront}"/>`,
  // POUs: a function block's box (FB with two outputs, FUN with one), a program's window with Run.
  fb: c => block(c.orange, c.orangeSoft, 2),
  fun: c => block(c.purple, c.purpleSoft, 1),
  prg: c => `<rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="${c.greenSoft}" stroke="${c.green}"/>`
    + `<path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5V5H1z" fill="${c.green}"/>`
    + `<path d="M6 6.5v5.5l4.5-2.75z" fill="${c.green}"/>`,
  // An interface: the lollipop of UML.
  interface: c => `<rect x="1" y="7" width="6" height="2" fill="${c.blue}"/>`
    + `<circle cx="10.5" cy="8" r="3.5" fill="${c.paper}" stroke="${c.blue}" stroke-width="2"/>`,
  // DUTs: a structure's fields, an enumeration's values, a union's overlapping members, an alias' arrow.
  struct: c => `<rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="${c.tealSoft}" stroke="${c.teal}"/>`
    + `<path d="M4 4h8v2H4zM4 7h6v2H4zM4 10h7v2H4z" fill="${c.teal}"/>`,
  enum: c => `<rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="${c.tealSoft}" stroke="${c.teal}"/>`
    + `<path d="M4 4h2v2H4zM4 7h2v2H4zM4 10h2v2H4z" fill="${c.orange}"/>`
    + `<path d="M7 4h5v2H7zM7 7h5v2H7zM7 10h5v2H7z" fill="${c.teal}"/>`,
  union: c => `<rect x="1.5" y="1.5" width="8" height="8" rx="1" fill="${c.tealSoft}" stroke="${c.teal}"/>`
    + `<rect x="6.5" y="6.5" width="8" height="8" rx="1" fill="${c.tealSoft}" stroke="${c.teal}" fill-opacity=".7"/>`,
  alias: c => `<rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="${c.tealSoft}" stroke="${c.teal}"/>`
    + `<path d="M4.5 11.5V9a2.5 2.5 0 0 1 2.5-2.5h4" fill="none" stroke="${c.teal}" stroke-width="1.5"/>`
    + `<path d="M9.5 4l3 2.5-3 2.5z" fill="${c.teal}"/>`,
  // A global variable list: the globe.
  gvl: c => `<circle cx="8" cy="8" r="6.5" fill="${c.blueSoft}" stroke="${c.blue}"/>`
    + `<ellipse cx="8" cy="8" rx="2.5" ry="6.5" fill="none" stroke="${c.blue}"/>`
    + `<path d="M2.5 5.5h11M2.5 10.5h11" stroke="${c.blue}"/>`,
  // Members: a method's cube, a property's wrench and its accessors, an action's flash, a transition of SFC.
  method: c => `<path d="M8 1.5l6 3v7l-6 3-6-3v-7z" fill="${c.cubeLeft}"/>`
    + `<path d="M8 1.5l6 3-6 3-6-3z" fill="${c.cubeTop}"/><path d="M8 7.5l6-3v7l-6 3z" fill="${c.cubeRight}"/>`,
  property: c => `<mask id="jaw"><rect width="16" height="16" fill="#fff"/>`
    + `<path d="M10.2 4.1l3-3 1.7 1.7-3 3z" fill="#000"/><circle cx="11.05" cy="4.95" r="1.2" fill="#000"/></mask>`
    + `<g mask="url(#jaw)" fill="${c.slate}"><circle cx="10.5" cy="5.5" r="4"/>`
    + `<path d="M1.6 12.6l5.5-5.5 1.8 1.8-5.5 5.5a1.27 1.27 0 0 1-1.8-1.8z"/></g>`,
  get: c => accessor(c, true),
  set: c => accessor(c, false),
  action: c => `<path d="M10 1L3 9.5h4.5L6 15l7-9H8.5z" fill="${c.amber}"/>`,
  transition: c => `<rect x="4.5" y="1.5" width="6" height="3" fill="${c.paper}" stroke="${c.slate}"/>`
    + `<rect x="4.5" y="11.5" width="6" height="3" fill="${c.paper}" stroke="${c.slate}"/>`
    + `<path d="M7 5h1v6H7z" fill="${c.slate}"/><rect x="2" y="7" width="11" height="2" fill="${c.green}"/>`,
  // A task: its cycle's stopwatch.
  task: c => `<circle cx="8" cy="9" r="5.5" fill="${c.greenSoft}" stroke="${c.green}"/>`
    + `<path d="M6 1.5h4" stroke="${c.green}"/><rect x="7" y="2" width="2" height="1.5" fill="${c.green}"/>`
    + `<path d="M8 9V5.75M8 9h2.5" fill="none" stroke="${c.green}" stroke-width="1.5" stroke-linecap="round"/>`,
  // Any other file.
  file: c => `<path d="M3.5 1.5h6l3 3v10h-9z" fill="${c.paper}" stroke="${c.ink}"/>`
    + `<path d="M9.5 1.5v3h3" fill="none" stroke="${c.ink}"/>`,
};

for (const [theme, colors] of Object.entries(PALETTES)) {
  const dir = path.join(root, 'media', 'icons', theme);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, draw] of Object.entries(ICONS)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${draw(colors)}</svg>\n`;
    fs.writeFileSync(path.join(dir, `${name}.svg`), svg);
  }
}
console.log(`media/icons: ${Object.keys(ICONS).length} icons, ${Object.keys(PALETTES).join(' and ')}`);
