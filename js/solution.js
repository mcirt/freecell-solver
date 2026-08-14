(function (ns) {
  "use strict";

  let moves = [];
  let states = [];
  let current = 0;
  let playing = false;
  let lastMoveDetails = null;
  let lastMoveBeforeState = null;
  let animating = false;
  let speaking = false;
  let voiceEnabled = false;
  let availableVoices = [];
  let activeUtterance = null;
  let solutionPayload = null;

  const counter = document.getElementById("move-counter");
  const description = document.getElementById("move-description");
  const error = document.getElementById("viewer-error");
  const speed = document.getElementById("speed");
  const enableVoiceButton = document.getElementById("enable-voice");
  const autoSpeak = document.getElementById("auto-speak");
  const voiceSelect = document.getElementById("speech-voice");
  const speechRate = document.getElementById("speech-rate");
  const speechStatus = document.getElementById("speech-status");
  const canSpeak = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const captionsToggle = document.getElementById("show-captions");
  const captionBox = document.getElementById("spoken-caption");

  const spokenRanks = { A: "ace", J: "jack", Q: "queen", K: "king", T: "10" };
  const spokenSuits = { S: "spade", H: "heart", D: "diamond", C: "clover" };

  function cardWords(card) {
    if (!card) return "card";
    const rank = card.slice(0, -1);
    const suit = card.slice(-1);
    return (spokenRanks[rank] || rank) + " " + (spokenSuits[suit] || suit);
  }

  function columnWords(index) { return "column " + (Number(index) + 1); }
  function freeCellWords(index) { return "free cell " + (Number(index) + 1); }

  function describeMove(state, text) {
    let m;
    if ((m = text.match(/^Move (\d+) cards? from stack (\d+) to stack (\d+)$/i))) {
      const count = Number(m[1]);
      const source = Number(m[2]);
      const destination = Number(m[3]);
      const cards = state.tableau[source].slice(-count);
      const firstCard = cards[0];
      const destinationCard = state.tableau[destination].at(-1);
      const destinationWords = destinationCard
        ? columnWords(destination) + " " + cardWords(destinationCard)
        : columnWords(destination);
      if (count === 1) {
        return columnWords(source) + " " + cardWords(firstCard) + " to " + destinationWords + ".";
      }
      return columnWords(source) + " " + cardWords(firstCard) + ", " + count + " cards, to " + destinationWords + ".";
    }
    if ((m = text.match(/^Move a card from stack (\d+) to stack (\d+)$/i))) {
      const source = Number(m[1]);
      const destination = Number(m[2]);
      const card = state.tableau[source].at(-1);
      const destinationCard = state.tableau[destination].at(-1);
      return columnWords(source) + " " + cardWords(card) + " to " + columnWords(destination) +
        (destinationCard ? " " + cardWords(destinationCard) : "") + ".";
    }
    if ((m = text.match(/^Move a card from stack (\d+) to freecell (\d+)$/i))) {
      const source = Number(m[1]);
      const card = state.tableau[source].at(-1);
      return columnWords(source) + " " + cardWords(card) + " to " + freeCellWords(m[2]) + ".";
    }
    if ((m = text.match(/^Move a card from freecell (\d+) to stack (\d+)$/i))) {
      const source = Number(m[1]);
      const destination = Number(m[2]);
      const card = state.freecells[source];
      const destinationCard = state.tableau[destination].at(-1);
      return freeCellWords(source) + " " + cardWords(card) + " to " + columnWords(destination) +
        (destinationCard ? " " + cardWords(destinationCard) : "") + ".";
    }
    if ((m = text.match(/^Move a card from stack (\d+) to the foundations$/i))) {
      const source = Number(m[1]);
      const card = state.tableau[source].at(-1);
      return columnWords(source) + " " + cardWords(card) + " to foundation.";
    }
    if ((m = text.match(/^Move a card from freecell (\d+) to the foundations$/i))) {
      const source = Number(m[1]);
      const card = state.freecells[source];
      return freeCellWords(source) + " " + cardWords(card) + " to foundation.";
    }
    return text.replace(/^Move\s+/i, "");
  }

  function updateCaption(text) {
    const show = Boolean(captionsToggle && captionsToggle.checked);
    captionBox.hidden = !show;
    captionBox.textContent = show ? (text || "") : "";
  }

  function currentInstruction() {
    if (current >= moves.length) return "Solution complete.";
    return describeMove(states[current], moves[current]);
  }

  function setSpeechStatus(message, kind) {
    speechStatus.textContent = message || "";
    speechStatus.dataset.kind = kind || "";
  }

  function preferredVoiceIndex(voices) {
    const saved = safeStorageGet("freecellSpeechVoice");
    if (saved) {
      const savedIndex = voices.findIndex(voice => voice.voiceURI === saved || voice.name === saved);
      if (savedIndex >= 0) return savedIndex;
    }
    const preferredPatterns = [/samantha/i, /ava/i, /allison/i, /susan/i, /zira/i, /google us english/i];
    for (const pattern of preferredPatterns) {
      const index = voices.findIndex(voice => /^en(-|_)/i.test(voice.lang || "") && pattern.test(voice.name || ""));
      if (index >= 0) return index;
    }
    const localEnglish = voices.findIndex(voice => /^en(-|_)/i.test(voice.lang || "") && voice.localService);
    if (localEnglish >= 0) return localEnglish;
    return voices.findIndex(voice => /^en(-|_)/i.test(voice.lang || ""));
  }

  function loadVoices() {
    if (!canSpeak) return [];
    const voices = window.speechSynthesis.getVoices() || [];
    availableVoices = voices.slice();
    const previousValue = voiceSelect.value;
    voiceSelect.replaceChildren();

    if (!voices.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Default iPhone voice";
      voiceSelect.appendChild(option);
      voiceSelect.disabled = true;
      return voices;
    }

    voices.forEach((voice, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = voice.name + (voice.lang ? " — " + voice.lang : "");
      voiceSelect.appendChild(option);
    });
    voiceSelect.disabled = false;

    const priorIndex = Number(previousValue);
    if (previousValue !== "" && Number.isInteger(priorIndex) && voices[priorIndex]) {
      voiceSelect.value = String(priorIndex);
    } else {
      const index = preferredVoiceIndex(voices);
      voiceSelect.value = String(index >= 0 ? index : 0);
    }
    return voices;
  }

  function selectedVoice() {
    const index = Number(voiceSelect.value);
    return Number.isInteger(index) && availableVoices[index] ? availableVoices[index] : null;
  }

  function stopSpeaking({ clearStatus = true } = {}) {
    if (canSpeak) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
    }
    activeUtterance = null;
    speaking = false;
    if (clearStatus) setSpeechStatus(voiceEnabled ? "Voice ready." : "Tap Enable Voice first.", voiceEnabled ? "ready" : "warning");
  }

  function speak(text, options = {}) {
    const requireEnabled = options.requireEnabled !== false;
    return new Promise(resolve => {
      if (!canSpeak || !text) {
        resolve(false);
        return;
      }
      if (requireEnabled && !voiceEnabled) {
        setSpeechStatus("Tap Enable Voice first.", "warning");
        resolve(false);
        return;
      }

      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      loadVoices();

      const utterance = new SpeechSynthesisUtterance(text);
      const voice = selectedVoice();
      if (voice) utterance.voice = voice;
      utterance.lang = voice && voice.lang ? voice.lang : "en-US";
      utterance.rate = Number(speechRate.value) || 0.9;
      utterance.pitch = 1;
      utterance.volume = 1;
      activeUtterance = utterance;
      speaking = true;
      setSpeechStatus("Speaking…", "speaking");
      setControls();

      let finished = false;
      const timeout = window.setTimeout(() => finish(false, "Speech timed out. Tap Enable Voice again."), Math.max(6000, text.length * 180));
      function finish(ok, message) {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeout);
        if (activeUtterance === utterance) activeUtterance = null;
        speaking = false;
        if (message) setSpeechStatus(message, ok ? "ready" : "error");
        else setSpeechStatus(voiceEnabled ? "Voice ready." : "", voiceEnabled ? "ready" : "");
        setControls();
        resolve(ok);
      }

      utterance.onstart = () => {
        speaking = true;
        setSpeechStatus("Speaking…", "speaking");
        setControls();
      };
      utterance.onend = () => finish(true);
      utterance.onerror = event => {
        const reason = event && event.error ? event.error : "unknown error";
        finish(false, "Speech error: " + reason + ". Tap Enable Voice again.");
      };

      try {
        window.speechSynthesis.speak(utterance);
        // iOS can occasionally remain paused after cancel().
        window.setTimeout(() => window.speechSynthesis.resume(), 60);
      } catch (speechError) {
        finish(false, "Speech could not start: " + (speechError.message || speechError));
      }
    });
  }

  function safeStorageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }

  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function safeStorageRemove(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function enableVoice() {
    if (!canSpeak) {
      setSpeechStatus("Speech is not supported in this browser.", "error");
      return;
    }

    // Keep the first iPhone speech request inside the direct tap handler.
    setSpeechStatus("Enable Voice tapped — starting test phrase…", "speaking");
    enableVoiceButton.textContent = "Starting Voice…";
    enableVoiceButton.disabled = true;

    let utterance;
    try {
      utterance = new SpeechSynthesisUtterance("Voice guidance is ready.");
      utterance.lang = "en-US";
      utterance.rate = 0.9;
      utterance.pitch = 1;
      utterance.volume = 1;
    } catch (creationError) {
      voiceEnabled = false;
      enableVoiceButton.disabled = false;
      setSpeechStatus("Could not create speech: " + (creationError.message || creationError), "error");
      setControls();
      return;
    }

    let settled = false;
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      voiceEnabled = ok;
      speaking = false;
      activeUtterance = null;
      enableVoiceButton.disabled = false;
      autoSpeak.disabled = !ok;
      if (!ok) autoSpeak.checked = false;
      setSpeechStatus(message, ok ? "ready" : "error");
      setControls();
    };

    utterance.onstart = () => {
      speaking = true;
      voiceEnabled = true;
      setSpeechStatus("Speaking test phrase…", "speaking");
      setControls();
    };
    utterance.onend = () => finish(true, "Voice ready.");
    utterance.onerror = event => finish(false, "Voice error: " + ((event && event.error) || "unknown"));

    activeUtterance = utterance;
    speaking = true;

    try {
      // Do not cancel, resume, load voices, select a voice, or access storage here.
      window.speechSynthesis.speak(utterance);
    } catch (speechError) {
      finish(false, "Speech could not start: " + (speechError.message || speechError));
      return;
    }

    window.setTimeout(() => {
      if (!settled && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
        finish(false, "The browser accepted the tap but did not start speech.");
      }
    }, 2500);
  }

  function setControls() {
    const atStart = current === 0;
    const atEnd = current === moves.length;
    document.getElementById("first").disabled = atStart || animating;
    document.getElementById("previous").disabled = atStart || animating;
    document.getElementById("next").disabled = atEnd || animating;
    const playButton = document.getElementById("play");
    playButton.disabled = (!playing && animating) || moves.length === 0;
    playButton.textContent = playing ? "Ⅱ Pause" : "▶ Play";
    enableVoiceButton.disabled = !canSpeak || speaking;
    enableVoiceButton.textContent = voiceEnabled ? "✓ Voice Enabled" : "🔊 Enable Voice";
    document.getElementById("speak-move").disabled = !canSpeak || !voiceEnabled || atEnd || speaking;
    document.getElementById("stop-speaking").disabled = !canSpeak || !speaking;
  }

  function render() {
    ns.renderState(states[current]);
    if (lastMoveDetails && lastMoveBeforeState) ns.showMoveAftermath(lastMoveDetails, lastMoveBeforeState);
    if (current >= moves.length) {
      counter.textContent = "Move " + moves.length + " of " + moves.length;
      description.textContent = "Solution complete.";
      updateCaption("Solution complete.");
    } else {
      counter.textContent = "Next move " + (current + 1) + " of " + moves.length;
      const instruction = currentInstruction();
      description.textContent = instruction;
      updateCaption(instruction);
    }
    setControls();
  }

  function pause() {
    playing = false;
    stopSpeaking();
    setControls();
  }

  async function advanceOne({ fromPlay = false } = {}) {
    if (animating || current >= moves.length) {
      if (current >= moves.length) pause();
      return false;
    }

    animating = true;
    lastMoveDetails = null;
    lastMoveBeforeState = null;
    setControls();

    const moveText = moves[current];
    const spokenText = describeMove(states[current], moveText);
    description.textContent = spokenText;
    if (autoSpeak.checked && voiceEnabled) await speak(spokenText);

    const beforeState = states[current];
    const details = ns.moveDetails(beforeState, moveText);
    const nextState = states[current + 1];
    const selected = Number(speed.value);
    const duration = selected === 0 ? 0 : Math.max(260, Math.min(700, selected * 0.62));

    if (duration === 0) ns.renderState(nextState);
    else await ns.animateMove(details, nextState, duration);

    current += 1;
    lastMoveDetails = details;
    lastMoveBeforeState = beforeState;
    animating = false;
    render();

    if (!fromPlay) {
      playing = false;
      setControls();
    }
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
    lastMoveDetails = null;
    lastMoveBeforeState = null;
    ns.clearHighlights();
    render();
  }

  function formatLogTime(ms) {
    const value = Number(ms || 0);
    return value < 1000 ? Math.round(value) + " ms" : (value / 1000).toFixed(2) + " s";
  }

  function describeMoveList(board, moveList) {
    const lines = [];
    let state = ns.parseBoard(board);
    (moveList || []).forEach((move, index) => {
      let spoken = move;
      try { spoken = ns.describeMove(state, move); } catch (_) {}
      lines.push(String(index + 1).padStart(3, " ") + ". " + spoken + "   [" + move + "]");
      state = ns.applyMove(state, move);
    });
    return lines;
  }

  function buildSolutionLog() {
    const data = solutionPayload || {};
    const metadata = data.metadata || {};
    const race = metadata.raceWinner || null;
    const finalInfo = metadata.finalSolution || null;
    const optimizer = metadata.optimizer || null;
    const methods = Array.isArray(metadata.methods) ? metadata.methods : [];
    const finalMoves = Array.isArray(data.moves) ? data.moves : [];
    const raceMoves = race && Array.isArray(race.moveStrings) ? race.moveStrings : finalMoves;
    const lines = [];

    lines.push("FREECELL SOLUTION LOG");
    lines.push("Generated: " + new Date().toISOString());
    lines.push("");
    lines.push("SUMMARY");
    lines.push("Race winner: " + (race ? race.name : "Unknown"));
    lines.push("Race solution: " + raceMoves.length + " moves");
    if (optimizer) {
      lines.push("Optimizer removed: " + Number(optimizer.savedMoves || 0) + " moves");
      lines.push("Optimizer iterations: " + Number(optimizer.iterations || 0).toLocaleString("en-US"));
      lines.push("Optimizer time: " + formatLogTime(optimizer.elapsedMs));
      if (Number(optimizer.foundationCascades || 0)) lines.push("Foundation cascade promotions: " + Number(optimizer.foundationCascades || 0));
      if (Number(optimizer.cascadeSeeds || 0)) lines.push("Mobility cascade seed branches: " + Number(optimizer.cascadeSeeds || 0));
    }
    lines.push("Final solution: " + finalMoves.length + " moves" + (finalInfo && finalInfo.name ? " (" + finalInfo.name + ")" : ""));
    lines.push("");

    if (methods.length) {
      lines.push("SOLVER RACE RESULTS");
      methods.forEach(item => {
        if (!item) return;
        lines.push("- " + item.name + ": " + (item.validated ? item.moves + " moves" : "not solved") +
          "; iterations " + Number(item.iterations || 0).toLocaleString("en-US") +
          "; time " + formatLogTime(item.elapsedMs));
      });
      lines.push("");
    }

    lines.push("ORIGINAL BOARD");
    lines.push((data.board || "").trim());
    lines.push("");

    lines.push("RACE WINNER MOVE LIST — " + raceMoves.length + " MOVES");
    lines.push("Each line shows the spoken/viewer description followed by the raw solver move in brackets.");
    lines.push(...describeMoveList(data.board, raceMoves));
    lines.push("");

    lines.push("FINAL OPTIMIZED MOVE LIST — " + finalMoves.length + " MOVES");
    lines.push(...describeMoveList(data.board, finalMoves));
    lines.push("");
    return lines.join("\n");
  }

  function downloadSolutionLog() {
    try {
      const text = buildSolutionLog();
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "freecell-solution-log-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      error.hidden = false;
      error.textContent = "Could not create solution log: " + (e.message || String(e));
    }
  }

  function init() {
    try {
      const raw = sessionStorage.getItem("freecellSolution");
      if (!raw) throw new Error("No solved board was found. Return to the solver page, solve a board, and open the graphical viewer.");

      const data = JSON.parse(raw);
      solutionPayload = data;
      moves = data.moves;
      states = [ns.parseBoard(data.board)];
      moves.forEach(move => states.push(ns.applyMove(states.at(-1), move)));

      ns.bindControls({ goTo, next, play, pause, isPlaying: () => playing, current: () => current, total: () => moves.length });
      const downloadLogButton = document.getElementById("download-solution-log");
      if (downloadLogButton) downloadLogButton.addEventListener("click", downloadSolutionLog);
      enableVoiceButton.addEventListener("click", enableVoice);
      document.getElementById("speak-move").addEventListener("click", () => speak(currentInstruction()));
      document.getElementById("stop-speaking").addEventListener("click", () => stopSpeaking());
      voiceSelect.addEventListener("change", () => {
        const voice = selectedVoice();
        if (voice) safeStorageSet("freecellSpeechVoice", voice.voiceURI || voice.name);
        if (voiceEnabled) setSpeechStatus("Voice selected: " + (voice ? voice.name : "default") + ".", "ready");
      });
      speechRate.addEventListener("change", () => safeStorageSet("freecellSpeechRate", speechRate.value));
      autoSpeak.addEventListener("change", () => safeStorageSet("freecellAutoSpeak", autoSpeak.checked ? "true" : "false"));
      captionsToggle.addEventListener("change", () => {
        safeStorageSet("freecellShowCaptions", captionsToggle.checked ? "true" : "false");
        updateCaption(currentInstruction());
      });
      window.addEventListener("beforeunload", () => stopSpeaking({ clearStatus: false }));
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && canSpeak) window.speechSynthesis.resume();
      });

      if (!canSpeak) {
        autoSpeak.checked = false;
        autoSpeak.disabled = true;
        enableVoiceButton.disabled = true;
        voiceSelect.disabled = true;
        setSpeechStatus("Speech is not supported in this browser.", "error");
      } else {
        const savedRate = safeStorageGet("freecellSpeechRate");
        if (savedRate && Array.from(speechRate.options).some(option => option.value === savedRate)) speechRate.value = savedRate;
        autoSpeak.checked = safeStorageGet("freecellAutoSpeak") !== "false";
        captionsToggle.checked = safeStorageGet("freecellShowCaptions") !== "false";
        autoSpeak.disabled = true;
        loadVoices();
        window.speechSynthesis.onvoiceschanged = loadVoices;
        setSpeechStatus("Tap Enable Voice once before using spoken moves.", "warning");
      }
      render();
    } catch (e) {
      error.hidden = false;
      error.textContent = e.message || String(e);
      console.error(e);
    }
  }

  init();
}(window.FreeCellViewer = window.FreeCellViewer || {}));
