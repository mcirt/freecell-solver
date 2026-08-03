(function (global) {
  "use strict";

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function canvasFromMat(cv, mat) {
    const canvas = document.createElement("canvas");
    canvas.width = mat.cols;
    canvas.height = mat.rows;
    cv.imshow(canvas, mat);
    return canvas;
  }

  function drawCandidateOverlay(sourceCanvas, candidate) {
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(sourceCanvas, 0, 0);
    if (candidate) {
      ctx.save();
      ctx.strokeStyle = "#00f3ff";
      ctx.fillStyle = "rgba(0, 243, 255, 0.10)";
      ctx.lineWidth = Math.max(4, Math.round(canvas.width * 0.006));
      ctx.fillRect(candidate.x, candidate.y, candidate.width, candidate.height);
      ctx.strokeRect(candidate.x, candidate.y, candidate.width, candidate.height);
      ctx.restore();
    }
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
      height: rows[rows.length - 1] - rows[0] + 1
    };
  }

  function contourCandidate(cv, mask) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let best = null;
    try {
      cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const imageArea = mask.cols * mask.rows;
      for (let i = 0; i < contours.size(); i += 1) {
        const contour = contours.get(i);
        const area = Math.abs(cv.contourArea(contour));
        const rect = cv.boundingRect(contour);
        const widthRatio = rect.width / mask.cols;
        const heightRatio = rect.height / mask.rows;
        const aspect = rect.width / Math.max(1, rect.height);
        const fill = area / Math.max(1, rect.width * rect.height);
        const score = (widthRatio * 3.0) + (heightRatio * 1.3) + fill - Math.abs(aspect - 1.8) * 0.15;
        if (widthRatio >= 0.56 && heightRatio >= 0.18 && area >= imageArea * 0.06) {
          if (!best || score > best.score) best = { ...rect, score, area, fill };
        }
        contour.delete();
      }
    } finally {
      contours.delete();
      hierarchy.delete();
    }
    return best;
  }

  function analyze(sourceCanvas, options) {
    const cv = global.cv;
    if (!cv || !sourceCanvas) throw new Error("OpenCV and a captured photo are required.");

    const settings = Object.assign({
      brightness: 116,
      saturation: 150,
      cleanup: 2.2,
      safetyPaddingX: 0.035,
      safetyPaddingY: 0.055
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

      let candidate = contourCandidate(cv, connected);
      if (!candidate) candidate = projectionBounds(clean, 0.20, 0.12);

      if (candidate) {
        const padX = Math.round(candidate.width * settings.safetyPaddingX);
        const padY = Math.round(candidate.height * settings.safetyPaddingY);
        candidate = {
          x: clamp(candidate.x - padX, 0, workWidth - 1),
          y: clamp(candidate.y - padY, 0, workHeight - 1),
          width: 0,
          height: 0
        };
        candidate.width = clamp((candidate.width || 0), 1, workWidth - candidate.x);
        // Recover original dimensions after replacing x/y.
        const raw = contourCandidate(cv, connected) || projectionBounds(clean, 0.20, 0.12);
        if (raw) {
          candidate.width = clamp(raw.width + padX * 2, 1, workWidth - candidate.x);
          candidate.height = clamp(raw.height + padY * 2, 1, workHeight - candidate.y);
        }
      }

      const strictCanvas = canvasFromMat(cv, strict);
      const cleanCanvas = canvasFromMat(cv, clean);
      const connectedCanvas = canvasFromMat(cv, connected);

      let originalCandidate = null;
      let overlayCanvas = drawCandidateOverlay(sourceCanvas, null);
      let candidateCanvas = null;
      if (candidate) {
        originalCandidate = {
          x: Math.round(candidate.x / scale),
          y: Math.round(candidate.y / scale),
          width: Math.round(candidate.width / scale),
          height: Math.round(candidate.height / scale)
        };
        originalCandidate.x = clamp(originalCandidate.x, 0, sourceCanvas.width - 1);
        originalCandidate.y = clamp(originalCandidate.y, 0, sourceCanvas.height - 1);
        originalCandidate.width = clamp(originalCandidate.width, 1, sourceCanvas.width - originalCandidate.x);
        originalCandidate.height = clamp(originalCandidate.height, 1, sourceCanvas.height - originalCandidate.y);
        overlayCanvas = drawCandidateOverlay(sourceCanvas, originalCandidate);
        candidateCanvas = cropCanvas(sourceCanvas, originalCandidate);
      }

      const whitePixels = cv.countNonZero(strict);
      const cleanPixels = cv.countNonZero(clean);
      const diagnostics = {
        sourceWidth: sourceCanvas.width,
        sourceHeight: sourceCanvas.height,
        workWidth,
        workHeight,
        brightness: settings.brightness,
        saturation: settings.saturation,
        cleanup: settings.cleanup,
        strictCoverage: whitePixels / (strict.rows * strict.cols),
        cleanCoverage: cleanPixels / (clean.rows * clean.cols),
        candidate: originalCandidate
      };

      return {
        settings,
        strictCanvas,
        cleanCanvas,
        connectedCanvas,
        overlayCanvas,
        candidateCanvas,
        candidate: originalCandidate,
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
