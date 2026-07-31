(function (ns) {
  "use strict";
  ns.bindControls=function(api){
    document.getElementById('first').addEventListener('click',()=>api.goTo(0));
    document.getElementById('previous').addEventListener('click',()=>api.goTo(api.current()-1));
    document.getElementById('next').addEventListener('click',api.next);
    document.getElementById('last').addEventListener('click',()=>api.goTo(api.total()));
    document.getElementById('play').addEventListener('click',api.play);
    document.getElementById('pause').addEventListener('click',api.pause);
  };
}(window.FreeCellViewer = window.FreeCellViewer || {}));
