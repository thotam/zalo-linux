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
    if (state === 'calling') return 'Đang nối máy đến ' + name;
    if (state === 'ended') return name + ' đã kết thúc cuộc gọi.';
    return '';
  }
  return { formatDuration: formatDuration, statusText: statusText };
});
