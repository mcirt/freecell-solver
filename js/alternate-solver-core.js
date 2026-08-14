(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FreeCellAltSolver = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const SUITS = ['S','H','C','D'];
  const SUIT_INDEX = Object.freeze({S:0,H:1,C:2,D:3});
  const RED = Object.freeze({H:true,D:true,S:false,C:false});
  const RANKS = Object.freeze({A:1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,T:10,J:11,Q:12,K:13});

  function normalizeCard(raw) {
    const text = String(raw || '').trim().toUpperCase().replace(/^10/, 'T');
    if (!/^(?:A|[2-9]|T|J|Q|K)[SHCD]$/.test(text)) throw new Error('Invalid card: ' + raw);
    return text;
  }
  function rank(card) { return RANKS[card.slice(0,-1)]; }
  function suit(card) { return card.slice(-1); }
  function opposite(a,b) { return RED[suit(a)] !== RED[suit(b)]; }
  function canPlace(card, destination) { return !!destination && opposite(card,destination) && rank(destination) === rank(card) + 1; }

  function parseBoard(text) {
    const lines = String(text || '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 8) throw new Error('Board must contain exactly 8 tableau columns.');
    const tableau = lines.map(line => line.replace(/^:\s*/, '').split(/\s+/).filter(Boolean).map(normalizeCard));
    const expected = [7,7,7,7,6,6,6,6];
    tableau.forEach((column,i) => {
      if (column.length !== expected[i]) throw new Error('Column ' + (i+1) + ' must contain ' + expected[i] + ' cards.');
    });
    const cards = tableau.flat();
    if (cards.length !== 52 || new Set(cards).size !== 52) throw new Error('Board must contain 52 unique cards.');
    return { tableau, freecells:[null,null,null,null], foundations:[0,0,0,0] };
  }

  function cloneState(s) {
    return { tableau:s.tableau.map(c=>c.slice()), freecells:s.freecells.slice(), foundations:s.foundations.slice() };
  }
  function foundationCount(s) { return s.foundations[0]+s.foundations[1]+s.foundations[2]+s.foundations[3]; }
  function isGoal(s) { return foundationCount(s) === 52; }
  function foundationLegal(s, card) { const si=SUIT_INDEX[suit(card)]; return rank(card) === s.foundations[si] + 1; }

  function canonicalKey(s) {
    const cols = s.tableau.map(c=>c.join(',')).sort();
    const cells = s.freecells.filter(Boolean).slice().sort();
    return s.foundations.join('.') + '|' + cells.join(',') + '|' + cols.join('|');
  }

  function validTailLength(column) {
    if (!column.length) return 0;
    let len=1;
    for (let i=column.length-2;i>=0;i--) {
      if (canPlace(column[i+1], column[i])) len++;
      else break;
    }
    return len;
  }

  function moveCapacity(s, destinationIndex) {
    const emptyFree = s.freecells.reduce((n,c)=>n+(c?0:1),0);
    let emptyCols = s.tableau.reduce((n,c)=>n+(c.length?0:1),0);
    if (s.tableau[destinationIndex].length === 0) emptyCols = Math.max(0, emptyCols-1);
    return (emptyFree + 1) * Math.pow(2, emptyCols);
  }

  function pushMove(list, state, move, orderBias) {
    list.push({state, move, orderBias:orderBias||0});
  }

  function generateMoves(s, fullSymmetry) {
    fullSymmetry = Boolean(fullSymmetry);
    const out=[];
    const emptyCellIndexes = [];
    for (let i=0;i<4;i++) if (!s.freecells[i]) emptyCellIndexes.push(i);
    const firstEmptyCell = emptyCellIndexes.length ? emptyCellIndexes[0] : -1;
    const emptyCols = [];
    for (let i=0;i<8;i++) if (!s.tableau[i].length) emptyCols.push(i);
    const firstEmptyCol = emptyCols.length ? emptyCols[0] : -1;

    // Foundation moves first. They reduce the board and are never forced; bad early choices remain separate branches.
    for (let i=0;i<8;i++) {
      const col=s.tableau[i]; if (!col.length) continue;
      const card=col[col.length-1];
      if (foundationLegal(s,card)) {
        const n=cloneState(s); n.tableau[i].pop(); n.foundations[SUIT_INDEX[suit(card)]]++;
        pushMove(out,n,'Move a card from stack '+i+' to the foundations',-100);
      }
    }
    for (let i=0;i<4;i++) {
      const card=s.freecells[i]; if (!card) continue;
      if (foundationLegal(s,card)) {
        const n=cloneState(s); n.freecells[i]=null; n.foundations[SUIT_INDEX[suit(card)]]++;
        pushMove(out,n,'Move a card from freecell '+i+' to the foundations',-100);
      }
    }

    // Freecell to tableau.
    for (let f=0;f<4;f++) {
      const card=s.freecells[f]; if (!card) continue;
      for (let d=0;d<8;d++) {
        const dc=s.tableau[d], top=dc[dc.length-1];
        if (top && canPlace(card,top)) {
          const n=cloneState(s); n.freecells[f]=null; n.tableau[d].push(card);
          pushMove(out,n,'Move a card from freecell '+f+' to stack '+d,-25);
        } else if (!top && (fullSymmetry || d===firstEmptyCol)) {
          const n=cloneState(s); n.freecells[f]=null; n.tableau[d].push(card);
          pushMove(out,n,'Move a card from freecell '+f+' to stack '+d,-15);
        }
      }
    }

    // Tableau sequences to tableau. Include legal supermoves.
    for (let src=0;src<8;src++) {
      const sc=s.tableau[src]; if (!sc.length) continue;
      const tail=validTailLength(sc);
      for (let dst=0;dst<8;dst++) {
        if (src===dst) continue;
        const dc=s.tableau[dst], dstTop=dc[dc.length-1] || null;
        if (!dstTop && !fullSymmetry && dst!==firstEmptyCol) continue; // empty columns are symmetric during solving
        const cap=moveCapacity(s,dst);
        const max=Math.min(tail,cap);
        for (let count=1;count<=max;count++) {
          const first=sc[sc.length-count];
          if (dstTop ? !canPlace(first,dstTop) : false) continue;
          if (!dstTop && !fullSymmetry && count===sc.length) continue; // pure column permutation is useless during solving
          const n=cloneState(s); const moved=n.tableau[src].splice(n.tableau[src].length-count,count); n.tableau[dst].push.apply(n.tableau[dst],moved);
          const text=count===1 ? 'Move a card from stack '+src+' to stack '+dst : 'Move '+count+' cards from stack '+src+' to stack '+dst;
          pushMove(out,n,text,dstTop ? -10-count : 3-count);
        }
      }
    }

    // During solving one representative empty freecell is enough because freecells are symmetric.
    // The optimizer asks for full symmetry so it can match exact future positions in an existing solution.
    const freecellTargets = fullSymmetry ? emptyCellIndexes : (firstEmptyCell>=0 ? [firstEmptyCell] : []);
    for (const target of freecellTargets) {
      for (let src=0;src<8;src++) {
        const sc=s.tableau[src]; if (!sc.length) continue;
        const n=cloneState(s); n.freecells[target]=n.tableau[src].pop();
        pushMove(out,n,'Move a card from stack '+src+' to freecell '+target,20);
      }
    }
    return out;
  }

  function disorderScore(s) {
    let bad=0;
    for (const col of s.tableau) {
      for (let i=0;i<col.length-1;i++) if (!canPlace(col[i+1],col[i])) bad++;
    }
    return bad;
  }
  function burialScore(s) {
    let score=0;
    for (let si=0;si<4;si++) {
      const need=s.foundations[si]+1;
      if (need>13) continue;
      const suitCode=SUITS[si];
      for (const col of s.tableau) {
        const idx=col.findIndex(c=>suit(c)===suitCode && rank(c)===need);
        if (idx>=0) { score += col.length-1-idx; break; }
      }
    }
    return score;
  }
  function heuristic(s, mode) {
    const remaining=52-foundationCount(s);
    const buried=burialScore(s);
    const disorder=disorderScore(s);
    const occupied=s.freecells.reduce((n,c)=>n+(c?1:0),0);
    const emptyCols=s.tableau.reduce((n,c)=>n+(c.length?0:1),0);
    if (mode==='best') return remaining*18 + buried*5 + disorder*2 + occupied*2 - emptyCols*5;
    // A practical A* heuristic: g remains dominant while board-shape terms break ties.
    return remaining*4 + buried*2 + disorder*0.5 + occupied*0.5 - emptyCols;
  }

  class MinHeap {
    constructor(){this.a=[];this.seq=0;}
    get size(){return this.a.length;}
    push(item,priority){ const node={item,priority,seq:this.seq++}; const a=this.a; a.push(node); let i=a.length-1; while(i>0){const p=(i-1)>>1;if(compare(a[p],node)<=0)break;a[i]=a[p];i=p;}a[i]=node; }
    pop(){const a=this.a;if(!a.length)return null;const root=a[0],last=a.pop();if(a.length){let i=0;while(true){let l=i*2+1,r=l+1;if(l>=a.length)break;let c=r<a.length&&compare(a[r],a[l])<0?r:l;if(compare(a[c],last)>=0)break;a[i]=a[c];i=c;}a[i]=last;}return root.item;}
  }
  function compare(x,y){return x.priority-y.priority || x.seq-y.seq;}

  function reconstruct(node) {
    const moves=[];
    while(node && node.parent){ moves.push(node.move); node=node.parent; }
    moves.reverse(); return moves;
  }

  function normalizeMoveText(text) {
    return String(text || '').trim().replace(/^Move 1 cards? from stack (\d+) to stack (\d+)$/i, 'Move a card from stack $1 to stack $2');
  }

  function exactKey(s) {
    return s.foundations.join('.') + '|' + s.freecells.map(c=>c||'-').join(',') + '|' + s.tableau.map(c=>c.join(',')).join('|');
  }

  function applyMoveText(previous, rawText) {
    const s=cloneState(previous);
    const text=normalizeMoveText(rawText);
    let m;
    if ((m=text.match(/^Move (\d+) cards? from stack (\d+) to stack (\d+)$/i))) {
      const count=Number(m[1]), src=Number(m[2]), dst=Number(m[3]);
      const sc=s.tableau[src], dc=s.tableau[dst];
      if (!sc || !dc || src===dst || count<1 || sc.length<count) throw new Error('Illegal stack-to-stack move: '+text);
      const tail=sc.slice(-count);
      if (validTailLength(sc)<count) throw new Error('Illegal sequence in move: '+text);
      const top=dc[dc.length-1]||null;
      if (top && !canPlace(tail[0],top)) throw new Error('Illegal destination in move: '+text);
      if (count>moveCapacity(s,dst)) throw new Error('Move exceeds FreeCell capacity: '+text);
      sc.splice(sc.length-count,count); dc.push.apply(dc,tail); return s;
    }
    if ((m=text.match(/^Move a card from stack (\d+) to stack (\d+)$/i))) {
      const src=Number(m[1]), dst=Number(m[2]), sc=s.tableau[src], dc=s.tableau[dst];
      if (!sc || !dc || src===dst || !sc.length) throw new Error('Illegal stack-to-stack move: '+text);
      const card=sc[sc.length-1], top=dc[dc.length-1]||null;
      if (top && !canPlace(card,top)) throw new Error('Illegal destination in move: '+text);
      sc.pop(); dc.push(card); return s;
    }
    if ((m=text.match(/^Move a card from stack (\d+) to freecell (\d+)$/i))) {
      const src=Number(m[1]), dst=Number(m[2]), sc=s.tableau[src];
      if (!sc || !sc.length || dst<0 || dst>3 || s.freecells[dst]) throw new Error('Illegal stack-to-freecell move: '+text);
      s.freecells[dst]=sc.pop(); return s;
    }
    if ((m=text.match(/^Move a card from freecell (\d+) to stack (\d+)$/i))) {
      const src=Number(m[1]), dst=Number(m[2]), card=s.freecells[src], dc=s.tableau[dst];
      if (!card || !dc) throw new Error('Illegal freecell-to-stack move: '+text);
      const top=dc[dc.length-1]||null;
      if (top && !canPlace(card,top)) throw new Error('Illegal destination in move: '+text);
      s.freecells[src]=null; dc.push(card); return s;
    }
    if ((m=text.match(/^Move a card from stack (\d+) to the foundations$/i))) {
      const src=Number(m[1]), sc=s.tableau[src];
      if (!sc || !sc.length) throw new Error('Illegal stack-to-foundation move: '+text);
      const card=sc[sc.length-1]; if (!foundationLegal(s,card)) throw new Error('Illegal foundation move: '+text);
      sc.pop(); s.foundations[SUIT_INDEX[suit(card)]]++; return s;
    }
    if ((m=text.match(/^Move a card from freecell (\d+) to the foundations$/i))) {
      const src=Number(m[1]), card=s.freecells[src];
      if (!card || !foundationLegal(s,card)) throw new Error('Illegal freecell-to-foundation move: '+text);
      s.freecells[src]=null; s.foundations[SUIT_INDEX[suit(card)]]++; return s;
    }
    throw new Error('Unrecognized move: '+rawText);
  }

  function replay(boardText,moves) {
    let s=parseBoard(boardText);
    try {
      for (const text of moves) s=applyMoveText(s,text);
    } catch (error) {
      return {valid:false,state:s,failedMove:error.message,error};
    }
    return {valid:isGoal(s),state:s};
  }

  function buildTrajectory(boardText,moves) {
    const states=[parseBoard(boardText)];
    const normalized=[];
    let current=states[0];
    for (const raw of moves) {
      const move=normalizeMoveText(raw);
      current=applyMoveText(current,move);
      normalized.push(move);
      states.push(current);
    }
    return {states,moves:normalized,valid:isGoal(current)};
  }

  function findBestShortcut(states, maxDepth) {
    let best=null;
    const n=states.length-1;
    for (let i=0;i<n;i++) {
      const future=new Map();
      for (let j=i+2;j<=n;j++) future.set(exactKey(states[j]),j);
      // If the solution wanders away and returns to the exact same state,
      // the entire loop can be removed safely.
      const repeated=future.get(exactKey(states[i]));
      if (repeated!==undefined) {
        const saving=repeated-i;
        if (saving>0 && (!best || saving>best.saving)) best={i,j:repeated,bridge:[],saving};
      }
      const first=generateMoves(states[i],true);
      for (const a of first) {
        const j=future.get(exactKey(a.state));
        if (j!==undefined) {
          const saving=(j-i)-1;
          if (saving>0 && (!best || saving>best.saving)) best={i,j,bridge:[a.move],saving};
        }
      }
      if (maxDepth<2) continue;
      for (const a of first) {
        const second=generateMoves(a.state,true);
        for (const b of second) {
          const j=future.get(exactKey(b.state));
          if (j===undefined || j<i+3) continue;
          const saving=(j-i)-2;
          if (saving>0 && (!best || saving>best.saving)) best={i,j,bridge:[a.move,b.move],saving};
        }
      }
    }
    return best;
  }



  function movedCardAtState(state, rawText) {
    const text=normalizeMoveText(rawText);
    let m;
    if ((m=text.match(/^Move a card from stack (\d+) to (?:stack \d+|freecell \d+|the foundations)$/i))) {
      const src=Number(m[1]), col=state.tableau[src];
      return col && col.length ? col[col.length-1] : null;
    }
    if ((m=text.match(/^Move a card from freecell (\d+) to (?:stack \d+|the foundations)$/i))) {
      return state.freecells[Number(m[1])] || null;
    }
    return null;
  }

  function foundationMoveForParking(state, rawText) {
    const text=normalizeMoveText(rawText);
    let m;
    if ((m=text.match(/^Move a card from stack (\d+) to (?:stack \d+|freecell \d+)$/i))) {
      const src=Number(m[1]), col=state.tableau[src];
      if (!col || !col.length) return null;
      const card=col[col.length-1];
      return foundationLegal(state,card) ? {card,move:'Move a card from stack '+src+' to the foundations'} : null;
    }
    if ((m=text.match(/^Move a card from freecell (\d+) to stack \d+$/i))) {
      const src=Number(m[1]), card=state.freecells[src];
      return card && foundationLegal(state,card) ? {card,move:'Move a card from freecell '+src+' to the foundations'} : null;
    }
    return null;
  }

  function isFoundationMoveOfCard(state, rawText, card) {
    const text=normalizeMoveText(rawText);
    if (!/to the foundations$/i.test(text)) return false;
    return movedCardAtState(state,text) === card;
  }

  function foundationReadyMoves(state) {
    const out=[];
    // Free cells first: clearing one immediately increases maneuvering capacity.
    for (let f=0;f<4;f++) {
      const card=state.freecells[f];
      if (card && foundationLegal(state,card)) out.push({card,move:'Move a card from freecell '+f+' to the foundations',fromFreecell:true});
    }
    for (let i=0;i<8;i++) {
      const col=state.tableau[i];
      if (!col || !col.length) continue;
      const card=col[col.length-1];
      if (foundationLegal(state,card)) out.push({card,move:'Move a card from stack '+i+' to the foundations',fromFreecell:false});
    }
    return out;
  }

  function applyFoundationShortcuts(boardText,moves,maxPasses) {
    let current=moves.map(normalizeMoveText);
    let saved=0, passes=0;
    const limit=Math.max(1,Number(maxPasses||16));
    while (passes<limit) {
      const trajectory=buildTrajectory(boardText,current);
      if (!trajectory.valid) return {validated:false,moveStrings:current,savedMoves:saved,passes};
      let changed=false;
      for (let i=0;i<current.length;i++) {
        const shortcut=foundationMoveForParking(trajectory.states[i],current[i]);
        if (!shortcut) continue;
        for (let j=i+1;j<current.length;j++) {
          if (!isFoundationMoveOfCard(trajectory.states[j],current[j],shortcut.card)) continue;
          const candidate=current.slice();
          candidate[i]=shortcut.move;
          candidate.splice(j,1);
          const checked=replay(boardText,candidate);
          if (checked.valid) {
            current=candidate;
            saved++;
            passes++;
            changed=true;
          }
          break;
        }
        if (changed) break;
      }
      if (!changed) break;
    }
    return {validated:replay(boardText,current).valid,moveStrings:current,savedMoves:saved,passes};
  }

  function applyFoundationCascades(boardText,moves,maxPasses) {
    let current=moves.map(normalizeMoveText);
    let reorders=0, passes=0;
    const limit=Math.max(1,Number(maxPasses||24));
    while (passes<limit) {
      const trajectory=buildTrajectory(boardText,current);
      if (!trajectory.valid) return {validated:false,moveStrings:current,savedMoves:0,reorders,passes};
      let changed=false;
      for (let i=0;i<current.length;i++) {
        if (!/to the foundations$/i.test(current[i])) continue;
        const triggerCard=movedCardAtState(trajectory.states[i],current[i]);
        if (!triggerCard) continue;
        const nextRank=rank(triggerCard)+1;
        if (nextRank>13) continue;
        const stateAfter=trajectory.states[i+1];
        // Only promote the immediate next card of the SAME suit. This makes the
        // transformation monotonic and prevents harmless foundation-order swaps
        // from bouncing back and forth across passes.
        const ready=foundationReadyMoves(stateAfter).filter(item=>suit(item.card)===suit(triggerCard) && rank(item.card)===nextRank);
        for (const item of ready) {
          let later=-1;
          for (let j=i+1;j<current.length;j++) {
            if (isFoundationMoveOfCard(trajectory.states[j],current[j],item.card)) { later=j; break; }
          }
          if (later<0 || later===i+1) continue;
          const candidate=current.slice();
          candidate.splice(later,1);
          candidate.splice(i+1,0,item.move);
          const checked=replay(boardText,candidate);
          if (checked.valid) {
            current=candidate;
            reorders++;
            passes++;
            changed=true;
            break;
          }
        }
        if (changed) break;
      }
      if (!changed) break;
    }
    return {validated:replay(boardText,current).valid,moveStrings:current,savedMoves:moves.length-current.length,reorders,passes};
  }

  function appendImmediateFoundationChain(state,moves,maxAdds) {
    let current=state;
    const out=moves.slice();
    for (let k=0;k<Math.max(0,Number(maxAdds||3));k++) {
      const ready=foundationReadyMoves(current);
      if (!ready.length) break;
      // Prefer a tableau top because it exposes another card; otherwise free a cell.
      ready.sort((a,b)=>(a.fromFreecell?1:0)-(b.fromFreecell?1:0));
      const chosen=ready[0];
      try { current=applyMoveText(current,chosen.move); out.push(chosen.move); }
      catch (_) { break; }
    }
    return {state:current,moves:out};
  }

  function buildCascadeSeeds(boardText,moves,maxSeeds) {
    const trajectory=buildTrajectory(boardText,moves);
    if (!trajectory.valid) return [];
    const seeds=[];
    const limit=Math.max(1,Number(maxSeeds||8));
    for (let i=1;i<trajectory.states.length-1;i++) {
      if (!/^Move a card from freecell \d+ to the foundations$/i.test(trajectory.moves[i-1])) continue;
      const state=trajectory.states[i];
      const candidates=generateMoves(state,true).filter(item=>{
        const m=item.move.match(/^Move (\d+) cards? from stack (\d+) to stack (\d+)$/i);
        if (!m || Number(m[1])<2) return false;
        const src=Number(m[2]);
        const top=item.state.tableau[src][item.state.tableau[src].length-1]||null;
        return top && foundationLegal(item.state,top);
      });
      candidates.sort((a,b)=>{
        const ca=Number((a.move.match(/^Move (\d+) cards/)||[])[1]||1);
        const cb=Number((b.move.match(/^Move (\d+) cards/)||[])[1]||1);
        return cb-ca || a.orderBias-b.orderBias;
      });
      for (const child of candidates.slice(0,3)) {
        if (trajectory.moves[i]===child.move) continue;
        let stateAfter=child.state;
        let prefix=trajectory.moves.slice(0,i).concat([child.move]);
        const chained=appendImmediateFoundationChain(stateAfter,prefix,3);
        prefix=chained.moves;
        try {
          let test=parseBoard(boardText);
          for (const mv of prefix) test=applyMoveText(test,mv);
          seeds.push(prefix);
        } catch (_) {}
        if (seeds.length>=limit) return seeds;
      }
    }
    return seeds;
  }

  function simplifySolution(boardText,moves,options) {
    const opts=Object.assign({maxPasses:16,maxBridgeDepth:2},options||{});
    let trajectory=buildTrajectory(boardText,moves);
    if (!trajectory.valid) return {validated:false,moves:trajectory.moves,moveStrings:trajectory.moves,savedMoves:0,passes:0,reason:'input solution did not validate'};
    const originalLength=trajectory.moves.length;
    let currentMoves=trajectory.moves.slice();
    let passes=0;
    while (passes<opts.maxPasses) {
      const shortcut=findBestShortcut(trajectory.states,opts.maxBridgeDepth);
      if (!shortcut) break;
      currentMoves=currentMoves.slice(0,shortcut.i).concat(shortcut.bridge,currentMoves.slice(shortcut.j));
      trajectory=buildTrajectory(boardText,currentMoves);
      if (!trajectory.valid) throw new Error('Optimizer produced an invalid shortcut.');
      currentMoves=trajectory.moves.slice();
      passes++;
    }
    return {validated:true,moves:currentMoves,moveStrings:currentMoves,savedMoves:originalLength-currentMoves.length,passes,reason:'simplified'};
  }

  async function search(boardText, options, onProgress) {
    const opts=Object.assign({mode:'best',maxExpanded:131072,maxMs:15000,yieldEvery:350,continueAfterFirst:false,incumbentMoves:null,seedPaths:null},options||{});
    const started=Date.now();
    const initial=parseBoard(boardText);
    const heap=new MinHeap();
    const visited=new Map();
    const root={state:initial,g:0,parent:null,move:null};
    heap.push(root,heuristic(initial,opts.mode));
    visited.set(canonicalKey(initial),0);
    let expanded=0,generated=1,bestFoundation=0;
    let bestMoves=null;
    if (Array.isArray(opts.incumbentMoves) && opts.incumbentMoves.length) {
      const checked=replay(boardText,opts.incumbentMoves);
      if (checked.valid) bestMoves=opts.incumbentMoves.map(normalizeMoveText);
    }
    let bestLength=bestMoves ? bestMoves.length : Infinity;

    // Human-inspired seed branches: start the search immediately from promising
    // mobility cascades instead of waiting for Best-First to rediscover them.
    if (Array.isArray(opts.seedPaths)) {
      for (const rawSeed of opts.seedPaths) {
        if (!Array.isArray(rawSeed) || !rawSeed.length || rawSeed.length>=bestLength) continue;
        let parent=root, state=initial, g=0, ok=true;
        try {
          for (const rawMove of rawSeed) {
            const move=normalizeMoveText(rawMove);
            state=applyMoveText(state,move); g++;
            parent={state,g,parent,move};
          }
        } catch (_) { ok=false; }
        if (!ok) continue;
        const remaining=52-foundationCount(state);
        if (g+remaining>=bestLength) continue;
        const key=canonicalKey(state);
        const old=visited.get(key);
        if (old!==undefined && old<=g) continue;
        visited.set(key,g);
        heap.push(parent,heuristic(state,opts.mode)-75);
      }
    }

    while (heap.size && expanded<opts.maxExpanded && (Date.now()-started)<opts.maxMs) {
      const node=heap.pop();
      const remaining=52-foundationCount(node.state);
      if (node.g + remaining >= bestLength) continue;
      if (isGoal(node.state)) {
        const moves=reconstruct(node);
        const checked=replay(boardText,moves);
        if (checked.valid && moves.length<bestLength) {
          bestMoves=moves; bestLength=moves.length;
          if (onProgress) onProgress({expanded,generated,frontier:heap.size,bestFoundation:52,elapsedMs:Date.now()-started,bestMoves:bestLength,stage:'improved'});
        }
        if (!opts.continueAfterFirst) break;
        continue;
      }
      expanded++;
      const fcount=foundationCount(node.state); if (fcount>bestFoundation) bestFoundation=fcount;
      const children=generateMoves(node.state,false);
      for (const child of children) {
        const g=node.g+1;
        const lowerBound=g + (52-foundationCount(child.state));
        if (lowerBound>=bestLength) continue;
        const key=canonicalKey(child.state);
        const old=visited.get(key);
        if (old!==undefined && old<=g) continue;
        visited.set(key,g);
        const next={state:child.state,g,parent:node,move:child.move};
        const h=heuristic(child.state,opts.mode);
        const priority=(opts.mode==='best'?h:(g+h)) + child.orderBias*0.01;
        heap.push(next,priority); generated++;
      }
      if (opts.yieldEvery && expanded%opts.yieldEvery===0) {
        if (onProgress) onProgress({expanded,generated,frontier:heap.size,bestFoundation,elapsedMs:Date.now()-started,bestMoves:Number.isFinite(bestLength)?bestLength:null,stage:'searching'});
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    if (bestMoves) {
      const checked=replay(boardText,bestMoves);
      return {solved:checked.valid,validated:checked.valid,moves:bestMoves,moveStrings:bestMoves,expanded,generated,elapsedMs:Date.now()-started,reason:checked.valid?'solved':'validation failed',bestFoundation};
    }
    return {solved:false,validated:false,moves:[],moveStrings:[],expanded,generated,elapsedMs:Date.now()-started,reason:heap.size?'search budget reached':'frontier exhausted',bestFoundation};
  }

  async function solve(boardText, options, onProgress) {
    return search(boardText,options,onProgress);
  }

  async function improve(boardText, incumbentMoves, options, onProgress) {
    const opts=Object.assign({maxExpanded:131072,maxMs:5000,yieldEvery:350,maxPasses:16,maxBridgeDepth:2},options||{});
    const started=Date.now();
    const initialLength=Array.isArray(incumbentMoves)?incumbentMoves.length:0;
    const foundationFirst=applyFoundationShortcuts(boardText,incumbentMoves,opts.maxPasses);
    if (!foundationFirst.validated) throw new Error('Foundation shortcut pass produced an invalid solution.');
    const cascadeFirst=applyFoundationCascades(boardText,foundationFirst.moveStrings,Math.max(opts.maxPasses,24));
    if (!cascadeFirst.validated) throw new Error('Foundation cascade pass produced an invalid solution.');
    const first=simplifySolution(boardText,cascadeFirst.moveStrings,{maxPasses:opts.maxPasses,maxBridgeDepth:opts.maxBridgeDepth});
    if (!first.validated) throw new Error('Cannot optimize an invalid solution.');
    const seedPaths=buildCascadeSeeds(boardText,first.moveStrings,8);
    if (onProgress) onProgress({stage:'simplified',startingMoves:initialLength,bestMoves:first.moveStrings.length,savedMoves:initialLength-first.moveStrings.length,foundationShortcuts:foundationFirst.savedMoves,foundationCascades:cascadeFirst.reorders,cascadeSeeds:seedPaths.length,expanded:0,frontier:0});

    const searched=await search(boardText,{mode:'best',maxExpanded:opts.maxExpanded,maxMs:opts.maxMs,yieldEvery:opts.yieldEvery,continueAfterFirst:true,incumbentMoves:first.moveStrings,seedPaths},onProgress);
    let candidate=searched.solved ? searched.moveStrings : first.moveStrings;
    const foundationSecond=applyFoundationShortcuts(boardText,candidate,opts.maxPasses);
    if (foundationSecond.validated) candidate=foundationSecond.moveStrings;
    const cascadeSecond=applyFoundationCascades(boardText,candidate,Math.max(opts.maxPasses,24));
    if (cascadeSecond.validated) candidate=cascadeSecond.moveStrings;
    const second=simplifySolution(boardText,candidate,{maxPasses:opts.maxPasses,maxBridgeDepth:opts.maxBridgeDepth});
    if (second.validated) candidate=second.moveStrings;
    const checked=replay(boardText,candidate);
    return {
      solved:checked.valid,
      validated:checked.valid,
      moves:candidate,
      moveStrings:candidate,
      startingMoves:initialLength,
      simplifiedMoves:first.moveStrings.length,
      foundationShortcuts:Number(foundationFirst.savedMoves||0)+Number(foundationSecond && foundationSecond.savedMoves||0),
      foundationCascades:Number(cascadeFirst.reorders||0)+Number(cascadeSecond && cascadeSecond.reorders||0),
      cascadeSeeds:seedPaths.length,
      savedMoves:initialLength-candidate.length,
      expanded:Number(searched.expanded||0),
      generated:Number(searched.generated||0),
      elapsedMs:Date.now()-started,
      reason:checked.valid?'optimized':'validation failed'
    };
  }

  return Object.freeze({parseBoard,solve,replay,improve,simplifySolution,applyFoundationShortcuts,applyFoundationCascades,buildCascadeSeeds});
}));
