(function () {
  "use strict";

  const LOCAL_SOURCE = "js/opencv.js?v=11";
  const TIMEOUT_MS = 45000;
  let timer = null;
  let script = null;
  let resolveReady;
  let rejectReady;
  let settled = false;

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
    if (settled || !isReady(cv)) return;
    settled = true;
    window.clearTimeout(timer);
    window.cv = cv;
    dispatch("freecell-opencv-ready", { source: LOCAL_SOURCE });
    resolveReady(cv);
  }

  function fail(message) {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    const error = message instanceof Error ? message : new Error(String(message));
    dispatch("freecell-opencv-error", {
      message: error.message,
      source: LOCAL_SOURCE
    });
    rejectReady(error);
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

    if (!settled) window.setTimeout(waitForRuntime, 100);
  }

  function loadLocalOpenCv() {
    settled = false;
    dispatch("freecell-opencv-loading", { source: LOCAL_SOURCE, attempt: 1 });

    window.Module = window.Module || {};
    const oldCallback = window.Module.onRuntimeInitialized;
    window.Module.onRuntimeInitialized = function () {
      if (typeof oldCallback === "function") oldCallback();
      waitForRuntime();
    };

    script = document.createElement("script");
    script.async = true;
    script.src = LOCAL_SOURCE;
    script.dataset.freecellOpenCv = "local";
    script.onload = waitForRuntime;
    script.onerror = function () {
      fail(new Error("Local OpenCV file was not found at js/opencv.js."));
    };
    document.head.appendChild(script);

    timer = window.setTimeout(function () {
      fail(new Error("Local OpenCV timed out while initializing."));
    }, TIMEOUT_MS);
  }

  function createPromise() {
    window.freecellCvReady = new Promise(function (resolve, reject) {
      resolveReady = resolve;
      rejectReady = reject;
    });
    loadLocalOpenCv();
    return window.freecellCvReady;
  }

  window.freecellCvRetry = function () {
    if (script) script.remove();
    window.cv = undefined;
    return createPromise();
  };

  createPromise();
}());
