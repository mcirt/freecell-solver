(function (global) {
  "use strict";

  const TABLEAU = Object.freeze({
    columns: 8,
    rowStepToWidth: 0.072,
    fullCardHeightToWidth: 0.165
  });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function medianAbsoluteDeviation(values, center) {
    if (!values.length || center == null) return null;
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

  function projectionBounds(mask, minRowCoverage, minColCoverage) {
    const rows = [];
    const cols = [];
    const rowMin = Math.max(1, Math.round(mask.cols * minRowCoverage));
    const colMin = Math.max(1, Math.round(mask.rows * minColCoverage));

    for (let y = 0; y < mask.rows; y += 1) {
      let count = 0;
      const row = mask.ucharPtr(y, 0);
      for (let x = 0; x < mask.cols; x += 1) if (row[x] > 0) count += 1;
      if (count >= rowMin) rows.push(y);
    }

    for (let x = 0; x < mask.cols; x += 1) {
      let count = 0;
      for (let y = 0; y < mask.rows; y += 1) if (mask.ucharPtr(y, x)[0] > 0) count += 1;
      if (count >= colMin) cols.push(x);
    }

    if (!rows.length || !cols.length) return null;
    return {
      x: cols[0],
      y: rows[0],
      width: cols[cols.length - 1] - cols[0] + 1,
      height: rows[rows.length - 1] - rows[0] + 1,
      bottom: rows[rows.length - 1]
    };
  }

  function rowEdges(mask, y, minRun) {
    const row = mask.ucharPtr(y, 0);
    let left = -1;
    let right = -1;
    let run = 0;

    for (let x = 0; x < mask.cols; x += 1) {
      run = row[x] > 0 ? run + 1 : 0;
      if (run >= minRun) {
        left = x - run + 1;
        break;
      }
    }

    run = 0;
    for (let x = mask.cols - 1; x >= 0; x -= 1) {
      run = row[x] > 0 ? run + 1 : 0;
      if (run >= minRun) {
        right = x + run - 1;
        break;
      }
    }

    return left >= 0 && right > left ? { left, right } : null;
  }

  function measureTableauEdges(mask, bounds) {
    if (!bounds) return null;
    const minRun = Math.max(2, Math.round(mask.cols * 0.008));
    const yStart = clamp(Math.round(bounds.y + bounds.height * 0.08), 0, mask.rows - 1);
    const yEnd = clamp(Math.round(bounds.y + bounds.height * 0.82), yStart, mask.rows - 1);
    const step = Math.max(1, Math.round((yEnd - yStart + 1) / 36));
    const samples = [];

    for (let y = yStart; y <= yEnd; y += step) {
      const edges = rowEdges(mask, y, minRun);
      if (!edges) continue;
      const width = edges.right - edges.left + 1;
      if (width >= mask.cols * 0.48) samples.push({ y, ...edges, width });
    }

    if (samples.length < 5) return null;
    const widths = samples.map((sample) => sample.width);
    const widthMedian = median(widths);
    const filtered = samples.filter((sample) => Math.abs(sample.width - widthMedian) <= Math.max(8, widthMedian * 0.16));
    if (filtered.length < 5) return null;

    const leftValues = filtered.map((sample) => sample.left);
    const rightValues = filtered.map((sample) => sample.right);
    const left = median(leftValues);
    const right = median(rightValues);
    return {
      left,
      right,
      width: right - left + 1,
      sampleCount: filtered.length,
      rawSampleCount: samples.length,
      leftMad: medianAbsoluteDeviation(leftValues, left),
      rightMad: medianAbsoluteDeviation(rightValues, right),
      scanlineStart: yStart,
      scanlineEnd: yEnd,
      samples: filtered
    };
  }

  function tableauTemplate(left, top, width) {
    const pitch = width / TABLEAU.columns;
    const rowStep = width * TABLEAU.rowStepToWidth;
    const fullCardHeight = width * TABLEAU.fullCardHeightToWidth;
    const height = 6 * rowStep + fullCardHeight;
    return {
      left,
      right: left + width - 1,
      top,
      bottom: top + height - 1,
      width,
      height,
      pitch,
      columnWidth: pitch
    };
  }

  function confidenceFor(mask, bounds, measured, template, cleanCoverage) {
    if (!bounds || !measured || !template) {
      return { score: 0, pass: false, reasons: ["Insufficient stable edge evidence"] };
    }

    const reasons = [];
    const widthRatio = measured.width / mask.cols;
    const madRatio = ((measured.leftMad || 0) + (measured.rightMad || 0)) / Math.max(1, measured.width);
    const yError = bounds.bottom - template.bottom;
    const yErrorRatio = Math.abs(yError) / Math.max(1, template.height);
    const sampleScore = clamp(measured.sampleCount / 20, 0, 1);
    const stabilityScore = clamp(1 - madRatio / 0.035, 0, 1);
    const widthScore = clamp(1 - Math.abs(widthRatio - 0.82) / 0.34, 0, 1);
    const heightScore = clamp(1 - yErrorRatio / 0.28, 0, 1);
    const coverageScore = clamp(1 - Math.abs(cleanCoverage - 0.24) / 0.24, 0, 1);
    const score = 0.28 * sampleScore + 0.30 * stabilityScore + 0.18 * widthScore + 0.16 * heightScore + 0.08 * coverageScore;

    if (measured.sampleCount < 8) reasons.push("Too few reliable scanlines");
    if (madRatio > 0.04) reasons.push("Left/right edges vary too much");
    if (widthRatio < 0.52 || widthRatio > 0.99) reasons.push("Measured tableau width is implausible");
    if (yErrorRatio > 0.34) reasons.push("Measured height disagrees with the canonical tableau");
    if (cleanCoverage < 0.035 || cleanCoverage > 0.62) reasons.push("Card-mask coverage is implausible");

    return {
      score,
      pass: score >= 0.62 && reasons.length === 0,
      reasons,
      metrics: { widthRatio, madRatio, yError, yErrorRatio, sampleScore, stabilityScore, widthScore, heightScore, coverageScore }
    };
  }

  function drawGeometryOverlay(sourceCanvas, geometry) {
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(sourceCanvas, 0, 0);
    if (!geometry) return canvas;

    const lineWidth = Math.max(3, Math.round(canvas.width * 0.004));
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.font = `${Math.max(14, Math.round(canvas.width * 0.018))}px sans-serif`;

    ctx.strokeStyle = "#ffcc00";
    ctx.beginPath();
    ctx.moveTo(geometry.measuredLeft, geometry.top);
    ctx.lineTo(geometry.measuredLeft, geometry.bottom);
    ctx.moveTo(geometry.measuredRight, geometry.top);
    ctx.lineTo(geometry.measuredRight, geometry.bottom);
    ctx.stroke();

    ctx.strokeStyle = "#00f3ff";
    ctx.strokeRect(geometry.templateLeft, geometry.templateTop, geometry.templateWidth, geometry.templateHeight);

    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(8, 8, Math.min(canvas.width - 16, 430), 76);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`X error: ${geometry.xError.toFixed(1)} px`, 18, 34);
    ctx.fillText(`Y error: ${geometry.yError.toFixed(1)} px`, 18, 60);
    ctx.restore();
    return canvas;
  }

  function analyze(sourceCanvas, options) {
    const cv = global.cv;
    if (!cv || !sourceCanvas) throw new Error("OpenCV and a captured photo are required.");

    const settings = Object.assign({ brightness: 116, saturation: 150, cleanup: 2.2 }, options || {});
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

      const bounds = projectionBounds(clean, 0.20, 0.12);
      const measured = measureTableauEdges(clean, bounds);
      const template = measured && bounds ? tableauTemplate(measured.left, bounds.y, measured.width) : null;
      const cleanPixels = cv.countNonZero(clean);
      const strictPixels = cv.countNonZero(strict);
      const cleanCoverage = cleanPixels / (clean.rows * clean.cols);
      const confidence = confidenceFor(clean, bounds, measured, template, cleanCoverage);

      let workCandidate = null;
      let originalCandidate = null;
      let candidateCanvas = null;
      let overlayCanvas = drawGeometryOverlay(sourceCanvas, null);
      let geometry = null;

      if (template) {
        workCandidate = {
          x: clamp(Math.round(template.left), 0, workWidth - 1),
          y: clamp(Math.round(template.top), 0, workHeight - 1),
          width: clamp(Math.round(template.width), 1, workWidth),
          height: clamp(Math.round(template.height), 1, workHeight)
        };
        workCandidate.width = clamp(workCandidate.width, 1, workWidth - workCandidate.x);
        workCandidate.height = clamp(workCandidate.height, 1, workHeight - workCandidate.y);

        originalCandidate = {
          x: Math.round(workCandidate.x / scale),
          y: Math.round(workCandidate.y / scale),
          width: Math.round(workCandidate.width / scale),
          height: Math.round(workCandidate.height / scale)
        };
        originalCandidate.x = clamp(originalCandidate.x, 0, sourceCanvas.width - 1);
        originalCandidate.y = clamp(originalCandidate.y, 0, sourceCanvas.height - 1);
        originalCandidate.width = clamp(originalCandidate.width, 1, sourceCanvas.width - originalCandidate.x);
        originalCandidate.height = clamp(originalCandidate.height, 1, sourceCanvas.height - originalCandidate.y);

        geometry = {
          measuredLeft: measured.left / scale,
          measuredRight: measured.right / scale,
          templateLeft: template.left / scale,
          templateTop: template.top / scale,
          templateWidth: template.width / scale,
          templateHeight: template.height / scale,
          top: template.top / scale,
          bottom: Math.min(sourceCanvas.height - 1, template.bottom / scale),
          xError: ((measured.left - template.left) + (measured.right - template.right)) / (2 * scale),
          yError: bounds ? (bounds.bottom - template.bottom) / scale : 0
        };
        overlayCanvas = drawGeometryOverlay(sourceCanvas, geometry);
        candidateCanvas = cropCanvas(sourceCanvas, originalCandidate);
      }

      return {
        settings,
        strictCanvas: canvasFromMat(cv, strict),
        cleanCanvas: canvasFromMat(cv, clean),
        connectedCanvas: canvasFromMat(cv, connected),
        overlayCanvas,
        candidateCanvas,
        candidate: originalCandidate,
        confidence,
        diagnostics: {
          version: "v40-edge-first-geometry-lock",
          coordinateSpace: "clean-mask crop coordinates",
          sourceWidth: sourceCanvas.width,
          sourceHeight: sourceCanvas.height,
          workWidth,
          workHeight,
          scale,
          brightness: settings.brightness,
          saturation: settings.saturation,
          cleanup: settings.cleanup,
          strictCoverage: strictPixels / (strict.rows * strict.cols),
          cleanCoverage,
          projectionBounds: bounds,
          measuredEdges: measured ? {
            left: measured.left,
            right: measured.right,
            width: measured.width,
            sampleCount: measured.sampleCount,
            rawSampleCount: measured.rawSampleCount,
            leftMad: measured.leftMad,
            rightMad: measured.rightMad,
            scanlineStart: measured.scanlineStart,
            scanlineEnd: measured.scanlineEnd
          } : null,
          canonicalTemplate: template,
          xErrorPx: geometry ? geometry.xError : null,
          yErrorPx: geometry ? geometry.yError : null,
          candidate: originalCandidate,
          confidence
        }
      };
    } finally {
      [src, work, rgb, hsv, strict, clean, connected, kernelOpen, kernelClose, kernelConnect].forEach((mat) => {
        if (mat && typeof mat.delete === "function") mat.delete();
      });
    }
  }

  global.GuidedPhotoPipeline = Object.freeze({ analyze });
})(window);
