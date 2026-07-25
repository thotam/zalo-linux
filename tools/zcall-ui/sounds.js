// tools/zcall-ui/sounds.js — renderer sound player. State-driven; the engine owns state, this only
// plays. UMD so the node test can require it. In the browser pass make = (n)=> new Audio('assets/native/'+n).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = { createSounds: factory() };
  else root.createSounds = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return function createSounds(opts) {
    opts = opts || {};
    var make = opts.make || function () { return { play: function(){}, pause: function(){}, loop:false }; };
    var cache = {};
    function get(name) { if (!cache[name]) cache[name] = make(name); return cache[name]; }
    var loops = ['zalo_ringback.mp3', 'zalo_ringtone.mp3', 'connecting.mp3'];
    function stopLoops() { loops.forEach(function (n) { if (cache[n]) { try { cache[n].pause(); } catch (e) {} } }); }
    function playLoop(name) { stopLoops(); var a = get(name); a.loop = true; try { a.currentTime = 0; } catch (e) {} try { a.play(); } catch (e) {} }
    function oneShot(name) { var a = get(name); a.loop = false; try { a.currentTime = 0; } catch (e) {} try { a.play(); } catch (e) {} }
    return {
      apply: function (state, outcome) {
        // 'calling' (dialing, before the remote rings) -> connecting tone; then 'ringing' -> ringback.
        if (state === 'calling' || state === 'connecting') playLoop('connecting.mp3');
        else if (state === 'ringing') playLoop('zalo_ringback.mp3');
        else if (state === 'ringing-incoming') playLoop('zalo_ringtone.mp3');
        else if (state === 'connected') stopLoops();
        else if (state === 'ended') { stopLoops(); oneShot(outcome === 'busy' ? 'busy.mp3' : outcome === 'disconnect' ? 'disconnect.mp3' : 'endcall.mp3'); }
        else stopLoops();
      },
      stopAll: function () { stopLoops(); },
    };
  };
});
