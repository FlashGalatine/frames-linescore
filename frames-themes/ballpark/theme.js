// Ballpark's renderer. It holds no scoring logic: every value comes from the payload that
// frames-shared/panel-core.js dispatches as `linescore:update`. Team names and labels go in
// with textContent only, because chat can set them.
(function () {
  'use strict';

  var NAME_MAX = 28, NAME_MIN = 14;

  // ?skin=crosley loads ../skins/crosley.css, which only overrides variables.
  var skin = new URLSearchParams(location.search).get('skin') || '';
  if (/^[a-z0-9-]+$/.test(skin)) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '../skins/' + skin + '.css';
    document.head.appendChild(link);
  }

  var board = document.getElementById('board');
  var title = document.getElementById('title');
  var grid = document.getElementById('grid');
  var labels = document.getElementById('labels');
  var builtColumns = -1, last = null;

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function build(n) {
    builtColumns = n;
    grid.textContent = '';
    grid.style.gridTemplateColumns = '300px repeat(' + n + ', 56px) 72px';
    grid.appendChild(el('span'));
    for (var c = 0; c < n; c++) { var h = el('div', 'bp-head'); h.dataset.col = c; grid.appendChild(h); }
    var totalHead = el('div', 'bp-head'); totalHead.dataset.col = 'total'; grid.appendChild(totalHead);
    for (var t = 1; t <= 2; t++) {
      var name = el('div', 'bp-name'); name.dataset.team = t; grid.appendChild(name);
      for (var i = 0; i < n; i++) {
        var cell = el('div', 'bp-cell');
        cell.dataset.team = t;
        cell.dataset.col = i;
        grid.appendChild(cell);
      }
      var total = el('div', 'bp-total'); total.dataset.team = t; grid.appendChild(total);
    }
  }

  // Shrink to fit in 2px steps; past the floor, the CSS ellipsis takes over.
  function fit(node) {
    var size = NAME_MAX;
    node.style.fontSize = size + 'px';
    while (node.scrollWidth > node.clientWidth && size > NAME_MIN) {
      size -= 2;
      node.style.fontSize = size + 'px';
    }
  }

  function render(s) {
    last = s;
    board.classList.toggle('is-hidden', !!s.hidden);
    title.textContent = s.title || '';
    if (s.columns.length !== builtColumns) build(s.columns.length);

    s.columns.forEach(function (c, i) {
      var h = grid.querySelector('.bp-head[data-col="' + i + '"]');
      h.textContent = c.label;
      h.classList.toggle('is-live', c.state === 'live');
    });
    grid.querySelector('.bp-head[data-col="total"]').textContent = s.totalLabel;

    s.teams.forEach(function (team, t) {
      var name = grid.querySelector('.bp-name[data-team="' + (t + 1) + '"]');
      if (name.textContent !== team.name) name.textContent = team.name;
      fit(name);
      s.columns.forEach(function (c, i) {
        var cell = grid.querySelector('.bp-cell[data-team="' + (t + 1) + '"][data-col="' + i + '"]');
        var v = team.scores[i], live = c.state === 'live' && v === null;
        cell.textContent = v !== null ? v : live && c.worth !== null ? '+' + c.worth : '';
        cell.classList.toggle('is-zero', v === 0);
        cell.classList.toggle('is-live', live);
      });
      var total = grid.querySelector('.bp-total[data-team="' + (t + 1) + '"]');
      total.textContent = team.total;
      total.classList.toggle('is-lead', s.lead === t);
    });

    labels.textContent = '';
    var on = s.labels.filter(function (l) { return l.on; });
    labels.classList.toggle('is-off', !on.length);
    on.forEach(function (l) {
      var row = el('div', 'bp-label');
      row.dataset.key = l.key;
      var name = el('span');
      name.textContent = l.name;
      var value = el('b');
      value.textContent = l.value;
      row.appendChild(name);
      row.appendChild(value);
      labels.appendChild(row);
    });
  }

  window.addEventListener('linescore:update', function (e) { render(e.detail); });
  // Text measured before a webfont arrives is wrong: re-fit once fonts settle.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (last) render(last); });
})();
