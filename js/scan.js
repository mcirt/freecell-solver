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

  const SESSION_KEY = "freecellPendingScanV18";
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
    if (!window.freecellCvReady) {
      updateCvStatus("OpenCV loader is missing.", "warning");
      return;
    }
    window.freecellCvReady.then(() => {
      cvReady = true;
      detectButton.disabled = false;
      updateCvStatus("OpenCV ready.", "ready");
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
    summaryEl.textContent = "No tableau detected yet.";
    detailsPanel.hidden = true;
    detailsGrid.replaceChildren();
    if (debugPanel) { debugPanel.hidden = true; debugPanel.open = false; }
    confirmButton.disabled = true;
  }

  function showPicker() {
    cleanUrl(); selectedFile = null; sourceCanvas = null; clearDetection();
    image.removeAttribute("src"); pickerPanel.hidden = false; previewPanel.hidden = true; pictureInput.value = "";
  }

  function ensureCanvas() {
    if (sourceCanvas && sourceCanvas.width === image.naturalWidth && sourceCanvas.height === image.naturalHeight) return;
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = image.naturalWidth;
    sourceCanvas.height = image.naturalHeight;
    sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  }

  function mean(values) { return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length); }
  function median(values) {
    const a = values.slice().sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function coefficientOfVariation(values) {
    const m = mean(values);
    return Math.sqrt(mean(values.map((v) => (v - m) ** 2))) / Math.max(1, m);
  }
  function movingAverage(values, radius) {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i += 1) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j += 1) { sum += values[j]; count += 1; }
      out[i] = sum / count;
    }
    return out;
  }

  /* Deliberately strict: no adaptive-threshold OR. The old adaptive mask
     turned white lettering, cyan borders and colored slots into card evidence. */
  function makeStrictCardMask(rgb) {
    const cv = window.cv;
    const hsv = new cv.Mat();
    const gray = new cv.Mat();
    const neutral = new cv.Mat();
    const light = new cv.Mat();
    const mask = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 145, 0]);
    const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 82, 255, 255]);
    cv.inRange(hsv, low, high, neutral);
    cv.threshold(gray, light, 145, 255, cv.THRESH_BINARY);
    cv.bitwise_and(neutral, light, mask);
    const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel);
    closeKernel.delete();
    const openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, openKernel);
    openKernel.delete();
    hsv.delete(); gray.delete(); neutral.delete(); light.delete(); low.delete(); high.delete();
    return mask;
  }

  function rowCoverage(mask, x0, x1) {
    const out = new Float32Array(mask.rows);
    x0 = Math.max(0, Math.round(x0)); x1 = Math.min(mask.cols - 1, Math.round(x1));
    const width = Math.max(1, x1 - x0 + 1);
    for (let y = 0; y < mask.rows; y += 1) {
      const row = mask.ucharPtr(y);
      let n = 0;
      for (let x = x0; x <= x1; x += 1) if (row[x]) n += 1;
      out[y] = n / width;
    }
    return movingAverage(out, Math.max(1, Math.round(mask.rows * 0.0015)));
  }

  function columnProfile(mask, y0, y1) {
    const out = new Float32Array(mask.cols);
    y0 = Math.max(0, Math.round(y0)); y1 = Math.min(mask.rows - 1, Math.round(y1));
    const height = Math.max(1, y1 - y0 + 1);
    for (let y = y0; y <= y1; y += 1) {
      const row = mask.ucharPtr(y);
      for (let x = 0; x < mask.cols; x += 1) if (row[x]) out[x] += 1;
    }
    for (let x = 0; x < out.length; x += 1) out[x] /= height;
    return movingAverage(out, 2);
  }

  function findRuns(profile, threshold, minWidth, maxGap) {
    const raw = []; let start = -1;
    for (let i = 0; i <= profile.length; i += 1) {
      const on = i < profile.length && profile[i] >= threshold;
      if (on && start < 0) start = i;
      if (!on && start >= 0) { if (i - start >= minWidth) raw.push({ start, end: i - 1, width: i - start }); start = -1; }
    }
    const merged = [];
    raw.forEach((r) => {
      const last = merged[merged.length - 1];
      if (last && r.start - last.end <= maxGap) { last.end = r.end; last.width = last.end - last.start + 1; }
      else merged.push({ ...r });
    });
    return merged;
  }

  function chooseEightRuns(runs, cols) {
    let best = null;
    for (let s = 0; s <= runs.length - 8; s += 1) {
      const group = runs.slice(s, s + 8);
      const widths = group.map((r) => r.width);
      const centers = group.map((r) => (r.start + r.end) / 2);
      const gaps = centers.slice(1).map((c, i) => c - centers[i]);
      const span = group[7].end - group[0].start + 1;
      const spanRatio = span / cols;
      const widthCV = coefficientOfVariation(widths);
      const gapCV = coefficientOfVariation(gaps);
      if (spanRatio < 0.72 || spanRatio > 1.0) continue;
      if (mean(widths) < cols * 0.055 || mean(widths) > cols * 0.15) continue;
      const score = 4.5 - widthCV * 10 - gapCV * 12 - Math.abs(spanRatio - 0.91) * 3;
      if (!best || score > best.score) best = { group, centers, widths, gaps, spanRatio, widthCV, gapCV, score };
    }
    return best;
  }

  function findTableauTop(mask) {
    const x0 = mask.cols * 0.015, x1 = mask.cols * 0.985;
    const coverage = rowCoverage(mask, x0, x1);
    const yMin = Math.round(mask.rows * 0.24);
    const yMax = Math.round(mask.rows * 0.70);
    const bandH = Math.max(5, Math.round(mask.rows * 0.012));
    const candidates = [];
    for (let y = yMin; y < yMax; y += 2) {
      const now = mean(Array.from(coverage.slice(y, Math.min(coverage.length, y + bandH))));
      const below = mean(Array.from(coverage.slice(y + bandH, Math.min(coverage.length, y + bandH * 5))));
      const above = mean(Array.from(coverage.slice(Math.max(0, y - bandH * 2), y)));
      const rise = now - above;
      if (now < 0.28 || below < 0.20 || rise < 0.035) continue;
      const profile = columnProfile(mask, y, Math.min(mask.rows - 1, y + bandH * 2));
      const runs = findRuns(profile, 0.24, Math.max(6, Math.round(mask.cols * 0.035)), Math.max(2, Math.round(mask.cols * 0.009)));
      const fit = chooseEightRuns(runs, mask.cols);
      if (!fit) continue;
      const score = fit.score + now * 1.6 + below * 1.1 + rise * 2.0 - (y - yMin) / Math.max(1, yMax - yMin) * 0.25;
      candidates.push({ y, bandH, now, below, above, rise, fit, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) return { best: null, candidates: [], coverage };
    const nearBest = candidates.filter((c) => c.score >= candidates[0].score - 0.45);
    nearBest.sort((a, b) => a.y - b.y);
    return { best: nearBest[0], candidates: candidates.slice(0, 15), coverage };
  }

  function horizontalEdgeProfile(gray, centers, laneWidth, top, bottom) {
    const cv = window.cv;
    const grad = new cv.Mat();
    cv.Sobel(gray, grad, cv.CV_16S, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT);
    const abs = new cv.Mat(); cv.convertScaleAbs(grad, abs);
    const values = new Float32Array(gray.rows);
    const half = Math.max(3, Math.round(laneWidth * 0.30));
    for (let y = Math.max(1, top); y <= Math.min(gray.rows - 2, bottom); y += 1) {
      const row = abs.ucharPtr(y); let sum = 0, count = 0;
      centers.forEach((cx) => {
        for (let x = Math.max(0, Math.round(cx - half)); x <= Math.min(gray.cols - 1, Math.round(cx + half)); x += 1) { sum += row[x]; count += 1; }
      });
      values[y] = sum / Math.max(1, count);
    }
    grad.delete(); abs.delete();
    return movingAverage(values, Math.max(1, Math.round(gray.rows * 0.0015)));
  }

  function findPeriodicPeaks(profile, top, maxY, expectedMin, expectedMax) {
    const peaks = [];
    let maxV = 0;
    for (let y = top; y <= maxY; y += 1) maxV = Math.max(maxV, profile[y]);
    const threshold = maxV * 0.46;
    for (let y = top + 2; y < maxY - 2; y += 1) {
      if (profile[y] >= threshold && profile[y] >= profile[y - 1] && profile[y] >= profile[y + 1]) {
        if (!peaks.length || y - peaks[peaks.length - 1] >= expectedMin * 0.55) peaks.push(y);
        else if (profile[y] > profile[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = y;
      }
    }
    let bestStep = 0, bestScore = -Infinity;
    for (let step = expectedMin; step <= expectedMax; step += 1) {
      let score = 0;
      for (let k = 0; k < 7; k += 1) {
        const target = top + k * step;
        let nearest = 999;
        peaks.forEach((p) => { nearest = Math.min(nearest, Math.abs(p - target)); });
        score += Math.max(0, 1 - nearest / Math.max(2, step * 0.28));
      }
      if (score > bestScore) { bestScore = score; bestStep = step; }
    }
    return { peaks, step: bestStep, score: bestScore, maxV, threshold };
  }

  function rectangleSupport(mask, left, right, top, bottom) {
    const step = 3; let on = 0, total = 0;
    for (let y = top; y <= bottom; y += step) {
      const row = mask.ucharPtr(Math.max(0, Math.min(mask.rows - 1, y)));
      for (let x = left; x <= right; x += step) { if (row[Math.max(0, Math.min(mask.cols - 1, x))]) on += 1; total += 1; }
    }
    return on / Math.max(1, total);
  }

  function buildDetection(mask, gray, topResult) {
    const c = topResult.best;
    if (!c) throw new Error("No pale eight-column tableau top was found.");
    const centers = c.fit.centers;
    const spacing = median(c.fit.gaps);
    const left = Math.max(0, Math.round(centers[0] - spacing / 2));
    const right = Math.min(mask.cols - 1, Math.round(centers[7] + spacing / 2));
    const top = c.y;
    const edgeProfile = horizontalEdgeProfile(gray, centers, spacing, top, Math.min(mask.rows - 1, top + mask.rows * 0.42));
    const periodic = findPeriodicPeaks(edgeProfile, top, Math.min(mask.rows - 1, top + mask.rows * 0.38), Math.round(mask.rows * 0.026), Math.round(mask.rows * 0.065));
    let rowStep = periodic.step;
    if (!rowStep) rowStep = Math.round(mask.rows * 0.047);
    const cardWidth = spacing * 0.90;
    const cardHeight = cardWidth * 1.36;
    const bottomLeft = Math.min(mask.rows - 1, Math.round(top + 6 * rowStep + cardHeight));
    const bottomRight = Math.min(mask.rows - 1, Math.round(top + 5 * rowStep + cardHeight));
    const stepX = Math.round((centers[3] + centers[4]) / 2);
    const supportLeft = rectangleSupport(mask, left, stepX, top, bottomLeft);
    const supportRight = rectangleSupport(mask, stepX, right, top, bottomRight);
    const cardSupport = (supportLeft + supportRight) / 2;
    const stepHeight = bottomLeft - bottomRight;
    const expectedStep = rowStep;
    const rowEvidence = periodic.score / 7;
    const checks = {
      paleTableauTop: c.now > 0.28 && c.rise > 0.035,
      eightColumns: c.fit.group.length === 8,
      widthConsistency: c.fit.widthCV < 0.23,
      spacingConsistency: c.fit.gapCV < 0.16,
      boardSpan: c.fit.spanRatio > 0.73,
      repeatedRows: rowEvidence > 0.52,
      cardPixelSupport: cardSupport > 0.18,
      correctStep: stepHeight > expectedStep * 0.72 && stepHeight < expectedStep * 1.35
    };
    const passCount = Object.values(checks).filter(Boolean).length;
    const points = [
      { x: left, y: top }, { x: right, y: top }, { x: right, y: bottomRight },
      { x: stepX, y: bottomRight }, { x: stepX, y: bottomLeft }, { x: left, y: bottomLeft }
    ];
    const cardRows = centers.map((cx, i) => {
      const count = i < 4 ? 7 : 6;
      return Array.from({ length: count }, (_, r) => ({ x: cx, y: top + r * rowStep }));
    });
    return { left, right, top, bottomLeft, bottomRight, stepX, centers, spacing, rowStep, cardHeight, stepHeight, points, cardRows, checks, passCount, cardSupport, rowEvidence, topCandidate: c, periodic, edgeProfile };
  }

  function matToDataUrl(mat) {
    const canvas = document.createElement("canvas");
    window.cv.imshow(canvas, mat);
    return canvas.toDataURL("image/png");
  }

  function makeProfileFrame(resized, result, topResult) {
    const cv = window.cv;
    const frame = resized.clone();
    topResult.candidates.slice(0, 8).forEach((candidate, index) => {
      const color = index === 0 ? new cv.Scalar(0, 255, 0, 255) : new cv.Scalar(255, 170, 0, 255);
      cv.line(frame, new cv.Point(0, candidate.y), new cv.Point(frame.cols - 1, candidate.y), color, index === 0 ? 3 : 1);
    });
    result.periodic.peaks.forEach((y) => cv.line(frame, new cv.Point(result.left, y), new cv.Point(result.right, y), new cv.Scalar(255, 0, 255, 255), 1));
    cv.line(frame, new cv.Point(result.left, result.top), new cv.Point(result.right, result.top), new cv.Scalar(0, 255, 255, 255), 3);
    return frame;
  }

  function makeGeometryFrame(resized, result) {
    const cv = window.cv;
    const frame = resized.clone();
    result.cardRows.forEach((rows, i) => {
      rows.forEach((p) => {
        const half = result.spacing * 0.43;
        cv.rectangle(frame, new cv.Point(p.x - half, p.y), new cv.Point(p.x + half, p.y + Math.max(4, result.rowStep * 0.55)), new cv.Scalar(0, 255, 0, 255), 2);
      });
      cv.line(frame, new cv.Point(result.centers[i], result.top), new cv.Point(result.centers[i], i < 4 ? result.bottomLeft : result.bottomRight), new cv.Scalar(0, 255, 255, 255), 1);
    });
    const pts = result.points;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      cv.line(frame, new cv.Point(a.x, a.y), new cv.Point(b.x, b.y), new cv.Scalar(0, 255, 255, 255), 4);
    }
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
    polygon.setAttribute("class", result.passCount === 8 ? "scan-silhouette-good" : "scan-silhouette-review");
    svg.appendChild(polygon);
    for (let i = 1; i < 8; i += 1) {
      const x = (result.centers[i - 1] + result.centers[i]) / 2;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", x); line.setAttribute("x2", x); line.setAttribute("y1", result.top); line.setAttribute("y2", i <= 4 ? result.bottomLeft : result.bottomRight);
      line.setAttribute("class", "scan-silhouette-divider"); svg.appendChild(line);
    }
    overlay.appendChild(svg);

    summaryEl.textContent = `${result.passCount}/8 hierarchy checks passed • image ${image.naturalWidth} × ${image.naturalHeight}`;
    checksEl.replaceChildren();
    const labels = {
      paleTableauTop: "Pale tableau top", eightColumns: "Eight column lanes", widthConsistency: "Card-width consistency",
      spacingConsistency: "Column-spacing consistency", boardSpan: "Tableau spans board", repeatedRows: "Repeated card-row edges",
      cardPixelSupport: "Card-surface support", correctStep: "One-row bottom step"
    };
    Object.entries(result.checks).forEach(([key, pass]) => {
      const item = document.createElement("span"); item.className = "scan-column-count" + (pass ? "" : " scan-column-warning");
      item.textContent = `${labels[key]}: ${pass ? "Pass" : "Review"}`; checksEl.appendChild(item);
    });
    confirmButton.disabled = result.passCount < 8;
  }

  function renderDebugView() {
    if (!debugCanvas || !debugSelect) return;
    const frame = debugFrames[debugSelect.value];
    if (!frame) return;
    const pic = new Image();
    pic.onload = () => { debugCanvas.width = pic.naturalWidth; debugCanvas.height = pic.naturalHeight; debugCanvas.getContext("2d").drawImage(pic, 0, 0); };
    pic.src = frame;
  }

  function detectTableauShape() {
    if (!image.naturalWidth) return;
    if (!cvReady || !window.cv || typeof window.cv.imread !== "function") { updateCvStatus("OpenCV is not ready yet.", "warning"); return; }
    detectButton.disabled = true;
    updateCvStatus("Locating the pale tableau region, eight lanes, and repeated card rows…", "working");
    let src, resized, rgb, gray, mask, profileFrame, geometryFrame;
    try {
      ensureCanvas(); const cv = window.cv;
      src = cv.imread(sourceCanvas);
      const maxW = 900, scale = Math.min(1, maxW / src.cols);
      resized = new cv.Mat(); cv.resize(src, resized, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
      rgb = new cv.Mat(); cv.cvtColor(resized, rgb, cv.COLOR_RGBA2RGB);
      gray = new cv.Mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
      mask = makeStrictCardMask(rgb);
      const topResult = findTableauTop(mask);
      const small = buildDetection(mask, gray, topResult);
      profileFrame = makeProfileFrame(resized, small, topResult);
      geometryFrame = makeGeometryFrame(resized, small);
      debugFrames = { original: matToDataUrl(resized), mask: matToDataUrl(mask), profile: matToDataUrl(profileFrame), geometry: matToDataUrl(geometryFrame) };
      const inv = 1 / scale;
      detection = {
        ...small,
        points: small.points.map((p) => ({ x: p.x * inv, y: p.y * inv })),
        left: small.left * inv, right: small.right * inv, top: small.top * inv,
        bottomLeft: small.bottomLeft * inv, bottomRight: small.bottomRight * inv, stepX: small.stepX * inv,
        centers: small.centers.map((v) => v * inv), spacing: small.spacing * inv, rowStep: small.rowStep * inv,
        cardHeight: small.cardHeight * inv, confidence: small.passCount / 8
      };
      drawDetection(detection);
      if (debugPanel) debugPanel.hidden = false;
      renderDebugView();
      if (debugText) debugText.textContent = JSON.stringify({
        selectedTop: Math.round(small.top), topCoverage: Number(small.topCandidate.now.toFixed(3)), topRise: Number(small.topCandidate.rise.toFixed(3)),
        topCandidateScore: Number(small.topCandidate.score.toFixed(3)), widthCV: Number(small.topCandidate.fit.widthCV.toFixed(3)),
        spacingCV: Number(small.topCandidate.fit.gapCV.toFixed(3)), rowStep: Math.round(small.rowStep), rowEvidence: Number(small.rowEvidence.toFixed(3)),
        cardHeight: Math.round(small.cardHeight), cardSupport: Number(small.cardSupport.toFixed(3)), stepHeight: Math.round(small.stepHeight), passes: small.passCount
      }, null, 2);
      const perfect = detection.passCount === 8;
      updateCvStatus(perfect ? "Board detected. Review the cyan outline." : "Board candidate found. Open Debug View and review the failed check.", perfect ? "ready" : "warning");
      announce(perfect ? "Tableau geometry is ready for the card-strip stage." : "The detector found a candidate but will not confirm it until every hierarchy check passes.", perfect ? "success" : "");
    } catch (error) {
      console.error(error); clearDetection(); updateCvStatus(`Board not found: ${error.message}`, "warning");
      announce("OpenCV could not establish the tableau hierarchy in this image.", "error");
    } finally {
      [src, resized, rgb, gray, mask, profileFrame, geometryFrame].forEach((m) => { if (m && typeof m.delete === "function") m.delete(); });
      detectButton.disabled = false;
    }
  }

  function showDetails() {
    if (!detection) { announce("Detect the board first.", "error"); return; }
    detailsGrid.replaceChildren();
    const data = [
      ["Top", `${(detection.top / image.naturalHeight * 100).toFixed(1)}%`], ["Left", `${(detection.left / image.naturalWidth * 100).toFixed(1)}%`],
      ["Right", `${(detection.right / image.naturalWidth * 100).toFixed(1)}%`], ["Row step", `${(detection.rowStep / image.naturalHeight * 100).toFixed(2)}%`],
      ["Columns 1–4 bottom", `${(detection.bottomLeft / image.naturalHeight * 100).toFixed(1)}%`], ["Columns 5–8 bottom", `${(detection.bottomRight / image.naturalHeight * 100).toFixed(1)}%`],
      ["Card-surface support", `${Math.round(detection.cardSupport * 100)}%`], ["Confidence", `${Math.round(detection.confidence * 100)}%`]
    ];
    data.forEach(([name, value]) => { const box = document.createElement("div"); box.className = "scan-shape-detail"; box.innerHTML = `<strong>${name}</strong><span>${value}</span>`; detailsGrid.appendChild(box); });
    detailsPanel.hidden = false; detailsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function confirmShape() {
    if (!detection || detection.passCount < 8) return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ version: 18, detector: "opencv-hierarchical-tableau", imageName: selectedFile ? selectedFile.name : "board image", imageWidth: image.naturalWidth, imageHeight: image.naturalHeight, silhouette: detection, savedAt: new Date().toISOString() }));
    setDialogOpen(false); announce("Tableau geometry saved for the card-strip stage.", "success");
  }

  function showImage(file) {
    if (!file || (file.type && !file.type.startsWith("image/"))) { announce("Choose a valid image file.", "error"); return; }
    cleanUrl(); selectedFile = file; objectUrl = URL.createObjectURL(file);
    image.onload = () => { sourceCanvas = null; pickerPanel.hidden = true; previewPanel.hidden = false; clearDetection(); updateCvStatus(cvReady ? "Image loaded. Detecting board…" : "Image loaded. Waiting for OpenCV…", "working"); if (cvReady) window.setTimeout(detectTableauShape, 30); };
    image.onerror = () => announce("The selected image could not be displayed.", "error"); image.src = objectUrl;
  }

  function handleSelection() { const file = pictureInput.files && pictureInput.files[0]; if (file) showImage(file); }
  if (!openButton || !dialog || !pictureInput) return;
  initializeOpenCv(); detectButton.disabled = true; confirmButton.disabled = true;
  openButton.addEventListener("click", () => setDialogOpen(true)); closeButton.addEventListener("click", () => setDialogOpen(false));
  dialog.querySelectorAll("[data-scan-cancel]").forEach((node) => node.addEventListener("click", () => setDialogOpen(false)));
  pictureInput.addEventListener("change", handleSelection); pictureInput.addEventListener("input", handleSelection);
  chooseAnotherButton.addEventListener("click", showPicker); resetButton.addEventListener("click", clearDetection);
  detectButton.addEventListener("click", detectTableauShape); detailsButton.addEventListener("click", showDetails); confirmButton.addEventListener("click", confirmShape);
  if (debugSelect) debugSelect.addEventListener("change", renderDebugView);
  window.addEventListener("beforeunload", cleanUrl);
}());
