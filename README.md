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

## Screenshot crop calibration

The Scan Board dialog now automatically overlays 52 numbered rank-and-suit crop regions across the eight tableau columns. The default geometry is percentage-based, so it scales to screenshots from different iPhone models. Advanced sliders allow calibration of tableau top, left edge, column spacing, row overlap, and crop size. Confirmed settings are saved locally in the browser for the next recognition stage.


## Scanner calibration update

- Default tableau top is 55%.
- Tableau top can be adjusted from 40% to 65%.
- Camera and saved-image inputs use direct labels for better reliability in iPhone Safari.
