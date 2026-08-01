(function () {
  "use strict";

  const TIMEOUT_MS = 120000;
  let activePromise = null;

  function dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  }

  function isReady(candidate) {
    return !!(
      candidate &&
      typeof candidate.Mat === "function" &&
      typeof candidate.imread === "function" &&
      typeof candidate.cvtColor === "function"
    );
  }

  function waitForOpenCv() {
    if (activePromise) return activePromise;

    dispatch("freecell-opencv-loading", {
      source: "js/opencv.js?v=11.1",
      attempt: 1
    });

    activePromise = new Promise(function (resolve, reject) {
      const started = Date.now();

      function fail(message) {
        const error = message instanceof Error ? message : new Error(String(message));
        dispatch("freecell-opencv-error", {
          message: error.message,
          source: "js/opencv.js?v=11.1"
        });
        reject(error);
      }

      function succeed(cvObject) {
        window.cv = cvObject;
        dispatch("freecell-opencv-ready", {
          source: "js/opencv.js?v=11.1"
        });
        resolve(cvObject);
      }

      function check() {
        const candidate = window.cv;

        if (isReady(candidate)) {
          succeed(candidate);
          return;
        }

        // Some OpenCV.js builds expose cv as a Promise.
        if (candidate && typeof candidate.then === "function") {
          candidate.then(function (resolvedCv) {
            if (isReady(resolvedCv)) succeed(resolvedCv);
            else fail("OpenCV resolved, but cv.Mat is unavailable.");
          }).catch(fail);
          return;
        }

        if (Date.now() - started >= TIMEOUT_MS) {
          if (!candidate) {
            fail("opencv.js loaded, but window.cv was not created.");
          } else {
            fail("OpenCV runtime timed out before cv.Mat became available.");
          }
          return;
        }

        window.setTimeout(check, 100);
      }

      check();
    });

    return activePromise;
  }

  window.freecellCvReady = waitForOpenCv();

  // Retry only the readiness check. The local opencv.js file is already loaded
  // by index.html, so adding a second copy can corrupt the runtime.
  window.freecellCvRetry = function () {
    activePromise = null;
    window.freecellCvReady = waitForOpenCv();
    return window.freecellCvReady;
  };
}());
