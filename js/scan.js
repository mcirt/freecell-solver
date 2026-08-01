(function () {
  "use strict";

  const openButton = document.getElementById("scan-board");
  const dialog = document.getElementById("scan-dialog");
  const closeButton = document.getElementById("scan-close");
  const takePhotoButton = document.getElementById("take-board-photo");
  const choosePictureButton = document.getElementById("choose-board-picture");
  const chooseAnotherButton = document.getElementById("scan-choose-another");
  const resetButton = document.getElementById("scan-reset-calibration");
  const confirmButton = document.getElementById("scan-confirm-crops");
  const cameraInput = document.getElementById("board-camera-input");
  const pictureInput = document.getElementById("board-picture-input");
  const pickerPanel = document.getElementById("scan-picker-panel");
  const previewPanel = document.getElementById("scan-preview-panel");
  const image = document.getElementById("scan-image");
  const cropsEl = document.getElementById("scan-crops");
  const summaryEl = document.getElementById("scan-detection-summary");
  const message = document.getElementById("input-message");

  const STORAGE_KEY = "freecellScanCalibrationV2";
  const COLUMN_COUNTS = [7, 7, 7, 7, 6, 6, 6, 6];
  const DEFAULTS = {
    top: 34.5,
    left: 0.75,
    spacing: 12.45,
    rowStep: 3.18,
    cropWidth: 7.4,
    cropHeight: 2.65
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

  let objectUrl = null;
  let selectedFile = null;
  let calibration = loadCalibration();

  function announce(text, kind) {
    message.textContent = text;
    message.className = "input-message" + (kind ? " " + kind : "");
  }

  function setDialogOpen(open) {
    dialog.hidden = !open;
    document.body.classList.toggle("scan-open", open);
    if (open) takePhotoButton.focus();
  }

  function clearObjectUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
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
    clearObjectUrl();
    selectedFile = null;
    image.removeAttribute("src");
    pickerPanel.hidden = false;
    previewPanel.hidden = true;
    cropsEl.replaceChildren();
    cameraInput.value = "";
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

  function renderCrops() {
    cropsEl.replaceChildren();
    let number = 1;
    COLUMN_COUNTS.forEach((count, column) => {
      for (let row = 0; row < count; row += 1) {
        const crop = document.createElement("div");
        crop.className = "scan-crop";
        crop.style.left = (calibration.left + column * calibration.spacing) + "%";
        crop.style.top = (calibration.top + row * calibration.rowStep) + "%";
        crop.style.width = calibration.cropWidth + "%";
        crop.style.height = calibration.cropHeight + "%";
        crop.title = "Column " + (column + 1) + ", card " + (row + 1);
        crop.innerHTML = "<span>" + number + "</span>";
        cropsEl.appendChild(crop);
        number += 1;
      }
    });
    summaryEl.textContent = "52 expected card regions • 8 columns • screenshot " + image.naturalWidth + " × " + image.naturalHeight;
  }

  function updateCalibration() {
    readControls();
    syncControls();
    renderCrops();
  }

  function resetCalibration() {
    calibration = Object.assign({}, DEFAULTS);
    syncControls();
    renderCrops();
  }

  function showImage(file) {
    if (!file || !file.type.startsWith("image/")) {
      announce("Choose a valid screenshot, photo, or other image file.", "error");
      return;
    }
    clearObjectUrl();
    selectedFile = file;
    objectUrl = URL.createObjectURL(file);
    image.onload = function () {
      syncControls();
      renderCrops();
      pickerPanel.hidden = true;
      previewPanel.hidden = false;
    };
    image.onerror = function () {
      announce("That image could not be opened.", "error");
      showPicker();
    };
    image.src = objectUrl;
  }

  function handleInput(input) {
    const file = input.files && input.files[0];
    if (file) showImage(file);
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
    sessionStorage.setItem("freecellPendingScanV2", JSON.stringify(scanData));
    closeDialog();
    announce("Crop calibration saved. The next scanner stage will read these 52 card regions.", "success");
  }

  openButton.addEventListener("click", () => setDialogOpen(true));
  closeButton.addEventListener("click", closeDialog);
  dialog.querySelectorAll("[data-scan-cancel]").forEach((node) => node.addEventListener("click", closeDialog));
  takePhotoButton.addEventListener("click", () => cameraInput.click());
  choosePictureButton.addEventListener("click", () => pictureInput.click());
  chooseAnotherButton.addEventListener("click", showPicker);
  resetButton.addEventListener("click", resetCalibration);
  confirmButton.addEventListener("click", confirmCrops);
  cameraInput.addEventListener("change", () => handleInput(cameraInput));
  pictureInput.addEventListener("change", () => handleInput(pictureInput));
  Object.values(inputs).forEach((input) => input.addEventListener("input", updateCalibration));
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !dialog.hidden) closeDialog();
  });
  window.addEventListener("beforeunload", clearObjectUrl);
}());
