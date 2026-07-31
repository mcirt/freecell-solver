# FreeCell Web Project

A browser-based FreeCell solver using the Freecell Solver WebAssembly engine.

## Files
- `index.html` — board input and solver results
- `solution.html` — graphical solution viewer
- `css/styles.css` — shared styles for both pages
- `js/solver.js` — WebAssembly solver integration
- `js/cards.js` — card display, including `10` instead of `T`
- `js/board.js` — board parsing, state changes, and rendering
- `js/animation.js` — card-flight animation and source/destination highlighting
- `js/controls.js` — viewer controls
- `js/solution.js` — solution viewer controller

Serve this folder through HTTP, such as GitHub Pages or `python3 -m http.server 8000`.
