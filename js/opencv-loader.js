(function () {
  "use strict";

  const VERSION = "12";
  const BASE_SOURCE = "js/opencv.js?v=" + VERSION;
  const TIMEOUT_MS = 120000;
  const POLL_MS = 100;

  let attempt = 0;
  let activePromise = null;

  function dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  }

  function isUsable(cv) {
    return !!(
      cv &&
      typeof cv.Mat === "function" &&
      typeof cv.imread === "function" &&
      typeof cv.cvtColor === "function"
    );
  }

  function describeValue(value) {
    if (value === undefined) return "window.cv is undefined";
    if (value === null) return "window.cv is null";
    if (typeof value.then === "function") return "window.cv is a Promise";
    return "window.cv exists but cv.Mat is not ready";
  }

  function waitForUsableCv(timeoutMs) {
    const started = Date.now();

    return new Promise(function (resolve, reject) {
      function inspect() {
        let candidate = window.cv;

        if (candidate && typeof candidate.then === "function") {
          candidate.then(function (resolvedCv) {
            window.cv = resolvedCv;
            if (isUsable(resolvedCv)) {
              resolve(resolvedCv);
            } else if (Date.now() - started >= timeoutMs) {
              reject(new Error("The OpenCV Promise resolved, but cv.Mat was unavailable."));
            } else {
              window.setTimeout(inspect, POLL_MS);
            }
          }).catch(function (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
          return;
        }

        if (isUsable(candidate)) {
          resolve(candidate);
          return;
        }

        if (Date.now() - started >= timeoutMs) {
          reject(new Error("OpenCV initialization timed out: " + describeValue(candidate) + "."));
          return;
        }

        window.setTimeout(inspect, POLL_MS);
      }

      inspect();
    });
  }

  function beginWaiting(source) {
    attempt += 1;
    dispatch("freecell-opencv-loading", { source: source, attempt: attempt });

    activePromise = waitForUsableCv(TIMEOUT_MS)
      .then(function (cv) {
        window.cv = cv;
        dispatch("freecell-opencv-ready", { source: source, attempt: attempt });
        return cv;
      })
      .catch(function (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        dispatch("freecell-opencv-error", {
          message: normalized.message,
          source: source,
          attempt: attempt
        });
        throw normalized;
      });

    window.freecellCvReady = activePromise;
    return activePromise;
  }

  function injectRetryScript() {
    return new Promise(function (resolve, reject) {
      const source = BASE_SOURCE + "&retry=" + Date.now();
      const script = document.createElement("script");
      script.src = source;
      script.async = true;
      script.dataset.freecellOpenCvRetry = String(attempt + 1);
      script.onload = function () { resolve(source); };
      script.onerror = function () {
        reject(new Error("The browser could not download " + source + "."));
      };
      document.head.appendChild(script);
    });
  }

  window.freecellCvRetry = function () {
    if (isUsable(window.cv)) {
      return Promise.resolve(window.cv);
    }

    window.cv = undefined;
    dispatch("freecell-opencv-loading", { source: BASE_SOURCE, attempt: attempt + 1 });

    const retryPromise = injectRetryScript()
      .then(function (source) { return beginWaiting(source); })
      .catch(function (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        dispatch("freecell-opencv-error", {
          message: normalized.message,
          source: BASE_SOURCE,
          attempt: attempt + 1
        });
        throw normalized;
      });

    window.freecellCvReady = retryPromise;
    return retryPromise;
  };

  // opencv.js is loaded immediately before this file in index.html.
  beginWaiting(BASE_SOURCE);
}());
