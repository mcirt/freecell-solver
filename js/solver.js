define([
  "libfcs-wrap",
  "web-fc-solve",
  "web-fcs-api-base"
], function (ModuleFactory, FCS, BaseApi) {
  "use strict";

  const boardEl = document.getElementById("board");
  const solveButton = document.getElementById("solve");
  const loadDealButton = document.getElementById("load-deal");
  const clearButton = document.getElementById("clear-output");
  const statusEl = document.getElementById("status");
  const statsEl = document.getElementById("stats");
  const movesEl = document.getElementById("moves");
  const errorEl = document.getElementById("error");
  const viewerLink = document.getElementById("open-viewer");

  let moduleWrapper = null;

  function setStatus(kind, label) {
    statusEl.className = "status " + kind;
    statusEl.textContent = label;
  }

  function showError(error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    errorEl.hidden = false;
    errorEl.textContent = message;
    setStatus("error", "Error");
    console.error(error);
  }

  function clearResults() {
    movesEl.replaceChildren();
    statsEl.textContent = "";
    errorEl.hidden = true;
    errorEl.textContent = "";
    viewerLink.hidden = true;
  }

  function loadSampleDeal() {
    if (!moduleWrapper) return;
    boardEl.value = BaseApi.deal_ms_fc_board(moduleWrapper, 1);
    clearResults();
  }

  function allowBrowserToPaint() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  async function solveBoard() {
    clearResults();
    solveButton.disabled = true;
    loadDealButton.disabled = true;

    try {
      const board = boardEl.value.trim();
      if (!board) throw new Error("Enter a FreeCell board before solving.");

      const solver = new FCS.FC_Solve({
        module_wrapper: moduleWrapper,
        dir_base: "js/",
        string_params: "",
        cmd_line_preset: "default",
        set_status_callback: setStatus
      });

      let result = solver.do_solve(board);

      // The solver works in batches. Resume until it solves, proves the deal
      // impossible, or reaches the built-in iteration ceiling.
      while (result === FCS.FCS_STATE_SUSPEND_PROCESS && solver.current_iters_limit < 131072) {
        await allowBrowserToPaint();
        result = solver.resume_solution();
      }

      if (result !== FCS.FCS_STATE_WAS_SOLVED) return;

      // Calling display_solution builds the internal state-and-move sequence.
      const displayer = new FCS.DisplayFilter({
        is_unicode_cards: false,
        is_unicode_cards_chars: false
      });
      solver.display_solution({ displayer: displayer });

      const sequence = solver.get_pre_expand_states_and_moves_seq() || [];
      const moves = sequence.filter(item => item.type === "m");

      for (const move of moves) {
        const li = document.createElement("li");
        li.textContent = move.str;
        movesEl.appendChild(li);
      }

      statsEl.textContent = moves.length + " moves · " +
        solver.get_num_times_long().toLocaleString() + " solver iterations";
      sessionStorage.setItem("freecellSolution", JSON.stringify({
        board: board,
        moves: moves.map(move => move.str)
      }));
      viewerLink.hidden = false;
      setStatus("solved", "Solved");
    } catch (error) {
      showError(error);
    } finally {
      solveButton.disabled = !moduleWrapper;
      loadDealButton.disabled = !moduleWrapper;
    }
  }

  solveButton.addEventListener("click", solveBoard);
  loadDealButton.addEventListener("click", loadSampleDeal);
  clearButton.addEventListener("click", clearResults);

  (async function initialize() {
    try {
      // libfreecell-solver.min.js exports an asynchronous Emscripten module factory.
      const Module = await ModuleFactory({
        locateFile: function (path) {
          return path.endsWith(".wasm") ? "js/" + path : path;
        }
      });

      moduleWrapper = FCS.FC_Solve_init_wrappers_with_module(Module);
      loadSampleDeal();
      solveButton.disabled = false;
      setStatus("ready", "Solver loaded");

      if (new URLSearchParams(location.search).get("autosolve") === "1") {
        await solveBoard();
      }
    } catch (error) {
      showError(error);
    }
  }());
});
