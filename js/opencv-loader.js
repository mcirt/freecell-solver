(function () {
  "use strict";

  const OPENCV_URL = "https://docs.opencv.org/4.x/opencv.js";
  let resolveReady;
  let rejectReady;

  window.freecellCvReady = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function finishWhenReady(attempt) {
    const cv = window.cv;
    if (cv && typeof cv.then === "function") {
      cv.then((resolvedCv) => {
        window.cv = resolvedCv;
        resolveReady(resolvedCv);
      }).catch(rejectReady);
      return;
    }
    if (cv && typeof cv.Mat === "function" && typeof cv.imread === "function") {
      resolveReady(cv);
      return;
    }
    if (attempt > 240) {
      rejectReady(new Error("OpenCV.js did not finish loading."));
      return;
    }
    window.setTimeout(() => finishWhenReady(attempt + 1), 50);
  }

  const script = document.createElement("script");
  script.async = true;
  script.src = OPENCV_URL;
  script.onload = () => finishWhenReady(0);
  script.onerror = () => rejectReady(new Error("OpenCV.js could not be downloaded."));
  document.head.appendChild(script);
}());
