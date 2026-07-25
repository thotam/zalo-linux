(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.zcallUI || { onPartner:function(){}, onState:function(){}, action:function(){} };
  var sounds = window.createSounds ? window.createSounds({ make:function(n){ return new Audio('assets/native/'+n); } }) : { apply:function(){}, stopAll:function(){} };
  api.onPartner(function (p) {
    p = p || {};
    $('name').textContent = p.name || '—';
    if (p.avatar) $('avatar').style.backgroundImage = 'url("' + p.avatar + '")';
  });
  api.onState(function (s) { sounds.apply(s && s.state, s && s.outcome); });
  $('btn-accept').addEventListener('click', function () { sounds.stopAll(); api.action('accept'); });
  $('btn-decline').addEventListener('click', function () { sounds.stopAll(); api.action('decline'); });
})();
