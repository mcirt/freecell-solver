(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const openButton = byId("scan-board");
  const dialog = byId("scan-dialog");
  const closeButton = byId("scan-close");
  const chooseAnotherButton = byId("scan-choose-another");
  const resetButton = byId("scan-reset-calibration");
  const detectButton = byId("scan-detect-tops");
  const previewButton = byId("scan-preview-crops");
  const confirmButton = byId("scan-confirm-crops");
  const pictureInput = byId("board-picture-input");
  const pickerPanel = byId("scan-picker-panel");
  const previewPanel = byId("scan-preview-panel");
  const cropPreviewPanel = byId("scan-crop-preview-panel");
  const cropPreviewGrid = byId("scan-crop-preview-grid");
  const image = byId("scan-image");
  const cropsEl = byId("scan-crops");
  const summaryEl = byId("scan-detection-summary");
  const columnCountsEl = byId("scan-column-counts");
  const message = byId("input-message");

  const STORAGE_KEY = "freecellScanCalibrationV7";
  const COLUMN_COUNTS = [7, 7, 7, 7, 6, 6, 6, 6];
  const DEFAULTS = {
    top: 53.7,
    left: 1.0,
    spacing: 12.40,
    rowStep: 5.00,
    cropWidth: 11.0,
    cropHeight: 4.3
  };

  const inputs = {
    top: byId("scan-top"), left: byId("scan-left"), spacing: byId("scan-spacing"),
    rowStep: byId("scan-row"), cropWidth: byId("scan-width"), cropHeight: byId("scan-height")
  };
  const outputs = {
    top: byId("scan-top-value"), left: byId("scan-left-value"), spacing: byId("scan-spacing-value"),
    rowStep: byId("scan-row-value"), cropWidth: byId("scan-width-value"), cropHeight: byId("scan-height-value")
  };

  let selectedFile = null;
  let objectUrl = null;
  let activeReader = null;
  let lastHandledSignature = "";
  let calibration = loadCalibration();
  let detectedRegions = [];
  let sourceCanvas = null;
  let sourceCtx = null;

  function announce(text, kind) {
    if (!message) return;
    message.textContent = text;
    message.className = "input-message" + (kind ? " " + kind : "");
  }

  function setDialogOpen(open) {
    dialog.hidden = !open;
    document.body.classList.toggle("scan-open", open);
    if (open) window.setTimeout(() => pictureInput.focus(), 0);
  }

  function cleanTemporaryResources() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    if (activeReader && activeReader.readyState === FileReader.LOADING) activeReader.abort();
    activeReader = null;
  }

  function loadCalibration() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return saved && typeof saved === "object" ? Object.assign({}, DEFAULTS, saved) : Object.assign({}, DEFAULTS);
    } catch (_error) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveCalibration() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration));
  }

  function showPicker() {
    cleanTemporaryResources();
    selectedFile = null;
    lastHandledSignature = "";
    detectedRegions = [];
    sourceCanvas = null;
    sourceCtx = null;
    image.removeAttribute("src");
    pickerPanel.hidden = false;
    previewPanel.hidden = true;
    cropPreviewPanel.hidden = true;
    cropPreviewGrid.replaceChildren();
    cropsEl.replaceChildren();
    columnCountsEl.replaceChildren();
    pictureInput.value = "";
  }

  function syncControls() {
    Object.keys(inputs).forEach((key) => {
      inputs[key].value = String(calibration[key]);
      outputs[key].textContent = Number(calibration[key]).toFixed(key === "spacing" || key === "rowStep" ? 2 : 1) + "%";
    });
  }

  function readControls() {
    Object.keys(inputs).forEach((key) => { calibration[key] = Number(inputs[key].value); });
  }

  function makeFixedRegions() {
    const regions = [];
    let number = 1;
    COLUMN_COUNTS.forEach((count, column) => {
      for (let row = 0; row < count; row += 1) {
        regions.push({
          number: number++, column, row,
          left: calibration.left + column * calibration.spacing,
          top: calibration.top + row * calibration.rowStep,
          width: calibration.cropWidth,
          height: calibration.cropHeight,
          confidence: 0,
          detected: false
        });
      }
    });
    return regions;
  }

  function ensureSourceCanvas() {
    if (sourceCanvas && sourceCanvas.width === image.naturalWidth && sourceCanvas.height === image.naturalHeight) return;
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = image.naturalWidth;
    sourceCanvas.height = image.naturalHeight;
    sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    sourceCtx.drawImage(image, 0, 0);
  }

  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

  function analyzeCandidate(x, y, w, h) {
    const imgW = sourceCanvas.width;
    const imgH = sourceCanvas.height;
    const sx = clamp(Math.round(x), 0, imgW - 2);
    const sy = clamp(Math.round(y), 1, imgH - 2);

    // Only inspect the upper-left part of the crop. That is where the small
    // rank and suit live; ignoring the large central suit/face artwork keeps
    // the detector from jumping to unrelated high-contrast shapes.
    const sw = clamp(Math.round(w * 0.62), 12, imgW - sx);
    const sh = clamp(Math.round(h * 0.78), 10, imgH - sy);
    if (sw < 8 || sh < 8) return { score: -Infinity, valid: false, whiteRatio: 0, inkRatio: 0 };

    const pixels = sourceCtx.getImageData(sx, sy, sw, sh).data;
    let light = 0;
    let ink = 0;
    let teal = 0;
    let total = 0;
    let minLum = 255;
    let maxLum = 0;
    const sampleStep = Math.max(1, Math.floor(Math.min(sw, sh) / 28));

    for (let py = 0; py < sh; py += sampleStep) {
      for (let px = 0; px < sw; px += sampleStep) {
        const i = (py * sw + px) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        minLum = Math.min(minLum, lum);
        maxLum = Math.max(maxLum, lum);

        const nearlyNeutral = Math.max(r, g, b) - Math.min(r, g, b) < 52;
        if (lum > 164 && nearlyNeutral) light += 1;

        const darkInk = lum < 118 && (b >= r * 0.72 || r < 95);
        const redInk = r > 132 && r > g * 1.25 && r > b * 1.12;
        if (darkInk || redInk) ink += 1;

        // Typical table/background color in this app: green/teal with green
        // and blue clearly stronger than red.
        if (g > r * 1.18 && b > r * 1.08 && g > 75) teal += 1;
        total += 1;
      }
    }

    const lightRatio = light / Math.max(1, total);
    const inkRatio = ink / Math.max(1, total);
    const tealRatio = teal / Math.max(1, total);
    const contrast = (maxLum - minLum) / 255;

    // Compare a thin row just above the candidate with one just inside it.
    // A real card top usually gets brighter as we enter the white card.
    const edgeW = Math.max(10, Math.round(sw * 0.88));
    const aboveY = clamp(sy - 2, 0, imgH - 1);
    const insideY = clamp(sy + Math.max(2, Math.round(sh * 0.10)), 0, imgH - 1);
    const above = sourceCtx.getImageData(sx, aboveY, edgeW, 1).data;
    const inside = sourceCtx.getImageData(sx, insideY, edgeW, 1).data;
    let aboveLum = 0, insideLum = 0;
    for (let i = 0; i < edgeW; i += 1) {
      const j = i * 4;
      aboveLum += above[j] * .299 + above[j + 1] * .587 + above[j + 2] * .114;
      insideLum += inside[j] * .299 + inside[j + 1] * .587 + inside[j + 2] * .114;
    }
    const edgeGain = clamp((insideLum - aboveLum) / edgeW / 80, -1, 1);

    const score =
      lightRatio * 2.15 +
      Math.min(inkRatio, 0.30) * 3.15 +
      contrast * 0.34 +
      Math.max(0, edgeGain) * 0.42 -
      tealRatio * 1.35;

    // Validation is deliberately conservative. A box can still be shown even
    // when invalid, but it will be marked as a warning instead of a false ✓.
    const valid = lightRatio >= 0.28 && inkRatio >= 0.018 && tealRatio <= 0.48;
    return { score, valid, lightRatio, inkRatio, tealRatio };
  }

  function findConstrainedY(xPx, expectedYPx, cropWPx, cropHPx, radiusPx) {
    const imgH = sourceCanvas.height;
    const start = clamp(Math.round(expectedYPx - radiusPx), 0, imgH - 2);
    const end = clamp(Math.round(expectedYPx + radiusPx), 0, imgH - 2);
    const scanStep = Math.max(1, Math.round(imgH / 2600));
    let best = {
      y: clamp(Math.round(expectedYPx), 0, imgH - 2),
      score: -Infinity,
      valid: false,
      lightRatio: 0,
      inkRatio: 0,
      tealRatio: 0
    };

    for (let y = start; y <= end; y += scanStep) {
      const analysis = analyzeCandidate(xPx, y, cropWPx, cropHPx);
      // Add a strong distance penalty so the box can only fine-tune around the
      // calibrated row; it cannot jump to crowns, large suit art, or borders.
      const distancePenalty = Math.abs(y - expectedYPx) / Math.max(1, radiusPx) * 0.42;
      const constrainedScore = analysis.score - distancePenalty;
      if (constrainedScore > best.score) {
        best = Object.assign({ y, score: constrainedScore }, analysis);
      }
    }
    return best;
  }

  function detectCardTops() {
    if (!image.naturalWidth || !image.naturalHeight) return;
    ensureSourceCanvas();
    readControls();

    const imgW = image.naturalWidth;
    const imgH = image.naturalHeight;
    const cropWPx = calibration.cropWidth / 100 * imgW;
    const cropHPx = calibration.cropHeight / 100 * imgH;
    const rowStepPx = calibration.rowStep / 100 * imgH;

    // Maximum correction is intentionally small: approximately ±0.38% of the
    // image height. The calibrated top and uniform row step remain authoritative.
    const fineRadiusPx = Math.max(3, imgH * 0.0038);
    const regions = [];
    const columnResults = [];
    let number = 1;

    COLUMN_COUNTS.forEach((count, column) => {
      const xPct = calibration.left + column * calibration.spacing;
      const xPx = xPct / 100 * imgW;
      const results = [];

      for (let row = 0; row < count; row += 1) {
        const expectedYPx = calibration.top / 100 * imgH + row * rowStepPx;
        const found = findConstrainedY(xPx, expectedYPx, cropWPx, cropHPx, fineRadiusPx);
        results.push(found);
        regions.push({
          number: number++,
          column,
          row,
          left: xPct,
          top: found.y / imgH * 100,
          expectedTop: expectedYPx / imgH * 100,
          width: calibration.cropWidth,
          height: calibration.cropHeight,
          confidence: found.score,
          valid: found.valid,
          lightRatio: found.lightRatio,
          inkRatio: found.inkRatio,
          tealRatio: found.tealRatio,
          detected: true
        });
      }
      columnResults.push(results);
    });

    detectedRegions = regions;
    renderRegions();
    renderColumnCounts(columnResults);
    cropPreviewPanel.hidden = true;

    const validCount = regions.filter((region) => region.valid).length;
    announce(
      "Placed 52 constrained card regions; " + validCount + " currently pass the card-corner check.",
      validCount === 52 ? "success" : ""
    );
  }

  function renderColumnCounts(columnResults) {
    columnCountsEl.replaceChildren();
    COLUMN_COUNTS.forEach((expectedCount, column) => {
      const results = columnResults[column] || [];
      const validCount = results.filter((result) => result.valid).length;
      const item = document.createElement("span");
      item.className = "scan-column-count" + (validCount !== expectedCount ? " scan-column-warning" : "");
      item.textContent = "Column " + (column + 1) + ": " + validCount + "/" + expectedCount + (validCount === expectedCount ? " ✓" : "");
      item.title = "Validated card-corner regions, not merely boxes created.";
      columnCountsEl.appendChild(item);
    });
  }

  function renderRegions() {
    cropsEl.replaceChildren();
    const regions = detectedRegions.length ? detectedRegions : makeFixedRegions();
    regions.forEach((region) => {
      const crop = document.createElement("div");
      crop.className = "scan-crop" + (region.detected ? " scan-crop-detected" : "") + (region.detected && !region.valid ? " scan-crop-invalid" : "");
      crop.style.left = region.left + "%";
      crop.style.top = region.top + "%";
      crop.style.width = region.width + "%";
      crop.style.height = region.height + "%";
      crop.title = "Column " + (region.column + 1) + ", card " + (region.row + 1) + (region.detected ? "; " + (region.valid ? "valid" : "needs adjustment") + "; score " + region.confidence.toFixed(2) : "");
      crop.innerHTML = "<span>" + region.number + "</span>";
      cropsEl.appendChild(crop);
    });
    summaryEl.textContent = (detectedRegions.length ? "52 detected card tops" : "52 expected card regions") + " • 8 columns • screenshot " + image.naturalWidth + " × " + image.naturalHeight;
  }

  function updateCalibration() {
    readControls();
    syncControls();
    detectedRegions = [];
    columnCountsEl.replaceChildren();
    renderRegions();
    cropPreviewPanel.hidden = true;
  }

  function resetCalibration() {
    calibration = Object.assign({}, DEFAULTS);
    syncControls();
    detectedRegions = [];
    columnCountsEl.replaceChildren();
    renderRegions();
    cropPreviewPanel.hidden = true;
  }

  function isProbablyImage(file) {
    return !!file && (!file.type || file.type.startsWith("image/") || /\.(png|jpe?g|heic|heif|webp)$/i.test(file.name || ""));
  }

  function finishImageLoad() {
    sourceCanvas = null;
    sourceCtx = null;
    syncControls();
    pickerPanel.hidden = true;
    previewPanel.hidden = false;
    cropPreviewPanel.hidden = true;
    detectedRegions = [];
    renderRegions();
    announce("Image loaded. Detecting card tops…", "");
    window.setTimeout(detectCardTops, 80);
  }

  function loadWithFileReader(file) {
    activeReader = new FileReader();
    activeReader.onload = function () {
      image.onload = function () { activeReader = null; finishImageLoad(); };
      image.onerror = function () { activeReader = null; announce("The selected image could not be displayed. Try a PNG or JPEG screenshot.", "error"); };
      image.src = String(activeReader.result);
    };
    activeReader.onerror = function () { activeReader = null; announce("That image could not be read.", "error"); };
    activeReader.readAsDataURL(file);
  }

  function showImage(file) {
    if (!isProbablyImage(file)) { announce("Choose a valid screenshot or image file.", "error"); return; }
    cleanTemporaryResources();
    selectedFile = file;
    announce("Loading image…", "");
    objectUrl = URL.createObjectURL(file);
    image.onload = finishImageLoad;
    image.onerror = function () {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      loadWithFileReader(file);
    };
    image.src = objectUrl;
  }

  function handleNativeSelection() {
    const file = pictureInput.files && pictureInput.files[0];
    if (!file) return;
    const signature = [file.name, file.size, file.lastModified].join("|");
    if (signature === lastHandledSignature) return;
    lastHandledSignature = signature;
    showImage(file);
  }

  function renderCropPreview() {
    if (!image.naturalWidth || !image.naturalHeight) return;
    if (!detectedRegions.length) detectCardTops();
    ensureSourceCanvas();
    cropPreviewGrid.replaceChildren();

    detectedRegions.forEach((region) => {
      const sx = Math.round(region.left / 100 * image.naturalWidth);
      const sy = Math.round(region.top / 100 * image.naturalHeight);
      const sw = Math.max(1, Math.round(region.width / 100 * image.naturalWidth));
      const sh = Math.max(1, Math.round(region.height / 100 * image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
      const item = document.createElement("figure");
      item.className = "scan-crop-preview-item";
      const caption = document.createElement("figcaption");
      caption.textContent = "C" + (region.column + 1) + "-" + (region.row + 1);
      item.append(canvas, caption);
      cropPreviewGrid.appendChild(item);
    });
    cropPreviewPanel.hidden = false;
    cropPreviewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function confirmCrops() {
    if (!detectedRegions.length) detectCardTops();
    saveCalibration();
    const scanData = {
      calibration: Object.assign({}, calibration),
      imageName: selectedFile ? selectedFile.name : "board image",
      imageType: selectedFile ? selectedFile.type : "image/*",
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      detectedRegions: detectedRegions.map(({ number, column, row, left, top, width, height, confidence }) => ({ number, column, row, left, top, width, height, confidence })),
      savedAt: new Date().toISOString()
    };
    sessionStorage.setItem("freecellPendingScanV7", JSON.stringify(scanData));
    setDialogOpen(false);
    announce("Card-top positions saved. The 52 detected crops are ready for rank-and-suit recognition.", "success");
  }

  if (!openButton || !dialog || !pictureInput) {
    console.error("FreeCell scanner could not initialize: required page elements are missing.");
    return;
  }

  openButton.addEventListener("click", () => setDialogOpen(true));
  closeButton.addEventListener("click", () => setDialogOpen(false));
  dialog.querySelectorAll("[data-scan-cancel]").forEach((node) => node.addEventListener("click", () => setDialogOpen(false)));
  pictureInput.addEventListener("change", handleNativeSelection);
  pictureInput.addEventListener("input", handleNativeSelection);
  chooseAnotherButton.addEventListener("click", showPicker);
  resetButton.addEventListener("click", resetCalibration);
  detectButton.addEventListener("click", detectCardTops);
  previewButton.addEventListener("click", renderCropPreview);
  confirmButton.addEventListener("click", confirmCrops);
  Object.values(inputs).forEach((input) => input.addEventListener("input", updateCalibration));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !dialog.hidden) setDialogOpen(false); });
  window.addEventListener("beforeunload", cleanTemporaryResources);
}());
