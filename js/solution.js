(function (ns) {
  "use strict";

  let moves = [];
  let states = [];
  let current = 0;
  let playing = false;
  let animating = false;

  const counter = document.getElementById("move-counter");
  const description = document.getElementById("move-description");
  const error = document.getElementById("viewer-error");
  const speed = document.getElementById("speed");

  function setControls() {
    const atStart = current === 0;
    const atEnd = current === moves.length;
    document.getElementById("first").disabled = atStart || animating;
    document.getElementById("previous").disabled = atStart || animating;
    document.getElementById("next").disabled = atEnd || animating;
    document.getElementById("last").disabled = atEnd || animating;
    document.getElementById("play").disabled = playing || animating || moves.length === 0;
    document.getElementById("pause").disabled = !playing;
  }

  function render() {
    ns.renderState(states[current]);
    counter.textContent = "Move " + current + " of " + moves.length;
    description.textContent = current === 0 ? "Starting position" : moves[current - 1];
    setControls();
  }

  function pause() {
    playing = false;
    setControls();
  }

  async function advanceOne({ fromPlay = false } = {}) {
    if (animating || current >= moves.length) {
      if (current >= moves.length) pause();
      return false;
    }

    animating = true;
    setControls();

    const moveText = moves[current];
    const details = ns.moveDetails(states[current], moveText);
    const nextState = states[current + 1];
    const selected = Number(speed.value);
    const duration = selected === 0 ? 0 : Math.max(260, Math.min(700, selected * 0.62));

    if (duration === 0) {
      ns.renderState(nextState);
    } else {
      await ns.animateMove(details, nextState, duration);
    }

    current += 1;
    animating = false;
    render();

    if (!fromPlay) pause();
    return true;
  }

  async function next() {
    pause();
    await advanceOne();
  }

  async function play() {
    if (playing || moves.length === 0) return;
    if (current >= moves.length) current = 0;
    playing = true;
    render();

    while (playing && current < moves.length) {
      const moved = await advanceOne({ fromPlay: true });
      if (!moved || !playing) break;
      const delay = Number(speed.value) === 0 ? 0 : 90;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    }

    if (current >= moves.length) playing = false;
    setControls();
  }

  function goTo(index) {
    pause();
    current = Math.max(0, Math.min(moves.length, index));
    ns.clearHighlights();
    render();
  }

  function init() {
    try {
      const raw = sessionStorage.getItem("freecellSolution");
      if (!raw) {
        throw new Error("No solved board was found. Return to the solver page, solve a board, and open the graphical viewer.");
      }

      const data = JSON.parse(raw);
      moves = data.moves;
      states = [ns.parseBoard(data.board)];
      moves.forEach(move => states.push(ns.applyMove(states.at(-1), move)));

      ns.bindControls({
        goTo,
        next,
        play,
        pause,
        current: () => current,
        total: () => moves.length
      });

      render();
    } catch (e) {
      error.hidden = false;
      error.textContent = e.message || String(e);
      console.error(e);
    }
  }

  init();
}(window.FreeCellViewer = window.FreeCellViewer || {}));
