(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const openButton = byId("scan-board");
  const dialog = byId("scan-dialog");
  const closeButton = byId("scan-close");
  const chooseAnotherButton = byId("scan-choose-another");
  const resetButton = byId("scan-reset-calibration");
  const rebuildButton = byId("scan-detect-tops");
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
  const message = byId("input-message");

  const STORAGE_KEY = "freecellScanCalibrationV8";
  const SESSION_KEY = "freecellPendingScanV8";
  const COLUMN_COUNTS = [7, 7, 7, 7, 6, 6, 6, 6];

  // These values describe the game screenshot as percentages of the original
  // image. The card regions are deliberately shallow strips: only the exposed
  // rank-and-suit header, including on the final fully visible card.
  const DEFAULTS = {
    top: 53.7,
    left: 1.0,
    spacing: 12.40,
    rowStep: 5.00,
    cropWidth: 11.0,
    cropHeight: 3.25
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

  // One authoritative region list, stored in normalized source-image
  // coordinates (0 to 1). The overlay and cropper both consume these same
  // objects, so C1-1 on screen and C1-1 in the preview cannot diverge.
  function buildRegions() {
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
          height: calibration.cropHeight / 100
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
    document.querySelectorAll(".scan-region-selected").forEach((el) => {
      el.classList.remove("scan-region-selected");
    });
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
      strip.className = "scan-crop scan-labeled-strip";
      strip.dataset.regionId = region.id;
      strip.style.left = `${region.x * 100}%`;
      strip.style.top = `${region.y * 100}%`;
      strip.style.width = `${region.width * 100}%`;
      strip.style.height = `${region.height * 100}%`;
      strip.title = `${region.id}: Column ${region.column + 1}, card ${region.row + 1}`;
      strip.innerHTML = `<span>${region.id}</span>`;
      strip.addEventListener("click", () => selectRegion(region.id, "preview"));
      regionsLayer.appendChild(strip);
    });

    summaryEl.textContent = `52 labeled rank-and-suit strips • 8 columns • screenshot ${image.naturalWidth} × ${image.naturalHeight}`;
    columnCountsEl.replaceChildren();
    COLUMN_COUNTS.forEach((count, column) => {
      const item = document.createElement("span");
      item.className = "scan-column-count";
      item.textContent = `Column ${column + 1}: ${count} labeled strips`;
      columnCountsEl.appendChild(item);
    });
  }

  function rebuildLabeledStrips() {
    if (!image.naturalWidth || !image.naturalHeight) return;
    readControls();
    buildRegions();
    renderRegions();
    cropPreviewPanel.hidden = true;
    selectedRegionId = "";
    announce("Rebuilt 52 labeled rank-and-suit strips from one shared coordinate map.", "success");
  }

  function updateCalibration() {
    readControls();
    syncControls();
    rebuildLabeledStrips();
  }

  function resetCalibration() {
    calibration = Object.assign({}, DEFAULTS);
    syncControls();
    rebuildLabeledStrips();
  }

  function isProbablyImage(file) {
    return !!file && (
      !file.type ||
      file.type.startsWith("image/") ||
      /\.(png|jpe?g|heic|heif|webp)$/i.test(file.name || "")
    );
  }

  function finishImageLoad() {
    sourceCanvas = null;
    sourceCtx = null;
    syncControls();
    pickerPanel.hidden = true;
    previewPanel.hidden = false;
    cropPreviewPanel.hidden = true;
    buildRegions();
    renderRegions();
    announce("Image loaded. Review the labeled card-top strips, then preview the matching crops.", "success");
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
    if (!regions.length) buildRegions();
    cropPreviewGrid.replaceChildren();

    regions.forEach((region) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "scan-crop-preview-item scan-crop-preview-button";
      item.dataset.regionId = region.id;
      item.appendChild(cropRegionToCanvas(region));
      const caption = document.createElement("span");
      caption.className = "scan-crop-preview-caption";
      caption.textContent = region.id;
      item.appendChild(caption);
      item.addEventListener("click", () => selectRegion(region.id, "overlay"));
      cropPreviewGrid.appendChild(item);
    });

    cropPreviewPanel.hidden = false;
    cropPreviewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    if (selectedRegionId) selectRegion(selectedRegionId, "preview");
  }

  function confirmCrops() {
    if (!regions.length) buildRegions();
    saveCalibration();
    const scanData = {
      version: 8,
      calibration: Object.assign({}, calibration),
      imageName: selectedFile ? selectedFile.name : "board image",
      imageType: selectedFile ? selectedFile.type : "image/*",
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      regions: regions.map((region) => Object.assign({}, region)),
      savedAt: new Date().toISOString()
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(scanData));
    setDialogOpen(false);
    announce("The 52 labeled rank-and-suit strips were saved for the recognition stage.", "success");
  }

  if (!openButton || !dialog || !pictureInput) {
    console.error("FreeCell scanner could not initialize: required page elements are missing.");
    return;
  }

  openButton.addEventListener("click", () => setDialogOpen(true));
  closeButton.addEventListener("click", () => setDialogOpen(false));
  dialog.querySelectorAll("[data-scan-cancel]").forEach((node) => {
    node.addEventListener("click", () => setDialogOpen(false));
  });
  pictureInput.addEventListener("change", handleNativeSelection);
  pictureInput.addEventListener("input", handleNativeSelection);
  chooseAnotherButton.addEventListener("click", showPicker);
  resetButton.addEventListener("click", resetCalibration);
  rebuildButton.addEventListener("click", rebuildLabeledStrips);
  previewButton.addEventListener("click", renderCropPreview);
  confirmButton.addEventListener("click", confirmCrops);
  Object.values(inputs).forEach((input) => input.addEventListener("input", updateCalibration));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) setDialogOpen(false);
  });
  window.addEventListener("beforeunload", cleanTemporaryResources);
}());
