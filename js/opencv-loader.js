(function () {
  "use strict";

  const SOURCE = "js/opencv.js?v=13";
  const TIMEOUT_MS = 120000;
  let settled = false;
  let timeoutId = 0;
  let resolveReady;
  let rejectReady;

  function dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  }

  function isReady(cv) {
    return !!(
      cv &&
      typeof cv.Mat === "function" &&
      typeof cv.imread === "function" &&
      typeof cv.cvtColor === "function"
    );
  }

  function finish(cv) {
    if (settled) return;
    const readyCv = cv || window.cv;
    if (!isReady(readyCv)) return;

    settled = true;
    window.clearTimeout(timeoutId);
    window.cv = readyCv;
    dispatch("freecell-opencv-ready", { source: SOURCE });

    // Do not resolve with cv itself. This OpenCV build is thenable, and a
    // native Promise would try to assimilate it indefinitely.
    resolveReady({ ready: true, source: SOURCE });
  }

  function fail(errorLike) {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeoutId);
    const error = errorLike instanceof Error
      ? errorLike
      : new Error(String(errorLike || "OpenCV failed to initialize."));
    dispatch("freecell-opencv-error", {
      message: error.message,
      source: SOURCE
    });
    rejectReady(error);
  }

  function registerRuntimeCallback() {
    const cv = window.cv;

    if (!cv) {
      fail(new Error("js/opencv.js loaded, but window.cv was not created."));
      return;
    }

    if (isReady(cv)) {
      finish(cv);
      return;
    }

    // This specific OpenCV build exposes a custom callback-style then().
    // It must not be awaited and it does not return a normal Promise.
    if (typeof cv.then === "function") {
      try {
        cv.then(function (readyCv) {
          finish(readyCv || window.cv);
        });
      } catch (error) {
        fail(error);
      }
    }

    // Defensive polling covers cases where the callback fires before this
    // loader registers or where Safari delays publishing cv.Mat.
    (function poll() {
      if (settled) return;
      if (isReady(window.cv)) {
        finish(window.cv);
        return;
      }
      window.setTimeout(poll, 100);
    }());
  }

  function createReadyPromise() {
    settled = false;
    window.freecellCvReady = new Promise(function (resolve, reject) {
      resolveReady = resolve;
      rejectReady = reject;
    });

    dispatch("freecell-opencv-loading", { source: SOURCE, attempt: 1 });
    timeoutId = window.setTimeout(function () {
      fail(new Error(
        "OpenCV did not finish initializing. On Safari, fully close and reopen Safari, then try again."
      ));
    }, TIMEOUT_MS);

    registerRuntimeCallback();
    return window.freecellCvReady;
  }

  window.freecellCvRetry = function () {
    // Re-register against the existing OpenCV object. Reloading the 11 MB
    // library inside a live page is less reliable on iPhone Safari.
    return createReadyPromise();
  };

  createReadyPromise();
}());
