(function () {
  "use strict";

  const SOURCES = [
    "https://docs.opencv.org/4.10.0/opencv.js",
    "https://docs.opencv.org/4.x/opencv.js"
  ];
  const TIMEOUT_MS = 30000;
  let currentAttempt = 0;
  let settled = false;
  let resolveReady;
  let rejectReady;
  let timer = null;
  let activeScript = null;

  function dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  }

  function isReady(cv) {
    return !!(cv && typeof cv.Mat === "function" && typeof cv.imread === "function" && typeof cv.cvtColor === "function");
  }

  function finish(cv) {
    if (settled || !isReady(cv)) return;
    settled = true;
    window.clearTimeout(timer);
    window.cv = cv;
    dispatch("freecell-opencv-ready", { source: SOURCES[Math.max(0, currentAttempt - 1)] });
    resolveReady(cv);
  }

  function fail(error) {
    if (settled) return;
    window.clearTimeout(timer);
    if (currentAttempt < SOURCES.length) {
      loadNext();
      return;
    }
    settled = true;
    dispatch("freecell-opencv-error", { message: error && error.message ? error.message : String(error) });
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  }

  function waitForRuntime() {
    const cv = window.cv;
    if (cv && typeof cv.then === "function") {
      cv.then(finish).catch(fail);
      return;
    }
    if (isReady(cv)) {
      finish(cv);
      return;
    }
    window.setTimeout(waitForRuntime, 100);
  }

  function loadNext() {
    window.clearTimeout(timer);
    if (activeScript) activeScript.remove();
    if (currentAttempt >= SOURCES.length) {
      fail(new Error("OpenCV.js could not be loaded from the available sources."));
      return;
    }

    const source = SOURCES[currentAttempt++];
    dispatch("freecell-opencv-loading", { source, attempt: currentAttempt });

    // OpenCV's Emscripten build can signal readiness through this callback.
    window.Module = window.Module || {};
    const previousCallback = window.Module.onRuntimeInitialized;
    window.Module.onRuntimeInitialized = function () {
      if (typeof previousCallback === "function") previousCallback();
      waitForRuntime();
    };

    activeScript = document.createElement("script");
    activeScript.async = true;
    activeScript.src = source;
    activeScript.dataset.freecellOpenCv = "true";
    activeScript.onload = waitForRuntime;
    activeScript.onerror = function () {
      fail(new Error("OpenCV.js download failed."));
    };
    document.head.appendChild(activeScript);

    timer = window.setTimeout(function () {
      fail(new Error("OpenCV.js timed out while loading."));
    }, TIMEOUT_MS);
  }

  function createPromise() {
    settled = false;
    currentAttempt = 0;
    window.freecellCvReady = new Promise(function (resolve, reject) {
      resolveReady = resolve;
      rejectReady = reject;
    });
    loadNext();
    return window.freecellCvReady;
  }

  window.freecellCvRetry = function () {
    if (activeScript) activeScript.remove();
    window.cv = undefined;
    return createPromise();
  };

  createPromise();
}());
