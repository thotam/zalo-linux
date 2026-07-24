(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.zcallUI || { onPartner: function(){}, onState: function(){}, onDevices: function(){}, action: function(){} };
  var partner = { name: '', avatar: null };
  var timerIv = null, connectedAt = 0;
  var muted = false;
  var devices = { capture: [], playback: [] }, selIn = -1, selOut = -1;

  function setBg(url) {
    if (url) { $('bg').style.backgroundImage = 'url("' + url + '")'; $('bg').classList.add('on');
               $('avatar').style.backgroundImage = 'url("' + url + '")'; }
    else { $('bg').classList.remove('on'); $('avatar').style.backgroundImage = 'none'; }
  }

  api.onPartner(function (p) {
    partner = p || {};
    $('tb-title').textContent = 'Zalo Call' + (partner.name ? ' - ' + partner.name : '');
    setBg(partner.avatar);
    applyStatus(document.body.getAttribute('data-state'));
  });

  function applyStatus(state) {
    $('status').textContent = window.CallFormat.statusText(state, partner.name);
    if (state === 'ended') $('endtoast').textContent = partner.name + ' đã kết thúc cuộc gọi.';
  }

  function startTimer() {
    stopTimer();
    timerIv = setInterval(function () {
      $('timer').textContent = window.CallFormat.formatDuration((Date.now() - connectedAt) / 1000);
    }, 500);
  }
  function stopTimer() { if (timerIv) { clearInterval(timerIv); timerIv = null; } }

  api.onState(function (s) {
    var state = s && s.state || 'calling';
    document.body.setAttribute('data-state', state);
    applyStatus(state);
    if (state === 'connected') { connectedAt = (s && s.connectedAt) || Date.now(); startTimer(); }
    else if (state === 'ended' || state === 'free') { stopTimer(); }
  });

  api.onDevices(function (d) {
    devices = d || { capture: [], playback: [] };
    selIn = (d && typeof d.selectedIn === 'number') ? d.selectedIn : -1;
    selOut = (d && typeof d.selectedOut === 'number') ? d.selectedOut : -1;
    renderMenu();
  });

  function renderMenu() {
    var m = $('mic-menu');
    var html = '<div class="mh"><span class="zic zic-mic"></span>Chọn micro</div>';
    devices.capture.forEach(function (dev) { html += devItem('in', dev.index, dev.name, selIn === dev.index); });
    html += devItem('in', -1, 'Thiết bị mặc định', selIn === -1);
    html += '<div class="mh"><span class="zic zic-speaker"></span>Chọn loa</div>';
    devices.playback.forEach(function (dev) { html += devItem('out', dev.index, dev.name, selOut === dev.index); });
    html += devItem('out', -1, 'Thiết bị mặc định', selOut === -1);
    html += '<div class="sep"></div>';
    html += '<div class="mi" data-kind="settings" data-idx="0">Mở cài đặt</div>';
    m.innerHTML = html;
    Array.prototype.forEach.call(m.querySelectorAll('.mi'), function (el) {
      el.addEventListener('click', function () {
        var kind = el.getAttribute('data-kind'), idx = parseInt(el.getAttribute('data-idx'), 10);
        if (kind === 'in') { selIn = idx; api.action('selectInput', idx); renderMenu(); }
        else if (kind === 'out') { selOut = idx; api.action('selectOutput', idx); renderMenu(); }
        else if (kind === 'settings') { m.classList.remove('on'); api.action('openSettings'); }
      });
    });
  }
  function devItem(kind, idx, name, sel) {
    var safe = String(name).replace(/[<>&]/g, '');
    return '<div class="mi" data-kind="' + kind + '" data-idx="' + idx + '">' +
           (sel ? '<span class="mi-check">✓</span>' : '') + safe + '</div>';
  }

  $('wc-min').addEventListener('click', function () { api.action('win', 'minimize'); });
  $('wc-max').addEventListener('click', function () { api.action('win', 'maximize'); });
  $('wc-close').addEventListener('click', function () { api.action('win', 'close'); });

  $('btn-end').addEventListener('click', function () { api.action('end'); });
  $('btn-mic').addEventListener('click', function () {
    muted = !muted;
    $('btn-mic').classList.toggle('btn-active', muted);
    $('btn-mic').querySelector('.zic').className = 'zic ' + (muted ? 'zic-mic-off' : 'zic-mic');
    api.action('mute', muted);
  });
  $('mic-chev').addEventListener('click', function () { $('mic-menu').classList.toggle('on'); });
  $('btn-gear').addEventListener('click', function () { api.action('openSettings'); });
  // click outside the compact device menu closes it
  document.addEventListener('click', function (ev) {
    var m = $('mic-menu');
    if (!m.classList.contains('on')) return;
    if (m.contains(ev.target) || ev.target.closest('#mic-chev')) return;
    m.classList.remove('on');
  });
  $('btn-cam').addEventListener('click', function () { api.action('toggleCamera'); });
  $('cam-chev').addEventListener('click', function () { api.action('toggleCamera'); });
})();
