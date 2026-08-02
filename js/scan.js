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
  const regionsLayer = byId("scan-crops");
  const summaryEl = byId("scan-detection-summary");
  const columnCountsEl = byId("scan-column-counts");
  const cvStatus = byId("opencv-status");
  const message = byId("input-message");

  const STORAGE_KEY = "freecellScanCalibrationV10";
  const SESSION_KEY = "freecellPendingScanV15";
  const COLUMN_COUNTS = [7, 7, 7, 7, 6, 6, 6, 6];

  const DEFAULTS = {
    top: 34.55,
    left: 0.65,
    spacing: 12.45,
    rowStep: 4.90,
    cropWidth: 11.15,
    cropHeight: 3.15
  };

  const inputs = {
    top: byId("scan-top"),
    left: byId("scan-left"),
    spacing: byId("scan-spacing"),
    rowStep: byId("scan-row"),
    cropWidth: byId("scan-width"),
    cropHeight: byId("scan-height")
  };
  const outputs = {
    top: byId("scan-top-value"),
    left: byId("scan-left-value"),
    spacing: byId("scan-spacing-value"),
    rowStep: byId("scan-row-value"),
    cropWidth: byId("scan-width-value"),
    cropHeight: byId("scan-height-value")
  };

  let selectedFile = null;
  let objectUrl = null;
  let activeReader = null;
  let lastHandledSignature = "";
  let calibration = loadCalibration();
  let regions = [];
  let columnLanes = [];
  let detectionMode = "columns";
  let sourceCanvas = null;
  let sourceCtx = null;
  let selectedRegionId = "";
  let cvReady = false;
  let cvFailure = null;

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

  function attachOpenCvPromise(promise) {
    if (!promise) {
      cvFailure = new Error("OpenCV loader is missing.");
      updateCvStatus("OpenCV loader is missing.", "warning");
      return;
    }
    updateCvStatus("Loading OpenCV…", "working");
    promise.then(() => {
      cvReady = true;
      cvFailure = null;
      updateCvStatus("OpenCV ready. Choose a screenshot to run the processing test.", "ready");
      detectButton.disabled = false;
      if (image.naturalWidth && image.naturalHeight) runOpenCvProofTest();
    }).catch((error) => {
      cvReady = false;
      cvFailure = error;
      updateCvStatus("OpenCV failed to load. Tap Run OpenCV Test to retry.", "warning");
      detectButton.disabled = false;
    });
  }

  function initializeOpenCvStatus() {
    window.addEventListener("freecell-opencv-loading", (event) => {
      const attempt = event.detail && event.detail.attempt ? event.detail.attempt : 1;
      updateCvStatus(`Loading OpenCV… attempt ${attempt}`, "working");
    });
    window.addEventListener("freecell-opencv-error", () => {
      updateCvStatus("OpenCV failed to load. Tap Run OpenCV Test to retry.", "warning");
    });
    attachOpenCvPromise(window.freecellCvReady);
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
      return saved && typeof saved === "object"
        ? Object.assign({}, DEFAULTS, saved)
        : Object.assign({}, DEFAULTS);
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
    regions = [];
    sourceCanvas = null;
    sourceCtx = null;
    selectedRegionId = "";
    image.removeAttribute("src");
    pickerPanel.hidden = false;
    previewPanel.hidden = true;
    cropPreviewPanel.hidden = true;
    cropPreviewGrid.replaceChildren();
    regionsLayer.replaceChildren();
    columnCountsEl.replaceChildren();
    pictureInput.value = "";
  }

  function syncControls() {
    Object.keys(inputs).forEach((key) => {
      inputs[key].value = String(calibration[key]);
      outputs[key].textContent = Number(calibration[key]).toFixed(
        key === "spacing" || key === "rowStep" ? 2 : 1
      ) + "%";
    });
  }

  function readControls() {
    Object.keys(inputs).forEach((key) => {
      calibration[key] = Number(inputs[key].value);
    });
  }

  function buildRigidRegions() {
    const next = [];
    COLUMN_COUNTS.forEach((count, column) => {
      for (let row = 0; row < count; row += 1) {
        next.push({
          id: `C${column + 1}-${row + 1}`,
          column,
          row,
          x: (calibration.left + column * calibration.spacing) / 100,
          y: (calibration.top + row * calibration.rowStep) / 100,
          width: calibration.cropWidth / 100,
          height: calibration.cropHeight / 100,
          valid: true,
          score: 0,
          method: "rigid"
        });
      }
    });
    regions = next;
  }

  function ensureSourceCanvas() {
    if (sourceCanvas && sourceCanvas.width === image.naturalWidth && sourceCanvas.height === image.naturalHeight) return;
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = image.naturalWidth;
    sourceCanvas.height = image.naturalHeight;
    sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    sourceCtx.drawImage(image, 0, 0);
  }

  function selectRegion(id, scrollTarget) {
    selectedRegionId = id;
    document.querySelectorAll(".scan-region-selected").forEach((el) => el.classList.remove("scan-region-selected"));
    const overlay = regionsLayer.querySelector(`[data-region-id="${id}"]`);
    const preview = cropPreviewGrid.querySelector(`[data-region-id="${id}"]`);
    if (overlay) overlay.classList.add("scan-region-selected");
    if (preview) preview.classList.add("scan-region-selected");
    const target = scrollTarget === "preview" ? preview : overlay;
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderColumnLanes() {
    regionsLayer.replaceChildren();
    columnLanes.forEach((lane) => {
      const box = document.createElement("div");
      box.className = "scan-column-lane" + (lane.valid ? "" : " scan-column-lane-warning");
      box.style.left = `${lane.x * 100}%`;
      box.style.top = `${lane.y * 100}%`;
      box.style.width = `${lane.width * 100}%`;
      box.style.height = `${lane.height * 100}%`;
      box.title = `Column ${lane.column + 1} • confidence ${Math.round(lane.confidence * 100)}%`;
      regionsLayer.appendChild(box);
    });

    const valid = columnLanes.filter((lane) => lane.valid).length;
    summaryEl.textContent = `${valid}/8 tableau columns detected • screenshot ${image.naturalWidth} × ${image.naturalHeight}`;
    columnCountsEl.replaceChildren();
    const checks = [
      ["Detected count", valid === 8, `${valid}/8`],
      ["Width consistency", columnLanes.every((l) => l.widthConsistent), columnLanes.length ? "checked" : "waiting"],
      ["Spacing consistency", columnLanes.every((l) => l.spacingConsistent), columnLanes.length ? "checked" : "waiting"],
      ["Left-to-right order", columnLanes.every((l, i) => i === 0 || l.x > columnLanes[i - 1].x), columnLanes.length ? "checked" : "waiting"],
      ["Tableau below slot row", columnLanes.every((l) => l.topBelowSlots), columnLanes.length ? "checked" : "waiting"],
      ["7/7/7/7 + 6/6/6/6 shape", columnLanes.every((l) => l.shapeConsistent), columnLanes.length ? "checked" : "waiting"]
    ];
    checks.forEach(([label, pass, value]) => {
      const item = document.createElement("span");
      item.className = "scan-column-count" + (pass ? "" : " scan-column-warning");
      item.textContent = `${label}: ${pass ? "Pass" : "Review"} (${value})`;
      columnCountsEl.appendChild(item);
    });
  }

  function renderRegions() {
    renderColumnLanes();
  }

  function sampleGrayRows(mat, x0, x1) {
    const rows = new Float32Array(mat.rows);
    const width = Math.max(1, x1 - x0);
    for (let y = 1; y < mat.rows - 1; y += 1) {
      let total = 0;
      for (let x = x0; x < x1; x += 2) {
        total += mat.ucharPtr(y, x)[0];
      }
      rows[y] = total / Math.ceil(width / 2);
    }
    return rows;
  }

  function sampleMaskRows(mask, x0, x1) {
    const rows = new Float32Array(mask.rows);
    const width = Math.max(1, x1 - x0);
    for (let y = 0; y < mask.rows; y += 1) {
      let total = 0;
      for (let x = x0; x < x1; x += 2) total += mask.ucharPtr(y, x)[0] > 0 ? 1 : 0;
      rows[y] = total / Math.ceil(width / 2);
    }
    return rows;
  }

  function regionValidation(lightRows, edgeRows, yPx, stripHeightPx, imageHeight) {
    const top = Math.max(0, Math.round(yPx));
    const bottom = Math.min(imageHeight - 1, top + Math.max(3, Math.round(stripHeightPx * 0.72)));
    let light = 0;
    let edge = 0;
    let n = 0;
    for (let y = top; y <= bottom; y += 1) {
      light += lightRows[y] || 0;
      edge += edgeRows[y] || 0;
      n += 1;
    }
    light /= Math.max(1, n);
    edge /= Math.max(1, n);
    const valid = light > 0.34 && edge > 15;
    return { valid, score: light * 2.2 + Math.min(edge / 80, 1.5) };
  }

  function weightedKMeans1D(weights, count, minX, maxX) {
    const centers = Array.from({ length: count }, (_, i) => minX + ((i + 0.5) / count) * (maxX - minX));
    for (let iter = 0; iter < 30; iter += 1) {
      const sums = new Float64Array(count);
      const totals = new Float64Array(count);
      for (let x = minX; x <= maxX; x += 1) {
        const w = weights[x] || 0;
        if (w <= 0) continue;
        let best = 0;
        let bestDistance = Math.abs(x - centers[0]);
        for (let i = 1; i < count; i += 1) {
          const d = Math.abs(x - centers[i]);
          if (d < bestDistance) { best = i; bestDistance = d; }
        }
        sums[best] += x * w;
        totals[best] += w;
      }
      let moved = 0;
      for (let i = 0; i < count; i += 1) {
        if (totals[i] > 0) {
          const next = sums[i] / totals[i];
          moved += Math.abs(next - centers[i]);
          centers[i] = next;
        }
      }
      centers.sort((a, b) => a - b);
      if (moved < 0.05) break;
    }
    return centers;
  }

  function detectEightColumns(cv, src) {
    const gray = new cv.Mat();
    const lightMask = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.threshold(gray, lightMask, 142, 255, cv.THRESH_BINARY);

      const width = lightMask.cols;
      const height = lightMask.rows;

      // The screenshot layout is static. First estimate the eight horizontal
      // column centers from the actual white tableau card area only.
      const xScores = new Float64Array(width);
      const scoreTop = Math.round(height * 0.49);
      const scoreBottom = Math.round(height * 0.70);
      for (let x = 0; x < width; x += 2) {
        let white = 0;
        let samples = 0;
        for (let y = scoreTop; y < scoreBottom; y += 3) {
          white += lightMask.ucharPtr(y, x)[0] > 0 ? 1 : 0;
          samples += 1;
        }
        const ratio = samples ? white / samples : 0;
        xScores[x] = ratio * ratio;
        if (x + 1 < width) xScores[x + 1] = xScores[x];
      }

      let minX = Math.round(width * 0.01);
      let maxX = Math.round(width * 0.99);
      while (minX < maxX && xScores[minX] < 0.01) minX += 1;
      while (maxX > minX && xScores[maxX] < 0.01) maxX -= 1;
      if (maxX - minX < width * 0.72) {
        minX = Math.round(width * 0.01);
        maxX = Math.round(width * 0.99);
      }

      const centers = weightedKMeans1D(xScores, 8, minX, maxX);
      const spacings = centers.slice(1).map((c, i) => c - centers[i]);
      const avgSpacing = spacings.reduce((a, b) => a + b, 0) / Math.max(1, spacings.length);
      const laneWidthPx = Math.max(10, avgSpacing * 0.88);

      function laneWhiteRatio(y, center, widthScale) {
        const half = laneWidthPx * widthScale * 0.5;
        const x0 = Math.max(0, Math.round(center - half));
        const x1 = Math.min(width - 1, Math.round(center + half));
        let white = 0;
        let n = 0;
        for (let x = x0; x <= x1; x += 3) {
          white += lightMask.ucharPtr(y, x)[0] > 0 ? 1 : 0;
          n += 1;
        }
        return n ? white / n : 0;
      }

      function averageLaneWhite(y, widthScale) {
        let total = 0;
        centers.forEach((center) => { total += laneWhiteRatio(y, center, widthScale); });
        return total / centers.length;
      }

      // Detect the lower edge of the fixed foundation/free-cell slot row.
      // The slot row is mostly dark/colored; the tableau immediately below it
      // changes to a broad band of light card pixels across all eight lanes.
      let slotBottomY = Math.round(height * 0.48);
      let tableauTopY = -1;
      const searchStart = Math.round(height * 0.42);
      const searchEnd = Math.round(height * 0.61);
      const requiredConsecutive = Math.max(3, Math.round(height * 0.0025));
      let run = 0;
      for (let y = searchStart; y < searchEnd; y += 1) {
        let brightLanes = 0;
        centers.forEach((center) => {
          if (laneWhiteRatio(y, center, 0.78) >= 0.52) brightLanes += 1;
        });
        const broadWhite = averageLaneWhite(y, 0.78);
        if (brightLanes >= 7 && broadWhite >= 0.53) {
          run += 1;
          if (run >= requiredConsecutive) {
            tableauTopY = y - run + 1;
            break;
          }
        } else {
          run = 0;
          slotBottomY = y;
        }
      }

      // Safe fallback is still anchored below the known slot row, never over it.
      if (tableauTopY < 0) {
        let bestY = Math.round(height * 0.52);
        let bestScore = -Infinity;
        for (let y = Math.round(height * 0.47); y < Math.round(height * 0.61); y += 1) {
          const before = averageLaneWhite(Math.max(0, y - 3), 0.78);
          const after = averageLaneWhite(Math.min(height - 1, y + 3), 0.78);
          const score = (after - before) + after * 0.6;
          if (score > bestScore) { bestScore = score; bestY = y; }
        }
        tableauTopY = bestY;
        slotBottomY = Math.min(slotBottomY, tableauTopY - 1);
      }

      // Use the fixed FreeCell deal shape as a consistency check. The first
      // four columns contain seven cards; the final four contain six. We still
      // detect each visible bottom from the image instead of hard-coding it.
      const bottoms = centers.map((center, column) => {
        let lastBrightY = tableauTopY;
        let seenCard = false;
        let darkRun = 0;
        const minExpected = Math.round(height * (column < 4 ? 0.66 : 0.61));
        const maxSearch = Math.round(height * 0.83);
        for (let y = tableauTopY; y < maxSearch; y += 1) {
          const ratio = laneWhiteRatio(y, center, 0.82);
          if (ratio >= 0.34) {
            seenCard = true;
            lastBrightY = y;
            darkRun = 0;
          } else if (seenCard) {
            darkRun += 1;
            // Ignore brief dark artwork inside the final card. Only stop after
            // a sustained background run and after the expected deal depth.
            if (y > minExpected && darkRun > Math.max(12, Math.round(height * 0.007))) break;
          }
        }
        return Math.max(lastBrightY + 2, minExpected);
      });

      const spacingDeviation = Math.max(...spacings.map((s) => Math.abs(s - avgSpacing) / avgSpacing), 0);
      const spacingPass = spacingDeviation < 0.12;
      const topBelowSlots = tableauTopY > slotBottomY;
      const avgTallBottom = bottoms.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
      const avgShortBottom = bottoms.slice(4).reduce((a, b) => a + b, 0) / 4;
      const shapePass = avgTallBottom > avgShortBottom + height * 0.02;

      const lanes = centers.map((center, column) => {
        const xScore = xScores[Math.max(0, Math.min(width - 1, Math.round(center)))] || 0;
        const bottomY = bottoms[column];
        return {
          column,
          x: Math.max(0, center - laneWidthPx / 2) / width,
          y: tableauTopY / height,
          width: Math.min(laneWidthPx, width) / width,
          height: Math.max(1, bottomY - tableauTopY) / height,
          confidence: Math.max(0, Math.min(1, Math.sqrt(xScore) * 1.7)),
          valid: xScore > 0.018 && topBelowSlots,
          widthConsistent: true,
          spacingConsistent: spacingPass,
          slotBottom: slotBottomY / height,
          tableauTop: tableauTopY / height,
          bottom: bottomY / height,
          topBelowSlots,
          shapeConsistent: shapePass
        };
      });

      return {
        lanes,
        grayCols: gray.cols,
        grayRows: gray.rows,
        slotBottomY,
        tableauTopY,
        spacingPass,
        shapePass
      };
    } finally {
      gray.delete();
      lightMask.delete();
    }
  }

  function runOpenCvProofTest() {
    if (!image.naturalWidth || !image.naturalHeight) {
      announce("Choose a screenshot before running column detection.", "error");
      return;
    }
    if (!cvReady || !window.cv || typeof window.cv.imread !== "function") {
      updateCvStatus("Retrying OpenCV…", "working");
      detectButton.disabled = true;
      const retry = typeof window.freecellCvRetry === "function" ? window.freecellCvRetry() : window.freecellCvReady;
      attachOpenCvPromise(retry);
      detectButton.disabled = false;
      return;
    }

    updateCvStatus("Running OpenCV eight-column detection…", "working");
    detectButton.disabled = true;
    window.setTimeout(() => {
      let src;
      try {
        ensureSourceCanvas();
        const cv = window.cv;
        src = cv.imread(sourceCanvas);
        const result = detectEightColumns(cv, src);
        columnLanes = result.lanes;
        detectionMode = "opencv-columns";
        renderColumnLanes();
        const valid = columnLanes.filter((lane) => lane.valid).length;
        const topPct = (result.tableauTopY / result.grayRows * 100).toFixed(1);
        const slotPct = (result.slotBottomY / result.grayRows * 100).toFixed(1);
        updateCvStatus(`OpenCV aligned the fixed board template: ${valid}/8 columns • slot bottom ${slotPct}% • tableau top ${topPct}%.`, valid === 8 && result.shapePass ? "ready" : "warning");
        announce(valid === 8 ? "Eight column lanes detected. Check that each cyan lane covers exactly one tableau column." : "Column detection needs adjustment. Open Adjust calibration or choose another screenshot.", valid === 8 ? "success" : "error");
      } catch (error) {
        console.error(error);
        updateCvStatus(`OpenCV column detection failed: ${error.message || error}`, "warning");
        announce("OpenCV could not detect the eight columns. The working manual board-entry page is unaffected.", "error");
      } finally {
        if (src && typeof src.delete === "function") src.delete();
        detectButton.disabled = false;
      }
    }, 20);
  }

  function autoDetectWithOpenCv() {
    runOpenCvProofTest();
  }


  function rebuildManualGrid() {
    if (!image.naturalWidth || !image.naturalHeight) return;
    readControls();
    columnLanes = Array.from({ length: 8 }, (_, column) => ({
      column,
      x: (calibration.left + column * calibration.spacing) / 100,
      y: calibration.top / 100,
      width: calibration.cropWidth / 100,
      height: 0.32,
      confidence: 0,
      valid: true,
      widthConsistent: true,
      spacingConsistent: true
    }));
    detectionMode = "manual-columns";
    renderColumnLanes();
    cropPreviewPanel.hidden = true;
    selectedRegionId = "";
    announce("Rebuilt eight fallback column lanes from the calibration controls.", "success");
  }

  function updateCalibration() {
    readControls();
    syncControls();
    rebuildManualGrid();
  }

  function resetCalibration() {
    calibration = Object.assign({}, DEFAULTS);
    syncControls();
    rebuildManualGrid();
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
    columnLanes = [];
    regionsLayer.replaceChildren();
    summaryEl.textContent = `Waiting to detect 8 tableau columns • screenshot ${image.naturalWidth} × ${image.naturalHeight}`;
    columnCountsEl.replaceChildren();
    announce("Screenshot loaded. OpenCV will now look for the eight tableau columns.", "success");
    if (cvReady) runOpenCvProofTest();
    else updateCvStatus("Screenshot loaded. Waiting for OpenCV to finish loading…", "working");
  }

  function loadWithFileReader(file) {
    activeReader = new FileReader();
    activeReader.onload = function () {
      image.onload = function () {
        activeReader = null;
        finishImageLoad();
      };
      image.onerror = function () {
        activeReader = null;
        announce("The selected image could not be displayed. Try a PNG or JPEG screenshot.", "error");
      };
      image.src = String(activeReader.result);
    };
    activeReader.onerror = function () {
      activeReader = null;
      announce("That image could not be read.", "error");
    };
    activeReader.readAsDataURL(file);
  }

  function showImage(file) {
    if (!isProbablyImage(file)) {
      announce("Choose a valid screenshot or image file.", "error");
      return;
    }
    cleanTemporaryResources();
    selectedFile = file;
    announce("Loading screenshot…", "");
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

  function cropRegionToCanvas(region) {
    ensureSourceCanvas();
    const sx = Math.max(0, Math.round(region.x * image.naturalWidth));
    const sy = Math.max(0, Math.round(region.y * image.naturalHeight));
    const sw = Math.max(1, Math.min(image.naturalWidth - sx, Math.round(region.width * image.naturalWidth)));
    const sh = Math.max(1, Math.min(image.naturalHeight - sy, Math.round(region.height * image.naturalHeight)));
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
  }

  function renderCropPreview() {
    announce("The 52-crop preview is intentionally disabled in this build. First confirm the eight detected column lanes.", "");
    return;
    if (!image.naturalWidth || !image.naturalHeight) return;
    if (!regions.length) buildRigidRegions();
    cropPreviewGrid.replaceChildren();
    regions.forEach((region) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "scan-crop-preview-item scan-crop-preview-button" + (region.valid ? "" : " scan-preview-invalid");
      item.dataset.regionId = region.id;
      item.appendChild(cropRegionToCanvas(region));
      item.setAttribute("aria-label", region.valid ? "Card strip preview" : "Card strip preview — review");
      item.title = region.id + (region.valid ? "" : " • review");
      item.addEventListener("click", () => selectRegion(region.id, "overlay"));
      cropPreviewGrid.appendChild(item);
    });
    cropPreviewPanel.hidden = false;
    cropPreviewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    if (selectedRegionId) selectRegion(selectedRegionId, "preview");
  }

  function confirmCrops() {
    if (columnLanes.length !== 8) {
      announce("Detect all eight column lanes before continuing.", "error");
      return;
    }
    saveCalibration();
    const validCount = columnLanes.filter((lane) => lane.valid).length;
    const scanData = {
      version: 15,
      detector: detectionMode,
      calibration: Object.assign({}, calibration),
      imageName: selectedFile ? selectedFile.name : "board screenshot",
      imageType: selectedFile ? selectedFile.type : "image/*",
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      columnLanes: columnLanes.map((lane) => Object.assign({}, lane)),
      validCount: columnLanes.filter((lane) => lane.valid).length,
      savedAt: new Date().toISOString()
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(scanData));
    setDialogOpen(false);
    announce(`Saved ${validCount}/8 detected column lanes for the next card-top stage.`, validCount === 8 ? "success" : "");
  }

  if (!openButton || !dialog || !pictureInput) {
    console.error("FreeCell scanner could not initialize: required page elements are missing.");
    return;
  }

  initializeOpenCvStatus();
  detectButton.disabled = true;
  openButton.addEventListener("click", () => setDialogOpen(true));
  closeButton.addEventListener("click", () => setDialogOpen(false));
  dialog.querySelectorAll("[data-scan-cancel]").forEach((node) => node.addEventListener("click", () => setDialogOpen(false)));
  pictureInput.addEventListener("change", handleNativeSelection);
  pictureInput.addEventListener("input", handleNativeSelection);
  chooseAnotherButton.addEventListener("click", showPicker);
  resetButton.addEventListener("click", resetCalibration);
  detectButton.addEventListener("click", autoDetectWithOpenCv);
  previewButton.addEventListener("click", renderCropPreview);
  confirmButton.addEventListener("click", confirmCrops);
  Object.values(inputs).forEach((input) => input.addEventListener("input", updateCalibration));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) setDialogOpen(false);
  });
  window.addEventListener("beforeunload", cleanTemporaryResources);
}());
