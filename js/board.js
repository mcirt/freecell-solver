(function (ns) {
  "use strict";
  ns.parseBoard = function (text) {
    const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 8) throw new Error("The stored board must contain exactly eight tableau columns.");
    return { tableau: lines.map(line => line.replace(/^:\s*/, "").split(/\s+/).filter(Boolean)), freecells: [null,null,null,null], foundations: {S:null,H:null,D:null,C:null} };
  };
  ns.cloneState = function (state) { return { tableau: state.tableau.map(c => c.slice()), freecells: state.freecells.slice(), foundations: Object.assign({}, state.foundations) }; };
  function take(state, stack, count) { const c=state.tableau[stack]; if(!c||c.length<count) throw new Error("Invalid solver move from stack " + stack + "."); return c.splice(c.length-count,count); }
  ns.applyMove = function (previous, text) {
    const state=ns.cloneState(previous); let m;
    if((m=text.match(/^Move (\d+) cards? from stack (\d+) to stack (\d+)$/i))){ state.tableau[+m[3]].push(...take(state,+m[2],+m[1])); return state; }
    if((m=text.match(/^Move a card from stack (\d+) to stack (\d+)$/i))){ state.tableau[+m[2]].push(take(state,+m[1],1)[0]); return state; }
    if((m=text.match(/^Move a card from stack (\d+) to freecell (\d+)$/i))){ state.freecells[+m[2]]=take(state,+m[1],1)[0]; return state; }
    if((m=text.match(/^Move a card from freecell (\d+) to stack (\d+)$/i))){ const card=state.freecells[+m[1]]; if(!card) throw new Error("Invalid solver move from empty free cell."); state.freecells[+m[1]]=null; state.tableau[+m[2]].push(card); return state; }
    if((m=text.match(/^Move a card from stack (\d+) to the foundations$/i))){ const card=take(state,+m[1],1)[0]; state.foundations[card.slice(-1)]=card; return state; }
    if((m=text.match(/^Move a card from freecell (\d+) to the foundations$/i))){ const i=+m[1],card=state.freecells[i]; if(!card) throw new Error("Invalid foundation move from empty free cell."); state.freecells[i]=null; state.foundations[card.slice(-1)]=card; return state; }
    throw new Error("Unrecognized solver move: " + text);
  };
  ns.renderState = function (state) {
    const foundations=document.getElementById("foundations"), freecells=document.getElementById("freecells"), tableau=document.getElementById("tableau");
    foundations.replaceChildren(); ns.suitOrder.forEach(suit=>{ const slot=document.createElement("div"); slot.className="slot foundation-slot"+(state.foundations[suit]?"":" empty"); slot.dataset.symbol=ns.suitSymbols[suit]; slot.dataset.location="foundation-"+suit; if(state.foundations[suit]) slot.appendChild(ns.cardElement(state.foundations[suit])); foundations.appendChild(slot); });
    freecells.replaceChildren(); state.freecells.forEach((card,i)=>{ const slot=document.createElement("div"); slot.className="slot freecell-slot"+(card?"":" empty"); slot.dataset.symbol="⚜"; slot.dataset.location="freecell-"+i; if(card) slot.appendChild(ns.cardElement(card)); freecells.appendChild(slot); });
    tableau.replaceChildren(); state.tableau.forEach((column,i)=>{ const col=document.createElement("div"); col.className="column"; col.dataset.location="stack-"+i; const cards=document.createElement("div"); cards.className="cards"; column.forEach((card,j)=>{ const el=ns.cardElement(card); el.style.top="calc("+j+" * var(--overlap))"; el.style.zIndex=String(j+1); cards.appendChild(el); }); col.append(cards); tableau.appendChild(col); });
    ns.fitTableauToCards();
  };

  // v51: size the green tableau to the cards that are actually on screen.
  // This removes the large fixed empty area that could push playback controls below the iPhone viewport.
  ns.fitTableauToCards = function () {
    const tableauArea = document.querySelector('.solution-page .tableau-area');
    const columns = Array.from(document.querySelectorAll('.solution-page .cards'));
    if (!tableauArea || !columns.length) return;
    requestAnimationFrame(() => {
      let tallest = 0;
      columns.forEach(cards => {
        const cardEls = Array.from(cards.querySelectorAll('.card'));
        let needed = 0;
        if (cardEls.length) {
          const last = cardEls[cardEls.length - 1];
          needed = last.offsetTop + last.offsetHeight;
        }
        // Keep an empty column visible without forcing a tall board.
        needed = Math.max(needed, 74);
        cards.style.setProperty('--tableau-column-height', Math.ceil(needed) + 'px');
        tallest = Math.max(tallest, needed);
      });
      tableauArea.style.minHeight = Math.ceil(tallest + 20) + 'px';
    });
  };

  ns.showMoveAftermath = function (details, beforeState) {
    document.querySelectorAll('.just-moved,.move-origin-placeholder').forEach(el=>el.classList.remove('just-moved'));
    document.querySelectorAll('.move-origin-placeholder').forEach(el=>el.remove());
    if (!details || !beforeState) return;

    (details.cards || []).forEach(card => {
      const el = document.querySelector('.card[data-card="'+card+'"]');
      if (el) el.classList.add('just-moved');
    });

    if (details.source && details.source.startsWith('stack-')) {
      const sourceIndex = Number(details.source.split('-')[1]);
      const count = Math.max(1, (details.cards || []).length);
      const sourceBefore = beforeState.tableau[sourceIndex] || [];
      const firstIndex = Math.max(0, sourceBefore.length - count);
      const cards = document.querySelector('[data-location="stack-'+sourceIndex+'"] .cards');
      if (cards) {
        for (let i = 0; i < count; i += 1) {
          const placeholder = document.createElement('div');
          placeholder.className = 'move-origin-placeholder';
          placeholder.style.top = 'calc('+(firstIndex+i)+' * var(--overlap))';
          placeholder.style.zIndex = String(firstIndex+i+1);
          cards.appendChild(placeholder);
        }
      }
    } else if (details.source && details.source.startsWith('freecell-')) {
      const slot = document.querySelector('[data-location="'+details.source+'"]');
      if (slot) {
        const placeholder = document.createElement('div');
        placeholder.className = 'move-origin-placeholder freecell-origin-placeholder';
        slot.appendChild(placeholder);
      }
    }
  };
  if (!ns.v51TableauResizeBound) {
    ns.v51TableauResizeBound = true;
    window.addEventListener('resize', () => ns.fitTableauToCards && ns.fitTableauToCards(), { passive:true });
  }
  const spokenRanks = { A:"ace", J:"jack", Q:"queen", K:"king", T:"10" };
  const spokenSuits = { S:"spade", H:"heart", D:"diamond", C:"clover" };
  function cardWords(card) {
    if (!card) return "card";
    const rawRank = card.slice(0, -1);
    const suit = card.slice(-1);
    return (spokenRanks[rawRank] || rawRank) + " " + (spokenSuits[suit] || suit);
  }
  function columnWords(index) { return "column " + (Number(index) + 1); }
  function freeCellWords(index) { return "free cell " + (Number(index) + 1); }

  ns.describeMove = function (state, text) {
    let m;
    if ((m = text.match(/^Move (\d+) cards? from stack (\d+) to stack (\d+)$/i))) {
      const count = Number(m[1]);
      const source = Number(m[2]);
      const destination = Number(m[3]);
      const cards = state.tableau[source].slice(-count);
      const firstCard = cards[0];
      const destinationCard = state.tableau[destination].at(-1);
      const ending = destinationCard
        ? " to " + cardWords(destinationCard) + " " + columnWords(destination)
        : " to " + columnWords(destination);
      if (count === 1) return "Move " + cardWords(firstCard) + " " + columnWords(source) + ending + ".";
      return "Move " + count + " cards, starting with " + cardWords(firstCard) + " " + columnWords(source) + ending + ".";
    }
    if ((m = text.match(/^Move a card from stack (\d+) to stack (\d+)$/i))) {
      const source = Number(m[1]);
      const destination = Number(m[2]);
      const card = state.tableau[source].at(-1);
      const destinationCard = state.tableau[destination].at(-1);
      return "Move " + cardWords(card) + " " + columnWords(source) +
        (destinationCard ? " to " + cardWords(destinationCard) + " " + columnWords(destination) : " to " + columnWords(destination)) + ".";
    }
    if ((m = text.match(/^Move a card from stack (\d+) to freecell (\d+)$/i))) {
      const source = Number(m[1]);
      const card = state.tableau[source].at(-1);
      return "Move " + cardWords(card) + " to " + freeCellWords(m[2]) + ".";
    }
    if ((m = text.match(/^Move a card from freecell (\d+) to stack (\d+)$/i))) {
      const source = Number(m[1]);
      const destination = Number(m[2]);
      const card = state.freecells[source];
      const destinationCard = state.tableau[destination].at(-1);
      return "Move " + cardWords(card) + " " + freeCellWords(source) +
        (destinationCard ? " to " + cardWords(destinationCard) + " " + columnWords(destination) : " to " + columnWords(destination)) + ".";
    }
    if ((m = text.match(/^Move a card from stack (\d+) to the foundations$/i))) {
      const source = Number(m[1]);
      const card = state.tableau[source].at(-1);
      return "Move " + cardWords(card) + " " + columnWords(source) + " to foundation.";
    }
    if ((m = text.match(/^Move a card from freecell (\d+) to the foundations$/i))) {
      const source = Number(m[1]);
      const card = state.freecells[source];
      return "Move " + cardWords(card) + " " + freeCellWords(source) + " to foundation.";
    }
    return text;
  };

  ns.moveDetails = function (state,text) { let m;
    if((m=text.match(/^Move (\d+) cards? from stack (\d+) to stack (\d+)$/i))){ const n=+m[1],s=+m[2]; return {cards:state.tableau[s].slice(-n),source:"stack-"+s,destination:"stack-"+(+m[3])}; }
    if((m=text.match(/^Move a card from stack (\d+) to stack (\d+)$/i))){ const s=+m[1]; return {cards:state.tableau[s].slice(-1),source:"stack-"+s,destination:"stack-"+(+m[2])}; }
    if((m=text.match(/^Move a card from stack (\d+) to freecell (\d+)$/i))){ const s=+m[1]; return {cards:state.tableau[s].slice(-1),source:"stack-"+s,destination:"freecell-"+(+m[2])}; }
    if((m=text.match(/^Move a card from freecell (\d+) to stack (\d+)$/i))){ const s=+m[1]; return {cards:[state.freecells[s]],source:"freecell-"+s,destination:"stack-"+(+m[2])}; }
    if((m=text.match(/^Move a card from stack (\d+) to the foundations$/i))){ const s=+m[1],card=state.tableau[s].at(-1); return {cards:[card],source:"stack-"+s,destination:"foundation-"+card.slice(-1)}; }
    if((m=text.match(/^Move a card from freecell (\d+) to the foundations$/i))){ const s=+m[1],card=state.freecells[s]; return {cards:[card],source:"freecell-"+s,destination:"foundation-"+card.slice(-1)}; }
    return null;
  };
}(window.FreeCellViewer = window.FreeCellViewer || {}));
