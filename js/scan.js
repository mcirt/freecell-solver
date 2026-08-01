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

  const STORAGE_KEY = "freecellScanCalibrationV9";
  const SESSION_KEY = "freecellPendingScanV9";
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

  function initializeOpenCvStatus() {
    if (!window.freecellCvReady) {
      cvFailure = new Error("OpenCV loader is missing.");
      updateCvStatus("OpenCV unavailable — manual grid fallback active.", "warning");
      return;
    }
    window.freecellCvReady.then(() => {
      cvReady = true;
      updateCvStatus("OpenCV ready — automatic screenshot alignment is available.", "ready");
      detectButton.disabled = false;
    }).catch((error) => {
      cvFailure = error;
      updateCvStatus("OpenCV could not load — manual grid fallback active.", "warning");
      detectButton.disabled = false;
    });
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

  function renderRegions() {
    regionsLayer.replaceChildren();
    regions.forEach((region) => {
      const strip = document.createElement("button");
      strip.type = "button";
      strip.className = "scan-crop scan-labeled-strip " + (region.valid ? "scan-crop-detected" : "scan-crop-invalid");
      strip.dataset.regionId = region.id;
      strip.style.left = `${region.x * 100}%`;
      strip.style.top = `${region.y * 100}%`;
      strip.style.width = `${region.width * 100}%`;
      strip.style.height = `${region.height * 100}%`;
      strip.title = `${region.id} • ${region.valid ? "valid" : "review"} • score ${Number(region.score || 0).toFixed(2)}`;
      strip.innerHTML = `<span>${region.id}</span>`;
      strip.addEventListener("click", () => selectRegion(region.id, "preview"));
      regionsLayer.appendChild(strip);
    });

    const validCount = regions.filter((region) => region.valid).length;
    summaryEl.textContent = `${validCount}/52 valid labeled strips • screenshot ${image.naturalWidth} × ${image.naturalHeight}`;
    columnCountsEl.replaceChildren();
    COLUMN_COUNTS.forEach((count, column) => {
      const found = regions.filter((region) => region.column === column && region.valid).length;
      const item = document.createElement("span");
      item.className = "scan-column-count" + (found === count ? "" : " scan-column-warning");
      item.textContent = `Column ${column + 1}: ${found}/${count} valid`;
      columnCountsEl.appendChild(item);
    });
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

  function autoDetectWithOpenCv() {
    if (!image.naturalWidth || !image.naturalHeight) return;
    if (!cvReady || !window.cv || typeof window.cv.imread !== "function") {
      buildRigidRegions();
      renderRegions();
      announce(cvFailure ? "OpenCV is unavailable, so the calibrated rigid grid was rebuilt." : "OpenCV is still loading. Try again in a moment.", "error");
      return;
    }

    updateCvStatus("OpenCV is analyzing the screenshot…", "working");
    detectButton.disabled = true;
    window.setTimeout(() => {
      let src;
      let rgb;
      let hsv;
      let gray;
      let lightMask;
      let gradY;
      let absGradY;
      try {
        ensureSourceCanvas();
        const cv = window.cv;
        src = cv.imread(sourceCanvas);

        const maxWidth = 900;
        const scale = src.cols > maxWidth ? maxWidth / src.cols : 1;
        if (scale < 1) {
          const resized = new cv.Mat();
          cv.resize(src, resized, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
          src.delete();
          src = resized;
        }

        rgb = new cv.Mat();
        hsv = new cv.Mat();
        gray = new cv.Mat();
        lightMask = new cv.Mat();
        gradY = new cv.Mat();
        absGradY = new cv.Mat();
        cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
        cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
        cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

        // Card faces are bright and relatively low-saturation compared with the teal table.
        const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 125, 0]);
        const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [179, 135, 255, 255]);
        cv.inRange(hsv, low, high, lightMask);
        low.delete();
        high.delete();

        cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
        cv.Sobel(gray, gradY, cv.CV_16S, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT);
        cv.convertScaleAbs(gradY, absGradY);

        const W = src.cols;
        const H = src.rows;
        const widthPx = calibration.cropWidth / 100 * W;
        const heightPx = calibration.cropHeight / 100 * H;

        const laneData = [];
        for (let column = 0; column < 8; column += 1) {
          const x0 = Math.max(0, Math.round((calibration.left + column * calibration.spacing) / 100 * W));
          const x1 = Math.min(W, Math.round(x0 + widthPx * 0.88));
          laneData.push({
            light: sampleMaskRows(lightMask, x0, x1),
            edge: sampleGrayRows(absGradY, x0, x1)
          });
        }

        // Fit one global top and one global row step. This prevents independent boxes from wandering.
        const topMin = 30.0;
        const topMax = 42.0;
        const stepMin = 3.6;
        const stepMax = 5.5;
        let best = { score: -Infinity, top: calibration.top, step: calibration.rowStep };
        for (let top = topMin; top <= topMax; top += 0.12) {
          for (let step = stepMin; step <= stepMax; step += 0.04) {
            let score = 0;
            let valid = 0;
            COLUMN_COUNTS.forEach((count, column) => {
              const lane = laneData[column];
              for (let row = 0; row < count; row += 1) {
                const y = (top + row * step) / 100 * H;
                const check = regionValidation(lane.light, lane.edge, y, heightPx, H);
                score += check.score;
                valid += check.valid ? 1 : 0;
              }
            });
            score += valid * 0.7;
            // Small preference for the previous calibration avoids needless jumps when scores tie.
            score -= Math.abs(top - calibration.top) * 0.02;
            score -= Math.abs(step - calibration.rowStep) * 0.05;
            if (score > best.score) best = { score, top, step };
          }
        }

        calibration.top = Number(best.top.toFixed(2));
        calibration.rowStep = Number(best.step.toFixed(2));
        syncControls();

        const detected = [];
        COLUMN_COUNTS.forEach((count, column) => {
          const lane = laneData[column];
          for (let row = 0; row < count; row += 1) {
            const yNorm = (calibration.top + row * calibration.rowStep) / 100;
            const yPx = yNorm * H;
            const check = regionValidation(lane.light, lane.edge, yPx, heightPx, H);
            detected.push({
              id: `C${column + 1}-${row + 1}`,
              column,
              row,
              x: (calibration.left + column * calibration.spacing) / 100,
              y: yNorm,
              width: calibration.cropWidth / 100,
              height: calibration.cropHeight / 100,
              valid: check.valid,
              score: check.score,
              method: "opencv-global-grid"
            });
          }
        });
        regions = detected;
        renderRegions();
        cropPreviewPanel.hidden = true;
        saveCalibration();
        const validCount = regions.filter((region) => region.valid).length;
        updateCvStatus(`OpenCV fitted a rigid grid: top ${calibration.top.toFixed(2)}%, row step ${calibration.rowStep.toFixed(2)}%.`, validCount === 52 ? "ready" : "warning");
        announce(`OpenCV aligned the grid and validated ${validCount} of 52 strips.`, validCount === 52 ? "success" : "");
      } catch (error) {
        console.error(error);
        buildRigidRegions();
        renderRegions();
        updateCvStatus("OpenCV analysis failed — calibrated rigid grid shown instead.", "warning");
        announce("OpenCV could not analyze this image. The manual calibration grid remains available.", "error");
      } finally {
        [src, rgb, hsv, gray, lightMask, gradY, absGradY].forEach((mat) => {
          if (mat && typeof mat.delete === "function") mat.delete();
        });
        detectButton.disabled = false;
      }
    }, 30);
  }

  function rebuildManualGrid() {
    if (!image.naturalWidth || !image.naturalHeight) return;
    readControls();
    buildRigidRegions();
    renderRegions();
    cropPreviewPanel.hidden = true;
    selectedRegionId = "";
    announce("Rebuilt the rigid labeled-strip grid from the calibration controls.", "success");
  }

  function updateCalibration() {
    readControls();
    syncControls();
    rebuildManualGrid();
  }

  function resetCalibration() {
    calibration = Object.assign({}, DEFAULTS);
    syncControls();
    if (cvReady) autoDetectWithOpenCv();
    else rebuildManualGrid();
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
    buildRigidRegions();
    renderRegions();
    announce("Screenshot loaded. OpenCV will fit one constrained grid to the card-header edges.", "success");
    if (cvReady) autoDetectWithOpenCv();
    else updateCvStatus("OpenCV is still loading. The calibrated grid is shown for now.", "working");
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
    if (!image.naturalWidth || !image.naturalHeight) return;
    if (!regions.length) buildRigidRegions();
    cropPreviewGrid.replaceChildren();
    regions.forEach((region) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "scan-crop-preview-item scan-crop-preview-button" + (region.valid ? "" : " scan-preview-invalid");
      item.dataset.regionId = region.id;
      item.appendChild(cropRegionToCanvas(region));
      const caption = document.createElement("span");
      caption.className = "scan-crop-preview-caption";
      caption.textContent = region.id + (region.valid ? "" : " • review");
      item.appendChild(caption);
      item.addEventListener("click", () => selectRegion(region.id, "overlay"));
      cropPreviewGrid.appendChild(item);
    });
    cropPreviewPanel.hidden = false;
    cropPreviewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    if (selectedRegionId) selectRegion(selectedRegionId, "preview");
  }

  function confirmCrops() {
    if (!regions.length) buildRigidRegions();
    saveCalibration();
    const validCount = regions.filter((region) => region.valid).length;
    const scanData = {
      version: 9,
      detector: cvReady ? "opencv-global-grid" : "manual-rigid-grid",
      calibration: Object.assign({}, calibration),
      imageName: selectedFile ? selectedFile.name : "board screenshot",
      imageType: selectedFile ? selectedFile.type : "image/*",
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      regions: regions.map((region) => Object.assign({}, region)),
      validCount,
      savedAt: new Date().toISOString()
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(scanData));
    setDialogOpen(false);
    announce(`Saved ${validCount}/52 labeled strips for the recognition stage.`, validCount === 52 ? "success" : "");
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
