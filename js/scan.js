(function () {
  "use strict";

  const openButton = document.getElementById("scan-board");
  const dialog = document.getElementById("scan-dialog");
  const closeButton = document.getElementById("scan-close");
  const chooseAnotherButton = document.getElementById("scan-choose-another");
  const resetButton = document.getElementById("scan-reset-calibration");
  const previewButton = document.getElementById("scan-preview-crops");
  const confirmButton = document.getElementById("scan-confirm-crops");
  const pictureInput = document.getElementById("board-picture-input");
  const pickerPanel = document.getElementById("scan-picker-panel");
  const previewPanel = document.getElementById("scan-preview-panel");
  const cropPreviewPanel = document.getElementById("scan-crop-preview-panel");
  const cropPreviewGrid = document.getElementById("scan-crop-preview-grid");
  const image = document.getElementById("scan-image");
  const cropsEl = document.getElementById("scan-crops");
  const summaryEl = document.getElementById("scan-detection-summary");
  const message = document.getElementById("input-message");

  const STORAGE_KEY = "freecellScanCalibrationV5";
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
    top: document.getElementById("scan-top"),
    left: document.getElementById("scan-left"),
    spacing: document.getElementById("scan-spacing"),
    rowStep: document.getElementById("scan-row"),
    cropWidth: document.getElementById("scan-width"),
    cropHeight: document.getElementById("scan-height")
  };
  const outputs = {
    top: document.getElementById("scan-top-value"),
    left: document.getElementById("scan-left-value"),
    spacing: document.getElementById("scan-spacing-value"),
    rowStep: document.getElementById("scan-row-value"),
    cropWidth: document.getElementById("scan-width-value"),
    cropHeight: document.getElementById("scan-height-value")
  };

  let selectedFile = null;
  let objectUrl = null;
  let activeReader = null;
  let lastHandledSignature = "";
  let calibration = loadCalibration();

  function announce(text, kind) {
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
    image.removeAttribute("src");
    pickerPanel.hidden = false;
    previewPanel.hidden = true;
    cropPreviewPanel.hidden = true;
    cropPreviewGrid.replaceChildren();
    cropsEl.replaceChildren();
    pictureInput.value = "";
  }

  function closeDialog() { setDialogOpen(false); }

  function syncControls() {
    Object.keys(inputs).forEach((key) => {
      inputs[key].value = String(calibration[key]);
      outputs[key].textContent = Number(calibration[key]).toFixed(key === "spacing" || key === "rowStep" ? 2 : 1) + "%";
    });
  }

  function readControls() {
    Object.keys(inputs).forEach((key) => { calibration[key] = Number(inputs[key].value); });
  }

  function eachRegion(callback) {
    let number = 1;
    COLUMN_COUNTS.forEach((count, column) => {
      for (let row = 0; row < count; row += 1) {
        callback({
          number,
          column,
          row,
          left: calibration.left + column * calibration.spacing,
          top: calibration.top + row * calibration.rowStep,
          width: calibration.cropWidth,
          height: calibration.cropHeight
        });
        number += 1;
      }
    });
  }

  function renderCrops() {
    cropsEl.replaceChildren();
    eachRegion((region) => {
      const crop = document.createElement("div");
      crop.className = "scan-crop";
      crop.style.left = region.left + "%";
      crop.style.top = region.top + "%";
      crop.style.width = region.width + "%";
      crop.style.height = region.height + "%";
      crop.title = "Column " + (region.column + 1) + ", card " + (region.row + 1);
      crop.innerHTML = "<span>" + region.number + "</span>";
      cropsEl.appendChild(crop);
    });
    summaryEl.textContent = "52 expected card regions • 8 columns • screenshot " + image.naturalWidth + " × " + image.naturalHeight;
  }

  function updateCalibration() {
    readControls();
    syncControls();
    renderCrops();
    cropPreviewPanel.hidden = true;
  }

  function resetCalibration() {
    calibration = Object.assign({}, DEFAULTS);
    syncControls();
    renderCrops();
    cropPreviewPanel.hidden = true;
  }

  function isProbablyImage(file) {
    return !!file && (!file.type || file.type.startsWith("image/") || /\.(png|jpe?g|heic|heif|webp)$/i.test(file.name || ""));
  }

  function finishImageLoad() {
    syncControls();
    renderCrops();
    pickerPanel.hidden = true;
    previewPanel.hidden = false;
    cropPreviewPanel.hidden = true;
    announce("Image loaded.", "success");
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
        announce("Safari selected the image, but could not display it. Try a PNG or JPEG screenshot.", "error");
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
      announce("Choose a valid screenshot, photo, or image file.", "error");
      return;
    }

    cleanTemporaryResources();
    selectedFile = file;
    announce("Loading image…", "");

    // First use a blob URL—the same approach used by the last native picker
    // version that worked on iPhone. FileReader remains a fallback.
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
    cropPreviewGrid.replaceChildren();
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = image.naturalWidth;
    sourceCanvas.height = image.naturalHeight;
    const sourceCtx = sourceCanvas.getContext("2d");
    sourceCtx.drawImage(image, 0, 0);

    eachRegion((region) => {
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
    saveCalibration();
    const scanData = {
      calibration: Object.assign({}, calibration),
      imageName: selectedFile ? selectedFile.name : "board image",
      imageType: selectedFile ? selectedFile.type : "image/*",
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      cardRegions: 52,
      savedAt: new Date().toISOString()
    };
    sessionStorage.setItem("freecellPendingScanV4", JSON.stringify(scanData));
    closeDialog();
    announce("Crop calibration saved. The 52 card regions are ready for recognition.", "success");
  }

  openButton.addEventListener("click", () => setDialogOpen(true));
  closeButton.addEventListener("click", closeDialog);
  dialog.querySelectorAll("[data-scan-cancel]").forEach((node) => node.addEventListener("click", closeDialog));
  // Listen for both events because Safari versions differ in which one is
  // dispatched after choosing from Camera, Photos, or Files.
  pictureInput.addEventListener("change", handleNativeSelection);
  pictureInput.addEventListener("input", handleNativeSelection);
  chooseAnotherButton.addEventListener("click", showPicker);
  resetButton.addEventListener("click", resetCalibration);
  previewButton.addEventListener("click", renderCropPreview);
  confirmButton.addEventListener("click", confirmCrops);
  Object.values(inputs).forEach((input) => input.addEventListener("input", updateCalibration));
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !dialog.hidden) closeDialog();
  });
  window.addEventListener("beforeunload", cleanTemporaryResources);
}());
