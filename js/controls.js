(function (ns) {
  "use strict";
  ns.bindControls=function(api){
    document.getElementById('first').addEventListener('click',()=>api.goTo(0));
    document.getElementById('previous').addEventListener('click',()=>api.goTo(api.current()-1));
    document.getElementById('next').addEventListener('click',api.next);
    document.getElementById('play').addEventListener('click',()=>api.isPlaying()?api.pause():api.play());
  };
}(window.FreeCellViewer = window.FreeCellViewer || {}));
