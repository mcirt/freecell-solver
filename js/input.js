(function () {
  "use strict";

  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
  const SUITS = [
    { code: "S", symbol: "♠", red: false },
    { code: "H", symbol: "♥", red: true },
    { code: "C", symbol: "♣", red: false },
    { code: "D", symbol: "♦", red: true }
  ];
  const COLUMN_SIZES = [7, 7, 7, 7, 6, 6, 6, 6];
  const STORAGE_KEY = "freecellSavedBoardV1";

  const boardEl = document.getElementById("input-board");
  const keyboardEl = document.getElementById("card-keyboard");
  const hiddenBoardEl = document.getElementById("board");
  const solveButton = document.getElementById("solve");
  const solveSubtitle = document.getElementById("solve-subtitle");
  const copyBoardTextButton = document.getElementById("copy-board-text");
  const downloadBoardButton = document.getElementById("download-board");
  const uploadBoardButton = document.getElementById("upload-board-file");
  const boardFileInput = document.getElementById("board-file-input");
  const messageEl = document.getElementById("input-message");
  const activeColumnLabel = document.getElementById("active-column-label");
  const activeCardLabel = document.getElementById("active-card-label");
  const remainingLabel = document.getElementById("remaining-label");

  let columns = COLUMN_SIZES.map(size => Array(size).fill(null));
  let active = { column: 0, row: 0 };
  let history = [];
  let solverReady = false;

  function displayRank(rank) { return rank === "T" ? "10" : rank; }
  function displayCard(card) {
    if (!card) return "";
    const suit = SUITS.find(item => item.code === card.slice(-1));
    return displayRank(card.slice(0, -1)) + suit.symbol;
  }
  function isRed(card) { return /[HD]$/.test(card); }

  function usedCards() {
    return new Set(columns.flat().filter(Boolean));
  }

  function countEntered() {
    return columns.flat().filter(Boolean).length;
  }

  function firstEmpty() {
    for (let c = 0; c < columns.length; c += 1) {
      for (let r = 0; r < columns[c].length; r += 1) {
        if (!columns[c][r]) return { column: c, row: r };
      }
    }
    return null;
  }

  function boardToPortableText() {
    return columns.map(column => column.join(" ")).join("\n") + "\n";
  }

  function boardToSolverText() {
    return columns.map(column => ": " + column.join(" ")).join("\n") + "\n";
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("Clipboard access is unavailable in this browser.");
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function boardFilename() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return "freecell-board-" + stamp + ".txt";
  }

  function announce(text, kind) {
    messageEl.textContent = text;
    messageEl.className = "input-message" + (kind ? " " + kind : "");
  }

  function snapshot() {
    return {
      columns: columns.map(column => column.slice()),
      active: { column: active.column, row: active.row }
    };
  }

  function restoreSnapshot(state) {
    columns = state.columns.map(column => column.slice());
    active = { column: state.active.column, row: state.active.row };
  }

  function pushHistory() {
    history.push(snapshot());
    if (history.length > 120) history.shift();
  }

  function nextAfter(column, row) {
    if (row + 1 < columns[column].length) return { column, row: row + 1 };
    for (let c = column + 1; c < columns.length; c += 1) {
      for (let r = 0; r < columns[c].length; r += 1) {
        if (!columns[c][r]) return { column: c, row: r };
      }
    }
    return firstEmpty() || { column, row };
  }

  function renderBoard() {
    boardEl.replaceChildren();
    columns.forEach((column, columnIndex) => {
      const wrapper = document.createElement("div");
      wrapper.className = "input-column";

      const number = document.createElement("div");
      number.className = "input-column-number";
      number.textContent = String(columnIndex + 1);
      wrapper.appendChild(number);

      const slots = document.createElement("div");
      slots.className = "input-slots";
      column.forEach((card, rowIndex) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "input-slot";
        button.dataset.column = String(columnIndex);
        button.dataset.row = String(rowIndex);
        button.setAttribute("aria-label", card ? displayCard(card) + ", tap to edit" : "Empty card position");
        if (card) {
          button.textContent = displayCard(card);
          button.classList.add("filled");
          if (isRed(card)) button.classList.add("red");
        }
        if (active.column === columnIndex && active.row === rowIndex) button.classList.add("active");
        button.addEventListener("click", () => selectSlot(columnIndex, rowIndex));
        slots.appendChild(button);
      });
      wrapper.appendChild(slots);
      boardEl.appendChild(wrapper);
    });
  }

  function renderKeyboard() {
    const used = usedCards();
    keyboardEl.replaceChildren();
    SUITS.forEach(suit => {
      const row = document.createElement("div");
      row.className = "keyboard-row";
      RANKS.forEach(rank => {
        const card = rank + suit.code;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "card-key" + (suit.red ? " red" : "");
        button.textContent = displayRank(rank) + suit.symbol;
        button.dataset.card = card;
        button.disabled = used.has(card);
        button.addEventListener("click", () => enterCard(card));
        row.appendChild(button);
      });
      keyboardEl.appendChild(row);
    });
  }

  function renderStatus() {
    const entered = countEntered();
    const total = 52;
    activeColumnLabel.textContent = "Column " + (active.column + 1);
    activeCardLabel.textContent = "Card " + (active.row + 1) + " of " + columns[active.column].length;
    remainingLabel.textContent = (total - entered) + " cards remaining";
    hiddenBoardEl.value = entered === total ? boardToSolverText() : "";
    const complete = entered === total;
    const canSolve = complete && solverReady;
    solveButton.disabled = !canSolve;
    if (copyBoardTextButton) copyBoardTextButton.disabled = !complete;
    if (downloadBoardButton) downloadBoardButton.disabled = !complete;
    solveSubtitle.textContent = entered < total ? "Enter all 52 cards first" : (solverReady ? "Ready to solve" : "Loading solver…");
    document.getElementById("undo-input").disabled = history.length === 0;
  }

  function renderAll() {
    renderBoard();
    renderKeyboard();
    renderStatus();
  }

  function selectSlot(column, row) {
    if (columns[column][row]) {
      pushHistory();
      const removed = columns[column][row];
      columns[column][row] = null;
      active = { column, row };
      announce(displayCard(removed) + " cleared. Choose its replacement.", "info");
    } else {
      active = { column, row };
      announce("Selected Column " + (column + 1) + ", Card " + (row + 1) + ".", "info");
    }
    renderAll();
  }

  function enterCard(card) {
    if (usedCards().has(card)) return;
    pushHistory();
    columns[active.column][active.row] = card;
    const justFilled = { column: active.column, row: active.row };
    active = nextAfter(justFilled.column, justFilled.row);
    announce(displayCard(card) + " entered in Column " + (justFilled.column + 1) + ", Card " + (justFilled.row + 1) + ".", "success");
    renderAll();
  }

  function clearBoard() {
    if (countEntered() > 0 && !window.confirm("Clear every entered card?")) return;
    pushHistory();
    columns = COLUMN_SIZES.map(size => Array(size).fill(null));
    active = { column: 0, row: 0 };
    announce("Board cleared.", "info");
    renderAll();
  }

  function undo() {
    if (!history.length) return;
    restoreSnapshot(history.pop());
    announce("Last board change undone.", "info");
    renderAll();
  }

  function saveBoard() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ columns, savedAt: new Date().toISOString() }));
      announce("Board saved on this device.", "success");
    } catch (error) {
      announce("The board could not be saved: " + error.message, "error");
    }
  }


  async function copyBoardText() {
    if (countEntered() !== 52) {
      announce("Enter all 52 cards before copying board text.", "error");
      return;
    }
    try {
      await copyText(boardToPortableText());
      announce("Board text copied. It contains 8 lines, one tableau column per line.", "success");
    } catch (error) {
      announce("The board text could not be copied: " + error.message, "error");
    }
  }

  function downloadBoard() {
    if (countEntered() !== 52) {
      announce("Enter all 52 cards before downloading the board.", "error");
      return;
    }
    try {
      downloadText(boardFilename(), boardToPortableText());
      announce("Board downloaded as a portable text file.", "success");
    } catch (error) {
      announce("The board file could not be downloaded: " + error.message, "error");
    }
  }

  function importColumns(rawColumns, options) {
    const settings = Object.assign({ solve: false, closeScanner: true, sourceLabel: "Board" }, options || {});

    try {
      if (!Array.isArray(rawColumns) || rawColumns.length !== 8) {
        throw new Error("Imported board must contain exactly 8 columns.");
      }

      const imported = rawColumns.map((column, columnIndex) => {
        if (!Array.isArray(column) || column.length !== COLUMN_SIZES[columnIndex]) {
          throw new Error(
            "Column " + (columnIndex + 1) + " must contain " + COLUMN_SIZES[columnIndex] + " cards."
          );
        }

        return column.map(card => {
          if (typeof card !== "string") throw new Error("Every imported card must be text.");
          const normalized = card.trim().toUpperCase().replace(/^10/, "T");
          const rank = normalized.slice(0, -1);
          const suit = normalized.slice(-1);
          if (!RANKS.includes(rank) || !SUITS.some(item => item.code === suit)) {
            throw new Error("Invalid imported card: " + card);
          }
          return rank + suit;
        });
      });

      const cards = imported.flat();
      if (cards.length !== 52) throw new Error("Imported board must contain exactly 52 cards.");
      if (new Set(cards).size !== 52) throw new Error("Imported board contains duplicate cards.");

      pushHistory();
      columns = imported.map(column => column.slice());
      active = { column: 7, row: 5 };
      announce(settings.sourceLabel + " loaded. Choose Solve This Board or Compare Solver Modes.", "success");
      renderAll();

      if (settings.closeScanner) {
        const dialog = document.getElementById("scan-dialog");
        if (dialog) dialog.hidden = true;
        document.body.classList.remove("scan-open");
      }

      boardEl.scrollIntoView({ behavior: "smooth", block: "start" });

      if (settings.solve) {
        window.setTimeout(() => {
          if (!solveButton.disabled) {
            solveButton.click();
          } else {
            announce("Board loaded. The solver is still loading; press Solve This Board when it becomes ready.", "info");
          }
        }, 100);
      }

      return { ok: true, columns: columns.map(column => column.slice()) };
    } catch (error) {
      announce("The board could not be loaded: " + error.message, "error");
      return { ok: false, error: error.message };
    }
  }

  function parsePortableBoardText(text) {
    const lines = String(text || "").trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 8) throw new Error("Board file must contain exactly 8 non-empty lines.");
    return lines.map((line, columnIndex) => {
      const cards = line.replace(/^:\s*/, "").split(/\s+/).filter(Boolean);
      if (cards.length !== COLUMN_SIZES[columnIndex]) {
        throw new Error("Column " + (columnIndex + 1) + " must contain " + COLUMN_SIZES[columnIndex] + " cards.");
      }
      return cards;
    });
  }

  async function uploadBoardFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const imported = parsePortableBoardText(text);
      const result = importColumns(imported, { closeScanner:false, sourceLabel:"Board file" });
      if (result.ok) announce("Board file loaded successfully: " + file.name, "success");
    } catch (error) {
      announce("The board file could not be loaded: " + error.message, "error");
    } finally {
      if (boardFileInput) boardFileInput.value = "";
    }
  }

  function loadBoard() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        announce("No saved board was found on this device.", "error");
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.columns) || parsed.columns.length !== 8) throw new Error("Saved board data is invalid.");
      const validShape = parsed.columns.every((column, i) => Array.isArray(column) && column.length === COLUMN_SIZES[i]);
      if (!validShape) throw new Error("Saved board has the wrong column sizes.");
      const cards = parsed.columns.flat().filter(Boolean);
      if (new Set(cards).size !== cards.length) throw new Error("Saved board contains duplicate cards.");
      pushHistory();
      columns = parsed.columns.map(column => column.slice());
      active = firstEmpty() || { column: 7, row: 5 };
      announce("Saved board loaded.", "success");
      renderAll();
    } catch (error) {
      announce("The saved board could not be loaded: " + error.message, "error");
    }
  }

  document.getElementById("undo-input").addEventListener("click", undo);
  document.getElementById("clear-board").addEventListener("click", clearBoard);
  document.getElementById("save-board").addEventListener("click", saveBoard);
  document.getElementById("load-board").addEventListener("click", loadBoard);
  if (copyBoardTextButton) copyBoardTextButton.addEventListener("click", copyBoardText);
  if (downloadBoardButton) downloadBoardButton.addEventListener("click", downloadBoard);
  if (uploadBoardButton && boardFileInput) {
    uploadBoardButton.addEventListener("click", () => boardFileInput.click());
    boardFileInput.addEventListener("change", () => uploadBoardFile(boardFileInput.files && boardFileInput.files[0]));
  }
  document.getElementById("how-to").addEventListener("click", () => {
    window.alert("Enter cards down Column 1, then Column 2, through Column 8. Tap any entered card to clear and replace it. Used cards are disabled automatically.");
  });
  document.getElementById("settings").addEventListener("click", () => {
    window.alert("No settings are needed yet.");
  });

  window.FreeCellBoardInput = Object.freeze({
    loadColumns(rawColumns, options) {
      return importColumns(rawColumns, options);
    },
    getColumns() {
      return columns.map(column => column.slice());
    },
    getBoardText() {
      return boardToPortableText();
    },
    getFcSolveText() {
      return boardToSolverText();
    }
  });

  window.addEventListener("freecell-import-board", event => {
    const detail = event.detail || {};
    importColumns(detail.columns, {
      solve: Boolean(detail.solve),
      closeScanner: detail.closeScanner !== false
    });
  });

  window.addEventListener("freecell-solver-ready", () => {
    solverReady = true;
    renderStatus();
    announce("Solver loaded. Enter all 52 cards to solve.", "success");
  });
  window.addEventListener("freecell-solver-status", event => {
    if (event.detail && event.detail.label) announce(event.detail.label, event.detail.kind === "error" ? "error" : "info");
  });

  renderAll();
}());
