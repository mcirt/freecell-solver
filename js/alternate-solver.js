(function (root) {
  'use strict';
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('js/alternate-solver-worker.js?v=61');
    worker.onmessage = function (event) {
      const data = event.data || {};
      const job = pending.get(data.id);
      if (!job) return;
      if (data.type === 'progress') {
        if (job.onProgress) job.onProgress(data.progress || {});
        return;
      }
      pending.delete(data.id);
      if (data.type === 'result') job.resolve(data.result);
      else job.reject(new Error(data.error || 'Alternate solver failed.'));
    };
    worker.onerror = function (event) {
      const error = new Error(event.message || 'Alternate solver worker crashed.');
      pending.forEach(job => job.reject(error));
      pending.clear();
      worker.terminate();
      worker = null;
    };
    return worker;
  }

  function run(type, board, moves, options, onProgress) {
    return new Promise(function (resolve, reject) {
      const id = nextId++;
      pending.set(id, {resolve, reject, onProgress});
      ensureWorker().postMessage({type, id, board, moves:moves || [], options:options || {}});
    });
  }

  function solve(board, options, onProgress) {
    return run('solve', board, [], options, onProgress);
  }

  function improve(board, moves, options, onProgress) {
    return run('improve', board, moves, options, onProgress);
  }

  root.FreeCellAlternateSolver = Object.freeze({solve, improve});
}(window));
