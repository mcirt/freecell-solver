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

  const labButton = document.getElementById("solver-lab");
  const labPanel = document.getElementById("solver-lab-panel");
  const labClose = document.getElementById("solver-lab-close");
  const labRun = document.getElementById("solver-lab-run");
  const labOpenBest = document.getElementById("solver-lab-open-best");
  const labProgress = document.getElementById("solver-lab-progress");
  const labResults = document.getElementById("solver-lab-results");

  const MAX_ITERS = 131072;
  const OPTIMIZER_MAX_ITERS = 524288;
  const SOLVER_TESTS = [
    { id: "default", name: "fc-solve — Default", engine: "fc", params: "" },
    { id: "optimize", name: "fc-solve — Optimize", engine: "fc", params: "--optimize-solution" },
    { id: "reparent", name: "fc-solve — Reparent", engine: "fc", params: "--reparent-states --calc-real-depth" },
    { id: "combined", name: "fc-solve — Optimize + reparent", engine: "fc", params: "--optimize-solution --reparent-states --calc-real-depth" },
    { id: "fc-befs", name: "fc-solve — Best-First", engine: "fc", params: "--method a-star" },
    { id: "fc-soft-dfs", name: "fc-solve — Soft-DFS", engine: "fc", params: "--method soft-dfs" },
    { id: "js-best", name: "Independent JS — Best-First", engine: "js", mode: "best" },
    { id: "js-astar", name: "Independent JS — A*", engine: "js", mode: "astar" }
  ];
  const OPTIMIZER_TEST = { id: "optimizer", name: "Post-race optimizer", engine: "optimizer" };

  let moduleWrapper = null;
  let comparisonRunning = false;
  let bestComparison = null;
  let lastComparisonRaceWinner = null;
  let lastComparisonOutcomes = [];
  let lastComparisonOptimizer = null;

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

  function createSolver(params, statusCallback) {
    return new FCS.FC_Solve({
      module_wrapper: moduleWrapper,
      dir_base: "js/",
      string_params: params,
      cmd_line_preset: "default",
      set_status_callback: statusCallback || function () {}
    });
  }

  async function runSolver(board, params, statusCallback) {
    const started = performance.now();
    let solver;
    try {
      solver = createSolver(params, statusCallback);
      let result = solver.do_solve(board);
      while (result === FCS.FCS_STATE_SUSPEND_PROCESS && solver.current_iters_limit < MAX_ITERS) {
        await allowBrowserToPaint();
        result = solver.resume_solution();
      }

      const elapsedMs = performance.now() - started;
      const iterations = typeof solver.get_num_times_long === "function" ? solver.get_num_times_long() : solver.current_iters_limit;
      if (result !== FCS.FCS_STATE_WAS_SOLVED) {
        return { solved: false, result, elapsedMs, iterations, moves: [], moveStrings: [] };
      }

      solver.display_solution({
        displayer: new FCS.DisplayFilter({ is_unicode_cards: false, is_unicode_cards_chars: false })
      });
      const sequence = solver.get_pre_expand_states_and_moves_seq() || [];
      const moves = sequence.filter(item => item.type === "m");
      return {
        solved: true,
        result,
        elapsedMs,
        iterations,
        moves,
        moveStrings: moves.map(move => move.str)
      };
    } catch (error) {
      return {
        solved: false,
        error,
        elapsedMs: performance.now() - started,
        iterations: 0,
        moves: [],
        moveStrings: []
      };
    }
  }

  async function runAlternateSolver(board, mode, statusCallback) {
    const started = performance.now();
    if (!window.FreeCellAlternateSolver) {
      return { solved:false, error:new Error("Independent JavaScript solver did not load."), elapsedMs:0, iterations:0, moves:[], moveStrings:[] };
    }
    try {
      const result = await window.FreeCellAlternateSolver.solve(board, {
        mode: mode,
        maxExpanded: MAX_ITERS,
        maxMs: 15000,
        yieldEvery: 350
      }, function (progress) {
        if (!statusCallback) return;
        const expanded = Number(progress.expanded || 0).toLocaleString();
        const frontier = Number(progress.frontier || 0).toLocaleString();
        statusCallback("searching", "expanded " + expanded + " states; frontier " + frontier);
      });
      const moveStrings = Array.isArray(result.moveStrings) ? result.moveStrings : [];
      return {
        solved: Boolean(result.solved && result.validated),
        validated: Boolean(result.validated),
        elapsedMs: Number(result.elapsedMs || (performance.now() - started)),
        iterations: Number(result.expanded || 0),
        generated: Number(result.generated || 0),
        moves: moveStrings.map(str => ({str})),
        moveStrings,
        reason: result.reason || ""
      };
    } catch (error) {
      return { solved:false, error, elapsedMs:performance.now()-started, iterations:0, moves:[], moveStrings:[] };
    }
  }

  async function runTest(board, test, statusCallback) {
    if (test.engine === "js") return runAlternateSolver(board, test.mode, statusCallback);
    return runSolver(board, test.params || "", statusCallback);
  }

  async function runOptimizer(board, incumbent, statusCallback) {
    const started = performance.now();
    if (!incumbent || !incumbent.solved || !Array.isArray(incumbent.moveStrings)) {
      return { solved:false, elapsedMs:0, iterations:0, moves:[], moveStrings:[], reason:"No incumbent solution to optimize." };
    }
    if (!window.FreeCellAlternateSolver || typeof window.FreeCellAlternateSolver.improve !== "function") {
      return { solved:true, validated:true, elapsedMs:0, iterations:0, moves:incumbent.moves.slice(), moveStrings:incumbent.moveStrings.slice(), reason:"Optimizer unavailable; incumbent preserved." };
    }
    try {
      const result = await window.FreeCellAlternateSolver.improve(board, incumbent.moveStrings, {
        maxExpanded: OPTIMIZER_MAX_ITERS,
        maxMs: 10000,
        yieldEvery: 350,
        maxPasses: 16,
        maxBridgeDepth: 2
      }, function (progress) {
        if (!statusCallback) return;
        const best = progress.bestMoves ? progress.bestMoves + " moves" : "searching";
        const expanded = Number(progress.expanded || 0).toLocaleString();
        const stage = progress.stage === "simplified" ? "shortcut cleanup" : "bounded Best-First";
        statusCallback("searching", `${stage}: ${best}; expanded ${expanded} states`);
      });
      const moveStrings = Array.isArray(result.moveStrings) ? result.moveStrings : incumbent.moveStrings.slice();
      return {
        solved: Boolean(result.solved && result.validated),
        validated: Boolean(result.validated),
        elapsedMs: Number(result.elapsedMs || (performance.now() - started)),
        iterations: Number(result.expanded || 0),
        generated: Number(result.generated || 0),
        moves: moveStrings.map(str => ({str})),
        moveStrings,
        savedMoves: Number(result.savedMoves || 0),
        startingMoves: Number(result.startingMoves || incumbent.moveStrings.length),
        reason: result.reason || ""
      };
    } catch (error) {
      return { solved:false, error, elapsedMs:performance.now()-started, iterations:0, moves:[], moveStrings:[] };
    }
  }

  function outcomeSummary(outcome) {
    if (!outcome) return null;
    return {
      name: outcome.test ? outcome.test.name : "Unknown",
      moves: Array.isArray(outcome.moveStrings) ? outcome.moveStrings.length : 0,
      iterations: Number(outcome.iterations || 0),
      elapsedMs: Number(outcome.elapsedMs || 0),
      validated: Boolean(outcome.validated !== false && outcome.solved)
    };
  }

  function saveSolution(board, moveStrings, metadata) {
    const payload = { board, moves: moveStrings };
    if (metadata) payload.metadata = metadata;
    sessionStorage.setItem("freecellSolution", JSON.stringify(payload));
  }

  async function findBestSolution(board, statusCallback) {
    let best = null;
    const outcomes = [];

    for (let index = 0; index < SOLVER_TESTS.length; index += 1) {
      const test = SOLVER_TESTS[index];
      if (statusCallback) {
        statusCallback("searching", `Trying ${index + 1} of ${SOLVER_TESTS.length}: ${test.name}…`);
      }

      const outcome = await runTest(board, test, function (_kind, label) {
        if (statusCallback) statusCallback("searching", `${test.name}: ${label}`);
      });

      outcome.test = test;
      outcomes.push(outcome);

      if (outcome.solved && (!best || outcome.moveStrings.length < best.moveStrings.length)) {
        best = outcome;
        if (statusCallback) {
          statusCallback("searching", `New best: ${best.moveStrings.length} moves using ${test.name}.`);
        }
      }

      await allowBrowserToPaint();
    }

    return { best, outcomes };
  }

  async function solveBoard() {
    if (!moduleWrapper || comparisonRunning) return;
    solveButton.disabled = true;
    if (labButton) labButton.disabled = true;

    try {
      const board = boardEl.value.trim();
      if (!board) throw new Error("Enter all 52 cards before solving.");

      setStatus("searching", "Running 8 reliable solver methods…");
      const result = await findBestSolution(board, setStatus);
      let outcome = result.best;

      if (!outcome) {
        throw new Error("None of the solver methods found a validated solution within the search limits.");
      }

      const raceWinner = outcome;
      setStatus("searching", `Best race result: ${outcome.moveStrings.length} moves. Running cleanup and improvement pass…`);
      const optimized = await runOptimizer(board, outcome, setStatus);
      if (optimized.solved && optimized.moveStrings.length <= outcome.moveStrings.length) {
        optimized.test = OPTIMIZER_TEST;
        outcome = optimized;
      }

      if (movesEl) {
        movesEl.replaceChildren();
        outcome.moves.forEach(move => {
          const li = document.createElement("li");
          li.textContent = move.str;
          movesEl.appendChild(li);
        });
      }

      if (statsEl) statsEl.textContent = outcome.moveStrings.length + " moves";
      saveSolution(board, outcome.moveStrings, {
        raceWinner: {
          ...outcomeSummary(raceWinner),
          moveStrings: raceWinner.moveStrings.slice()
        },
        finalSolution: outcomeSummary(outcome),
        optimizer: outcome.test && outcome.test.id === "optimizer" ? {
          savedMoves: Math.max(0, raceWinner.moveStrings.length - outcome.moveStrings.length),
          iterations: Number(outcome.iterations || 0),
          elapsedMs: Number(outcome.elapsedMs || 0),
          reason: outcome.reason || ""
        } : null,
        methods: result.outcomes.map(item => outcomeSummary(item))
      });
      if (viewerLink) viewerLink.hidden = false;
      setStatus(
        "solved",
        `Shortest validated solution after optimization: ${outcome.moveStrings.length} moves. Opening viewer…`
      );
      window.location.href = "solution.html";
    } catch (error) {
      showError(error);
      solveButton.disabled = false;
      syncLabButton();
    }
  }

  function formatTime(ms) {
    return ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";
  }

  function addPendingRow(test) {
    const row = document.createElement("tr");
    row.dataset.testId = test.id;
    row.innerHTML = "<th scope=\"row\"></th><td class=\"lab-result\">Waiting</td><td>—</td><td>—</td><td>—</td>";
    row.querySelector("th").textContent = test.name;
    labResults.appendChild(row);
    return row;
  }

  function updateResultRow(row, outcome) {
    const cells = row.querySelectorAll("td");
    if (outcome.error) {
      row.classList.add("solver-lab-error");
      cells[0].textContent = "Error";
      cells[0].title = outcome.error.message || String(outcome.error);
      cells[1].textContent = "—";
      cells[2].textContent = "—";
      cells[3].textContent = formatTime(outcome.elapsedMs);
      return;
    }
    cells[0].textContent = outcome.solved ? "Solved" : "Not solved";
    cells[1].textContent = outcome.solved ? String(outcome.moveStrings.length) : "—";
    cells[2].textContent = Number(outcome.iterations || 0).toLocaleString();
    cells[3].textContent = formatTime(outcome.elapsedMs);
    row.classList.add(outcome.solved ? "solver-lab-solved" : "solver-lab-unsolved");
  }

  function syncLabButton() {
    if (!labButton || comparisonRunning) return;
    labButton.disabled = !moduleWrapper || solveButton.disabled;
  }

  async function runComparison() {
    if (!moduleWrapper || comparisonRunning) return;
    const board = boardEl.value.trim();
    if (!board) {
      showError(new Error("Enter all 52 cards before comparing solver modes."));
      return;
    }

    comparisonRunning = true;
    bestComparison = null;
    lastComparisonRaceWinner = null;
    lastComparisonOutcomes = [];
    lastComparisonOptimizer = null;
    labOpenBest.disabled = true;
    labButton.disabled = true;
    labRun.disabled = true;
    labResults.replaceChildren();
    const rows = new Map();
    SOLVER_TESTS.forEach(test => rows.set(test.id, addPendingRow(test)));
    rows.set(OPTIMIZER_TEST.id, addPendingRow(OPTIMIZER_TEST));

    try {
      for (let index = 0; index < SOLVER_TESTS.length; index += 1) {
        const test = SOLVER_TESTS[index];
        const row = rows.get(test.id);
        row.classList.add("solver-lab-running");
        labProgress.textContent = `Testing ${index + 1} of ${SOLVER_TESTS.length}: ${test.name}…`;
        const outcome = await runTest(board, test, function (_kind, label) {
          labProgress.textContent = `${test.name}: ${label}`;
        });
        row.classList.remove("solver-lab-running");
        updateResultRow(row, outcome);
        outcome.test = test;
        lastComparisonOutcomes.push(outcome);
        if (outcome.solved && (!bestComparison || outcome.moveStrings.length < bestComparison.moveStrings.length)) {
          bestComparison = outcome;
        }
        await allowBrowserToPaint();
      }

      const optimizerRow = rows.get(OPTIMIZER_TEST.id);
      if (bestComparison) {
        const raceWinner = bestComparison;
        lastComparisonRaceWinner = raceWinner;
        optimizerRow.classList.add("solver-lab-running");
        labProgress.textContent = `Race winner: ${raceWinner.moveStrings.length} moves using ${raceWinner.test.name}. Optimizing…`;
        const optimized = await runOptimizer(board, raceWinner, function (_kind, label) {
          labProgress.textContent = `Post-race optimizer: ${label}`;
        });
        optimizerRow.classList.remove("solver-lab-running");
        optimized.test = OPTIMIZER_TEST;
        lastComparisonOptimizer = optimized;
        updateResultRow(optimizerRow, optimized);
        if (optimized.solved && optimized.moveStrings.length <= bestComparison.moveStrings.length) {
          bestComparison = optimized;
        }

        const bestRow = rows.get(bestComparison.test.id);
        bestRow.classList.add("solver-lab-best");
        bestRow.querySelector(".lab-result").textContent = bestComparison.test.id === "optimizer" ? "Best after cleanup" : "Best found";
        const saved = optimized.solved ? Math.max(0, raceWinner.moveStrings.length - optimized.moveStrings.length) : 0;
        labProgress.textContent = saved > 0
          ? `Comparison complete. Race winner ${raceWinner.moveStrings.length}; optimizer removed ${saved} move${saved===1?"":"s"}. Final: ${bestComparison.moveStrings.length} moves.`
          : `Comparison complete. Shortest result: ${bestComparison.moveStrings.length} moves. Optimizer found no shorter validated path within its budget.`;
        labOpenBest.disabled = false;
      } else {
        optimizerRow.querySelector(".lab-result").textContent = "Skipped";
        optimizerRow.querySelectorAll("td").forEach((cell,index)=>{ if(index>0) cell.textContent="—"; });
        labProgress.textContent = "Comparison complete, but none of the tested methods solved within the iteration ceiling.";
      }
    } finally {
      comparisonRunning = false;
      labRun.disabled = false;
      syncLabButton();
    }
  }

  function openLab() {
    labPanel.hidden = false;
    labPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    runComparison();
  }

  solveButton.addEventListener("click", solveBoard);
  if (labButton) labButton.addEventListener("click", openLab);
  if (labRun) labRun.addEventListener("click", runComparison);
  if (labClose) labClose.addEventListener("click", function () { labPanel.hidden = true; });
  if (labOpenBest) labOpenBest.addEventListener("click", function () {
    if (!bestComparison) return;
    const raceWinner = lastComparisonRaceWinner || bestComparison;
    saveSolution(boardEl.value.trim(), bestComparison.moveStrings, {
      raceWinner: {
        ...outcomeSummary(raceWinner),
        moveStrings: raceWinner.moveStrings.slice()
      },
      finalSolution: outcomeSummary(bestComparison),
      optimizer: lastComparisonOptimizer ? {
        savedMoves: Math.max(0, raceWinner.moveStrings.length - bestComparison.moveStrings.length),
        iterations: Number(lastComparisonOptimizer.iterations || 0),
        elapsedMs: Number(lastComparisonOptimizer.elapsedMs || 0),
        reason: lastComparisonOptimizer.reason || ""
      } : null,
      methods: lastComparisonOutcomes.map(item => outcomeSummary(item))
    });
    window.location.href = "solution.html";
  });

  if (solveButton && labButton) {
    new MutationObserver(syncLabButton).observe(solveButton, { attributes: true, attributeFilter: ["disabled"] });
  }

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
      syncLabButton();
    } catch (error) {
      showError(error);
    }
  }());
});
