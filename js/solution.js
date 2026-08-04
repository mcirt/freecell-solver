(function (ns) {
  "use strict";

  let moves = [];
  let states = [];
  let current = 0;
  let playing = false;
  let animating = false;
  let speaking = false;
  let voiceEnabled = false;
  let availableVoices = [];
  let activeUtterance = null;

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

  function currentInstruction() {
    if (current >= moves.length) return "Solution complete.";
    return ns.describeMove(states[current], moves[current]);
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
    document.getElementById("last").disabled = atEnd || animating;
    document.getElementById("play").disabled = playing || animating || moves.length === 0;
    document.getElementById("pause").disabled = !playing && !speaking;
    enableVoiceButton.disabled = !canSpeak || speaking;
    enableVoiceButton.textContent = voiceEnabled ? "✓ Voice Enabled" : "🔊 Enable Voice";
    document.getElementById("speak-move").disabled = !canSpeak || !voiceEnabled || atEnd || speaking;
    document.getElementById("stop-speaking").disabled = !canSpeak || !speaking;
  }

  function render() {
    ns.renderState(states[current]);
    if (current >= moves.length) {
      counter.textContent = "Move " + moves.length + " of " + moves.length;
      description.textContent = "Solution complete.";
    } else {
      counter.textContent = "Next move " + (current + 1) + " of " + moves.length;
      description.textContent = currentInstruction();
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
    setControls();

    const moveText = moves[current];
    const spokenText = ns.describeMove(states[current], moveText);
    description.textContent = spokenText;
    if (autoSpeak.checked && voiceEnabled) await speak(spokenText);

    const details = ns.moveDetails(states[current], moveText);
    const nextState = states[current + 1];
    const selected = Number(speed.value);
    const duration = selected === 0 ? 0 : Math.max(260, Math.min(700, selected * 0.62));

    if (duration === 0) ns.renderState(nextState);
    else await ns.animateMove(details, nextState, duration);

    current += 1;
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
    ns.clearHighlights();
    render();
  }

  function init() {
    try {
      const raw = sessionStorage.getItem("freecellSolution");
      if (!raw) throw new Error("No solved board was found. Return to the solver page, solve a board, and open the graphical viewer.");

      const data = JSON.parse(raw);
      moves = data.moves;
      states = [ns.parseBoard(data.board)];
      moves.forEach(move => states.push(ns.applyMove(states.at(-1), move)));

      ns.bindControls({ goTo, next, play, pause, current: () => current, total: () => moves.length });
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
