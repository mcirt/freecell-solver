(function (ns) {
  "use strict";
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  function location(name){ return document.querySelector('[data-location="'+name+'"]'); }
  ns.clearHighlights=function(){ document.querySelectorAll('.move-source,.move-destination,.moving-target').forEach(el=>el.classList.remove('move-source','move-destination','moving-target')); };
  ns.animateMove=async function(details,nextState,duration){
    if(!details||details.cards.some(c=>!c)){ ns.renderState(nextState); return; }
    const starts=details.cards.map(card=>{ const el=document.querySelector('.card[data-card="'+card+'"]'); return el?el.getBoundingClientRect():null; });
    const source=location(details.source); if(source) source.classList.add('move-source');
    await sleep(180);
    ns.renderState(nextState);
    const destination=location(details.destination); if(source) location(details.source)?.classList.add('move-source'); if(destination) destination.classList.add('move-destination');
    const flights=[];
    details.cards.forEach((card,i)=>{ const start=starts[i], targetEl=document.querySelector('.card[data-card="'+card+'"]'); const target=targetEl?targetEl.getBoundingClientRect():null; if(!start||!target)return; targetEl.style.visibility='hidden'; const ghost=ns.cardElement(card); ghost.classList.add('moving-card'); Object.assign(ghost.style,{position:'fixed',left:start.left+'px',top:start.top+'px',width:start.width+'px',height:start.height+'px',zIndex:String(10000+i),margin:'0',pointerEvents:'none'}); document.body.appendChild(ghost); flights.push({ghost,target,targetEl}); });
    document.body.offsetHeight;
    flights.forEach(({ghost,target})=>{ ghost.style.transition='left '+duration+'ms cubic-bezier(.2,.75,.25,1), top '+duration+'ms cubic-bezier(.2,.75,.25,1), transform '+duration+'ms ease'; ghost.style.left=target.left+'px'; ghost.style.top=target.top+'px'; ghost.style.transform='scale(1.035)'; });
    await sleep(duration+90);
    flights.forEach(({ghost,targetEl})=>{ ghost.remove(); targetEl.style.visibility=''; targetEl.classList.add('arrival-flash'); setTimeout(()=>targetEl.classList.remove('arrival-flash'),500); });
    await sleep(260); ns.clearHighlights();
  };
}(window.FreeCellViewer = window.FreeCellViewer || {}));
