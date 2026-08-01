# FreeCell Web Project

A browser-based FreeCell board-entry tool, WebAssembly solver, and animated solution viewer.

## Main files

- `index.html` — visual card keyboard and editable board input
- `solution.html` — animated solution viewer
- `css/styles.css` — shared styles
- `js/input.js` — card entry, editing, undo, save/load, and solver-board formatting
- `js/solver.js` — Freecell Solver WebAssembly integration

## Board input behavior

- Enter cards down columns 1 through 8.
- Columns 1–4 contain 7 cards each.
- Columns 5–8 contain 6 cards each.
- Used cards are disabled to prevent duplicates.
- Tap any filled board position to clear and replace it.
- Save/load uses browser Local Storage.


## Scan/import preview
The Board Input page includes **Scan Board**, with separate options to take a new photo or choose an existing screenshot/picture. The current phase previews the image and provides eight adjustable tableau-column guides; automatic card recognition is the next phase.
