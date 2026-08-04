(function (global) {
  "use strict";

  const TEMPLATE = Object.freeze({
    columns: 8,
    leftColumns: 4,
    rowStepToWidth: 0.072,
    fullCardHeightToWidth: 0.165,
    laneWidthToPitch: 0.94
  });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  }

  function mad(values, center) {
    return median(values.map((value) => Math.abs(value - center)));
  }

  function canvasFromMat(cv, mat) {
    const canvas = document.createElement("canvas");
    canvas.width = mat.cols;
    canvas.height = mat.rows;
    cv.imshow(canvas, mat);
    return canvas;
  }

  function cropCanvas(sourceCanvas, rect) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(
      sourceCanvas,
      rect.x, rect.y, rect.width, rect.height,
      0, 0, canvas.width, canvas.height
    );
    return canvas;
  }

  function rowEvidence(mask, y) {
    const row = mask.ucharPtr(y, 0);
    let left = -1;
    let right = -1;
    let white = 0;
    let longestRun = 0;
    let run = 0;

    for (let x = 0; x < mask.cols; x += 1) {
      if (row[x] > 0) {
        if (left < 0) left = x;
        right = x;
        white += 1;
        run += 1;
        if (run > longestRun) longestRun = run;
      } else {
        run = 0;
      }
    }

    return {
      y,
      left,
      right,
      span: left >= 0 ? right - left + 1 : 0,
      white,
      whiteRatio: white / Math.max(1, mask.cols),
      longestRun
    };
  }

  function robustTableauEdges(mask) {
    const minimumSpan = mask.cols * 0.52;
    const minimumWhite = mask.cols * 0.10;
    const rawRows = [];

    for (let y = 0; y < mask.rows; y += 1) {
      const evidence = rowEvidence(mask, y);
      if (evidence.span >= minimumSpan && evidence.white >= minimumWhite) rawRows.push(evidence);
    }

    if (rawRows.length < Math.max(12, mask.rows * 0.035)) {
      return { pass: false, reason: "insufficient stable edge evidence", rawRows, acceptedRows: [] };
    }

    const rawLeft = median(rawRows.map((row) => row.left));
    const rawRight = median(rawRows.map((row) => row.right));
    const leftMad = Math.max(2, mad(rawRows.map((row) => row.left), rawLeft));
    const rightMad = Math.max(2, mad(rawRows.map((row) => row.right), rawRight));
    const tolerance = Math.max(5, mask.cols * 0.018, leftMad * 3.5, rightMad * 3.5);

    let acceptedRows = rawRows.filter((row) =>
      Math.abs(row.left - rawLeft) <= tolerance &&
      Math.abs(row.right - rawRight) <= tolerance
    );

    if (acceptedRows.length < Math.max(10, rawRows.length * 0.35)) {
      return { pass: false, reason: "edge rows disagree too widely", rawRows, acceptedRows };
    }

    const measuredLeft = Math.round(median(acceptedRows.map((row) => row.left)));
    const measuredRight = Math.round(median(acceptedRows.map((row) => row.right)));
    const measuredTop = Math.round(percentile(acceptedRows.map((row) => row.y), 0.03));
    const evidenceBottom = Math.round(percentile(acceptedRows.map((row) => row.y), 0.97));
    const width = measuredRight - measuredLeft + 1;

    // Re-check rows against the final edges. This rejects isolated bezel highlights
    // and keeps measurement, overlay, and crop in one work-canvas coordinate space.
    const finalTolerance = Math.max(5, width * 0.025);
    acceptedRows = acceptedRows.filter((row) =>
      Math.abs(row.left - measuredLeft) <= finalTolerance &&
      Math.abs(row.right - measuredRight) <= finalTolerance
    );

    const leftSpread = mad(acceptedRows.map((row) => row.left), measuredLeft);
    const rightSpread = mad(acceptedRows.map((row) => row.right), measuredRight);
    const stableFraction = acceptedRows.length / Math.max(1, rawRows.length);
    const widthRatio = width / mask.cols;
    const expectedHeight = width * (6 * TEMPLATE.rowStepToWidth + TEMPLATE.fullCardHeightToWidth);
    const measuredBottom = Math.min(mask.rows - 1, Math.round(measuredTop + expectedHeight));
    const verticalEvidence = Math.max(0, Math.min(1, (evidenceBottom - measuredTop) / Math.max(1, expectedHeight)));
    const spreadScore = Math.max(0, 1 - ((leftSpread + rightSpread) / Math.max(1, width * 0.05)));
    const widthScore = Math.max(0, 1 - Math.abs(widthRatio - 0.88) / 0.32);
    const confidence = clamp(
      stableFraction * 0.38 + spreadScore * 0.30 + widthScore * 0.18 + verticalEvidence * 0.14,
      0,
      1
    );

    let reason = "geometry locked";
    let pass = true;
    if (widthRatio < 0.58 || widthRatio > 0.995) {
      pass = false;
      reason = "measured tableau width is implausible";
    } else if (acceptedRows.length < 14) {
      pass = false;
      reason = "too few reliable scanlines";
    } else if (confidence < 0.56) {
      pass = false;
      reason = "edge confidence is below the handoff threshold";
    }

    return {
      pass,
      reason,
      rawRows,
      acceptedRows,
      measuredLeft,
      measuredRight,
      measuredTop,
      measuredBottom,
      evidenceBottom,
      width,
      widthRatio,
      leftSpread,
      rightSpread,
      stableFraction,
      verticalEvidence,
      confidence
    };
  }

  function templateGeometry(edges) {
    if (!edges || !edges.width) return null;
    const left = edges.measuredLeft;
    const right = edges.measuredRight;
    const top = edges.measuredTop;
    const width = right - left + 1;
    const pitch = width / TEMPLATE.columns;
    const laneWidth = pitch * TEMPLATE.laneWidthToPitch;
    const rowStep = width * TEMPLATE.rowStepToWidth;
    const fullCardHeight = width * TEMPLATE.fullCardHeightToWidth;
    const leftHeight = 6 * rowStep + fullCardHeight;
    const rightHeight = 5 * rowStep + fullCardHeight;
    return {
      left,
      right,
      top,
      width,
      pitch,
      laneWidth,
      rowStep,
      fullCardHeight,
      bottomLeft: top + leftHeight,
      bottomRight: top + rightHeight,
      centers: Array.from({ length: 8 }, (_, i) => left + (i + 0.5) * pitch)
    };
  }

  function drawGeometryOverlay(sourceCanvas, workCanvas, scale, edges, geometry, candidate) {
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(sourceCanvas, 0, 0);

    if (!edges || !geometry) return canvas;

    const toOriginal = (value) => value / scale;
    const top = toOriginal(geometry.top);
    const bottom = toOriginal(Math.max(geometry.bottomLeft, geometry.bottomRight));
    const measuredLeft = toOriginal(edges.measuredLeft);
    const measuredRight = toOriginal(edges.measuredRight);
    const templateLeft = toOriginal(geometry.left);
    const templateRight = toOriginal(geometry.right);

    ctx.save();
    ctx.lineWidth = Math.max(3, Math.round(canvas.width * 0.004));

    // Candidate crop boundary.
    if (candidate) {
      ctx.strokeStyle = "rgba(0, 243, 255, 0.9)";
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(candidate.x, candidate.y, candidate.width, candidate.height);
      ctx.setLineDash([]);
    }

    // Measured edges: green. Template edges: blue. They should coincide.
    ctx.strokeStyle = "#39ff88";
    ctx.beginPath();
    ctx.moveTo(measuredLeft, top);
    ctx.lineTo(measuredLeft, bottom);
    ctx.moveTo(measuredRight, top);
    ctx.lineTo(measuredRight, bottom);
    ctx.stroke();

    ctx.strokeStyle = "#42a5ff";
    ctx.lineWidth = Math.max(1.5, Math.round(canvas.width * 0.002));
    ctx.beginPath();
    ctx.moveTo(templateLeft + 2, top);
    ctx.lineTo(templateLeft + 2, bottom);
    ctx.moveTo(templateRight - 2, top);
    ctx.lineTo(templateRight - 2, bottom);
    ctx.stroke();

    // Canonical eight-column geometry, anchored directly to measured edges.
    ctx.strokeStyle = "rgba(255, 213, 74, 0.92)";
    ctx.lineWidth = Math.max(2, Math.round(canvas.width * 0.0025));
    for (let i = 0; i <= TEMPLATE.columns; i += 1) {
      const x = toOriginal(geometry.left + i * geometry.pitch);
      const columnBottom = toOriginal(i <= 4 ? geometry.bottomLeft : geometry.bottomRight);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, columnBottom);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(templateLeft, top);
    ctx.lineTo(templateRight, top);
    ctx.stroke();

    ctx.font = `700 ${Math.max(18, Math.round(canvas.width * 0.024))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "top";
    const label = edges.pass
      ? `GEOMETRY PASS  ${(edges.confidence * 100).toFixed(0)}%`
      : `GEOMETRY HOLD  ${(edges.confidence * 100).toFixed(0)}%`;
    const labelWidth = ctx.measureText(label).width + 20;
    ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
    ctx.fillRect(10, 10, labelWidth, Math.max(34, canvas.width * 0.038));
    ctx.fillStyle = edges.pass ? "#79ffae" : "#ffd27a";
    ctx.fillText(label, 20, 16);
    ctx.restore();
    return canvas;
  }

  function analyze(sourceCanvas, options) {
    const cv = global.cv;
    if (!cv || !sourceCanvas) throw new Error("OpenCV and a captured photo are required.");

    const settings = Object.assign({
      brightness: 116,
      saturation: 150,
      cleanup: 2.2,
      safetyPaddingX: 0.025,
      safetyPaddingY: 0.035
    }, options || {});

    const maxWidth = 1000;
    const scale = Math.min(1, maxWidth / sourceCanvas.width);
    const workWidth = Math.max(320, Math.round(sourceCanvas.width * scale));
    const workHeight = Math.max(320, Math.round(sourceCanvas.height * scale));

    let src, work, rgb, hsv, strict, clean, connected, kernelOpen, kernelClose, kernelConnect;
    try {
      src = cv.imread(sourceCanvas);
      work = new cv.Mat();
      cv.resize(src, work, new cv.Size(workWidth, workHeight), 0, 0, cv.INTER_AREA);

      rgb = new cv.Mat();
      cv.cvtColor(work, rgb, cv.COLOR_RGBA2RGB);
      hsv = new cv.Mat();
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

      strict = new cv.Mat();
      const lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, settings.brightness, 0]);
      const upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, settings.saturation, 255, 255]);
      cv.inRange(hsv, lower, upper, strict);
      lower.delete();
      upper.delete();

      clean = new cv.Mat();
      const openSize = Math.max(3, Math.round(Math.min(workWidth, workHeight) * 0.004 * settings.cleanup) | 1);
      const closeWidth = Math.max(5, Math.round(workWidth * 0.010 * settings.cleanup) | 1);
      const closeHeight = Math.max(3, Math.round(workHeight * 0.004 * settings.cleanup) | 1);
      kernelOpen = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(openSize, openSize));
      kernelClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(closeWidth, closeHeight));
      cv.morphologyEx(strict, clean, cv.MORPH_OPEN, kernelOpen);
      cv.morphologyEx(clean, clean, cv.MORPH_CLOSE, kernelClose);

      connected = new cv.Mat();
      const connectWidth = Math.max(9, Math.round(workWidth * 0.026 * settings.cleanup) | 1);
      const connectHeight = Math.max(7, Math.round(workHeight * 0.015 * settings.cleanup) | 1);
      kernelConnect = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(connectWidth, connectHeight));
      cv.morphologyEx(clean, connected, cv.MORPH_CLOSE, kernelConnect);
      cv.dilate(connected, connected, kernelConnect, new cv.Point(-1, -1), 1);

      // Geometry lock: measure the cleaned mask directly. There is no contour-first
      // horizontal search and no second contour lookup after padding.
      const edges = robustTableauEdges(clean);
      const geometry = edges.pass || edges.width ? templateGeometry(edges) : null;

      let originalCandidate = null;
      let candidateCanvas = null;
      if (geometry) {
        const padX = Math.round(geometry.width * settings.safetyPaddingX);
        const padY = Math.round(geometry.width * settings.safetyPaddingY);
        const workRect = {
          x: clamp(geometry.left - padX, 0, workWidth - 1),
          y: clamp(geometry.top - padY, 0, workHeight - 1),
          width: 0,
          height: 0
        };
        const desiredRight = clamp(geometry.right + padX, workRect.x + 1, workWidth);
        const desiredBottom = clamp(Math.max(geometry.bottomLeft, geometry.bottomRight) + padY, workRect.y + 1, workHeight);
        workRect.width = desiredRight - workRect.x;
        workRect.height = desiredBottom - workRect.y;

        originalCandidate = {
          x: Math.round(workRect.x / scale),
          y: Math.round(workRect.y / scale),
          width: Math.round(workRect.width / scale),
          height: Math.round(workRect.height / scale)
        };
        originalCandidate.x = clamp(originalCandidate.x, 0, sourceCanvas.width - 1);
        originalCandidate.y = clamp(originalCandidate.y, 0, sourceCanvas.height - 1);
        originalCandidate.width = clamp(originalCandidate.width, 1, sourceCanvas.width - originalCandidate.x);
        originalCandidate.height = clamp(originalCandidate.height, 1, sourceCanvas.height - originalCandidate.y);
        if (edges.pass) candidateCanvas = cropCanvas(sourceCanvas, originalCandidate);
      }

      const strictCanvas = canvasFromMat(cv, strict);
      const cleanCanvas = canvasFromMat(cv, clean);
      const connectedCanvas = canvasFromMat(cv, connected);
      const overlayCanvas = drawGeometryOverlay(sourceCanvas, canvasFromMat(cv, work), scale, edges, geometry, originalCandidate);

      const strictCoverage = cv.countNonZero(strict) / (strict.rows * strict.cols);
      const cleanCoverage = cv.countNonZero(clean) / (clean.rows * clean.cols);
      const maskQuality = clamp(
        (1 - Math.abs(cleanCoverage - 0.42) / 0.42) * 0.45 +
        (edges.stableFraction || 0) * 0.35 +
        (edges.verticalEvidence || 0) * 0.20,
        0,
        1
      );

      const diagnostics = {
        version: "v40-geometry-lock",
        coordinateSpace: "single work-crop space",
        pass: Boolean(edges.pass),
        reason: edges.reason,
        source: { width: sourceCanvas.width, height: sourceCanvas.height },
        workCrop: { width: workWidth, height: workHeight, scale },
        thresholds: {
          brightness: settings.brightness,
          saturation: settings.saturation,
          cleanup: settings.cleanup
        },
        mask: {
          strictCoverage,
          cleanCoverage,
          quality: maskQuality
        },
        measured: geometry ? {
          left: edges.measuredLeft,
          right: edges.measuredRight,
          top: edges.measuredTop,
          bottom: edges.measuredBottom,
          width: edges.width,
          acceptedScanlines: edges.acceptedRows.length,
          candidateScanlines: edges.rawRows.length,
          leftSpreadPx: Number(edges.leftSpread.toFixed(2)),
          rightSpreadPx: Number(edges.rightSpread.toFixed(2)),
          confidence: edges.confidence
        } : null,
        template: geometry ? {
          left: geometry.left,
          right: geometry.right,
          top: geometry.top,
          width: geometry.width,
          columnWidth: geometry.pitch,
          xErrorPx: geometry.left - edges.measuredLeft,
          rightErrorPx: geometry.right - edges.measuredRight,
          yErrorPx: geometry.top - edges.measuredTop
        } : null,
        handoff: {
          allowed: Boolean(candidateCanvas),
          candidate: originalCandidate,
          gate: "confidence >= 56%, plausible width, and at least 14 stable scanlines"
        }
      };

      return {
        settings,
        strictCanvas,
        cleanCanvas,
        connectedCanvas,
        overlayCanvas,
        candidateCanvas,
        candidate: originalCandidate,
        pass: Boolean(edges.pass),
        confidence: edges.confidence || 0,
        maskQuality,
        diagnostics
      };
    } finally {
      [src, work, rgb, hsv, strict, clean, connected, kernelOpen, kernelClose, kernelConnect].forEach((mat) => {
        if (mat && typeof mat.delete === "function") mat.delete();
      });
    }
  }

  global.GuidedPhotoPipeline = Object.freeze({ analyze });
})(window);
