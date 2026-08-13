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

  function generateMoves(s) {
    const out=[];
    const firstEmptyCell = s.freecells.findIndex(c=>!c);
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
        } else if (!top && d===firstEmptyCol) {
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
        if (!dstTop && dst!==firstEmptyCol) continue; // empty columns are symmetric
        const cap=moveCapacity(s,dst);
        const max=Math.min(tail,cap);
        for (let count=1;count<=max;count++) {
          const first=sc[sc.length-count];
          if (dstTop ? !canPlace(first,dstTop) : false) continue;
          if (!dstTop && count===sc.length) continue; // pure column permutation
          const n=cloneState(s); const moved=n.tableau[src].splice(n.tableau[src].length-count,count); n.tableau[dst].push.apply(n.tableau[dst],moved);
          const text=count===1 ? 'Move a card from stack '+src+' to stack '+dst : 'Move '+count+' cards from stack '+src+' to stack '+dst;
          pushMove(out,n,text,dstTop ? -10-count : 3-count);
        }
      }
    }

    // Tableau to one representative empty freecell (freecells are symmetric).
    if (firstEmptyCell>=0) {
      for (let src=0;src<8;src++) {
        const sc=s.tableau[src]; if (!sc.length) continue;
        const n=cloneState(s); n.freecells[firstEmptyCell]=n.tableau[src].pop();
        pushMove(out,n,'Move a card from stack '+src+' to freecell '+firstEmptyCell,20);
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

  function replay(boardText,moves) {
    let s=parseBoard(boardText);
    for (const text of moves) {
      const candidates=generateMoves(s);
      const found=candidates.find(x=>x.move===text);
      if (!found) return {valid:false,state:s,failedMove:text};
      s=found.state;
    }
    return {valid:isGoal(s),state:s};
  }

  async function solve(boardText, options, onProgress) {
    const opts=Object.assign({mode:'best',maxExpanded:131072,maxMs:15000,yieldEvery:350},options||{});
    const started=Date.now();
    const initial=parseBoard(boardText);
    const heap=new MinHeap();
    const visited=new Map();
    const root={state:initial,g:0,parent:null,move:null};
    heap.push(root, heuristic(initial,opts.mode));
    visited.set(canonicalKey(initial),0);
    let expanded=0,generated=1,bestFoundation=0;

    while(heap.size && expanded<opts.maxExpanded && (Date.now()-started)<opts.maxMs) {
      const node=heap.pop();
      if (isGoal(node.state)) {
        const moves=reconstruct(node); const checked=replay(boardText,moves);
        return {solved:checked.valid,validated:checked.valid,moves,moveStrings:moves,expanded,generated,elapsedMs:Date.now()-started,reason:checked.valid?'solved':'validation failed'};
      }
      expanded++;
      const fcount=foundationCount(node.state); if(fcount>bestFoundation) bestFoundation=fcount;
      const children=generateMoves(node.state);
      for (const child of children) {
        const g=node.g+1;
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
        if(onProgress) onProgress({expanded,generated,frontier:heap.size,bestFoundation,elapsedMs:Date.now()-started});
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    return {solved:false,validated:false,moves:[],moveStrings:[],expanded,generated,elapsedMs:Date.now()-started,reason:heap.size?'search budget reached':'frontier exhausted',bestFoundation};
  }

  return Object.freeze({parseBoard,solve,replay});
}));
