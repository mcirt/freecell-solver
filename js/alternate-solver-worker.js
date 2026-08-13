'use strict';
importScripts('alternate-solver-core.js?v=53');

self.onmessage = async function (event) {
  const data = event.data || {};
  if (data.type !== 'solve') return;
  const id = data.id;
  try {
    const result = await self.FreeCellAltSolver.solve(data.board, data.options || {}, function (progress) {
      self.postMessage({type:'progress', id, progress});
    });
    self.postMessage({type:'result', id, result});
  } catch (error) {
    self.postMessage({type:'error', id, error: error && (error.stack || error.message) || String(error)});
  }
};
