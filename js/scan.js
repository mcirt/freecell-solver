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

  const SESSION_KEY = "freecellPendingScanV23";
  const TEMPLATE = Object.freeze({
    columns: 8,
    leftColumns: 4,
    rowStepToWidth: 0.072,
    fullCardHeightToWidth: 0.165,
    laneWidthToPitch: 0.94,
    cropHeightToRowStep: 0.78
  });

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
    if (debugPanel) {
      debugPanel.hidden = true;
      debugPanel.open = false;
    }
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
    if (sourceCanvas &&
        sourceCanvas.width === image.naturalWidth &&
        sourceCanvas.height === image.naturalHeight) return;
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = image.naturalWidth;
    sourceCanvas.height = image.naturalHeight;
    sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  }

  function makeStrictCardMask(rgb) {
    const cv = window.cv;
    const hsv = new cv.Mat();
    const gray = new cv.Mat();
    const neutral = new cv.Mat();
    const light = new cv.Mat();
    const mask = new cv.Mat();

    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

    const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 138, 0]);
    const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 92, 255, 255]);
    cv.inRange(hsv, low, high, neutral);
    cv.threshold(gray, light, 138, 255, cv.THRESH_BINARY);
    cv.bitwise_and(neutral, light, mask);

    // Close small holes created by ranks and suits without joining the upper slots
    // to the tableau.
    const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel);
    closeKernel.delete();

    hsv.delete(); gray.delete(); neutral.delete(); light.delete(); low.delete(); high.delete();
    return mask;
  }

  function makeIntegral(mask) {
    const width = mask.cols;
    const height = mask.rows;
    const stride = width + 1;
    const integral = new Uint32Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y += 1) {
      const row = mask.ucharPtr(y);
      let running = 0;
      const out = (y + 1) * stride;
      const prev = y * stride;
      for (let x = 0; x < width; x += 1) {
        running += row[x] ? 1 : 0;
        integral[out + x + 1] = integral[prev + x + 1] + running;
      }
    }
    return { data: integral, width, height, stride };
  }

  function rectSum(ii, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.min(ii.width, Math.round(x0)));
    x1 = Math.max(0, Math.min(ii.width, Math.round(x1)));
    y0 = Math.max(0, Math.min(ii.height, Math.round(y0)));
    y1 = Math.max(0, Math.min(ii.height, Math.round(y1)));
    if (x1 <= x0 || y1 <= y0) return 0;
    const a = ii.data[y0 * ii.stride + x0];
    const b = ii.data[y0 * ii.stride + x1];
    const c = ii.data[y1 * ii.stride + x0];
    const d = ii.data[y1 * ii.stride + x1];
    return d - b - c + a;
  }

  function rectRatio(ii, x0, y0, x1, y1) {
    const area = Math.max(1, (Math.round(x1) - Math.round(x0)) * (Math.round(y1) - Math.round(y0)));
    return rectSum(ii, x0, y0, x1, y1) / area;
  }

  function templateGeometry(left, top, width) {
    const pitch = width / TEMPLATE.columns;
    const laneWidth = pitch * TEMPLATE.laneWidthToPitch;
    const rowStep = width * TEMPLATE.rowStepToWidth;
    const fullCardHeight = width * TEMPLATE.fullCardHeightToWidth;
    const leftHeight = 6 * rowStep + fullCardHeight;
    const rightHeight = 5 * rowStep + fullCardHeight;
    const centers = Array.from({ length: 8 }, (_, i) => left + (i + 0.5) * pitch);
    return {
      left, top, width, right: left + width, pitch, laneWidth, rowStep,
      fullCardHeight, leftHeight, rightHeight,
      bottomLeft: top + leftHeight,
      bottomRight: top + rightHeight,
      stepX: left + 4 * pitch,
      centers
    };
  }

  function scoreTemplate(ii, g) {
    if (g.left < 0 || g.top < 0 || g.right > ii.width ||
        g.bottomLeft > ii.height || g.bottomRight > ii.height) return null;

    const half = g.laneWidth / 2;
    const laneSupports = [];
    for (let i = 0; i < 8; i += 1) {
      const h = i < 4 ? g.leftHeight : g.rightHeight;
      laneSupports.push(rectRatio(ii, g.centers[i] - half, g.top, g.centers[i] + half, g.top + h));
    }

    const gapSupports = [];
    const gapHalf = Math.max(1.5, (g.pitch - g.laneWidth) * 0.43);
    for (let i = 1; i < 8; i += 1) {
      const x = g.left + i * g.pitch;
      const h = i <= 4 ? g.leftHeight : g.rightHeight;
      gapSupports.push(rectRatio(ii, x - gapHalf, g.top, x + gapHalf, g.top + h));
    }

    const aboveH = Math.max(5, g.rowStep * 0.34);
    const aboveSupport = rectRatio(ii, g.left, g.top - aboveH, g.right, g.top - 1);
    const belowBand = Math.max(5, g.rowStep * 0.30);
    const belowLeft = rectRatio(ii, g.left, g.bottomLeft + 1, g.stepX, g.bottomLeft + belowBand);
    const belowRight = rectRatio(ii, g.stepX, g.bottomRight + 1, g.right, g.bottomRight + belowBand);

    // Check the shared tableau top as a thin horizontal band. A correct fit has
    // strong card support immediately below and substantially less immediately above.
    const topBand = Math.max(4, g.rowStep * 0.18);
    const topInside = rectRatio(ii, g.left, g.top, g.right, g.top + topBand);
    const topContrast = topInside - aboveSupport;

    const laneMean = laneSupports.reduce((a, b) => a + b, 0) / 8;
    const laneMin = Math.min(...laneSupports);
    const gapMean = gapSupports.reduce((a, b) => a + b, 0) / Math.max(1, gapSupports.length);
    const bottomDarkness = 1 - ((belowLeft + belowRight) / 2);

    const score =
      laneMean * 5.2 +
      laneMin * 1.7 +
      Math.max(0, topContrast) * 2.6 +
      (1 - gapMean) * 1.0 +
      bottomDarkness * 1.1 -
      aboveSupport * 1.6;

    return {
      score, laneSupports, laneMean, laneMin, gapMean,
      aboveSupport, belowLeft, belowRight, bottomDarkness,
      topInside, topContrast
    };
  }

  function fitTemplate(mask) {
    const ii = makeIntegral(mask);
    const w = mask.cols;
    const h = mask.rows;
    let best = null;
    const candidates = [];

    function consider(left, top, width) {
      const geometry = templateGeometry(left, top, width);
      const metrics = scoreTemplate(ii, geometry);
      if (!metrics) return;
      const candidate = { geometry, metrics };
      candidates.push(candidate);
      if (!best || metrics.score > best.metrics.score) best = candidate;
    }

    // Coarse search. The actual tableau spans most of the screenshot width,
    // but position and scale vary by phone and by screenshot cropping.
    const minWidth = Math.round(w * 0.78);
    const maxWidth = Math.round(w * 0.995);
    for (let width = minWidth; width <= maxWidth; width += Math.max(8, Math.round(w * 0.012))) {
      const leftMax = Math.max(0, w - width);
      const yMin = Math.round(h * 0.24);
      const yMax = Math.min(Math.round(h * 0.68), Math.round(h - width * 0.61));
      for (let left = 0; left <= leftMax; left += Math.max(4, Math.round(w * 0.008))) {
        for (let top = yMin; top <= yMax; top += Math.max(5, Math.round(h * 0.006))) {
          consider(left, top, width);
        }
      }
    }

    if (!best) throw new Error("No tableau-template candidate fit inside the image.");

    // Fine search around the best coarse match.
    const coarse = best.geometry;
    const fineCandidates = [];
    best = null;
    for (let width = coarse.width - 16; width <= coarse.width + 16; width += 2) {
      for (let left = coarse.left - 12; left <= coarse.left + 12; left += 2) {
        for (let top = coarse.top - 18; top <= coarse.top + 18; top += 2) {
          const geometry = templateGeometry(left, top, width);
          const metrics = scoreTemplate(ii, geometry);
          if (!metrics) continue;
          const candidate = { geometry, metrics };
          fineCandidates.push(candidate);
          if (!best || metrics.score > best.metrics.score) best = candidate;
        }
      }
    }

    // Find a meaningfully different alternative, not just the adjacent pixel.
    const alternatives = candidates.concat(fineCandidates).filter((candidate) => {
      const a = candidate.geometry;
      const b = best.geometry;
      return Math.abs(a.left - b.left) > b.pitch * 0.45 ||
             Math.abs(a.top - b.top) > b.rowStep * 0.55 ||
             Math.abs(a.width - b.width) > b.pitch * 0.40;
    }).sort((a, b) => b.metrics.score - a.metrics.score);

    const second = alternatives[0] || null;
    const margin = second ? best.metrics.score - second.metrics.score : best.metrics.score;

    return { best, second, margin };
  }

  function buildCardRegions(g) {
    const regions = [];
    const cropH = Math.max(8, g.rowStep * TEMPLATE.cropHeightToRowStep);
    for (let col = 0; col < 8; col += 1) {
      const count = col < 4 ? 7 : 6;
      const left = g.left + col * g.pitch;
      for (let row = 0; row < count; row += 1) {
        regions.push({
          id: `C${col + 1}-${row + 1}`,
          column: col + 1,
          row: row + 1,
          x: left,
          y: g.top + row * g.rowStep,
          width: g.pitch,
          height: cropH
        });
      }
    }
    return regions;
  }

  function matToDataUrl(mat) {
    const canvas = document.createElement("canvas");
    cv.imshow(canvas, mat);
    return canvas.toDataURL("image/png");
  }

  function canvasDataUrl(draw) {
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext("2d");
    draw(ctx, canvas);
    return canvas.toDataURL("image/png");
  }

  function drawTemplate(ctx, g, options = {}) {
    const lineWidth = options.lineWidth || Math.max(2, g.width * 0.004);
    const outline = options.outline || "#00ffff";
    const rowColor = options.rowColor || "#39ff70";
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = outline;
    ctx.beginPath();
    ctx.moveTo(g.left, g.top);
    ctx.lineTo(g.right, g.top);
    ctx.lineTo(g.right, g.bottomRight);
    ctx.lineTo(g.stepX, g.bottomRight);
    ctx.lineTo(g.stepX, g.bottomLeft);
    ctx.lineTo(g.left, g.bottomLeft);
    ctx.closePath();
    ctx.stroke();

    ctx.setLineDash([lineWidth * 2.2, lineWidth * 2.2]);
    for (let i = 1; i < 8; i += 1) {
      const x = g.left + i * g.pitch;
      ctx.beginPath();
      ctx.moveTo(x, g.top);
      ctx.lineTo(x, i <= 4 ? g.bottomLeft : g.bottomRight);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = rowColor;
    ctx.lineWidth = Math.max(1, lineWidth * 0.55);
    for (let row = 1; row < 7; row += 1) {
      const y = g.top + row * g.rowStep;
      ctx.beginPath();
      ctx.moveTo(g.left, y);
      ctx.lineTo(row < 6 ? g.right : g.stepX, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function makeDebugFrames(mask, result) {
    const inv = result.inverseScale;
    const g = result.geometryOriginal;
    const templateMask = document.createElement("canvas");
    templateMask.width = mask.cols;
    templateMask.height = mask.rows;
    const tm = templateMask.getContext("2d");
    tm.fillStyle = "black";
    tm.fillRect(0, 0, templateMask.width, templateMask.height);
    tm.fillStyle = "white";
    const smallG = result.geometrySmall;
    const half = smallG.laneWidth / 2;
    smallG.centers.forEach((center, i) => {
      const height = i < 4 ? smallG.leftHeight : smallG.rightHeight;
      tm.fillRect(center - half, smallG.top, smallG.laneWidth, height);
    });

    const overlayFrame = canvasDataUrl((ctx) => {
      ctx.drawImage(sourceCanvas, 0, 0);
      drawTemplate(ctx, g, { outline: "#00ffff", rowColor: "#39ff70" });
    });

    const regionFrame = canvasDataUrl((ctx) => {
      ctx.drawImage(sourceCanvas, 0, 0);
      ctx.lineWidth = Math.max(1, g.width * 0.0025);
      ctx.strokeStyle = "#39ff70";
      result.cardRegions.forEach((r) => ctx.strokeRect(r.x, r.y, r.width, r.height));
      drawTemplate(ctx, g, { outline: "#00ffff", rowColor: "rgba(57,255,112,.7)" });
    });

    return {
      original: sourceCanvas.toDataURL("image/png"),
      mask: matToDataUrl(mask),
      template: templateMask.toDataURL("image/png"),
      match: overlayFrame,
      geometry: regionFrame
    };
  }

  function drawDetection(result) {
    overlay.replaceChildren();
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${image.naturalWidth} ${image.naturalHeight}`);
    svg.setAttribute("preserveAspectRatio", "none");

    const polygon = document.createElementNS(ns, "polygon");
    polygon.setAttribute("points", result.points.map((p) => `${p.x},${p.y}`).join(" "));
    polygon.setAttribute("class", result.passCount === 8 ? "scan-silhouette-good" : "scan-silhouette-review");
    svg.appendChild(polygon);

    for (let i = 1; i < 8; i += 1) {
      const x = result.left + i * result.spacing;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", x);
      line.setAttribute("x2", x);
      line.setAttribute("y1", result.top);
      line.setAttribute("y2", i <= 4 ? result.bottomLeft : result.bottomRight);
      line.setAttribute("class", "scan-silhouette-divider");
      svg.appendChild(line);
    }

    overlay.appendChild(svg);
    const mappingOk = overlay.offsetWidth === image.offsetWidth &&
                      overlay.offsetHeight === image.offsetHeight;
    summaryEl.textContent =
      `${result.passCount}/8 template checks passed • image ${image.naturalWidth} × ${image.naturalHeight} • overlay ${mappingOk ? "mapped" : "review"}`;

    checksEl.replaceChildren();
    const labels = {
      templateFound: "Tableau template located",
      surfaceOverlap: "Card-surface overlap",
      laneMinimum: "All eight lanes supported",
      darkColumnGaps: "Column-gap separation",
      sharedTop: "Shared top boundary",
      steppedBottom: "Stepped bottom boundary",
      plausibleScale: "Plausible tableau scale",
      uniqueMatch: "Best-match separation"
    };
    Object.entries(result.checks).forEach(([key, pass]) => {
      const item = document.createElement("span");
      item.className = "scan-column-count" + (pass ? "" : " scan-column-warning");
      item.textContent = `${labels[key]}: ${pass ? "Pass" : "Review"}`;
      checksEl.appendChild(item);
    });
    confirmButton.disabled = result.passCount < 8;
  }

  function renderDebugView() {
    if (!debugCanvas || !debugSelect) return;
    const frame = debugFrames[debugSelect.value];
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
      updateCvStatus("OpenCV is not ready yet.", "warning");
      return;
    }

    detectButton.disabled = true;
    updateCvStatus("Fitting the fixed 8-column tableau template to the card-surface mask…", "working");

    let src, resized, rgb, mask;
    try {
      ensureCanvas();
      const cv = window.cv;
      src = cv.imread(sourceCanvas);
      const maxW = 850;
      const scale = Math.min(1, maxW / src.cols);
      resized = new cv.Mat();
      cv.resize(src, resized,
        new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)),
        0, 0, cv.INTER_AREA);
      rgb = new cv.Mat();
      cv.cvtColor(resized, rgb, cv.COLOR_RGBA2RGB);
      mask = makeStrictCardMask(rgb);

      const fit = fitTemplate(mask);
      const g = fit.best.geometry;
      const m = fit.best.metrics;
      const inv = 1 / scale;
      const original = templateGeometry(g.left * inv, g.top * inv, g.width * inv);
      const regions = buildCardRegions(original);

      const checks = {
        templateFound: true,
        surfaceOverlap: m.laneMean >= 0.52,
        laneMinimum: m.laneMin >= 0.36,
        darkColumnGaps: m.gapMean <= 0.52,
        sharedTop: m.topInside >= 0.48 && m.topContrast >= 0.10,
        steppedBottom: m.bottomDarkness >= 0.58,
        plausibleScale: g.width / mask.cols >= 0.78 && g.width / mask.cols <= 1.0,
        uniqueMatch: fit.margin >= 0.16 || m.score >= 8.0
      };
      const passCount = Object.values(checks).filter(Boolean).length;

      const result = {
        geometrySmall: g,
        geometryOriginal: original,
        inverseScale: inv,
        metrics: m,
        secondScore: fit.second ? fit.second.metrics.score : null,
        margin: fit.margin,
        checks,
        passCount,
        cardRegions: regions,
        left: original.left,
        right: original.right,
        top: original.top,
        bottomLeft: original.bottomLeft,
        bottomRight: original.bottomRight,
        stepX: original.stepX,
        spacing: original.pitch,
        rowStep: original.rowStep,
        cardHeight: original.fullCardHeight,
        centers: original.centers,
        points: [
          { x: original.left, y: original.top },
          { x: original.right, y: original.top },
          { x: original.right, y: original.bottomRight },
          { x: original.stepX, y: original.bottomRight },
          { x: original.stepX, y: original.bottomLeft },
          { x: original.left, y: original.bottomLeft }
        ],
        confidence: Math.max(0, Math.min(1, m.score / 9.0))
      };

      detection = result;
      debugFrames = makeDebugFrames(mask, result);
      drawDetection(result);
      if (debugPanel) debugPanel.hidden = false;
      renderDebugView();

      if (debugText) {
        debugText.textContent = JSON.stringify({
          detector: "fixed-tableau-template-v26",
          templateRatios: TEMPLATE,
          x: Math.round(original.left),
          y: Math.round(original.top),
          width: Math.round(original.width),
          pitch: Number(original.pitch.toFixed(2)),
          rowStep: Number(original.rowStep.toFixed(2)),
          fullCardHeight: Number(original.fullCardHeight.toFixed(2)),
          leftBottom: Math.round(original.bottomLeft),
          rightBottom: Math.round(original.bottomRight),
          bestScore: Number(m.score.toFixed(3)),
          secondBestScore: fit.second ? Number(fit.second.metrics.score.toFixed(3)) : null,
          scoreMargin: Number(fit.margin.toFixed(3)),
          laneMean: Number(m.laneMean.toFixed(3)),
          laneMinimum: Number(m.laneMin.toFixed(3)),
          laneSupports: m.laneSupports.map((v) => Number(v.toFixed(3))),
          gapSupport: Number(m.gapMean.toFixed(3)),
          sharedTopInside: Number(m.topInside.toFixed(3)),
          sharedTopContrast: Number(m.topContrast.toFixed(3)),
          darknessBelowBottoms: Number(m.bottomDarkness.toFixed(3)),
          cardRegions: regions.map((r) => ({
            id: r.id,
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height)
          })),
          checks,
          passes: passCount
        }, null, 2);
      }

      const perfect = passCount === 8;
      updateCvStatus(
        perfect
          ? "Board detected. Review the cyan template."
          : "Template candidate found. Open Debug View and review the failed check.",
        perfect ? "ready" : "warning"
      );
      announce(
        perfect
          ? "The fixed tableau template is aligned and all 52 card regions are known."
          : "The template fit is visible, but confirmation remains disabled until every check passes.",
        perfect ? "success" : ""
      );
    } catch (error) {
      console.error(error);
      clearDetection();
      updateCvStatus(`Board not found: ${error.message}`, "warning");
      announce("OpenCV could not fit the fixed tableau template to this image.", "error");
    } finally {
      [src, resized, rgb, mask].forEach((m) => {
        if (m && typeof m.delete === "function") m.delete();
      });
      detectButton.disabled = false;
    }
  }

  function recognitionCropForRegion(region) {
    // v25: wider and slightly taller than v24 so the entire rank and small suit
    // symbol remain visible. The crop still stays inside one fitted column lane.
    const insetX = detection.spacing * 0.012;
    const insetY = detection.rowStep * 0.018;
    const width = detection.spacing * 0.93;
    const height = detection.rowStep * 0.86;

    return {
      x: Math.max(0, region.x + insetX),
      y: Math.max(0, region.y + insetY),
      width: Math.min(width, image.naturalWidth - region.x - insetX),
      height: Math.min(height, image.naturalHeight - region.y - insetY)
    };
  }

  function rankAndSuitRegions(crop) {
    // The regions overlap slightly on purpose. The 10 is wider than other ranks,
    // while the suit symbol sometimes begins farther left on different phones.
    return {
      rank: {
        x: crop.x,
        y: crop.y,
        width: crop.width * 0.63,
        height: crop.height * 0.96
      },
      suit: {
        x: crop.x + crop.width * 0.50,
        y: crop.y,
        width: crop.width * 0.50,
        height: crop.height * 0.96
      }
    };
  }

  function cropCanvasFromSource(crop) {
    const width = Math.max(1, Math.round(crop.width));
    const height = Math.max(1, Math.round(crop.height));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sourceCanvas,
      Math.round(crop.x),
      Math.round(crop.y),
      width,
      height,
      0,
      0,
      width,
      height
    );
    return canvas;
  }

  function normalizedSymbolCanvas(source, targetWidth, targetHeight) {
    const srcCtx = source.getContext("2d", { willReadFrequently: true });
    const imageData = srcCtx.getImageData(0, 0, source.width, source.height);
    const data = imageData.data;

    let minX = source.width;
    let minY = source.height;
    let maxX = -1;
    let maxY = -1;
    let redPixels = 0;
    let darkPixels = 0;

    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const i = (y * source.width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const brightness = (r + g + b) / 3;
        const red = r > g * 1.28 && r > b * 1.28 && r > 105;
        const dark = brightness < 132 && Math.max(r, g, b) - Math.min(r, g, b) < 95;
        const foreground = red || dark;

        data[i] = foreground ? 0 : 255;
        data[i + 1] = foreground ? 0 : 255;
        data[i + 2] = foreground ? 0 : 255;
        data[i + 3] = 255;

        if (foreground) {
          if (red) redPixels += 1;
          if (dark) darkPixels += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    srcCtx.putImageData(imageData, 0, 0);

    const normalized = document.createElement("canvas");
    normalized.width = targetWidth;
    normalized.height = targetHeight;
    const out = normalized.getContext("2d");
    out.fillStyle = "#fff";
    out.fillRect(0, 0, targetWidth, targetHeight);
    out.imageSmoothingEnabled = true;
    out.imageSmoothingQuality = "high";

    if (maxX >= minX && maxY >= minY) {
      const contentWidth = maxX - minX + 1;
      const contentHeight = maxY - minY + 1;
      const padding = 5;
      const scale = Math.min(
        (targetWidth - padding * 2) / contentWidth,
        (targetHeight - padding * 2) / contentHeight
      );
      const drawWidth = contentWidth * scale;
      const drawHeight = contentHeight * scale;
      out.drawImage(
        source,
        minX,
        minY,
        contentWidth,
        contentHeight,
        (targetWidth - drawWidth) / 2,
        (targetHeight - drawHeight) / 2,
        drawWidth,
        drawHeight
      );
    }

    return {
      canvas: normalized,
      foregroundBounds: maxX >= minX ? { minX, minY, maxX, maxY } : null,
      colorFamily: redPixels > darkPixels * 0.65 ? "red" : "black",
      redPixels,
      darkPixels
    };
  }

  function makeCropCanvas(crop) {
    const canvas = document.createElement("canvas");
    const sourceWidth = Math.max(1, Math.round(crop.width));
    const sourceHeight = Math.max(1, Math.round(crop.height));

    // Preserve the complete extraction rectangle. CSS uses object-fit: contain,
    // so no edge of the bitmap is hidden in the thumbnail.
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sourceCanvas,
      Math.round(crop.x),
      Math.round(crop.y),
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight
    );
    return canvas;
  }

  function showDetails() {
    if (!detection) {
      announce("Detect the board first.", "error");
      return;
    }

    ensureCanvas();
    detailsGrid.replaceChildren();
    const recognitionRegions = [];

    detection.cardRegions.forEach((region) => {
      const crop = recognitionCropForRegion(region);
      const rois = rankAndSuitRegions(crop);

      const article = document.createElement("article");
      article.className = "scan-recognition-review";

      const header = document.createElement("header");
      header.innerHTML = `<strong>${region.id}</strong><small>${Math.round(crop.width)}×${Math.round(crop.height)} px source</small>`;

      const original = makeCropCanvas(crop);
      original.className = "scan-recognition-original";
      original.setAttribute("aria-label", `${region.id} complete extraction`);

      const rankSource = cropCanvasFromSource(rois.rank);
      const suitSource = cropCanvasFromSource(rois.suit);
      const rankMask = normalizedSymbolCanvas(rankSource, 64, 80);
      const suitMask = normalizedSymbolCanvas(suitSource, 64, 80);

      const rows = document.createElement("div");
      rows.className = "scan-recognition-rows";

      const originalBox = document.createElement("figure");
      originalBox.className = "scan-recognition-box scan-recognition-full";
      originalBox.innerHTML = "<figcaption>Full extraction</figcaption>";
      originalBox.prepend(original);

      const rankBox = document.createElement("figure");
      rankBox.className = "scan-recognition-box";
      rankBox.innerHTML = "<figcaption>Rank ROI</figcaption>";
      rankBox.prepend(rankSource);

      const suitBox = document.createElement("figure");
      suitBox.className = "scan-recognition-box";
      suitBox.innerHTML = "<figcaption>Suit ROI</figcaption>";
      suitBox.prepend(suitSource);

      const rankMaskBox = document.createElement("figure");
      rankMaskBox.className = "scan-recognition-box";
      rankMaskBox.innerHTML = "<figcaption>Rank mask</figcaption>";
      rankMaskBox.prepend(rankMask.canvas);

      const suitMaskBox = document.createElement("figure");
      suitMaskBox.className = "scan-recognition-box";
      suitMaskBox.innerHTML = "<figcaption>Suit mask</figcaption>";
      suitMaskBox.prepend(suitMask.canvas);

      rows.append(originalBox, rankBox, suitBox, rankMaskBox, suitMaskBox);

      const status = document.createElement("p");
      status.className = "scan-recognition-status";
      status.innerHTML =
        `<span>Suit color family: <strong>${suitMask.colorFamily}</strong></span>` +
        `<span>Rank prediction: <strong>next build</strong></span>` +
        `<span>Suit prediction: <strong>next build</strong></span>`;

      article.append(header, rows, status);
      detailsGrid.appendChild(article);

      recognitionRegions.push({
        id: region.id,
        extraction: crop,
        rank: rois.rank,
        suit: rois.suit,
        rankBounds: rankMask.foregroundBounds,
        suitBounds: suitMask.foregroundBounds,
        suitColorFamily: suitMask.colorFamily
      });
    });

    detection.recognitionRegions = recognitionRegions;
    detailsPanel.hidden = false;
    detailsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    announce("Showing the full extraction, rank ROI, suit ROI, and normalized masks for all 52 cards.", "success");
  }

  function confirmShape() {
    if (!detection || detection.passCount < 8) return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      version: 26,
      detector: "opencv-fixed-tableau-template",
      imageName: selectedFile ? selectedFile.name : "board image",
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      silhouette: detection,
      cardRegions: detection.cardRegions,
      savedAt: new Date().toISOString()
    }));
    setDialogOpen(false);
    announce("Tableau template and all 52 card regions were saved.", "success");
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
      updateCvStatus(
        cvReady ? "Image loaded. Fitting tableau template…" : "Image loaded. Waiting for OpenCV…",
        "working"
      );
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
  dialog.querySelectorAll("[data-scan-cancel]")
    .forEach((node) => node.addEventListener("click", () => setDialogOpen(false)));
  pictureInput.addEventListener("change", handleSelection);
  pictureInput.addEventListener("input", handleSelection);
  chooseAnotherButton.addEventListener("click", showPicker);
  resetButton.addEventListener("click", clearDetection);
  detectButton.addEventListener("click", detectTableauShape);
  detailsButton.addEventListener("click", showDetails);
  confirmButton.addEventListener("click", confirmShape);
  if (debugSelect) debugSelect.addEventListener("change", renderDebugView);

  window.addEventListener("resize", () => {
    if (detection) drawDetection(detection);
  });

  showPicker();
}());
