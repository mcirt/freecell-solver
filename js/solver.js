define([
  "libfcs-wrap",
  "web-fc-solve",
  "web-fcs-api-base"
], function (ModuleFactory, FCS) {
  "use strict";

  const boardEl = document.getElementById("board");
  const solveButton = document.getElementById("solve");
  const statusEl = document.getElementById("status");
  const statsEl = document.getElementById("stats");
  const movesEl = document.getElementById("moves");
  const errorEl = document.getElementById("error");
  const viewerLink = document.getElementById("open-viewer");
  let moduleWrapper = null;

  function setStatus(kind, label) {
    if (statusEl) {
      statusEl.className = "status " + kind;
      statusEl.textContent = label;
    }
    window.dispatchEvent(new CustomEvent("freecell-solver-status", { detail: { kind, label } }));
  }

  function showError(error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = message;
    }
    setStatus("error", message);
    console.error(error);
  }

  function allowBrowserToPaint() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  async function solveBoard() {
    if (!moduleWrapper) return;
    solveButton.disabled = true;
    try {
      const board = boardEl.value.trim();
      if (!board) throw new Error("Enter all 52 cards before solving.");

      const solver = new FCS.FC_Solve({
        module_wrapper: moduleWrapper,
        dir_base: "js/",
        string_params: "",
        cmd_line_preset: "default",
        set_status_callback: setStatus
      });

      let result = solver.do_solve(board);
      while (result === FCS.FCS_STATE_SUSPEND_PROCESS && solver.current_iters_limit < 131072) {
        await allowBrowserToPaint();
        result = solver.resume_solution();
      }
      if (result !== FCS.FCS_STATE_WAS_SOLVED) return;

      solver.display_solution({
        displayer: new FCS.DisplayFilter({ is_unicode_cards: false, is_unicode_cards_chars: false })
      });
      const sequence = solver.get_pre_expand_states_and_moves_seq() || [];
      const moves = sequence.filter(item => item.type === "m");

      if (movesEl) {
        movesEl.replaceChildren();
        moves.forEach(move => {
          const li = document.createElement("li");
          li.textContent = move.str;
          movesEl.appendChild(li);
        });
      }
      if (statsEl) statsEl.textContent = moves.length + " moves";

      sessionStorage.setItem("freecellSolution", JSON.stringify({
        board,
        moves: moves.map(move => move.str)
      }));
      if (viewerLink) viewerLink.hidden = false;
      setStatus("solved", "Solution found. Opening viewer…");
      window.location.href = "solution.html";
    } catch (error) {
      showError(error);
      solveButton.disabled = false;
    }
  }

  solveButton.addEventListener("click", solveBoard);

  (async function initialize() {
    try {
      const Module = await ModuleFactory({
        locateFile: function (path) {
          return path.endsWith(".wasm") ? "js/" + path : path;
        }
      });
      moduleWrapper = FCS.FC_Solve_init_wrappers_with_module(Module);
      window.dispatchEvent(new Event("freecell-solver-ready"));
      setStatus("ready", "Solver loaded");
    } catch (error) {
      showError(error);
    }
  }());
});
