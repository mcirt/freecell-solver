(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const openButton = byId("scan-board");
  const dialog = byId("scan-dialog");
  const closeButton = byId("scan-close");
  const chooseAnotherButton = byId("scan-choose-another");
  const resetButton = byId("scan-reset-calibration");
  const detectButton = byId("scan-detect-tops");
  const detailsButton = byId("scan-preview-crops");
  const confirmButton = byId("scan-confirm-crops");
  const pictureInput = byId("board-picture-input");
  const cameraInput = byId("board-camera-input");
  const photoPanel = byId("scan-photo-panel");
  const photoCanvas = byId("scan-photo-canvas");
  const photoStatus = byId("scan-photo-status");
  const photoAutoButton = byId("scan-photo-auto");
  const photoResetButton = byId("scan-photo-reset-points");
  const photoUseButton = byId("scan-photo-use");
  const photoSkipButton = byId("scan-photo-skip");
  const pickerPanel = byId("scan-picker-panel");
  const previewPanel = byId("scan-preview-panel");
  const detailsPanel = byId("scan-crop-preview-panel");
  const detailsGrid = byId("scan-crop-preview-grid");
  const image = byId("scan-image");
  const overlay = byId("scan-crops");
  const summaryEl = byId("scan-detection-summary");
  const checksEl = byId("scan-column-counts");
  const cvStatus = byId("opencv-status");
  const message = byId("input-message");
  const debugPanel = byId("scan-debug-panel");
  const debugSelect = byId("scan-debug-view");
  const debugCanvas = byId("scan-debug-canvas");
  const debugText = byId("scan-debug-text");

  const SESSION_KEY = "freecellPendingScanV23";
  const LOCAL_RECOGNITION_LIBRARY_KEY = "freecellRecognitionAdditionsV36";
  const BUILTIN_RECOGNITION_LIBRARY_VERSION = 36;
  const MAX_LOCAL_TEMPLATES_PER_SYMBOL = 3;
  const MIN_TEMPLATE_CONFIDENCE = 0.72;
  const RANK_LABELS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const SUIT_LABELS = ["S", "C", "H", "D"];
  const SUIT_NAMES = Object.freeze({ S: "♠", C: "♣", H: "♥", D: "♦" });
  const DISPLAY_RANKS = Object.freeze({ A: "A", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "10": "10", J: "J", Q: "Q", K: "K" });
  const AUTO_ACCEPT_CONFIDENCE = 0.95;
  const REVIEW_CONFIDENCE = 0.85;
  const TEMPLATE = Object.freeze({
    columns: 8,
    leftColumns: 4,
    rowStepToWidth: 0.072,
    fullCardHeightToWidth: 0.165,
    laneWidthToPitch: 0.94,
    cropHeightToRowStep: 0.78
  });

  // v27 calibration correction:
  // Move the complete fitted tableau geometry upward by five source-image pixels.
  // All 52 card positions, recognition crops, overlays, and debug views inherit
  // this same correction so they remain synchronized.
  const TABLEAU_TOP_CORRECTION_PX = -5;

  // v28 calibration correction:
  // Decrease the generated exposed-row spacing by one source-image pixel.
  // Row 1 remains anchored at the corrected tableau top, while rows farther
  // down receive a progressively larger upward adjustment:
  // row 2 = -1 px, row 3 = -2 px, ... row 7 = -6 px.
  const TABLEAU_ROW_STEP_CORRECTION_PX = -1;

  let selectedFile = null;
  let selectedInputMode = "screenshot";
  let originalPhotoCanvas = null;
  let photoCorners = [];
  let photoCornerInputActive = false;
  let objectUrl = null;
  let sourceCanvas = null;
  let detection = null;
  let cvReady = false;
  let debugFrames = {};
  let builtInRecognitionLibrary = loadBuiltInRecognitionLibrary();
  let localRecognitionLibrary = loadLocalRecognitionLibrary();
  let recognitionLibrary = mergeRecognitionLibraries(builtInRecognitionLibrary, localRecognitionLibrary);
  let recognitionCards = [];
  let recognizedBoard = [];
  let boardValidation = null;


  function normalizeRecognitionGroup(group, limit) {
    const result = {};
    Object.entries(group || {}).forEach(([label, value]) => {
      const examples = Array.isArray(value) ? value : (value && typeof value === "object" ? [value] : []);
      result[label] = examples.filter((example) => {
        return example && example.width === 64 && example.height === 80 && typeof example.bits === "string";
      }).slice(0, limit || examples.length);
    });
    return result;
  }

  function emptyRecognitionLibrary() {
    return { version: BUILTIN_RECOGNITION_LIBRARY_VERSION, ranks: {}, suits: {} };
  }

  function loadBuiltInRecognitionLibrary() {
    try {
      const raw = window.FREECELL_BUILTIN_RECOGNITION_LIBRARY;
      if (!raw || raw.format !== "freecell-recognition-template-library") {
        throw new Error("Built-in recognition library was not loaded.");
      }
      if (Number(raw.version) !== BUILTIN_RECOGNITION_LIBRARY_VERSION) {
        throw new Error(`Built-in recognition library v${raw.version || "?"} is incompatible with v${BUILTIN_RECOGNITION_LIBRARY_VERSION}.`);
      }
      return {
        version: BUILTIN_RECOGNITION_LIBRARY_VERSION,
        ranks: normalizeRecognitionGroup(raw.ranks),
        suits: normalizeRecognitionGroup(raw.suits)
      };
    } catch (error) {
      console.error(error);
      return emptyRecognitionLibrary();
    }
  }

  function loadLocalRecognitionLibrary() {
    try {
      const raw = JSON.parse(localStorage.getItem(LOCAL_RECOGNITION_LIBRARY_KEY) || "{}");
      return {
        version: BUILTIN_RECOGNITION_LIBRARY_VERSION,
        ranks: normalizeRecognitionGroup(raw.ranks, MAX_LOCAL_TEMPLATES_PER_SYMBOL),
        suits: normalizeRecognitionGroup(raw.suits, MAX_LOCAL_TEMPLATES_PER_SYMBOL)
      };
    } catch (error) {
      console.warn("Could not load locally added recognition templates.", error);
      return emptyRecognitionLibrary();
    }
  }

  function mergeRecognitionGroups(base, additions) {
    const merged = {};
    const labels = new Set([...Object.keys(base || {}), ...Object.keys(additions || {})]);
    labels.forEach((label) => {
      const examples = [];
      [...(base[label] || []), ...(additions[label] || [])].forEach((candidate) => {
        const duplicate = examples.some((existing) => binarySimilarity(candidate, existing) > 0.995);
        if (!duplicate) examples.push(candidate);
      });
      merged[label] = examples;
    });
    return merged;
  }

  function mergeRecognitionLibraries(base, additions) {
    return {
      version: BUILTIN_RECOGNITION_LIBRARY_VERSION,
      ranks: mergeRecognitionGroups(base.ranks, additions.ranks),
      suits: mergeRecognitionGroups(base.suits, additions.suits)
    };
  }

  function saveRecognitionLibrary() {
    localStorage.setItem(LOCAL_RECOGNITION_LIBRARY_KEY, JSON.stringify(localRecognitionLibrary));
    recognitionLibrary = mergeRecognitionLibraries(builtInRecognitionLibrary, localRecognitionLibrary);
    updateRecognitionLibrarySummary();
  }

  function canvasToBinary(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let bits = "";
    for (let i = 0; i < data.length; i += 4) bits += data[i] < 128 ? "1" : "0";
    return { width: canvas.width, height: canvas.height, bits };
  }

  function binarySimilarity(a, b) {
    if (!a || !b || a.width !== b.width || a.height !== b.height || a.bits.length !== b.bits.length) return 0;
    let same = 0;
    let union = 0;
    let intersection = 0;
    for (let i = 0; i < a.bits.length; i += 1) {
      const av = a.bits.charCodeAt(i) === 49;
      const bv = b.bits.charCodeAt(i) === 49;
      if (av === bv) same += 1;
      if (av || bv) union += 1;
      if (av && bv) intersection += 1;
    }
    const agreement = same / Math.max(1, a.bits.length);
    const iou = intersection / Math.max(1, union);
    return agreement * 0.35 + iou * 0.65;
  }

  function shiftedBinary(binary, dx, dy) {
    const { width, height, bits } = binary;
    const out = new Array(bits.length).fill("0");
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sx = x - dx;
        const sy = y - dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        out[y * width + x] = bits[sy * width + sx];
      }
    }
    return { width, height, bits: out.join("") };
  }

  function tolerantSimilarity(binary, template) {
    let best = 0;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        best = Math.max(best, binarySimilarity(shiftedBinary(binary, dx, dy), template));
      }
    }
    return best;
  }

  function bestTemplateMatch(binary, templates, allowedLabels) {
    let best = null;
    let second = null;

    allowedLabels.forEach((label) => {
      const examples = Array.isArray(templates[label]) ? templates[label] : [];
      if (!examples.length) return;

      const scores = examples.map((template) => tolerantSimilarity(binary, template));
      scores.sort((a, b) => b - a);

      // Use the strongest example, with a small boost when multiple examples agree.
      const top = scores[0];
      const support = scores.length > 1 ? scores.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, scores.length) : top;
      const score = top * 0.78 + support * 0.22;
      const item = { label, score, examples: examples.length };

      if (!best || item.score > best.score) {
        second = best;
        best = item;
      } else if (!second || item.score > second.score) {
        second = item;
      }
    });

    if (!best) return null;
    const margin = best.score - (second ? second.score : 0);
    const confidence = Math.max(0, Math.min(1, best.score * 0.74 + margin * 1.9));
    return {
      label: best.label,
      score: best.score,
      margin,
      examples: best.examples,
      confidence,
      accepted: confidence >= MIN_TEMPLATE_CONFIDENCE && margin >= 0.025
    };
  }

  function addTemplate(group, label, binary) {
    if (!group[label]) group[label] = [];
    const duplicate = group[label].some((existing) => tolerantSimilarity(binary, existing) > 0.985);
    if (duplicate) return { added: false, reason: "duplicate" };

    group[label].push(binary);
    if (group[label].length > MAX_LOCAL_TEMPLATES_PER_SYMBOL) {
      group[label].shift();
    }
    return { added: true, count: group[label].length };
  }

  function downloadBlob(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportRecognitionLibrary() {
    const payload = {
      format: "freecell-recognition-template-additions",
      version: 37,
      createdAt: new Date().toISOString(),
      normalization: { width: 64, height: 80, shiftTolerance: 2 },
      ranks: localRecognitionLibrary.ranks,
      suits: localRecognitionLibrary.suits
    };
    downloadBlob(
      "freecell-recognition-additions-v36.json",
      JSON.stringify(payload, null, 2),
      "application/json"
    );
    announce("Your locally added templates were exported.", "success");
  }

  function importRecognitionLibraryFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        const supportedFormat =
          parsed.format === "freecell-recognition-template-library" ||
          parsed.format === "freecell-recognition-template-additions";
        if (!supportedFormat || !parsed.ranks || !parsed.suits) {
          throw new Error("This file does not contain a compatible recognition library.");
        }

        let addedRanks = 0;
        let addedSuits = 0;
        Object.entries(normalizeRecognitionGroup(parsed.ranks)).forEach(([label, examples]) => {
          examples.forEach((example) => {
            const result = addTemplate(localRecognitionLibrary.ranks, label, example);
            if (result.added) addedRanks += 1;
          });
        });
        Object.entries(normalizeRecognitionGroup(parsed.suits)).forEach(([label, examples]) => {
          examples.forEach((example) => {
            const result = addTemplate(localRecognitionLibrary.suits, label, example);
            if (result.added) addedSuits += 1;
          });
        });

        saveRecognitionLibrary();
        refreshAllPredictions();
        announce(`Imported ${addedRanks} new rank examples and ${addedSuits} new suit examples. Built-in templates remain active.`, "success");
      } catch (error) {
        console.error(error);
        announce(error.message || "Could not import the recognition library.", "error");
      }
    };
    reader.onerror = () => announce("The selected JSON file could not be read.", "error");
    reader.readAsText(file);
  }

  function predictCard(card) {
    const rank = bestTemplateMatch(card.rankBinary, recognitionLibrary.ranks, RANK_LABELS);
    const allowedSuits = card.suitColorFamily === "red" ? ["H", "D"] : ["S", "C"];
    const suit = bestTemplateMatch(card.suitBinary, recognitionLibrary.suits, allowedSuits);
    return { rank, suit };
  }

  function optionMarkup(labels, prompt) {
    return `<option value="">${prompt}</option>` + labels.map((label) => {
      return `<option value="${label}">${SUIT_NAMES[label] || label}</option>`;
    }).join("");
  }

  function countRecognitionExamples(library, labels, groupName) {
    return labels.reduce((sum, label) => sum + ((library[groupName][label] || []).length), 0);
  }

  function updateRecognitionLibrarySummary() {
    const summary = byId("scan-recognition-library-summary");
    if (!summary) return;

    const builtInRanks = countRecognitionExamples(builtInRecognitionLibrary, RANK_LABELS, "ranks");
    const builtInSuits = countRecognitionExamples(builtInRecognitionLibrary, SUIT_LABELS, "suits");
    const localRanks = countRecognitionExamples(localRecognitionLibrary, RANK_LABELS, "ranks");
    const localSuits = countRecognitionExamples(localRecognitionLibrary, SUIT_LABELS, "suits");
    const totalRanks = countRecognitionExamples(recognitionLibrary, RANK_LABELS, "ranks");
    const totalSuits = countRecognitionExamples(recognitionLibrary, SUIT_LABELS, "suits");

    const builtInComplete =
      RANK_LABELS.every((label) => (builtInRecognitionLibrary.ranks[label] || []).length > 0) &&
      SUIT_LABELS.every((label) => (builtInRecognitionLibrary.suits[label] || []).length > 0);

    summary.innerHTML =
      `<strong>Built-in library v36:</strong> ${builtInRanks} rank examples · ${builtInSuits} suit examples` +
      `<span>${builtInComplete ? "Ready on this device—no import or training required." : "Built-in library file is missing or incomplete."}</span>` +
      `<small>My added examples: ${localRanks} ranks · ${localSuits} suits<br>Active total: ${totalRanks} ranks · ${totalSuits} suits</small>`;
  }

  function refreshAllPredictions() {
    recognitionCards.forEach((card) => {
      card.prediction = predictCard(card);
      card.rankPredictionEl.textContent = card.prediction.rank
        ? `${card.prediction.rank.accepted ? "" : "Review: "}${card.prediction.rank.label} (${Math.round(card.prediction.rank.confidence * 100)}%, ${card.prediction.rank.examples} examples)`
        : "needs templates";
      card.suitPredictionEl.textContent = card.prediction.suit
        ? `${card.prediction.suit.accepted ? "" : "Review: "}${SUIT_NAMES[card.prediction.suit.label]} (${Math.round(card.prediction.suit.confidence * 100)}%, ${card.prediction.suit.examples} examples)`
        : "needs templates";
    });
    updateRecognitionLibrarySummary();
  }


  function confidenceClass(confidence) {
    if (confidence >= AUTO_ACCEPT_CONFIDENCE) return "good";
    if (confidence >= REVIEW_CONFIDENCE) return "review";
    return "bad";
  }

  function rankSuitKey(rank, suit) {
    return rank && suit ? `${rank}${suit}` : "";
  }

  function displayCard(rank, suit) {
    return `${DISPLAY_RANKS[rank] || "?"}${SUIT_NAMES[suit] || "?"}`;
  }

  function buildRecognizedBoardFromCards() {
    const byIdMap = new Map(recognitionCards.map((card) => [card.id, card]));
    const columns = [];

    for (let col = 1; col <= 8; col += 1) {
      const count = col <= 4 ? 7 : 6;
      const column = [];
      for (let row = 1; row <= count; row += 1) {
        const id = `C${col}-${row}`;
        const source = byIdMap.get(id);
        const rankPrediction = source && source.prediction ? source.prediction.rank : null;
        const suitPrediction = source && source.prediction ? source.prediction.suit : null;

        column.push({
          id,
          column: col,
          row,
          rank: rankPrediction ? rankPrediction.label : "",
          suit: suitPrediction ? suitPrediction.label : "",
          rankConfidence: rankPrediction ? rankPrediction.confidence : 0,
          suitConfidence: suitPrediction ? suitPrediction.confidence : 0,
          confidence: Math.min(
            rankPrediction ? rankPrediction.confidence : 0,
            suitPrediction ? suitPrediction.confidence : 0
          ),
          rankAccepted: Boolean(rankPrediction && rankPrediction.accepted),
          suitAccepted: Boolean(suitPrediction && suitPrediction.accepted),
          manuallyEdited: false
        });
      }
      columns.push(column);
    }

    recognizedBoard = columns;
    boardValidation = validateRecognizedBoard(columns);
    return columns;
  }

  function validateRecognizedBoard(columns) {
    const cards = columns.flat();
    const issues = [];
    const keyCounts = new Map();
    const rankCounts = new Map(RANK_LABELS.map((rank) => [rank, 0]));
    const suitCounts = new Map(SUIT_LABELS.map((suit) => [suit, 0]));
    let completeCount = 0;
    let lowConfidenceCount = 0;

    cards.forEach((card) => {
      if (!card.rank || !card.suit) {
        issues.push({
          type: "missing",
          cardId: card.id,
          message: `${card.id} is missing a rank or suit.`
        });
        return;
      }

      completeCount += 1;
      if (card.confidence < REVIEW_CONFIDENCE) lowConfidenceCount += 1;

      rankCounts.set(card.rank, (rankCounts.get(card.rank) || 0) + 1);
      suitCounts.set(card.suit, (suitCounts.get(card.suit) || 0) + 1);

      const key = rankSuitKey(card.rank, card.suit);
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    });

    keyCounts.forEach((count, key) => {
      if (count > 1) {
        const ids = cards.filter((card) => rankSuitKey(card.rank, card.suit) === key).map((card) => card.id);
        issues.push({
          type: "duplicate",
          cardIds: ids,
          message: `${displayCard(key.slice(0, -1), key.slice(-1))} appears ${count} times: ${ids.join(", ")}.`
        });
      }
    });

    RANK_LABELS.forEach((rank) => {
      const count = rankCounts.get(rank) || 0;
      if (count !== 4) {
        issues.push({
          type: "rank-count",
          rank,
          message: `${rank} appears ${count} times; a valid deck needs 4.`
        });
      }
    });

    SUIT_LABELS.forEach((suit) => {
      const count = suitCounts.get(suit) || 0;
      if (count !== 13) {
        issues.push({
          type: "suit-count",
          suit,
          message: `${SUIT_NAMES[suit]} appears ${count} times; a valid deck needs 13.`
        });
      }
    });

    const missingCards = [];
    RANK_LABELS.forEach((rank) => {
      SUIT_LABELS.forEach((suit) => {
        const key = rankSuitKey(rank, suit);
        if (!keyCounts.get(key)) missingCards.push(displayCard(rank, suit));
      });
    });

    const valid = completeCount === 52 && issues.length === 0;

    return {
      valid,
      completeCount,
      lowConfidenceCount,
      issues,
      missingCards,
      rankCounts: Object.fromEntries(rankCounts),
      suitCounts: Object.fromEntries(suitCounts),
      uniqueCards: keyCounts.size
    };
  }

  function recognizedBoardToSolverText(columns) {
    // FreeCell Solver expects one tableau column per line, top to bottom.
    return columns.map((column) => {
      return column.map((card) => {
        const rank = card.rank === "10" ? "T" : card.rank;
        return `${rank}${card.suit}`;
      }).join(" ");
    }).join("\n");
  }

  function tryLoadRecognizedBoardIntoExistingInput(columns, options) {
    const settings = Object.assign({ solve: true }, options || {});
    const manualColumns = columns.map((column) => column.map((card) => {
      const rank = card.rank === "10" ? "T" : card.rank;
      return `${rank}${card.suit}`;
    }));

    if (window.FreeCellBoardInput && typeof window.FreeCellBoardInput.loadColumns === "function") {
      const result = window.FreeCellBoardInput.loadColumns(manualColumns, {
        solve: settings.solve,
        closeScanner: true
      });
      if (result && result.ok) return true;
      announce(result && result.error ? result.error : "The manual board rejected the scanned cards.", "error");
      return false;
    }

    // Event fallback keeps the scanner independent if script loading order changes.
    window.dispatchEvent(new CustomEvent("freecell-import-board", {
      detail: { columns: manualColumns, solve: settings.solve, closeScanner: true }
    }));

    window.setTimeout(() => {
      const manualBoard = byId("input-board");
      const filled = manualBoard ? manualBoard.querySelectorAll(".input-slot.filled").length : 0;
      if (filled !== 52) {
        announce("The scanner could not reach the manual-entry controller. Refresh the page and try again.", "error");
      }
    }, 250);
    return true;
  }

  function updateBoardCardFromEditor(card, rank, suit) {
    card.rank = rank;
    card.suit = suit;
    card.manuallyEdited = true;
    card.rankConfidence = 1;
    card.suitConfidence = 1;
    card.confidence = 1;
    card.rankAccepted = true;
    card.suitAccepted = true;

    boardValidation = validateRecognizedBoard(recognizedBoard);
    renderRecognizedBoard();
  }

  function cardIssueIds(validation) {
    const set = new Set();
    validation.issues.forEach((issue) => {
      if (issue.cardId) set.add(issue.cardId);
      (issue.cardIds || []).forEach((id) => set.add(id));
    });
    return set;
  }

  function renderRecognizedBoard() {
    const panel = byId("scan-recognized-board-panel");
    const grid = byId("scan-recognized-board-grid");
    const status = byId("scan-board-validation-status");
    const issuesEl = byId("scan-board-validation-issues");
    const loadButton = byId("scan-load-recognized-board");
    const copyButton = byId("scan-copy-recognized-board");

    if (!panel || !grid || !status || !issuesEl) return;

    if (!recognizedBoard.length) buildRecognizedBoardFromCards();
    boardValidation = validateRecognizedBoard(recognizedBoard);

    panel.hidden = false;
    grid.replaceChildren();
    issuesEl.replaceChildren();

    const issueIds = cardIssueIds(boardValidation);

    recognizedBoard.forEach((column, columnIndex) => {
      const columnEl = document.createElement("section");
      columnEl.className = "scan-board-column";

      const heading = document.createElement("h4");
      heading.textContent = `C${columnIndex + 1}`;
      columnEl.appendChild(heading);

      column.forEach((card) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "scan-recognized-card";

        const confidenceState = confidenceClass(card.confidence);
        item.classList.add(`scan-card-${confidenceState}`);
        if (issueIds.has(card.id)) item.classList.add("scan-card-invalid");
        if (card.manuallyEdited) item.classList.add("scan-card-edited");

        const label = document.createElement("strong");
        label.textContent = displayCard(card.rank, card.suit);

        const meta = document.createElement("small");
        meta.textContent = `${card.id} · ${Math.round(card.confidence * 100)}%`;

        item.append(label, meta);
        item.addEventListener("click", () => {
          const rank = window.prompt(
            `Correct rank for ${card.id} (A, 2-10, J, Q, K):`,
            card.rank
          );
          if (rank === null) return;
          const normalizedRank = rank.trim().toUpperCase();
          if (!RANK_LABELS.includes(normalizedRank)) {
            announce("That rank is not valid.", "error");
            return;
          }

          const suit = window.prompt(
            `Correct suit for ${card.id} (S, C, H, D):`,
            card.suit
          );
          if (suit === null) return;
          const normalizedSuit = suit.trim().toUpperCase();
          if (!SUIT_LABELS.includes(normalizedSuit)) {
            announce("That suit is not valid.", "error");
            return;
          }

          updateBoardCardFromEditor(card, normalizedRank, normalizedSuit);
        });

        columnEl.appendChild(item);
      });

      grid.appendChild(columnEl);
    });

    const confidenceMessage = boardValidation.lowConfidenceCount
      ? `${boardValidation.lowConfidenceCount} card(s) are below 85% confidence.`
      : "Every recognized card is at least 85% confidence.";

    status.className = `scan-board-validation-status ${boardValidation.valid ? "valid" : "invalid"}`;
    status.innerHTML = boardValidation.valid
      ? `<strong>Valid 52-card deck</strong><span>${confidenceMessage}</span>`
      : `<strong>Board needs review</strong><span>${boardValidation.completeCount}/52 complete · ${boardValidation.uniqueCards} unique cards · ${confidenceMessage}</span>`;

    if (boardValidation.issues.length) {
      boardValidation.issues.slice(0, 18).forEach((issue) => {
        const li = document.createElement("li");
        li.textContent = issue.message;
        issuesEl.appendChild(li);
      });
      if (boardValidation.issues.length > 18) {
        const li = document.createElement("li");
        li.textContent = `${boardValidation.issues.length - 18} additional validation issue(s).`;
        issuesEl.appendChild(li);
      }
    } else {
      const li = document.createElement("li");
      li.textContent = "No duplicates, missing cards, rank-count errors, or suit-count errors.";
      issuesEl.appendChild(li);
    }

    if (loadButton) loadButton.disabled = !boardValidation.valid;
    if (copyButton) copyButton.disabled = boardValidation.completeCount !== 52;
  }

  function copyRecognizedBoardText() {
    if (!recognizedBoard.length) buildRecognizedBoardFromCards();
    const text = recognizedBoardToSolverText(recognizedBoard);
    navigator.clipboard?.writeText(text).then(() => {
      announce("Recognized board copied in FreeCell Solver format.", "success");
    }).catch(() => {
      downloadBlob("recognized-freecell-board.txt", text, "text/plain");
      announce("Recognized board downloaded as text.", "success");
    });
  }

  function loadValidatedBoard() {
    if (!recognizedBoard.length) buildRecognizedBoardFromCards();
    boardValidation = validateRecognizedBoard(recognizedBoard);
    if (!boardValidation.valid) {
      announce("Correct the highlighted cards until the deck is valid.", "error");
      return;
    }
    tryLoadRecognizedBoardIntoExistingInput(recognizedBoard, { solve: true });
  }

  function clearRecognitionLibrary() {
    if (!window.confirm("Delete your locally added rank and suit templates? The built-in v36 library will remain.")) return;
    localRecognitionLibrary = emptyRecognitionLibrary();
    saveRecognitionLibrary();
    refreshAllPredictions();
    announce("Local additions cleared. The built-in v36 library is still active.", "success");
  }

  function clearRankTemplates() {
    if (!window.confirm("Delete only your locally added rank templates? Built-in ranks and all suits will remain.")) return;
    localRecognitionLibrary.ranks = {};
    saveRecognitionLibrary();
    refreshAllPredictions();
    announce("Local rank additions cleared. Built-in templates were kept.", "success");
  }

  function announce(text, kind) {
    if (!message) return;
    message.textContent = text;
    message.className = "input-message" + (kind ? " " + kind : "");
  }

  function updateCvStatus(text, kind) {
    if (!cvStatus) return;
    cvStatus.textContent = text;
    cvStatus.className = "opencv-status" + (kind ? " " + kind : "");
  }


  function setPhotoStatus(text, kind) {
    if (!photoStatus) return;
    photoStatus.textContent = text;
    photoStatus.className = "scan-photo-status" + (kind ? " " + kind : "");
  }

  function orderQuad(points) {
    if (!points || points.length !== 4) return null;
    const ordered = points.map((point) => ({ x: point.x, y: point.y }));
    const sum = ordered.map((p) => p.x + p.y);
    const diff = ordered.map((p) => p.x - p.y);
    return [
      ordered[sum.indexOf(Math.min(...sum))],
      ordered[diff.indexOf(Math.max(...diff))],
      ordered[sum.indexOf(Math.max(...sum))],
      ordered[diff.indexOf(Math.min(...diff))]
    ];
  }

  function quadArea(points) {
    if (!points || points.length !== 4) return 0;
    let area = 0;
    for (let i = 0; i < 4; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % 4];
      area += a.x * b.y - b.x * a.y;
    }
    return Math.abs(area) / 2;
  }

  function drawPhotoCornerReview() {
    if (!photoCanvas || !originalPhotoCanvas) return;
    const maxWidth = 900;
    const scale = Math.min(1, maxWidth / originalPhotoCanvas.width);
    photoCanvas.width = Math.round(originalPhotoCanvas.width * scale);
    photoCanvas.height = Math.round(originalPhotoCanvas.height * scale);
    const ctx = photoCanvas.getContext("2d");
    ctx.drawImage(originalPhotoCanvas, 0, 0, photoCanvas.width, photoCanvas.height);

    if (!photoCorners.length) return;
    const scaled = photoCorners.map((point) => ({ x: point.x * scale, y: point.y * scale }));
    ctx.save();
    ctx.strokeStyle = "#00f0ff";
    ctx.fillStyle = "#00f0ff";
    ctx.lineWidth = Math.max(3, photoCanvas.width * 0.004);
    ctx.beginPath();
    scaled.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    if (scaled.length === 4) ctx.closePath();
    ctx.stroke();

    scaled.forEach((point, index) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(7, photoCanvas.width * 0.012), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#04142e";
      ctx.font = `bold ${Math.max(12, photoCanvas.width * 0.018)}px Arial`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(index + 1), point.x, point.y);
      ctx.fillStyle = "#00f0ff";
    });
    ctx.restore();
  }

  function detectDisplayQuadrilateral() {
    if (!cvReady || !window.cv || !originalPhotoCanvas) {
      setPhotoStatus("OpenCV is not ready for photo preparation.", "warning");
      return;
    }

    let src, resized, gray, blurred, edges, closed, contours, hierarchy;
    try {
      const cv = window.cv;
      src = cv.imread(originalPhotoCanvas);
      const scale = Math.min(1, 1000 / src.cols);
      resized = new cv.Mat();
      cv.resize(src, resized, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);

      gray = new cv.Mat();
      cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY);
      blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0);
      edges = new cv.Mat();
      cv.Canny(blurred, edges, 45, 135);

      closed = new cv.Mat();
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
      cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
      kernel.delete();

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(closed, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const imageArea = resized.cols * resized.rows;
      let best = null;

      for (let i = 0; i < contours.size(); i += 1) {
        const contour = contours.get(i);
        const area = Math.abs(cv.contourArea(contour));
        if (area < imageArea * 0.18) {
          contour.delete();
          continue;
        }

        const perimeter = cv.arcLength(contour, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(contour, approx, perimeter * 0.025, true);

        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const points = [];
          for (let row = 0; row < 4; row += 1) {
            points.push({
              x: approx.intPtr(row, 0)[0] / scale,
              y: approx.intPtr(row, 0)[1] / scale
            });
          }
          const ordered = orderQuad(points);
          const score = area / imageArea;
          if (!best || score > best.score) best = { points: ordered, score };
        }

        approx.delete();
        contour.delete();
      }

      if (best) {
        photoCorners = best.points;
        setPhotoStatus(`Display candidate found. It covers ${Math.round(best.score * 100)}% of the working image. Review the cyan corners.`, "ready");
      } else {
        const insetX = originalPhotoCanvas.width * 0.06;
        const insetY = originalPhotoCanvas.height * 0.05;
        photoCorners = [
          { x: insetX, y: insetY },
          { x: originalPhotoCanvas.width - insetX, y: insetY },
          { x: originalPhotoCanvas.width - insetX, y: originalPhotoCanvas.height - insetY },
          { x: insetX, y: originalPhotoCanvas.height - insetY }
        ];
        setPhotoStatus("No strong four-corner display was found. A safe inset was drawn; tap the true four corners if needed.", "warning");
      }
      drawPhotoCornerReview();
    } catch (error) {
      console.error(error);
      setPhotoStatus(`Photo detection failed: ${error.message}`, "warning");
    } finally {
      [src, resized, gray, blurred, edges, closed, contours, hierarchy].forEach((mat) => {
        if (mat && typeof mat.delete === "function") mat.delete();
      });
    }
  }

  function beginManualPhotoCorners() {
    photoCorners = [];
    photoCornerInputActive = true;
    setPhotoStatus("Tap the display corners in this order: top-left, top-right, bottom-right, bottom-left.", "working");
    drawPhotoCornerReview();
  }

  function handlePhotoCanvasTap(event) {
    if (!photoCornerInputActive || !photoCanvas || !originalPhotoCanvas) return;
    const rect = photoCanvas.getBoundingClientRect();
    const canvasX = (event.clientX - rect.left) * (photoCanvas.width / rect.width);
    const canvasY = (event.clientY - rect.top) * (photoCanvas.height / rect.height);
    const scaleX = originalPhotoCanvas.width / photoCanvas.width;
    const scaleY = originalPhotoCanvas.height / photoCanvas.height;
    photoCorners.push({ x: canvasX * scaleX, y: canvasY * scaleY });

    if (photoCorners.length === 4) {
      photoCorners = orderQuad(photoCorners);
      photoCornerInputActive = false;
      setPhotoStatus("Four manual corners recorded. Review the cyan quadrilateral, then tap Straighten and Scan.", "ready");
    } else {
      setPhotoStatus(`${photoCorners.length}/4 corners recorded.`, "working");
    }
    drawPhotoCornerReview();
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function rectifyPhotoAndScan() {
    if (!cvReady || !window.cv || !originalPhotoCanvas || photoCorners.length !== 4) {
      setPhotoStatus("Four display corners are required before straightening.", "warning");
      return;
    }

    let src, srcPoints, dstPoints, transform, warped;
    try {
      const cv = window.cv;
      const points = orderQuad(photoCorners);
      const width = Math.max(
        distance(points[0], points[1]),
        distance(points[3], points[2])
      );
      const height = Math.max(
        distance(points[0], points[3]),
        distance(points[1], points[2])
      );

      if (width < 250 || height < 350 || quadArea(points) < originalPhotoCanvas.width * originalPhotoCanvas.height * 0.10) {
        throw new Error("The selected quadrilateral is too small.");
      }

      const targetWidth = Math.min(1400, Math.max(600, Math.round(width)));
      const targetHeight = Math.min(2400, Math.max(800, Math.round(height)));

      src = cv.imread(originalPhotoCanvas);
      srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        points[0].x, points[0].y,
        points[1].x, points[1].y,
        points[2].x, points[2].y,
        points[3].x, points[3].y
      ]);
      dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        targetWidth - 1, 0,
        targetWidth - 1, targetHeight - 1,
        0, targetHeight - 1
      ]);
      transform = cv.getPerspectiveTransform(srcPoints, dstPoints);
      warped = new cv.Mat();
      cv.warpPerspective(
        src,
        warped,
        transform,
        new cv.Size(targetWidth, targetHeight),
        cv.INTER_LINEAR,
        cv.BORDER_REPLICATE
      );

      const corrected = document.createElement("canvas");
      corrected.width = targetWidth;
      corrected.height = targetHeight;
      cv.imshow(corrected, warped);

      sourceCanvas = corrected;
      image.onload = () => {
        photoPanel.hidden = true;
        clearDetection();
        updateCvStatus("Photo straightened. Detecting the tableau in the corrected image…", "working");
        window.setTimeout(detectTableauShape, 40);
      };
      image.src = corrected.toDataURL("image/jpeg", 0.94);
      setPhotoStatus("Perspective correction complete.", "ready");
    } catch (error) {
      console.error(error);
      setPhotoStatus(`Could not straighten photo: ${error.message}`, "warning");
    } finally {
      [src, srcPoints, dstPoints, transform, warped].forEach((mat) => {
        if (mat && typeof mat.delete === "function") mat.delete();
      });
    }
  }

  function skipPhotoCorrection() {
    if (!originalPhotoCanvas) return;
    sourceCanvas = originalPhotoCanvas;
    photoPanel.hidden = true;
    updateCvStatus("Using the original photo without perspective correction.", "warning");
    window.setTimeout(detectTableauShape, 30);
  }

  function preparePhotoMode() {
    ensureCanvas();
    originalPhotoCanvas = document.createElement("canvas");
    originalPhotoCanvas.width = sourceCanvas.width;
    originalPhotoCanvas.height = sourceCanvas.height;
    originalPhotoCanvas.getContext("2d").drawImage(sourceCanvas, 0, 0);
    photoPanel.hidden = false;
    detectButton.disabled = true;
    setPhotoStatus("Looking for the photographed display boundary…", "working");
    window.setTimeout(detectDisplayQuadrilateral, 40);
  }

  function initializeOpenCv() {
    updateCvStatus("Loading OpenCV…", "working");
    if (!window.freecellCvReady) {
      updateCvStatus("OpenCV loader is missing.", "warning");
      return;
    }
    window.freecellCvReady.then(() => {
      cvReady = true;
      detectButton.disabled = false;
      updateCvStatus("OpenCV ready.", "ready");
      if (image.naturalWidth) {
        if (selectedInputMode === "photo" && !originalPhotoCanvas) preparePhotoMode();
        else if (selectedInputMode !== "photo") detectTableauShape();
      }
    }).catch((error) => {
      console.error(error);
      updateCvStatus("OpenCV did not initialize. Close and restart Safari, then retry.", "warning");
      detectButton.disabled = false;
    });
  }

  function setDialogOpen(open) {
    dialog.hidden = !open;
    document.body.classList.toggle("scan-open", open);
  }

  function cleanUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  function clearDetection() {
    detection = null;
    debugFrames = {};
    recognitionCards = [];
    recognizedBoard = [];
    boardValidation = null;
    overlay.replaceChildren();
    checksEl.replaceChildren();
    summaryEl.textContent = "No tableau detected yet.";
    detailsPanel.hidden = true;
    detailsGrid.replaceChildren();
    if (debugPanel) {
      debugPanel.hidden = true;
      debugPanel.open = false;
    }
    confirmButton.disabled = true;
  }

  function showPicker() {
    cleanUrl();
    selectedFile = null;
    selectedInputMode = "screenshot";
    sourceCanvas = null;
    originalPhotoCanvas = null;
    photoCorners = [];
    photoCornerInputActive = false;
    if (photoPanel) photoPanel.hidden = true;
    clearDetection();
    image.removeAttribute("src");
    pickerPanel.hidden = false;
    previewPanel.hidden = true;
    pictureInput.value = "";
    if (cameraInput) cameraInput.value = "";
  }

  function ensureCanvas() {
    if (sourceCanvas &&
        sourceCanvas.width === image.naturalWidth &&
        sourceCanvas.height === image.naturalHeight) return;
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = image.naturalWidth;
    sourceCanvas.height = image.naturalHeight;
    sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  }

  function makeStrictCardMask(rgb) {
    const cv = window.cv;
    const hsv = new cv.Mat();
    const gray = new cv.Mat();
    const neutral = new cv.Mat();
    const light = new cv.Mat();
    const mask = new cv.Mat();

    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

    const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 138, 0]);
    const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 92, 255, 255]);
    cv.inRange(hsv, low, high, neutral);
    cv.threshold(gray, light, 138, 255, cv.THRESH_BINARY);
    cv.bitwise_and(neutral, light, mask);

    // Close small holes created by ranks and suits without joining the upper slots
    // to the tableau.
    const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel);
    closeKernel.delete();

    hsv.delete(); gray.delete(); neutral.delete(); light.delete(); low.delete(); high.delete();
    return mask;
  }

  function makeIntegral(mask) {
    const width = mask.cols;
    const height = mask.rows;
    const stride = width + 1;
    const integral = new Uint32Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y += 1) {
      const row = mask.ucharPtr(y);
      let running = 0;
      const out = (y + 1) * stride;
      const prev = y * stride;
      for (let x = 0; x < width; x += 1) {
        running += row[x] ? 1 : 0;
        integral[out + x + 1] = integral[prev + x + 1] + running;
      }
    }
    return { data: integral, width, height, stride };
  }

  function rectSum(ii, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.min(ii.width, Math.round(x0)));
    x1 = Math.max(0, Math.min(ii.width, Math.round(x1)));
    y0 = Math.max(0, Math.min(ii.height, Math.round(y0)));
    y1 = Math.max(0, Math.min(ii.height, Math.round(y1)));
    if (x1 <= x0 || y1 <= y0) return 0;
    const a = ii.data[y0 * ii.stride + x0];
    const b = ii.data[y0 * ii.stride + x1];
    const c = ii.data[y1 * ii.stride + x0];
    const d = ii.data[y1 * ii.stride + x1];
    return d - b - c + a;
  }

  function rectRatio(ii, x0, y0, x1, y1) {
    const area = Math.max(1, (Math.round(x1) - Math.round(x0)) * (Math.round(y1) - Math.round(y0)));
    return rectSum(ii, x0, y0, x1, y1) / area;
  }

  function templateGeometry(left, top, width) {
    const pitch = width / TEMPLATE.columns;
    const laneWidth = pitch * TEMPLATE.laneWidthToPitch;
    const rowStep = width * TEMPLATE.rowStepToWidth;
    const fullCardHeight = width * TEMPLATE.fullCardHeightToWidth;
    const leftHeight = 6 * rowStep + fullCardHeight;
    const rightHeight = 5 * rowStep + fullCardHeight;
    const centers = Array.from({ length: 8 }, (_, i) => left + (i + 0.5) * pitch);
    return {
      left, top, width, right: left + width, pitch, laneWidth, rowStep,
      fullCardHeight, leftHeight, rightHeight,
      bottomLeft: top + leftHeight,
      bottomRight: top + rightHeight,
      stepX: left + 4 * pitch,
      centers
    };
  }

  function scoreTemplate(ii, g) {
    if (g.left < 0 || g.top < 0 || g.right > ii.width ||
        g.bottomLeft > ii.height || g.bottomRight > ii.height) return null;

    const half = g.laneWidth / 2;
    const laneSupports = [];
    for (let i = 0; i < 8; i += 1) {
      const h = i < 4 ? g.leftHeight : g.rightHeight;
      laneSupports.push(rectRatio(ii, g.centers[i] - half, g.top, g.centers[i] + half, g.top + h));
    }

    const gapSupports = [];
    const gapHalf = Math.max(1.5, (g.pitch - g.laneWidth) * 0.43);
    for (let i = 1; i < 8; i += 1) {
      const x = g.left + i * g.pitch;
      const h = i <= 4 ? g.leftHeight : g.rightHeight;
      gapSupports.push(rectRatio(ii, x - gapHalf, g.top, x + gapHalf, g.top + h));
    }

    const aboveH = Math.max(5, g.rowStep * 0.34);
    const aboveSupport = rectRatio(ii, g.left, g.top - aboveH, g.right, g.top - 1);
    const belowBand = Math.max(5, g.rowStep * 0.30);
    const belowLeft = rectRatio(ii, g.left, g.bottomLeft + 1, g.stepX, g.bottomLeft + belowBand);
    const belowRight = rectRatio(ii, g.stepX, g.bottomRight + 1, g.right, g.bottomRight + belowBand);

    // Check the shared tableau top as a thin horizontal band. A correct fit has
    // strong card support immediately below and substantially less immediately above.
    const topBand = Math.max(4, g.rowStep * 0.18);
    const topInside = rectRatio(ii, g.left, g.top, g.right, g.top + topBand);
    const topContrast = topInside - aboveSupport;

    const laneMean = laneSupports.reduce((a, b) => a + b, 0) / 8;
    const laneMin = Math.min(...laneSupports);
    const gapMean = gapSupports.reduce((a, b) => a + b, 0) / Math.max(1, gapSupports.length);
    const bottomDarkness = 1 - ((belowLeft + belowRight) / 2);

    const score =
      laneMean * 5.2 +
      laneMin * 1.7 +
      Math.max(0, topContrast) * 2.6 +
      (1 - gapMean) * 1.0 +
      bottomDarkness * 1.1 -
      aboveSupport * 1.6;

    return {
      score, laneSupports, laneMean, laneMin, gapMean,
      aboveSupport, belowLeft, belowRight, bottomDarkness,
      topInside, topContrast
    };
  }

  function fitTemplate(mask) {
    const ii = makeIntegral(mask);
    const w = mask.cols;
    const h = mask.rows;
    let best = null;
    const candidates = [];

    function consider(left, top, width) {
      const geometry = templateGeometry(left, top, width);
      const metrics = scoreTemplate(ii, geometry);
      if (!metrics) return;
      const candidate = { geometry, metrics };
      candidates.push(candidate);
      if (!best || metrics.score > best.metrics.score) best = candidate;
    }

    // Coarse search. The actual tableau spans most of the screenshot width,
    // but position and scale vary by phone and by screenshot cropping.
    const minWidth = Math.round(w * 0.78);
    const maxWidth = Math.round(w * 0.995);
    for (let width = minWidth; width <= maxWidth; width += Math.max(8, Math.round(w * 0.012))) {
      const leftMax = Math.max(0, w - width);
      const yMin = Math.round(h * 0.24);
      const yMax = Math.min(Math.round(h * 0.68), Math.round(h - width * 0.61));
      for (let left = 0; left <= leftMax; left += Math.max(4, Math.round(w * 0.008))) {
        for (let top = yMin; top <= yMax; top += Math.max(5, Math.round(h * 0.006))) {
          consider(left, top, width);
        }
      }
    }

    if (!best) throw new Error("No tableau-template candidate fit inside the image.");

    // Fine search around the best coarse match.
    const coarse = best.geometry;
    const fineCandidates = [];
    best = null;
    for (let width = coarse.width - 16; width <= coarse.width + 16; width += 2) {
      for (let left = coarse.left - 12; left <= coarse.left + 12; left += 2) {
        for (let top = coarse.top - 18; top <= coarse.top + 18; top += 2) {
          const geometry = templateGeometry(left, top, width);
          const metrics = scoreTemplate(ii, geometry);
          if (!metrics) continue;
          const candidate = { geometry, metrics };
          fineCandidates.push(candidate);
          if (!best || metrics.score > best.metrics.score) best = candidate;
        }
      }
    }

    // Find a meaningfully different alternative, not just the adjacent pixel.
    const alternatives = candidates.concat(fineCandidates).filter((candidate) => {
      const a = candidate.geometry;
      const b = best.geometry;
      return Math.abs(a.left - b.left) > b.pitch * 0.45 ||
             Math.abs(a.top - b.top) > b.rowStep * 0.55 ||
             Math.abs(a.width - b.width) > b.pitch * 0.40;
    }).sort((a, b) => b.metrics.score - a.metrics.score);

    const second = alternatives[0] || null;
    const margin = second ? best.metrics.score - second.metrics.score : best.metrics.score;

    return { best, second, margin };
  }

  function buildCardRegions(g) {
    const regions = [];
    const cropH = Math.max(8, g.rowStep * TEMPLATE.cropHeightToRowStep);
    for (let col = 0; col < 8; col += 1) {
      const count = col < 4 ? 7 : 6;
      const left = g.left + col * g.pitch;
      for (let row = 0; row < count; row += 1) {
        regions.push({
          id: `C${col + 1}-${row + 1}`,
          column: col + 1,
          row: row + 1,
          x: left,
          y: g.top + row * g.rowStep,
          width: g.pitch,
          height: cropH
        });
      }
    }
    return regions;
  }

  function matToDataUrl(mat) {
    const canvas = document.createElement("canvas");
    cv.imshow(canvas, mat);
    return canvas.toDataURL("image/png");
  }

  function canvasDataUrl(draw) {
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext("2d");
    draw(ctx, canvas);
    return canvas.toDataURL("image/png");
  }

  function drawTemplate(ctx, g, options = {}) {
    const lineWidth = options.lineWidth || Math.max(2, g.width * 0.004);
    const outline = options.outline || "#00ffff";
    const rowColor = options.rowColor || "#39ff70";
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = outline;
    ctx.beginPath();
    ctx.moveTo(g.left, g.top);
    ctx.lineTo(g.right, g.top);
    ctx.lineTo(g.right, g.bottomRight);
    ctx.lineTo(g.stepX, g.bottomRight);
    ctx.lineTo(g.stepX, g.bottomLeft);
    ctx.lineTo(g.left, g.bottomLeft);
    ctx.closePath();
    ctx.stroke();

    ctx.setLineDash([lineWidth * 2.2, lineWidth * 2.2]);
    for (let i = 1; i < 8; i += 1) {
      const x = g.left + i * g.pitch;
      ctx.beginPath();
      ctx.moveTo(x, g.top);
      ctx.lineTo(x, i <= 4 ? g.bottomLeft : g.bottomRight);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = rowColor;
    ctx.lineWidth = Math.max(1, lineWidth * 0.55);
    for (let row = 1; row < 7; row += 1) {
      const y = g.top + row * g.rowStep;
      ctx.beginPath();
      ctx.moveTo(g.left, y);
      ctx.lineTo(row < 6 ? g.right : g.stepX, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function makeDebugFrames(mask, result) {
    const inv = result.inverseScale;
    const g = result.geometryOriginal;
    const templateMask = document.createElement("canvas");
    templateMask.width = mask.cols;
    templateMask.height = mask.rows;
    const tm = templateMask.getContext("2d");
    tm.fillStyle = "black";
    tm.fillRect(0, 0, templateMask.width, templateMask.height);
    tm.fillStyle = "white";
    const smallG = result.geometrySmall;
    const half = smallG.laneWidth / 2;
    smallG.centers.forEach((center, i) => {
      const height = i < 4 ? smallG.leftHeight : smallG.rightHeight;
      tm.fillRect(center - half, smallG.top, smallG.laneWidth, height);
    });

    const overlayFrame = canvasDataUrl((ctx) => {
      ctx.drawImage(sourceCanvas, 0, 0);
      drawTemplate(ctx, g, { outline: "#00ffff", rowColor: "#39ff70" });
    });

    const regionFrame = canvasDataUrl((ctx) => {
      ctx.drawImage(sourceCanvas, 0, 0);
      ctx.lineWidth = Math.max(1, g.width * 0.0025);
      ctx.strokeStyle = "#39ff70";
      result.cardRegions.forEach((r) => ctx.strokeRect(r.x, r.y, r.width, r.height));
      drawTemplate(ctx, g, { outline: "#00ffff", rowColor: "rgba(57,255,112,.7)" });
    });

    return {
      original: sourceCanvas.toDataURL("image/png"),
      mask: matToDataUrl(mask),
      template: templateMask.toDataURL("image/png"),
      match: overlayFrame,
      geometry: regionFrame
    };
  }

  function drawDetection(result) {
    overlay.replaceChildren();
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${image.naturalWidth} ${image.naturalHeight}`);
    svg.setAttribute("preserveAspectRatio", "none");

    const polygon = document.createElementNS(ns, "polygon");
    polygon.setAttribute("points", result.points.map((p) => `${p.x},${p.y}`).join(" "));
    polygon.setAttribute("class", result.passCount === 8 ? "scan-silhouette-good" : "scan-silhouette-review");
    svg.appendChild(polygon);

    for (let i = 1; i < 8; i += 1) {
      const x = result.left + i * result.spacing;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", x);
      line.setAttribute("x2", x);
      line.setAttribute("y1", result.top);
      line.setAttribute("y2", i <= 4 ? result.bottomLeft : result.bottomRight);
      line.setAttribute("class", "scan-silhouette-divider");
      svg.appendChild(line);
    }

    overlay.appendChild(svg);
    const mappingOk = overlay.offsetWidth === image.offsetWidth &&
                      overlay.offsetHeight === image.offsetHeight;
    summaryEl.textContent =
      `${result.passCount}/8 template checks passed • image ${image.naturalWidth} × ${image.naturalHeight} • overlay ${mappingOk ? "mapped" : "review"}`;

    checksEl.replaceChildren();
    const labels = {
      templateFound: "Tableau template located",
      surfaceOverlap: "Card-surface overlap",
      laneMinimum: "All eight lanes supported",
      darkColumnGaps: "Column-gap separation",
      sharedTop: "Shared top boundary",
      steppedBottom: "Stepped bottom boundary",
      plausibleScale: "Plausible tableau scale",
      uniqueMatch: "Best-match separation"
    };
    Object.entries(result.checks).forEach(([key, pass]) => {
      const item = document.createElement("span");
      item.className = "scan-column-count" + (pass ? "" : " scan-column-warning");
      item.textContent = `${labels[key]}: ${pass ? "Pass" : "Review"}`;
      checksEl.appendChild(item);
    });
    confirmButton.disabled = result.passCount < 8;
  }

  function renderDebugView() {
    if (!debugCanvas || !debugSelect) return;
    const frame = debugFrames[debugSelect.value];
    if (!frame) return;
    const pic = new Image();
    pic.onload = () => {
      debugCanvas.width = pic.naturalWidth;
      debugCanvas.height = pic.naturalHeight;
      debugCanvas.getContext("2d").drawImage(pic, 0, 0);
    };
    pic.src = frame;
  }

  function detectTableauShape() {
    if (!image.naturalWidth) return;
    if (!cvReady || !window.cv || typeof window.cv.imread !== "function") {
      updateCvStatus("OpenCV is not ready yet.", "warning");
      return;
    }

    detectButton.disabled = true;
    updateCvStatus("Fitting the fixed 8-column tableau template to the card-surface mask…", "working");

    let src, resized, rgb, mask;
    try {
      ensureCanvas();
      const cv = window.cv;
      src = cv.imread(sourceCanvas);
      const maxW = 850;
      const scale = Math.min(1, maxW / src.cols);
      resized = new cv.Mat();
      cv.resize(src, resized,
        new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)),
        0, 0, cv.INTER_AREA);
      rgb = new cv.Mat();
      cv.cvtColor(resized, rgb, cv.COLOR_RGBA2RGB);
      mask = makeStrictCardMask(rgb);

      const fit = fitTemplate(mask);
      const fittedGeometry = fit.best.geometry;
      const m = fit.best.metrics;
      const inv = 1 / scale;

      // Apply the requested five-pixel upward correction to the entire template.
      // Convert it into resized-image coordinates first, then rebuild both the
      // small and original geometries from the corrected top.
      const correctedSmall = templateGeometry(
        fittedGeometry.left,
        fittedGeometry.top + TABLEAU_TOP_CORRECTION_PX * scale,
        fittedGeometry.width
      );
      const g = correctedSmall;
      const original = templateGeometry(
        g.left * inv,
        g.top * inv,
        g.width * inv
      );

      // Keep the fitted width and full-card height, but decrease the exposed-row
      // spacing by one source-image pixel. Recalculate the stepped bottoms so the
      // cyan outline, 52 card positions, extractions, and debug views all agree.
      original.rowStep += TABLEAU_ROW_STEP_CORRECTION_PX;
      original.leftHeight = 6 * original.rowStep + original.fullCardHeight;
      original.rightHeight = 5 * original.rowStep + original.fullCardHeight;
      original.bottomLeft = original.top + original.leftHeight;
      original.bottomRight = original.top + original.rightHeight;

      const regions = buildCardRegions(original);

      const checks = {
        templateFound: true,
        surfaceOverlap: m.laneMean >= 0.52,
        laneMinimum: m.laneMin >= 0.36,
        darkColumnGaps: m.gapMean <= 0.52,
        sharedTop: m.topInside >= 0.48 && m.topContrast >= 0.10,
        steppedBottom: m.bottomDarkness >= 0.58,
        plausibleScale: g.width / mask.cols >= 0.78 && g.width / mask.cols <= 1.0,
        uniqueMatch: fit.margin >= 0.16 || m.score >= 8.0
      };
      const passCount = Object.values(checks).filter(Boolean).length;

      const result = {
        geometrySmall: g,
        geometryOriginal: original,
        inverseScale: inv,
        metrics: m,
        secondScore: fit.second ? fit.second.metrics.score : null,
        margin: fit.margin,
        checks,
        passCount,
        cardRegions: regions,
        left: original.left,
        right: original.right,
        top: original.top,
        bottomLeft: original.bottomLeft,
        bottomRight: original.bottomRight,
        stepX: original.stepX,
        spacing: original.pitch,
        rowStep: original.rowStep,
        cardHeight: original.fullCardHeight,
        centers: original.centers,
        points: [
          { x: original.left, y: original.top },
          { x: original.right, y: original.top },
          { x: original.right, y: original.bottomRight },
          { x: original.stepX, y: original.bottomRight },
          { x: original.stepX, y: original.bottomLeft },
          { x: original.left, y: original.bottomLeft }
        ],
        confidence: Math.max(0, Math.min(1, m.score / 9.0))
      };

      detection = result;
      debugFrames = makeDebugFrames(mask, result);
      drawDetection(result);
      if (debugPanel) debugPanel.hidden = false;
      renderDebugView();

      if (debugText) {
        debugText.textContent = JSON.stringify({
          detector: "fixed-tableau-template-v37",
          templateRatios: TEMPLATE,
          tableauTopCorrectionPx: TABLEAU_TOP_CORRECTION_PX,
          tableauRowStepCorrectionPx: TABLEAU_ROW_STEP_CORRECTION_PX,
          x: Math.round(original.left),
          y: Math.round(original.top),
          width: Math.round(original.width),
          pitch: Number(original.pitch.toFixed(2)),
          rowStep: Number(original.rowStep.toFixed(2)),
          fullCardHeight: Number(original.fullCardHeight.toFixed(2)),
          leftBottom: Math.round(original.bottomLeft),
          rightBottom: Math.round(original.bottomRight),
          bestScore: Number(m.score.toFixed(3)),
          secondBestScore: fit.second ? Number(fit.second.metrics.score.toFixed(3)) : null,
          scoreMargin: Number(fit.margin.toFixed(3)),
          laneMean: Number(m.laneMean.toFixed(3)),
          laneMinimum: Number(m.laneMin.toFixed(3)),
          laneSupports: m.laneSupports.map((v) => Number(v.toFixed(3))),
          gapSupport: Number(m.gapMean.toFixed(3)),
          sharedTopInside: Number(m.topInside.toFixed(3)),
          sharedTopContrast: Number(m.topContrast.toFixed(3)),
          darknessBelowBottoms: Number(m.bottomDarkness.toFixed(3)),
          cardRegions: regions.map((r) => ({
            id: r.id,
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height)
          })),
          checks,
          passes: passCount
        }, null, 2);
      }

      const perfect = passCount === 8;
      updateCvStatus(
        perfect
          ? "Board detected. Review the cyan template."
          : "Template candidate found. Open Debug View and review the failed check.",
        perfect ? "ready" : "warning"
      );
      announce(
        perfect
          ? "The fixed tableau template is aligned and all 52 card regions are known."
          : "The template fit is visible, but confirmation remains disabled until every check passes.",
        perfect ? "success" : ""
      );
    } catch (error) {
      console.error(error);
      clearDetection();
      updateCvStatus(`Board not found: ${error.message}`, "warning");
      announce("OpenCV could not fit the fixed tableau template to this image.", "error");
    } finally {
      [src, resized, rgb, mask].forEach((m) => {
        if (m && typeof m.delete === "function") m.delete();
      });
      detectButton.disabled = false;
    }
  }

  function recognitionCropForRegion(region) {
    // v25: wider and slightly taller than v24 so the entire rank and small suit
    // symbol remain visible. The crop still stays inside one fitted column lane.
    const insetX = detection.spacing * 0.012;
    const insetY = detection.rowStep * 0.018;
    const width = detection.spacing * 0.93;
    const height = detection.rowStep * 0.86;

    return {
      x: Math.max(0, region.x + insetX),
      y: Math.max(0, region.y + insetY),
      width: Math.min(width, image.naturalWidth - region.x - insetX),
      height: Math.min(height, image.naturalHeight - region.y - insetY)
    };
  }

  function rankAndSuitRegions(crop) {
    // The regions overlap slightly on purpose. The 10 is wider than other ranks,
    // while the suit symbol sometimes begins farther left on different phones.
    return {
      rank: {
        x: crop.x,
        y: crop.y,
        width: crop.width * 0.63,
        height: crop.height * 0.96
      },
      suit: {
        x: crop.x + crop.width * 0.50,
        y: crop.y,
        width: crop.width * 0.50,
        height: crop.height * 0.96
      }
    };
  }

  function cropCanvasFromSource(crop) {
    const width = Math.max(1, Math.round(crop.width));
    const height = Math.max(1, Math.round(crop.height));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sourceCanvas,
      Math.round(crop.x),
      Math.round(crop.y),
      width,
      height,
      0,
      0,
      width,
      height
    );
    return canvas;
  }

  function cloneCanvas(source) {
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    const ctx = copy.getContext("2d");
    ctx.drawImage(source, 0, 0);
    return copy;
  }

  function binaryComponents(binary, width, height) {
    const visited = new Uint8Array(binary.length);
    const components = [];
    const neighbors = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0],            [1, 0],
      [-1, 1],  [0, 1],   [1, 1]
    ];

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const startIndex = y * width + x;
        if (!binary[startIndex] || visited[startIndex]) continue;

        const stack = [startIndex];
        visited[startIndex] = 1;
        const pixels = [];
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;

        while (stack.length) {
          const index = stack.pop();
          const px = index % width;
          const py = Math.floor(index / width);
          pixels.push(index);
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);

          neighbors.forEach(([dx, dy]) => {
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
            const ni = ny * width + nx;
            if (!binary[ni] || visited[ni]) return;
            visited[ni] = 1;
            stack.push(ni);
          });
        }

        components.push({
          pixels,
          area: pixels.length,
          minX,
          maxX,
          minY,
          maxY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
          touchesLeft: minX <= 2,
          touchesRight: maxX >= width - 3,
          touchesTop: minY <= 1,
          touchesBottom: maxY >= height - 2
        });
      }
    }

    return components;
  }

  function componentCenter(component) {
    return {
      x: (component.minX + component.maxX) / 2,
      y: (component.minY + component.maxY) / 2
    };
  }

  function componentMask(components, length) {
    const mask = new Uint8Array(length);
    components.forEach((component) => {
      component.pixels.forEach((index) => {
        mask[index] = 1;
      });
    });
    return mask;
  }

  function selectRankComponents(binary, width, height) {
    const components = binaryComponents(binary, width, height);
    if (!components.length) {
      return { binary, kept: [], removed: [], reasons: new Map() };
    }

    const reasons = new Map();
    const largestArea = Math.max(...components.map((component) => component.area));

    const candidates = components.filter((component) => {
      const edgeVertical =
        component.touchesLeft &&
        component.width <= Math.max(7, width * 0.14) &&
        component.height >= height * 0.38;

      const topRule =
        component.touchesTop &&
        component.height <= Math.max(5, height * 0.12) &&
        component.width >= width * 0.28;

      const bottomArtwork =
        component.touchesBottom &&
        component.minY >= height * 0.68 &&
        component.height <= height * 0.30 &&
        component.area < largestArea * 0.48;

      const tiny =
        component.area < Math.max(12, largestArea * 0.025) ||
        (component.width <= 3 && component.height <= 8);

      if (edgeVertical) reasons.set(component, "left border");
      else if (topRule) reasons.set(component, "top border");
      else if (bottomArtwork) reasons.set(component, "bottom artwork");
      else if (tiny) reasons.set(component, "small artifact");

      return !(edgeVertical || topRule || bottomArtwork || tiny);
    });

    if (!candidates.length) {
      const fallback = components.slice().sort((a, b) => b.area - a.area)[0];
      return {
        binary: componentMask([fallback], binary.length),
        kept: [fallback],
        removed: components.filter((component) => component !== fallback),
        reasons
      };
    }

    const centerTarget = { x: width * 0.38, y: height * 0.46 };

    const scored = candidates.map((component) => {
      const center = componentCenter(component);
      const dx = Math.abs(center.x - centerTarget.x) / width;
      const dy = Math.abs(center.y - centerTarget.y) / height;
      const areaScore = component.area / largestArea;
      const heightScore = component.height / height;
      const centrality = 1 - Math.min(1, dx * 1.35 + dy * 0.75);
      const borderPenalty =
        (component.touchesLeft ? 0.35 : 0) +
        (component.touchesTop && component.height < height * 0.18 ? 0.30 : 0) +
        (component.touchesBottom && component.area < largestArea * 0.55 ? 0.18 : 0);

      return {
        component,
        score: areaScore * 0.62 + heightScore * 0.22 + centrality * 0.28 - borderPenalty
      };
    }).sort((a, b) => b.score - a.score);

    const primary = scored[0].component;
    const kept = [primary];

    // A valid companion preserves the two-part "10" and threshold-split letters.
    scored.slice(1).forEach(({ component }) => {
      if (kept.length >= 2) return;

      const left = primary.minX <= component.minX ? primary : component;
      const right = left === primary ? component : primary;
      const verticalOverlap =
        Math.max(0, Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY) + 1) /
        Math.max(1, Math.min(left.height, right.height));
      const gap = right.minX - left.maxX - 1;
      const areaRatio = component.area / Math.max(1, primary.area);
      const sameLine =
        verticalOverlap >= 0.42 &&
        gap >= -2 &&
        gap <= width * 0.24;
      const substantial =
        areaRatio >= 0.09 &&
        component.height >= height * 0.25;
      const notArtwork =
        component.minY < height * 0.62 ||
        component.height > height * 0.38;

      if (sameLine && substantial && notArtwork) {
        kept.push(component);
      }
    });

    const removed = components.filter((component) => !kept.includes(component));
    removed.forEach((component) => {
      if (!reasons.has(component)) reasons.set(component, "not part of primary rank");
    });

    return {
      binary: componentMask(kept, binary.length),
      kept,
      removed,
      reasons
    };
  }

  function selectSuitComponents(binary, width, height) {
    const components = binaryComponents(binary, width, height);
    if (!components.length) {
      return { binary, kept: [], removed: [], reasons: new Map() };
    }

    const reasons = new Map();
    const largestArea = Math.max(...components.map((component) => component.area));
    const target = { x: width * 0.52, y: height * 0.46 };

    const scored = components.map((component) => {
      const center = componentCenter(component);
      const dx = Math.abs(center.x - target.x) / width;
      const dy = Math.abs(center.y - target.y) / height;
      const centrality = 1 - Math.min(1, dx * 1.2 + dy * 0.9);
      const area = component.area / largestArea;
      const shapeSize = Math.min(1, component.height / (height * 0.55));
      const edgePenalty =
        (component.touchesLeft ? 0.45 : 0) +
        (component.touchesRight ? 0.30 : 0) +
        (component.touchesTop && component.height < height * 0.16 ? 0.32 : 0) +
        (component.touchesBottom && component.area < largestArea * 0.40 ? 0.25 : 0);

      return {
        component,
        score: area * 0.62 + centrality * 0.34 + shapeSize * 0.18 - edgePenalty
      };
    }).sort((a, b) => b.score - a.score);

    const primary = scored[0].component;
    const kept = [primary];
    const removed = components.filter((component) => component !== primary);

    removed.forEach((component) => {
      const tiny = component.area < Math.max(10, largestArea * 0.03);
      const bottom = component.touchesBottom || component.minY > height * 0.70;
      const edge = component.touchesLeft || component.touchesRight || component.touchesTop;
      reasons.set(
        component,
        tiny ? "small artifact" :
        bottom ? "bottom artwork" :
        edge ? "edge artifact" :
        "not strongest central suit"
      );
    });

    return {
      binary: componentMask(kept, binary.length),
      kept,
      removed,
      reasons
    };
  }

  function componentDebugCanvas(width, height, kept, removed) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);

    for (let i = 0; i < width * height; i += 1) {
      const offset = i * 4;
      imageData.data[offset] = 255;
      imageData.data[offset + 1] = 255;
      imageData.data[offset + 2] = 255;
      imageData.data[offset + 3] = 255;
    }

    removed.forEach((component) => {
      component.pixels.forEach((index) => {
        const offset = index * 4;
        imageData.data[offset] = 225;
        imageData.data[offset + 1] = 55;
        imageData.data[offset + 2] = 55;
      });
    });

    kept.forEach((component) => {
      component.pixels.forEach((index) => {
        const offset = index * 4;
        imageData.data[offset] = 20;
        imageData.data[offset + 1] = 170;
        imageData.data[offset + 2] = 90;
      });
    });

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function binaryToCanvas(binary, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);

    for (let i = 0; i < binary.length; i += 1) {
      const value = binary[i] ? 0 : 255;
      const offset = i * 4;
      imageData.data[offset] = value;
      imageData.data[offset + 1] = value;
      imageData.data[offset + 2] = value;
      imageData.data[offset + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function normalizeBinaryCanvas(source, binary, targetWidth, targetHeight) {
    let minX = source.width;
    let minY = source.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        if (!binary[y * source.width + x]) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    const normalized = document.createElement("canvas");
    normalized.width = targetWidth;
    normalized.height = targetHeight;
    const out = normalized.getContext("2d");
    out.fillStyle = "#fff";
    out.fillRect(0, 0, targetWidth, targetHeight);
    out.imageSmoothingEnabled = true;
    out.imageSmoothingQuality = "high";

    const cleanedSource = binaryToCanvas(binary, source.width, source.height);

    if (maxX >= minX && maxY >= minY) {
      const contentWidth = maxX - minX + 1;
      const contentHeight = maxY - minY + 1;
      const padding = 5;
      const scale = Math.min(
        (targetWidth - padding * 2) / contentWidth,
        (targetHeight - padding * 2) / contentHeight
      );
      const drawWidth = contentWidth * scale;
      const drawHeight = contentHeight * scale;

      out.drawImage(
        cleanedSource,
        minX,
        minY,
        contentWidth,
        contentHeight,
        (targetWidth - drawWidth) / 2,
        (targetHeight - drawHeight) / 2,
        drawWidth,
        drawHeight
      );
    }

    return {
      canvas: normalized,
      sourceCanvas: cleanedSource,
      foregroundBounds: maxX >= minX ? { minX, minY, maxX, maxY } : null
    };
  }

  function normalizedSymbolCanvas(source, targetWidth, targetHeight, options = {}) {
    const srcCtx = source.getContext("2d", { willReadFrequently: true });
    const imageData = srcCtx.getImageData(0, 0, source.width, source.height);
    const data = imageData.data;
    const binary = new Uint8Array(source.width * source.height);

    let redPixels = 0;
    let darkPixels = 0;

    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const i = (y * source.width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const brightness = (r + g + b) / 3;
        const red = r > g * 1.28 && r > b * 1.28 && r > 105;
        const dark = brightness < 132 && Math.max(r, g, b) - Math.min(r, g, b) < 95;
        const foreground = red || dark;

        binary[y * source.width + x] = foreground ? 1 : 0;
        if (red) redPixels += 1;
        if (dark) darkPixels += 1;
      }
    }

    const rawMaskCanvas = binaryToCanvas(binary, source.width, source.height);
    const cleanup = options.role === "rank"
      ? selectRankComponents(binary, source.width, source.height)
      : selectSuitComponents(binary, source.width, source.height);

    const normalized = normalizeBinaryCanvas(
      source,
      cleanup.binary,
      targetWidth,
      targetHeight
    );

    const componentDebug = componentDebugCanvas(
      source.width,
      source.height,
      cleanup.kept,
      cleanup.removed
    );

    return {
      canvas: normalized.canvas,
      rawMaskCanvas,
      componentDebugCanvas: componentDebug,
      cleanedSourceCanvas: normalized.sourceCanvas,
      foregroundBounds: normalized.foregroundBounds,
      colorFamily: redPixels > darkPixels * 0.65 ? "red" : "black",
      redPixels,
      darkPixels,
      removedComponents: cleanup.removed.length,
      keptComponents: cleanup.kept.length,
      removalReasons: Array.from(cleanup.reasons.values())
    };
  }

  function makeCropCanvas(crop) {
    const canvas = document.createElement("canvas");
    const sourceWidth = Math.max(1, Math.round(crop.width));
    const sourceHeight = Math.max(1, Math.round(crop.height));

    // Preserve the complete extraction rectangle. CSS uses object-fit: contain,
    // so no edge of the bitmap is hidden in the thumbnail.
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sourceCanvas,
      Math.round(crop.x),
      Math.round(crop.y),
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight
    );
    return canvas;
  }

  function showDetails() {
    if (!detection) {
      announce("Detect the board first.", "error");
      return;
    }

    ensureCanvas();
    detailsGrid.replaceChildren();
    recognitionCards = [];
    const recognitionRegions = [];

    detection.cardRegions.forEach((region) => {
      const crop = recognitionCropForRegion(region);
      const rois = rankAndSuitRegions(crop);

      const article = document.createElement("article");
      article.className = "scan-recognition-review";

      const header = document.createElement("header");
      header.innerHTML = `<strong>${region.id}</strong><small>${Math.round(crop.width)}×${Math.round(crop.height)} px source</small>`;

      const original = makeCropCanvas(crop);
      original.className = "scan-recognition-original";

      const rankSource = cropCanvasFromSource(rois.rank);
      const suitSource = cropCanvasFromSource(rois.suit);
      const rankMask = normalizedSymbolCanvas(rankSource, 64, 80, { role: "rank" });
      const suitMask = normalizedSymbolCanvas(suitSource, 64, 80, { role: "suit" });
      const rankBinary = canvasToBinary(rankMask.canvas);
      const suitBinary = canvasToBinary(suitMask.canvas);

      const rows = document.createElement("div");
      rows.className = "scan-recognition-rows";

      function box(canvas, label, extraClass) {
        const figure = document.createElement("figure");
        figure.className = "scan-recognition-box" + (extraClass ? " " + extraClass : "");
        const caption = document.createElement("figcaption");
        caption.textContent = label;
        figure.append(canvas, caption);
        return figure;
      }

      rows.append(
        box(original, "Full extraction", "scan-recognition-full"),
        box(rankSource, "Rank ROI"),
        box(suitSource, "Suit ROI"),
        box(rankMask.rawMaskCanvas, "Raw rank mask"),
        box(rankMask.componentDebugCanvas, `Rank components · green kept / red rejected`),
        box(rankMask.cleanedSourceCanvas, `Cleaned rank · kept ${rankMask.keptComponents} / removed ${rankMask.removedComponents}`),
        box(rankMask.canvas, "Normalized rank mask"),
        box(suitMask.rawMaskCanvas, "Raw suit mask"),
        box(suitMask.componentDebugCanvas, "Suit components · green kept / red rejected"),
        box(suitMask.cleanedSourceCanvas, `Cleaned suit · kept ${suitMask.keptComponents} / removed ${suitMask.removedComponents}`),
        box(suitMask.canvas, "Normalized suit mask")
      );

      const status = document.createElement("div");
      status.className = "scan-recognition-status";
      status.innerHTML = `<span>Suit color family: <strong>${suitMask.colorFamily}</strong></span>`;

      const rankLine = document.createElement("span");
      rankLine.append("Rank prediction: ");
      const rankPredictionEl = document.createElement("strong");
      rankPredictionEl.textContent = "needs template";
      rankLine.append(rankPredictionEl);

      const suitLine = document.createElement("span");
      suitLine.append("Suit prediction: ");
      const suitPredictionEl = document.createElement("strong");
      suitPredictionEl.textContent = "needs template";
      suitLine.append(suitPredictionEl);

      status.append(rankLine, suitLine);

      const trainer = document.createElement("div");
      trainer.className = "scan-template-trainer";

      const rankSelect = document.createElement("select");
      rankSelect.innerHTML = optionMarkup(RANK_LABELS, "Choose rank");
      const saveRank = document.createElement("button");
      saveRank.type = "button";
      saveRank.textContent = "Save Rank Template";
      saveRank.addEventListener("click", () => {
        if (!rankSelect.value) {
          announce(`Choose the rank for ${region.id} first.`, "error");
          return;
        }
        const result = addTemplate(localRecognitionLibrary.ranks, rankSelect.value, rankBinary);
        if (!result.added) {
          announce(`That ${rankSelect.value} example is already in the library.`, "error");
          return;
        }
        saveRecognitionLibrary();
        refreshAllPredictions();
        announce(`Saved ${rankSelect.value} example ${result.count}/${MAX_LOCAL_TEMPLATES_PER_SYMBOL} from ${region.id}.`, "success");
      });

      const allowedSuits = suitMask.colorFamily === "red" ? ["H", "D"] : ["S", "C"];
      const suitSelect = document.createElement("select");
      suitSelect.innerHTML = optionMarkup(allowedSuits, "Choose suit");
      const saveSuit = document.createElement("button");
      saveSuit.type = "button";
      saveSuit.textContent = "Save Suit Template";
      saveSuit.addEventListener("click", () => {
        if (!suitSelect.value) {
          announce(`Choose the suit for ${region.id} first.`, "error");
          return;
        }
        const result = addTemplate(localRecognitionLibrary.suits, suitSelect.value, suitBinary);
        if (!result.added) {
          announce(`That ${SUIT_NAMES[suitSelect.value]} example is already in the library.`, "error");
          return;
        }
        saveRecognitionLibrary();
        refreshAllPredictions();
        announce(`Saved ${SUIT_NAMES[suitSelect.value]} example ${result.count}/${MAX_LOCAL_TEMPLATES_PER_SYMBOL} from ${region.id}.`, "success");
      });

      trainer.append(rankSelect, saveRank, suitSelect, saveSuit);
      article.append(header, rows, status, trainer);
      detailsGrid.appendChild(article);

      const card = {
        id: region.id,
        extraction: crop,
        rank: rois.rank,
        suit: rois.suit,
        rankBounds: rankMask.foregroundBounds,
        suitBounds: suitMask.foregroundBounds,
        suitColorFamily: suitMask.colorFamily,
        rankBinary,
        suitBinary,
        rankPredictionEl,
        suitPredictionEl,
        prediction: null
      };
      recognitionCards.push(card);
      recognitionRegions.push(card);
    });

    detection.recognitionRegions = recognitionRegions;
    detailsPanel.hidden = false;
    updateRecognitionLibrarySummary();
    refreshAllPredictions();
    detailsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    buildRecognizedBoardFromCards();
    renderRecognizedBoard();
    announce("Recognition complete. Review the validated 52-card board below.", "success");
  }

  function confirmShape() {
    if (!detection || detection.passCount < 8) return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      version: 37,
      detector: "opencv-fixed-tableau-template-v37",
      imageName: selectedFile ? selectedFile.name : "board image",
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      silhouette: detection,
      cardRegions: detection.cardRegions,
      savedAt: new Date().toISOString()
    }));
    setDialogOpen(false);
    announce("Tableau template and all 52 card regions were saved.", "success");
  }

  function showImage(file, inputMode = "screenshot") {
    if (!file || (file.type && !file.type.startsWith("image/"))) {
      announce("Choose a valid image file.", "error");
      return;
    }
    cleanUrl();
    selectedFile = file;
    selectedInputMode = inputMode;
    objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      sourceCanvas = null;
      pickerPanel.hidden = true;
      previewPanel.hidden = false;
      clearDetection();
      ensureCanvas();

      if (selectedInputMode === "photo") {
        updateCvStatus(
          cvReady ? "Photo loaded. Preparing perspective correction…" : "Photo loaded. Waiting for OpenCV…",
          "working"
        );
        if (cvReady) window.setTimeout(preparePhotoMode, 30);
      } else {
        updateCvStatus(
          cvReady ? "Screenshot loaded. Fitting tableau template…" : "Screenshot loaded. Waiting for OpenCV…",
          "working"
        );
        if (cvReady) window.setTimeout(detectTableauShape, 30);
      }
    };
    image.onerror = () => announce("The selected image could not be displayed.", "error");
    image.src = objectUrl;
  }

  function handleSelection() {
    const file = pictureInput.files && pictureInput.files[0];
    if (file) showImage(file, "screenshot");
  }

  function handleCameraSelection() {
    const file = cameraInput && cameraInput.files && cameraInput.files[0];
    if (file) showImage(file, "photo");
  }

  if (!openButton || !dialog || !pictureInput) return;

  initializeOpenCv();
  detectButton.disabled = true;
  confirmButton.disabled = true;

  openButton.addEventListener("click", () => setDialogOpen(true));
  closeButton.addEventListener("click", () => setDialogOpen(false));
  dialog.querySelectorAll("[data-scan-cancel]")
    .forEach((node) => node.addEventListener("click", () => setDialogOpen(false)));
  pictureInput.addEventListener("change", handleSelection);
  pictureInput.addEventListener("input", handleSelection);
  if (cameraInput) {
    cameraInput.addEventListener("change", handleCameraSelection);
    cameraInput.addEventListener("input", handleCameraSelection);
  }

  if (photoCanvas) photoCanvas.addEventListener("click", handlePhotoCanvasTap);
  if (photoAutoButton) photoAutoButton.addEventListener("click", detectDisplayQuadrilateral);
  if (photoResetButton) photoResetButton.addEventListener("click", beginManualPhotoCorners);
  if (photoUseButton) photoUseButton.addEventListener("click", rectifyPhotoAndScan);
  if (photoSkipButton) photoSkipButton.addEventListener("click", skipPhotoCorrection);
  chooseAnotherButton.addEventListener("click", showPicker);
  resetButton.addEventListener("click", clearDetection);
  detectButton.addEventListener("click", detectTableauShape);
  detailsButton.addEventListener("click", showDetails);
  const clearTemplatesButton = byId("scan-clear-recognition-templates");
  if (clearTemplatesButton) clearTemplatesButton.addEventListener("click", clearRecognitionLibrary);

  const clearRankTemplatesButton = byId("scan-clear-rank-templates");
  if (clearRankTemplatesButton) clearRankTemplatesButton.addEventListener("click", clearRankTemplates);

  const showRecognizedBoardButton = byId("scan-show-recognized-board");
  if (showRecognizedBoardButton) {
    showRecognizedBoardButton.addEventListener("click", () => {
      if (!recognitionCards.length) showDetails();
      else {
        buildRecognizedBoardFromCards();
        renderRecognizedBoard();
        byId("scan-recognized-board-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  const copyRecognizedBoardButton = byId("scan-copy-recognized-board");
  if (copyRecognizedBoardButton) copyRecognizedBoardButton.addEventListener("click", copyRecognizedBoardText);

  const loadRecognizedBoardButton = byId("scan-load-recognized-board");
  if (loadRecognizedBoardButton) loadRecognizedBoardButton.addEventListener("click", loadValidatedBoard);

  const exportTemplatesButton = byId("scan-export-recognition-templates");
  if (exportTemplatesButton) exportTemplatesButton.addEventListener("click", exportRecognitionLibrary);

  const importTemplatesInput = byId("scan-import-recognition-templates");
  if (importTemplatesInput) {
    importTemplatesInput.addEventListener("change", () => {
      const file = importTemplatesInput.files && importTemplatesInput.files[0];
      if (file) importRecognitionLibraryFile(file);
      importTemplatesInput.value = "";
    });
  }

  updateRecognitionLibrarySummary();
  confirmButton.addEventListener("click", confirmShape);
  if (debugSelect) debugSelect.addEventListener("change", renderDebugView);

  window.addEventListener("resize", () => {
    if (detection) drawDetection(detection);
  });

  showPicker();
}());
