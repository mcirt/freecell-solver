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
  const debugPanel = byId("scan-debug-panel");
  const debugSelect = byId("scan-debug-view");
  const debugCanvas = byId("scan-debug-canvas");
  const debugText = byId("scan-debug-text");

  const SESSION_KEY = "freecellPendingScanV17";
  let selectedFile = null;
  let objectUrl = null;
  let sourceCanvas = null;
  let detection = null;
  let cvReady = false;
  let debugFrames = {};

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
      updateCvStatus("OpenCV ready. Choose an image, then detect the tableau.", "ready");
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
    debugFrames = {};
    overlay.replaceChildren();
    checksEl.replaceChildren();
    summaryEl.textContent = "No tableau shape detected yet.";
    detailsPanel.hidden = true;
    detailsGrid.replaceChildren();
    if (debugPanel) debugPanel.hidden = true;
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

  function makeCardMask(rgb) {
    const cv = window.cv;
    const gray = new cv.Mat();
    const hsv = new cv.Mat();
    const neutral = new cv.Mat();
    const bright = new cv.Mat();
    const adaptive = new cv.Mat();
    const mask = new cv.Mat();
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

    const lowNeutral = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 130, 0]);
    const highNeutral = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 105, 255, 255]);
    cv.inRange(hsv, lowNeutral, highNeutral, neutral);

    cv.threshold(gray, bright, 148, 255, cv.THRESH_BINARY);
    cv.adaptiveThreshold(gray, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, -3);
    cv.bitwise_and(bright, neutral, mask);
    cv.bitwise_or(mask, adaptive, mask);

    const openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, openKernel);
    openKernel.delete();
    const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 5));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel);
    closeKernel.delete();

    gray.delete(); hsv.delete(); neutral.delete(); bright.delete(); adaptive.delete();
    lowNeutral.delete(); highNeutral.delete();
    return mask;
  }

  function smooth(values, radius) {
    const out = new Float32Array(values.length);
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[i];
      if (i - radius - 1 >= 0) sum -= values[i - radius - 1];
      const start = Math.max(0, i - radius);
      out[i] = sum / (i - start + 1);
    }
    return out;
  }

  function runsFromProfile(profile, threshold, minWidth, maxGap) {
    const raw = [];
    let start = -1;
    for (let x = 0; x <= profile.length; x += 1) {
      const on = x < profile.length && profile[x] >= threshold;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        if (x - start >= minWidth) raw.push({ start, end: x - 1, width: x - start });
        start = -1;
      }
    }
    const merged = [];
    raw.forEach((r) => {
      const last = merged[merged.length - 1];
      if (last && r.start - last.end - 1 <= maxGap) {
        last.end = r.end; last.width = last.end - last.start + 1;
      } else merged.push({ ...r });
    });
    return merged;
  }

  function bandProfile(mask, y0, y1) {
    const profile = new Float32Array(mask.cols);
    const h = Math.max(1, y1 - y0 + 1);
    for (let y = y0; y <= y1; y += 1) {
      const row = mask.ucharPtr(y);
      for (let x = 0; x < mask.cols; x += 1) if (row[x]) profile[x] += 1;
    }
    for (let x = 0; x < profile.length; x += 1) profile[x] /= h;
    return smooth(profile, 2);
  }

  function scoreEightRuns(runs, cols) {
    if (runs.length < 8) return null;
    let best = null;
    for (let s = 0; s <= runs.length - 8; s += 1) {
      const group = runs.slice(s, s + 8);
      const widths = group.map((r) => r.width);
      const centers = group.map((r) => (r.start + r.end) / 2);
      const gaps = centers.slice(1).map((c, i) => c - centers[i]);
      const meanW = widths.reduce((a, b) => a + b, 0) / 8;
      const meanG = gaps.reduce((a, b) => a + b, 0) / 7;
      const cvW = Math.sqrt(widths.reduce((a, v) => a + (v - meanW) ** 2, 0) / 8) / Math.max(1, meanW);
      const cvG = Math.sqrt(gaps.reduce((a, v) => a + (v - meanG) ** 2, 0) / 7) / Math.max(1, meanG);
      const span = group[7].end - group[0].start + 1;
      const spanRatio = span / cols;
      if (meanW < cols * 0.055 || meanW > cols * 0.15) continue;
      if (spanRatio < 0.62 || spanRatio > 0.99) continue;
      const score = 5 - cvW * 8 - cvG * 9 - Math.abs(spanRatio - 0.9) * 2;
      if (!best || score > best.score) best = { runs: group, centers, meanW, meanG, cvW, cvG, spanRatio, score };
    }
    return best;
  }

  function locateFirstCardRow(mask) {
    const yMin = Math.round(mask.rows * 0.18);
    const yMax = Math.round(mask.rows * 0.72);
    const bandH = Math.max(5, Math.round(mask.rows * 0.008));
    const minRun = Math.max(8, Math.round(mask.cols * 0.035));
    const maxGap = Math.max(3, Math.round(mask.cols * 0.012));
    const candidates = [];
    for (let y = yMin; y <= yMax; y += Math.max(2, Math.round(bandH / 2))) {
      const profile = bandProfile(mask, y, Math.min(mask.rows - 1, y + bandH));
      const runs = runsFromProfile(profile, 0.34, minRun, maxGap);
      const fit = scoreEightRuns(runs, mask.cols);
      if (!fit) continue;
      const belowY = Math.min(mask.rows - 1, y + Math.round(mask.rows * 0.035));
      const below = bandProfile(mask, belowY, Math.min(mask.rows - 1, belowY + bandH));
      const support = fit.centers.reduce((sum, cx) => sum + below[Math.round(cx)], 0) / 8;
      const topPreference = 1 - (y - yMin) / Math.max(1, yMax - yMin);
      candidates.push({ y, bandH, ...fit, support, totalScore: fit.score + support * 2 + topPreference * 0.15 });
    }
    candidates.sort((a, b) => b.totalScore - a.totalScore);
    return { best: candidates[0] || null, candidates: candidates.slice(0, 12) };
  }

  function laneCoverage(mask, x0, x1, y) {
    x0 = Math.max(0, Math.round(x0)); x1 = Math.min(mask.cols - 1, Math.round(x1));
    const row = mask.ucharPtr(y);
    let on = 0;
    for (let x = x0; x <= x1; x += 1) if (row[x]) on += 1;
    return on / Math.max(1, x1 - x0 + 1);
  }

  function detectLaneBottom(mask, center, laneWidth, top) {
    const x0 = center - laneWidth * 0.34;
    const x1 = center + laneWidth * 0.34;
    const values = new Float32Array(mask.rows - top);
    for (let y = top; y < mask.rows; y += 1) values[y - top] = laneCoverage(mask, x0, x1, y);
    const sm = smooth(values, Math.max(2, Math.round(mask.rows * 0.003)));
    let lastGood = top;
    let misses = 0;
    const maxMisses = Math.max(8, Math.round(mask.rows * 0.012));
    for (let i = 0; i < sm.length; i += 1) {
      if (sm[i] > 0.18) { lastGood = top + i; misses = 0; }
      else if (lastGood > top) {
        misses += 1;
        if (misses > maxMisses) break;
      }
    }
    return lastGood;
  }

  function evaluateSupport(mask, shape, rowFit) {
    let insideOn = 0, insideTotal = 0;
    const step = 3;
    for (let y = shape.top; y <= shape.bottomLeft; y += step) {
      const xEnd = y <= shape.bottomRight ? shape.right : shape.stepX;
      for (let x = shape.left; x <= xEnd; x += step) {
        insideOn += mask.ucharPtr(y, x)[0] ? 1 : 0;
        insideTotal += 1;
      }
    }
    const firstRowSupport = rowFit.centers.reduce((sum, cx) => sum + laneCoverage(mask, cx - rowFit.meanW * 0.35, cx + rowFit.meanW * 0.35, shape.top + Math.round(rowFit.bandH / 2)), 0) / 8;
    return { interiorSupport: insideOn / Math.max(1, insideTotal), firstRowSupport };
  }

  function buildDetection(mask, rowResult) {
    const fit = rowResult.best;
    if (!fit) throw new Error("Could not find one row of eight evenly spaced card tops.");
    const centers = fit.centers;
    const laneWidth = fit.meanG;
    const left = Math.max(0, Math.round(centers[0] - laneWidth / 2));
    const right = Math.min(mask.cols - 1, Math.round(centers[7] + laneWidth / 2));
    const top = fit.y;
    const bottoms = centers.map((c) => detectLaneBottom(mask, c, laneWidth, top));
    const leftBottoms = bottoms.slice(0, 4).sort((a, b) => a - b);
    const rightBottoms = bottoms.slice(4).sort((a, b) => a - b);
    const bottomLeft = Math.round((leftBottoms[1] + leftBottoms[2]) / 2);
    const bottomRight = Math.round((rightBottoms[1] + rightBottoms[2]) / 2);
    const stepX = Math.round((centers[3] + centers[4]) / 2);
    const stepHeight = bottomLeft - bottomRight;
    const expectedRowStep = Math.max(1, (bottomLeft - top) / 7);
    const shape = { left, right, top, bottomLeft, bottomRight, stepX, laneWidth, centers, bottoms, stepHeight, expectedRowStep };
    const support = evaluateSupport(mask, shape, fit);
    const checks = {
      eightFirstCards: fit.runs.length === 8,
      widthConsistency: fit.cvW < 0.22,
      spacingConsistency: fit.cvG < 0.16,
      broadTableau: fit.spanRatio > 0.68,
      cardPixelSupport: support.interiorSupport > 0.22,
      firstRowSupport: support.firstRowSupport > 0.34,
      correctStepDirection: stepHeight > expectedRowStep * 0.28,
      plausibleStep: stepHeight < expectedRowStep * 2.0
    };
    const passCount = Object.values(checks).filter(Boolean).length;
    const points = [
      { x: left, y: top }, { x: right, y: top }, { x: right, y: bottomRight },
      { x: stepX, y: bottomRight }, { x: stepX, y: bottomLeft }, { x: left, y: bottomLeft }
    ];
    return { ...shape, points, checks, passCount, support, rowFit: fit, candidates: rowResult.candidates };
  }

  function matToDataUrl(mat) {
    const canvas = document.createElement("canvas");
    cv.imshow(canvas, mat);
    return canvas.toDataURL("image/png");
  }

  function buildAnnotatedFrame(resized, rowResult, result) {
    const cv = window.cv;
    const frame = resized.clone();
    rowResult.candidates.forEach((c, idx) => {
      const color = idx === 0 ? new cv.Scalar(0, 255, 0, 255) : new cv.Scalar(255, 180, 0, 255);
      c.runs.forEach((r) => cv.rectangle(frame, new cv.Point(r.start, c.y), new cv.Point(r.end, c.y + c.bandH), color, idx === 0 ? 3 : 1));
    });
    result.centers.forEach((cx) => cv.line(frame, new cv.Point(cx, result.top), new cv.Point(cx, result.bottomLeft), new cv.Scalar(0, 255, 255, 255), 2));
    return frame;
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
    polygon.setAttribute("class", result.passCount >= 7 ? "scan-silhouette-good" : "scan-silhouette-review");
    svg.appendChild(polygon);
    for (let i = 1; i < 8; i += 1) {
      const x = (result.centers[i - 1] + result.centers[i]) / 2;
      const y2 = i <= 4 ? result.bottomLeft : result.bottomRight;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", x); line.setAttribute("x2", x);
      line.setAttribute("y1", result.top); line.setAttribute("y2", y2);
      line.setAttribute("class", "scan-silhouette-divider");
      svg.appendChild(line);
    }
    overlay.appendChild(svg);

    summaryEl.textContent = `${result.passCount}/8 evidence checks passed • image ${image.naturalWidth} × ${image.naturalHeight}`;
    checksEl.replaceChildren();
    const labels = {
      eightFirstCards: "Eight first-card regions", widthConsistency: "Card-width consistency",
      spacingConsistency: "Column-spacing consistency", broadTableau: "Tableau spans board",
      cardPixelSupport: "Card-pixel overlap", firstRowSupport: "First-row pixel support",
      correctStepDirection: "Columns 1–4 lower", plausibleStep: "Bottom-step size"
    };
    Object.entries(result.checks).forEach(([key, pass]) => {
      const item = document.createElement("span");
      item.className = "scan-column-count" + (pass ? "" : " scan-column-warning");
      item.textContent = `${labels[key]}: ${pass ? "Pass" : "Review"}`;
      checksEl.appendChild(item);
    });
    confirmButton.disabled = result.passCount < 7;
  }

  function renderDebugView() {
    if (!debugCanvas || !debugSelect) return;
    const frame = debugFrames[debugSelect.value];
    const ctx = debugCanvas.getContext("2d");
    ctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
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
      updateCvStatus("OpenCV is not ready yet. Close and restart Safari if it remains stuck.", "warning");
      return;
    }
    detectButton.disabled = true;
    updateCvStatus("OpenCV is finding eight actual first-card regions and tracing their columns…", "working");
    let src, resized, rgb, mask, annotated;
    try {
      ensureCanvas();
      const cv = window.cv;
      src = cv.imread(sourceCanvas);
      const maxW = 900;
      const scale = Math.min(1, maxW / src.cols);
      resized = new cv.Mat();
      cv.resize(src, resized, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
      rgb = new cv.Mat();
      cv.cvtColor(resized, rgb, cv.COLOR_RGBA2RGB);
      mask = makeCardMask(rgb);
      const rowResult = locateFirstCardRow(mask);
      const small = buildDetection(mask, rowResult);
      annotated = buildAnnotatedFrame(resized, rowResult, small);

      debugFrames = {
        original: matToDataUrl(resized),
        mask: matToDataUrl(mask),
        candidates: matToDataUrl(annotated)
      };

      const inv = 1 / scale;
      detection = {
        ...small,
        points: small.points.map((p) => ({ x: p.x * inv, y: p.y * inv })),
        top: small.top * inv, left: small.left * inv, right: small.right * inv,
        bottomLeft: small.bottomLeft * inv, bottomRight: small.bottomRight * inv,
        stepX: small.stepX * inv, stepHeight: small.stepHeight * inv,
        laneWidth: small.laneWidth * inv,
        centers: small.centers.map((v) => v * inv), bottoms: small.bottoms.map((v) => v * inv),
        confidence: small.passCount / 8
      };
      drawDetection(detection);
      if (debugPanel) debugPanel.hidden = false;
      renderDebugView();
      if (debugText) debugText.textContent = JSON.stringify({
        firstRowY: Math.round(small.top), candidateScore: Number(small.rowFit.totalScore.toFixed(3)),
        widthCV: Number(small.rowFit.cvW.toFixed(3)), spacingCV: Number(small.rowFit.cvG.toFixed(3)),
        interiorSupport: Number(small.support.interiorSupport.toFixed(3)), firstRowSupport: Number(small.support.firstRowSupport.toFixed(3)),
        bottoms: small.bottoms.map(Math.round), stepHeight: Math.round(small.stepHeight), passes: small.passCount
      }, null, 2);
      updateCvStatus(detection.passCount >= 7 ? "Tableau evidence found. Review the cyan outline and Debug View." : "A candidate was found, but the evidence checks need review.", detection.passCount >= 7 ? "ready" : "warning");
      announce("The outline is now derived from eight detected first-card regions and measured card-pixel support.", detection.passCount >= 7 ? "success" : "");
    } catch (error) {
      console.error(error);
      clearDetection();
      updateCvStatus(`Tableau not found: ${error.message}`, "warning");
      announce("Open Debug View after a candidate is found. A future fallback can allow manual corner/step adjustment.", "error");
    } finally {
      [src, resized, rgb, mask, annotated].forEach((m) => { if (m && typeof m.delete === "function") m.delete(); });
      detectButton.disabled = false;
    }
  }

  function showDetails() {
    if (!detection) { announce("Detect the tableau first.", "error"); return; }
    detailsGrid.replaceChildren();
    const data = [
      ["Top", `${(detection.top / image.naturalHeight * 100).toFixed(1)}%`],
      ["Left", `${(detection.left / image.naturalWidth * 100).toFixed(1)}%`],
      ["Right", `${(detection.right / image.naturalWidth * 100).toFixed(1)}%`],
      ["Columns 1–4 bottom", `${(detection.bottomLeft / image.naturalHeight * 100).toFixed(1)}%`],
      ["Columns 5–8 bottom", `${(detection.bottomRight / image.naturalHeight * 100).toFixed(1)}%`],
      ["Card-pixel overlap", `${Math.round(detection.support.interiorSupport * 100)}%`],
      ["First-row support", `${Math.round(detection.support.firstRowSupport * 100)}%`],
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
      version: 17, detector: "opencv-evidence-tableau", imageName: selectedFile ? selectedFile.name : "board image",
      imageWidth: image.naturalWidth, imageHeight: image.naturalHeight, silhouette: detection, savedAt: new Date().toISOString()
    }));
    setDialogOpen(false);
    announce("Tableau geometry saved for the card-strip stage.", "success");
  }

  function showImage(file) {
    if (!file || (file.type && !file.type.startsWith("image/"))) { announce("Choose a valid image file.", "error"); return; }
    cleanUrl(); selectedFile = file; objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      sourceCanvas = null; pickerPanel.hidden = true; previewPanel.hidden = false; clearDetection();
      updateCvStatus(cvReady ? "Image loaded. Detecting tableau evidence…" : "Image loaded. Waiting for OpenCV…", "working");
      if (cvReady) window.setTimeout(detectTableauShape, 30);
    };
    image.onerror = () => announce("The selected image could not be displayed.", "error");
    image.src = objectUrl;
  }

  function handleSelection() { const file = pictureInput.files && pictureInput.files[0]; if (file) showImage(file); }

  if (!openButton || !dialog || !pictureInput) return;
  initializeOpenCv(); detectButton.disabled = true; confirmButton.disabled = true;
  openButton.addEventListener("click", () => setDialogOpen(true));
  closeButton.addEventListener("click", () => setDialogOpen(false));
  dialog.querySelectorAll("[data-scan-cancel]").forEach((node) => node.addEventListener("click", () => setDialogOpen(false)));
  pictureInput.addEventListener("change", handleSelection); pictureInput.addEventListener("input", handleSelection);
  chooseAnotherButton.addEventListener("click", showPicker); resetButton.addEventListener("click", clearDetection);
  detectButton.addEventListener("click", detectTableauShape); detailsButton.addEventListener("click", showDetails);
  confirmButton.addEventListener("click", confirmShape);
  if (debugSelect) debugSelect.addEventListener("change", renderDebugView);
  window.addEventListener("beforeunload", cleanUrl);
}());
