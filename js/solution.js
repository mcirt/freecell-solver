(function (ns) {
  "use strict";
  let moves=[],states=[],current=0,timer=null,animating=false;
  const counter=document.getElementById('move-counter'),topCounter=document.getElementById('move-counter-top'),description=document.getElementById('move-description'),error=document.getElementById('viewer-error'),speed=document.getElementById('speed');
  function stop(){ if(timer) clearTimeout(timer); timer=null; }
  function render(){ ns.renderState(states[current]); counter.textContent='Move '+current+' of '+moves.length; topCounter.textContent=current+' / '+moves.length; description.textContent=current===0?'Starting position':moves[current-1]; ['first','previous'].forEach(id=>document.getElementById(id).disabled=current===0||animating); ['next','last'].forEach(id=>document.getElementById(id).disabled=current===moves.length||animating); if(current===moves.length) stop(); }
  async function next(){ if(animating||current>=moves.length)return; stop(); animating=true; render(); const details=ns.moveDetails(states[current],moves[current]); const nextState=states[current+1]; const duration=Math.max(320,Math.min(650,Number(speed.value)*.55)); await ns.animateMove(details,nextState,duration); current++; animating=false; render(); }
  function goTo(i){ stop(); current=Math.max(0,Math.min(moves.length,i)); ns.clearHighlights(); render(); }
  function schedule(){ if(timer===null||current>=moves.length)return stop(); timer=setTimeout(async()=>{ timer=-1; await next(); if(timer!==null&&current<moves.length)schedule(); },80); }
  function play(){ stop(); if(current>=moves.length)current=0; render(); timer=-1; schedule(); }
  function init(){ try { const raw=sessionStorage.getItem('freecellSolution'); if(!raw)throw new Error('No solved board was found. Return to the solver page, solve a board, and open the graphical viewer.'); const data=JSON.parse(raw); moves=data.moves; states=[ns.parseBoard(data.board)]; moves.forEach(m=>states.push(ns.applyMove(states.at(-1),m))); ns.bindControls({goTo,next,play,pause:stop,current:()=>current,total:()=>moves.length}); render(); } catch(e){ error.hidden=false; error.textContent=e.message||String(e); console.error(e); } }
  init();
}(window.FreeCellViewer = window.FreeCellViewer || {}));
