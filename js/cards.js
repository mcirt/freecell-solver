(function (ns) {
  "use strict";
  ns.suitSymbols = { S: "♠", H: "♥", D: "♦", C: "♣" };
  ns.suitOrder = ["S", "H", "D", "C"];
  ns.displayRank = function (rank) { return rank === "T" ? "10" : rank; };
  ns.cardElement = function (card) {
    const rawRank = card.slice(0, -1);
    const rank = ns.displayRank(rawRank);
    const suit = card.slice(-1);
    const el = document.createElement("div");
    el.className = "card " + ((suit === "H" || suit === "D") ? "red" : "black");
    el.dataset.card = card;
    el.setAttribute("aria-label", rank + " of " + suit);
    el.innerHTML = '<span class="rank">' + rank + '</span><span class="suit">' + ns.suitSymbols[suit] + '</span><span class="big-suit">' + ns.suitSymbols[suit] + '</span>';
    return el;
  };
}(window.FreeCellViewer = window.FreeCellViewer || {}));
