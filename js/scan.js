(function () {
  "use strict";

  const openButton = document.getElementById("scan-board");
  const dialog = document.getElementById("scan-dialog");
  const closeButton = document.getElementById("scan-close");
  const takePhotoButton = document.getElementById("take-board-photo");
  const choosePictureButton = document.getElementById("choose-board-picture");
  const chooseAnotherButton = document.getElementById("scan-choose-another");
  const resetButton = document.getElementById("scan-reset-guides");
  const useButton = document.getElementById("scan-use-image");
  const cameraInput = document.getElementById("board-camera-input");
  const pictureInput = document.getElementById("board-picture-input");
  const pickerPanel = document.getElementById("scan-picker-panel");
  const previewPanel = document.getElementById("scan-preview-panel");
  const image = document.getElementById("scan-image");
  const stage = document.getElementById("scan-stage");
  const guidesEl = document.getElementById("scan-guides");
  const message = document.getElementById("input-message");

  let objectUrl = null;
  let guidePositions = [];
  let activeGuide = null;
  let selectedFile = null;

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

  function showPicker() {
    clearObjectUrl();
    selectedFile = null;
    image.removeAttribute("src");
    pickerPanel.hidden = false;
    previewPanel.hidden = true;
    guidesEl.replaceChildren();
    cameraInput.value = "";
    pictureInput.value = "";
  }

  function closeDialog() {
    setDialogOpen(false);
  }

  function defaultPositions() {
    guidePositions = Array.from({ length: 8 }, (_, i) => ((i + 0.5) / 8) * 100);
  }

  function renderGuides() {
    guidesEl.replaceChildren();
    guidePositions.forEach((position, index) => {
      const guide = document.createElement("button");
      guide.type = "button";
      guide.className = "scan-guide";
      guide.style.left = position + "%";
      guide.dataset.index = String(index);
      guide.setAttribute("aria-label", "Column " + (index + 1) + " guide");
      guide.innerHTML = "<span>" + (index + 1) + "</span>";
      guide.addEventListener("pointerdown", startDrag);
      guidesEl.appendChild(guide);
    });
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function startDrag(event) {
    activeGuide = Number(event.currentTarget.dataset.index);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.addEventListener("pointermove", dragGuide);
    event.currentTarget.addEventListener("pointerup", endDrag, { once: true });
    event.currentTarget.addEventListener("pointercancel", endDrag, { once: true });
  }

  function dragGuide(event) {
    if (activeGuide === null) return;
    const rect = stage.getBoundingClientRect();
    const min = activeGuide === 0 ? 1 : guidePositions[activeGuide - 1] + 2;
    const max = activeGuide === 7 ? 99 : guidePositions[activeGuide + 1] - 2;
    guidePositions[activeGuide] = clamp(((event.clientX - rect.left) / rect.width) * 100, min, max);
    event.currentTarget.style.left = guidePositions[activeGuide] + "%";
  }

  function endDrag(event) {
    event.currentTarget.removeEventListener("pointermove", dragGuide);
    activeGuide = null;
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
      defaultPositions();
      renderGuides();
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

  function useImage() {
    const scanData = {
      guidePositions: guidePositions.slice(),
      imageName: selectedFile ? selectedFile.name : "board image",
      imageType: selectedFile ? selectedFile.type : "image/*",
      savedAt: new Date().toISOString()
    };
    sessionStorage.setItem("freecellPendingScanV1", JSON.stringify(scanData));
    closeDialog();
    announce("Board image aligned. Card recognition will be added in the next scan stage.", "success");
  }

  openButton.addEventListener("click", () => setDialogOpen(true));
  closeButton.addEventListener("click", closeDialog);
  dialog.querySelectorAll("[data-scan-cancel]").forEach(el => el.addEventListener("click", closeDialog));
  takePhotoButton.addEventListener("click", () => cameraInput.click());
  choosePictureButton.addEventListener("click", () => pictureInput.click());
  chooseAnotherButton.addEventListener("click", showPicker);
  resetButton.addEventListener("click", function () {
    defaultPositions();
    renderGuides();
  });
  useButton.addEventListener("click", useImage);
  cameraInput.addEventListener("change", () => handleInput(cameraInput));
  pictureInput.addEventListener("change", () => handleInput(pictureInput));
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !dialog.hidden) closeDialog();
  });
  window.addEventListener("beforeunload", clearObjectUrl);
}());
