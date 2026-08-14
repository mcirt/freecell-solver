'use strict';
importScripts('alternate-solver-core.js?v=61');

self.onmessage = async function (event) {
  const data = event.data || {};
  if (data.type !== 'solve' && data.type !== 'improve') return;
  const id = data.id;
  try {
    const progress = function (info) {
      self.postMessage({type:'progress', id, progress:info || {}});
    };
    const result = data.type === 'improve'
      ? await self.FreeCellAltSolver.improve(data.board, data.moves || [], data.options || {}, progress)
      : await self.FreeCellAltSolver.solve(data.board, data.options || {}, progress);
    self.postMessage({type:'result', id, result});
  } catch (error) {
    self.postMessage({type:'error', id, error:error && (error.stack || error.message) || String(error)});
  }
};
