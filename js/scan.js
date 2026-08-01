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
  const SESSION_KEY = "freecellPendingScanV10";
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

  function runOpenCvProofTest() {
    if (!image.naturalWidth || !image.naturalHeight) {
      announce("Choose a screenshot before running the OpenCV test.", "error");
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

    updateCvStatus("Image loaded. Running OpenCV grayscale test…", "working");
    detectButton.disabled = true;
    window.setTimeout(() => {
      let src;
      let gray;
      try {
        ensureSourceCanvas();
        const cv = window.cv;
        src = cv.imread(sourceCanvas);
        gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        if (gray.cols !== image.naturalWidth || gray.rows !== image.naturalHeight) {
          throw new Error("OpenCV returned unexpected image dimensions.");
        }
        updateCvStatus(`OpenCV test passed — processed ${gray.cols} × ${gray.rows} pixels in grayscale.`, "ready");
        announce("OpenCV loaded and successfully processed the screenshot. The cyan boxes below are the calibration preview, not automatic detection yet.", "success");
      } catch (error) {
        console.error(error);
        updateCvStatus("OpenCV loaded, but the screenshot processing test failed.", "warning");
        announce("OpenCV could not process this screenshot. Try choosing it again or use a PNG/JPEG copy.", "error");
      } finally {
        [src, gray].forEach((mat) => {
          if (mat && typeof mat.delete === "function") mat.delete();
        });
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
    buildRigidRegions();
    renderRegions();
    cropPreviewPanel.hidden = true;
    selectedRegionId = "";
    announce("Rebuilt the clean calibration grid from the calibration controls.", "success");
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
    buildRigidRegions();
    renderRegions();
    announce("Screenshot loaded. The clean cyan grid is the calibration preview.", "success");
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
    if (!regions.length) buildRigidRegions();
    saveCalibration();
    const validCount = regions.filter((region) => region.valid).length;
    const scanData = {
      version: 10,
      detector: cvReady ? "opencv-proof-plus-manual-grid" : "manual-rigid-grid",
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
    announce(`Saved ${validCount}/52 internal card-strip regions for the recognition stage.`, validCount === 52 ? "success" : "");
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
