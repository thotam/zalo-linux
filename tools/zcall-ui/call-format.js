// UMD pure helpers shared by the renderer (browser) and the node unit test.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CallFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function formatDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function statusText(state, name) {
    name = name || '';
    if (state === 'calling') return 'Đang gọi ' + name;
    if (state === 'ringing') return 'Đang đổ chuông...';
    if (state === 'connecting') return 'Đang kết nối...';
    if (state === 'ended') return name + ' đã kết thúc cuộc gọi.';
    return '';
  }
  function timerClass(state, o) {
    o = o || {};
    if (state === 'connected' && o.secure) return 'timer-secure';
    if (o.quality === 'poor') return 'timer-warn';
    return 'timer-normal';
  }
  return { formatDuration: formatDuration, statusText: statusText, timerClass: timerClass };
});
