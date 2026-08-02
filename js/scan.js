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

  const SESSION_KEY = "freecellPendingScanV16";
  let selectedFile = null;
  let objectUrl = null;
  let sourceCanvas = null;
  let detection = null;
  let cvReady = false;

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

  function initializeOpenCv() {
    updateCvStatus("Loading OpenCV…", "working");
    const ready = window.freecellCvReady;
    if (!ready) {
      updateCvStatus("OpenCV loader is missing.", "warning");
      return;
    }
    ready.then(() => {
      cvReady = true;
      detectButton.disabled = false;
      updateCvStatus("OpenCV ready. Choose an image, then detect the tableau shape.", "ready");
      if (image.naturalWidth) detectTableauShape();
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
    overlay.replaceChildren();
    checksEl.replaceChildren();
    summaryEl.textContent = "No tableau shape detected yet.";
    detailsPanel.hidden = true;
    detailsGrid.replaceChildren();
    confirmButton.disabled = true;
  }

  function showPicker() {
    cleanUrl();
    selectedFile = null;
    sourceCanvas = null;
    clearDetection();
    image.removeAttribute("src");
    pickerPanel.hidden = false;
    previewPanel.hidden = true;
    pictureInput.value = "";
  }

  function ensureCanvas() {
    if (sourceCanvas && sourceCanvas.width === image.naturalWidth && sourceCanvas.height === image.naturalHeight) return;
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = image.naturalWidth;
    sourceCanvas.height = image.naturalHeight;
    sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  }

  function rowCoverage(mask, rect, y) {
    let on = 0;
    let total = 0;
    const step = Math.max(1, Math.round(rect.width / 260));
    for (let x = rect.x; x < rect.x + rect.width; x += step) {
      on += mask.ucharPtr(y, x)[0] ? 1 : 0;
      total += 1;
    }
    return on / Math.max(1, total);
  }

  function columnCoverage(mask, rect, x, y0, y1) {
    let on = 0;
    let total = 0;
    const step = Math.max(1, Math.round((y1 - y0) / 220));
    for (let y = y0; y <= y1; y += step) {
      on += mask.ucharPtr(y, x)[0] ? 1 : 0;
      total += 1;
    }
    return on / Math.max(1, total);
  }

  function findTableauCandidate(mask) {
    const cv = window.cv;
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let best = null;
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const rect = cv.boundingRect(contour);
      const area = cv.contourArea(contour);
      contour.delete();

      const wr = rect.width / mask.cols;
      const hr = rect.height / mask.rows;
      const yr = rect.y / mask.rows;
      const aspect = rect.width / Math.max(1, rect.height);
      if (wr < 0.52 || wr > 0.99) continue;
      if (hr < 0.10 || hr > 0.52) continue;
      if (yr < 0.12 || yr > 0.72) continue;
      if (aspect < 1.25 || aspect > 5.8) continue;

      const fill = area / Math.max(1, rect.width * rect.height);
      const centerPenalty = Math.abs((rect.x + rect.width / 2) / mask.cols - 0.5);
      const score = wr * 4 + fill * 2.5 + Math.min(aspect, 3.5) * 0.25 - centerPenalty * 2 - Math.abs(yr - 0.38) * 0.5;
      if (!best || score > best.score) best = { rect, area, fill, score };
    }
    contours.delete();
    hierarchy.delete();
    return best;
  }

  function deriveSilhouette(mask, candidate) {
    const r = candidate.rect;
    const yStart = Math.max(0, r.y - Math.round(mask.rows * 0.025));
    const yEnd = Math.min(mask.rows - 1, r.y + r.height - 1);

    let top = r.y;
    for (let y = yStart; y <= Math.min(yEnd, r.y + Math.round(r.height * 0.35)); y += 1) {
      if (rowCoverage(mask, r, y) > 0.46) { top = y; break; }
    }

    const halfX = r.x + r.width / 2;
    const leftX0 = r.x;
    const leftX1 = Math.round(halfX - 1);
    const rightX0 = Math.round(halfX);
    const rightX1 = r.x + r.width - 1;

    function lowestPixel(x0, x1) {
      let last = top;
      const stepX = Math.max(1, Math.round((x1 - x0) / 220));
      for (let y = top; y <= yEnd; y += 1) {
        let found = false;
        for (let x = x0; x <= x1; x += stepX) {
          if (mask.ucharPtr(y, x)[0]) { found = true; break; }
        }
        if (found) last = y;
      }
      return last;
    }

    let bottomLeft = lowestPixel(leftX0, leftX1);
    let bottomRight = lowestPixel(rightX0, rightX1);
    if (bottomLeft < bottomRight) {
      const temp = bottomLeft;
      bottomLeft = bottomRight;
      bottomRight = temp;
    }

    // Estimate left/right boundaries by looking for sustained vertical card pixels.
    let left = r.x;
    let right = r.x + r.width - 1;
    for (let x = r.x; x < r.x + r.width * 0.18; x += 1) {
      if (columnCoverage(mask, r, x, top, bottomLeft) > 0.24) { left = x; break; }
    }
    for (let x = r.x + r.width - 1; x > r.x + r.width * 0.82; x -= 1) {
      if (columnCoverage(mask, r, x, top, bottomRight) > 0.24) { right = x; break; }
    }

    const stepX = Math.round(left + (right - left) * 0.5);
    const stepHeight = bottomLeft - bottomRight;
    const expectedStep = Math.max(4, Math.round((bottomLeft - top) / 7.2));
    const stepRatio = stepHeight / Math.max(1, expectedStep);

    const points = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottomRight },
      { x: stepX, y: bottomRight },
      { x: stepX, y: bottomLeft },
      { x: left, y: bottomLeft }
    ];

    const width = right - left;
    const height = bottomLeft - top;
    const laneWidth = width / 8;
    const checks = {
      broadCandidate: width / mask.cols > 0.58,
      sharedTop: rowCoverage(mask, { x: left, width, y: top, height }, top) > 0.42,
      correctStepDirection: bottomLeft > bottomRight,
      plausibleStep: stepRatio > 0.35 && stepRatio < 2.2,
      plausibleAspect: width / Math.max(1, height) > 1.45 && width / Math.max(1, height) < 4.8,
      eightLanes: laneWidth > mask.cols * 0.055 && laneWidth < mask.cols * 0.16
    };
    const passCount = Object.values(checks).filter(Boolean).length;
    return { points, top, left, right, bottomLeft, bottomRight, stepX, stepHeight, expectedStep, laneWidth, checks, passCount };
  }

  function drawDetection(result) {
    overlay.replaceChildren();
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${image.naturalWidth} ${image.naturalHeight}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.classList.add("scan-silhouette-svg");

    const polygon = document.createElementNS(ns, "polygon");
    polygon.setAttribute("points", result.points.map((p) => `${p.x},${p.y}`).join(" "));
    polygon.setAttribute("class", result.passCount >= 5 ? "scan-silhouette-good" : "scan-silhouette-review");
    svg.appendChild(polygon);

    for (let i = 1; i < 8; i += 1) {
      const x = result.left + result.laneWidth * i;
      const y2 = i <= 4 ? result.bottomLeft : result.bottomRight;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", x);
      line.setAttribute("x2", x);
      line.setAttribute("y1", result.top);
      line.setAttribute("y2", y2);
      line.setAttribute("class", "scan-silhouette-divider");
      svg.appendChild(line);
    }
    overlay.appendChild(svg);

    const passed = result.passCount;
    summaryEl.textContent = `${passed}/6 tableau-shape checks passed • image ${image.naturalWidth} × ${image.naturalHeight}`;
    checksEl.replaceChildren();
    const labels = {
      broadCandidate: "Large card region",
      sharedTop: "Shared top edge",
      correctStepDirection: "Columns 1–4 lower",
      plausibleStep: "Bottom step size",
      plausibleAspect: "Tableau proportions",
      eightLanes: "Eight-column width"
    };
    Object.entries(result.checks).forEach(([key, pass]) => {
      const item = document.createElement("span");
      item.className = "scan-column-count" + (pass ? "" : " scan-column-warning");
      item.textContent = `${labels[key]}: ${pass ? "Pass" : "Review"}`;
      checksEl.appendChild(item);
    });
    confirmButton.disabled = passed < 5;
  }

  function detectTableauShape() {
    if (!image.naturalWidth) return;
    if (!cvReady || !window.cv || typeof window.cv.imread !== "function") {
      updateCvStatus("OpenCV is not ready yet. Close and restart Safari if it remains stuck.", "warning");
      return;
    }

    detectButton.disabled = true;
    updateCvStatus("OpenCV is locating the stepped tableau silhouette…", "working");
    let src, resized, rgb, hsv, mask, closed, kernel, contours;
    try {
      ensureCanvas();
      const cv = window.cv;
      src = cv.imread(sourceCanvas);
      const maxW = 900;
      const scale = Math.min(1, maxW / src.cols);
      resized = new cv.Mat();
      cv.resize(src, resized, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
      rgb = new cv.Mat();
      hsv = new cv.Mat();
      cv.cvtColor(resized, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      mask = new cv.Mat();
      const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 112, 0]);
      const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 150, 255, 255]);
      cv.inRange(hsv, low, high, mask);
      low.delete(); high.delete();

      // Join card faces into one region while retaining the stepped outer boundary.
      closed = new cv.Mat();
      const kx = Math.max(5, Math.round(mask.cols * 0.014) | 1);
      const ky = Math.max(3, Math.round(mask.rows * 0.004) | 1);
      kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kx, ky));
      cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel);
      const kernel2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 5));
      cv.dilate(closed, closed, kernel2);
      kernel2.delete();

      const candidate = findTableauCandidate(closed);
      if (!candidate) throw new Error("No wide stepped card region matched the expected tableau proportions.");
      const small = deriveSilhouette(closed, candidate);
      const inv = 1 / scale;
      detection = {
        points: small.points.map((p) => ({ x: p.x * inv, y: p.y * inv })),
        top: small.top * inv,
        left: small.left * inv,
        right: small.right * inv,
        bottomLeft: small.bottomLeft * inv,
        bottomRight: small.bottomRight * inv,
        stepX: small.stepX * inv,
        stepHeight: small.stepHeight * inv,
        expectedStep: small.expectedStep * inv,
        laneWidth: small.laneWidth * inv,
        checks: small.checks,
        passCount: small.passCount,
        confidence: small.passCount / 6
      };
      drawDetection(detection);
      updateCvStatus(detection.passCount >= 5 ? "Tableau silhouette found. Review the cyan outline." : "A candidate shape was found, but some checks need review.", detection.passCount >= 5 ? "ready" : "warning");
      announce("OpenCV searched for the board’s stepped 7/7/7/7 + 6/6/6/6 silhouette without relying on the upper slots.", detection.passCount >= 5 ? "success" : "");
    } catch (error) {
      console.error(error);
      clearDetection();
      updateCvStatus(`Tableau shape not found: ${error.message}`, "warning");
      announce("Try a clearer screenshot/photo, crop closer to the phone screen, or use the manual fallback later.", "error");
    } finally {
      [src, resized, rgb, hsv, mask, closed, kernel].forEach((m) => { if (m && typeof m.delete === "function") m.delete(); });
      detectButton.disabled = false;
    }
  }

  function showDetails() {
    if (!detection) {
      announce("Detect the tableau shape first.", "error");
      return;
    }
    detailsGrid.replaceChildren();
    const data = [
      ["Top", `${(detection.top / image.naturalHeight * 100).toFixed(1)}%`],
      ["Left", `${(detection.left / image.naturalWidth * 100).toFixed(1)}%`],
      ["Right", `${(detection.right / image.naturalWidth * 100).toFixed(1)}%`],
      ["Columns 1–4 bottom", `${(detection.bottomLeft / image.naturalHeight * 100).toFixed(1)}%`],
      ["Columns 5–8 bottom", `${(detection.bottomRight / image.naturalHeight * 100).toFixed(1)}%`],
      ["Step height", `${Math.round(detection.stepHeight)} px`],
      ["Confidence", `${Math.round(detection.confidence * 100)}%`]
    ];
    data.forEach(([name, value]) => {
      const box = document.createElement("div");
      box.className = "scan-shape-detail";
      box.innerHTML = `<strong>${name}</strong><span>${value}</span>`;
      detailsGrid.appendChild(box);
    });
    detailsPanel.hidden = false;
    detailsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function confirmShape() {
    if (!detection) return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      version: 16,
      detector: "opencv-tableau-silhouette",
      imageName: selectedFile ? selectedFile.name : "board image",
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      silhouette: detection,
      savedAt: new Date().toISOString()
    }));
    setDialogOpen(false);
    announce("Tableau silhouette saved for the next card-strip detection stage.", "success");
  }

  function showImage(file) {
    if (!file || (file.type && !file.type.startsWith("image/"))) {
      announce("Choose a valid image file.", "error");
      return;
    }
    cleanUrl();
    selectedFile = file;
    objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      sourceCanvas = null;
      pickerPanel.hidden = true;
      previewPanel.hidden = false;
      clearDetection();
      updateCvStatus(cvReady ? "Image loaded. Detecting the tableau shape…" : "Image loaded. Waiting for OpenCV…", "working");
      if (cvReady) window.setTimeout(detectTableauShape, 30);
    };
    image.onerror = () => announce("The selected image could not be displayed.", "error");
    image.src = objectUrl;
  }

  function handleSelection() {
    const file = pictureInput.files && pictureInput.files[0];
    if (file) showImage(file);
  }

  if (!openButton || !dialog || !pictureInput) return;
  initializeOpenCv();
  detectButton.disabled = true;
  confirmButton.disabled = true;
  openButton.addEventListener("click", () => setDialogOpen(true));
  closeButton.addEventListener("click", () => setDialogOpen(false));
  dialog.querySelectorAll("[data-scan-cancel]").forEach((node) => node.addEventListener("click", () => setDialogOpen(false)));
  pictureInput.addEventListener("change", handleSelection);
  pictureInput.addEventListener("input", handleSelection);
  chooseAnotherButton.addEventListener("click", showPicker);
  resetButton.addEventListener("click", clearDetection);
  detectButton.addEventListener("click", detectTableauShape);
  detailsButton.addEventListener("click", showDetails);
  confirmButton.addEventListener("click", confirmShape);
  window.addEventListener("beforeunload", cleanUrl);
}());
