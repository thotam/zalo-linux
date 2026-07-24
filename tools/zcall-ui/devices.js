(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.zcallUI || { onDevices: function(){}, action: function(){} };
  var devices = { capture: [], playback: [] }, selIn = -1, selOut = -1;
  var meterIv = null;

  function buildMeter() {
    var m = $('mic-meter');
    if (m.children.length) return;
    for (var i = 0; i < 20; i++) { var d = document.createElement('span'); d.className = 'dot'; m.appendChild(d); }
  }
  function animMeter() {
    var dots = $('mic-meter').children;
    var lit = 5 + Math.floor(Math.random() * 11);
    for (var i = 0; i < dots.length; i++) dots[i].className = 'dot' + (i < lit ? ' on' : '');
  }
  function fillSelect(sel, list, cur) {
    sel.innerHTML = '';
    list.forEach(function (dev) {
      var o = document.createElement('option');
      o.value = dev.index; o.textContent = dev.name; if (cur === dev.index) o.selected = true;
      sel.appendChild(o);
    });
    var od = document.createElement('option');
    od.value = -1; od.textContent = 'Thiết bị mặc định'; if (cur === -1) od.selected = true;
    sel.appendChild(od);
  }
  function render() {
    fillSelect($('sel-mic'), devices.capture, selIn);
    fillSelect($('sel-spk'), devices.playback, selOut);
  }

  api.onDevices(function (d) {
    devices = d || { capture: [], playback: [] };
    if (d && typeof d.selectedIn === 'number') selIn = d.selectedIn;
    if (d && typeof d.selectedOut === 'number') selOut = d.selectedOut;
    render();
  });

  buildMeter();
  render();
  meterIv = setInterval(animMeter, 140);

  $('sel-mic').addEventListener('change', function () { selIn = parseInt(this.value, 10); api.action('selectInput', selIn); });
  $('sel-spk').addEventListener('change', function () { selOut = parseInt(this.value, 10); api.action('selectOutput', selOut); });
  $('test-play').addEventListener('click', function () {
    var f = $('test-fill');
    f.style.transition = 'none'; f.style.width = '0';
    setTimeout(function () { f.style.transition = 'width 2s linear'; f.style.width = '100%'; }, 20);
  });
  $('dlg-cancel').addEventListener('click', function () { api.action('devwin', 'close'); });
  $('wc-close').addEventListener('click', function () { api.action('devwin', 'close'); });
  $('wc-min').addEventListener('click', function () { api.action('devwin', 'minimize'); });
  $('wc-max').addEventListener('click', function () { api.action('devwin', 'maximize'); });
})();
