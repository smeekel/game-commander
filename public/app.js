'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);

  const els = {
    title: $('#title'),
    mode: $('#mode'),
    who: $('#who'),
    addBtn: $('#add-btn'),
    loginBtn: $('#login-btn'),
    logoutBtn: $('#logout-btn'),
    search: $('#search'),
    count: $('#count'),
    message: $('#message'),
    grid: $('#grid'),
    loginDialog: $('#login-dialog'),
    loginForm: $('#login-form'),
    loginStatus: $('#login-status'),
    editorDialog: $('#editor-dialog'),
    editorForm: $('#editor-form'),
    editorHeading: $('#editor-heading'),
    editorStatus: $('#editor-status'),
    thumbPreview: $('#thumb-preview'),
    deleteBtn: $('#delete-btn'),
    openLink: $('#open-link'),
    saveBtn: $('#save-btn'),
  };

  const state = {
    title: 'The Rack',
    games: [],
    loaded: false,
    loadError: null,
    signedIn: false,
    username: null,
    query: '',
    editing: null,
    busy: false,
  };

  // ------------------------------------------------------------- helpers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    const res = await fetch(path, { method: options.method || 'GET', headers, body, credentials: 'same-origin' });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function uploadFile(gameId, field, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `/api/games/${encodeURIComponent(gameId)}/${field}?filename=${encodeURIComponent(file.name)}`;
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener('load', () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          const err = new Error((data && data.error) || `Upload failed (${xhr.status}).`);
          err.status = xhr.status;
          reject(err);
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Upload failed. The connection was interrupted.')));
      xhr.send(file);
    });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  function hueFor(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  function initials(name) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
    return letters.toUpperCase();
  }

  function thumbUrl(game) {
    return `/thumbnails/${encodeURIComponent(game.thumbnail)}?v=${game.updated || 0}`;
  }

  function placeholder(name) {
    const box = el('span', 'placeholder');
    box.style.setProperty('--hue', String(hueFor(name || '?')));
    box.append(el('span', null, initials(name || '?')));
    return box;
  }

  function thumbImage(game) {
    if (!game.thumbnail) return placeholder(game.name);
    const img = el('img');
    img.src = thumbUrl(game);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.replaceWith(placeholder(game.name)), { once: true });
    return img;
  }

  function gameAction(game) {
    if (game.kind === 'web' && game.href) return { href: game.href, label: 'Open', badge: 'PLAY' };
    if (game.kind === 'install' && game.package) {
      return { href: `/packages/${encodeURIComponent(game.package)}`, label: 'Download', badge: 'GET', download: game.package };
    }
    return null;
  }

  // ------------------------------------------------------------- search

  function matches(game, query) {
    if (!query) return true;
    if (game.name.toLowerCase().includes(query)) return true;
    return game.tags.some((tag) => tag.toLowerCase().includes(query));
  }

  function setQuery(value) {
    state.query = value;
    els.search.value = value;
    renderGrid();
    els.search.focus();
  }

  function tagWeights(games) {
    const counts = new Map();
    for (const game of games) {
      for (const tag of game.tags) {
        const key = tag.toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const max = Math.max(1, ...counts.values());
    const min = Math.min(max, ...counts.values());
    return (tag) => {
      const n = counts.get(tag.toLowerCase()) || 1;
      return max === min ? 0.5 : (n - min) / (max - min);
    };
  }

  // ------------------------------------------------------------- rendering

  function renderChrome() {
    document.title = state.title;
    els.title.textContent = state.title;
    els.addBtn.hidden = !state.signedIn;
    els.mode.hidden = !state.signedIn;
    els.logoutBtn.hidden = !state.signedIn;
    els.loginBtn.hidden = state.signedIn;
    els.who.hidden = !state.signedIn;
    els.who.textContent = state.signedIn ? state.username : '';
  }

  function showMessage(heading, text, { error = false, action = null } = {}) {
    els.message.replaceChildren();
    els.message.classList.toggle('is-error', error);
    els.message.append(el('h2', null, heading), el('p', null, text));
    if (action) {
      const btn = el('button', 'btn btn-primary', action.label);
      btn.type = 'button';
      btn.addEventListener('click', action.onClick);
      els.message.append(btn);
    }
    els.message.hidden = false;
  }

  function buildCard(game, weight, activeQuery) {
    const card = el('article', 'card');
    const action = gameAction(game);

    let main;
    if (state.signedIn) {
      main = el('button', 'card-main');
      main.type = 'button';
      main.setAttribute('aria-label', `Edit ${game.name}`);
      main.addEventListener('click', () => openEditor(game));
    } else if (action) {
      main = el('a', 'card-main');
      main.href = action.href;
      if (action.download) {
        main.setAttribute('download', action.download);
      } else {
        main.target = '_blank';
        main.rel = 'noopener noreferrer';
      }
    } else {
      main = el('div', 'card-main is-unavailable');
      main.tabIndex = 0;
    }

    const thumb = el('span', 'thumb');
    thumb.append(thumbImage(game));

    let badge;
    if (state.signedIn) badge = el('span', 'badge is-edit', 'EDIT');
    else if (!action) badge = el('span', 'badge is-none', 'SOON');
    else badge = el('span', `badge${action.badge === 'GET' ? ' is-get' : ''}`, action.badge);
    thumb.append(badge);

    const desc = el('span', 'desc', game.description || 'No description yet.');
    if (!game.description) desc.classList.add('is-empty');
    thumb.append(desc);

    main.append(thumb, el('span', 'name', game.name));
    card.append(main);

    if (game.tags.length) {
      const list = el('ul', 'tags');
      list.setAttribute('aria-label', 'Tags');
      for (const tag of game.tags) {
        const item = el('li');
        const btn = el('button', 'tag', tag);
        btn.type = 'button';
        btn.title = `Show games tagged ${tag}`;
        const w = weight(tag);
        btn.style.setProperty('--tag-size', `${(11 + w * 4).toFixed(1)}px`);
        btn.style.setProperty('--tag-opacity', (0.7 + w * 0.3).toFixed(2));
        if (activeQuery && tag.toLowerCase() === activeQuery) btn.classList.add('is-active');
        btn.addEventListener('click', () => setQuery(tag));
        item.append(btn);
        list.append(item);
      }
      card.append(list);
    }

    return card;
  }

  function renderGrid() {
    const query = state.query.trim().toLowerCase();
    els.grid.replaceChildren();
    els.message.hidden = true;

    if (!state.loaded) {
      els.count.textContent = '';
      if (state.loadError) {
        showMessage('Could not load the shelf', state.loadError, {
          error: true,
          action: { label: 'Try again', onClick: loadGames },
        });
      }
      return;
    }

    const total = state.games.length;
    if (total === 0) {
      els.count.textContent = '0 games';
      showMessage(
        'The shelf is empty',
        state.signedIn ? 'Use + Add new to put the first game on the shelf.' : 'No games have been added yet. Check back soon.',
        state.signedIn ? { action: { label: '+ Add new', onClick: () => openEditor(null) } } : {},
      );
      return;
    }

    const visible = state.games.filter((game) => matches(game, query));
    els.count.textContent = query ? `${visible.length} of ${total} games` : `${total} ${total === 1 ? 'game' : 'games'}`;

    if (visible.length === 0) {
      showMessage('Nothing matches', `No game name or tag contains "${state.query.trim()}".`, {
        action: { label: 'Clear search', onClick: () => setQuery('') },
      });
      return;
    }

    const weight = tagWeights(state.games);
    const fragment = document.createDocumentFragment();
    for (const game of visible) fragment.append(buildCard(game, weight, query));
    els.grid.append(fragment);
  }

  function render() {
    renderChrome();
    renderGrid();
  }

  // ------------------------------------------------------------- data

  async function loadGames() {
    try {
      const data = await api('/api/games');
      state.title = data.title || 'The Rack';
      state.games = Array.isArray(data.games) ? data.games : [];
      state.loaded = true;
      state.loadError = null;
    } catch (err) {
      state.loaded = false;
      state.loadError = err.message;
    }
    render();
  }

  async function loadSession() {
    try {
      const data = await api('/api/session');
      state.signedIn = Boolean(data.signedIn);
      state.username = data.username || null;
    } catch {
      state.signedIn = false;
    }
  }

  function sessionExpired() {
    state.signedIn = false;
    state.username = null;
    if (els.editorDialog.open) els.editorDialog.close();
    render();
    openLogin('Your session ended. Log in again to keep editing.');
  }

  // ------------------------------------------------------------- login

  function openLogin(note) {
    els.loginForm.reset();
    setStatus(els.loginStatus, note || '');
    els.loginDialog.showModal();
    els.loginForm.elements.username.focus();
  }

  async function submitLogin(event) {
    event.preventDefault();
    const form = els.loginForm.elements;
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) {
      setStatus(els.loginStatus, 'Enter a username and password.', true);
      return;
    }
    const submit = els.loginForm.querySelector('[type="submit"]');
    submit.disabled = true;
    setStatus(els.loginStatus, 'Checking...');
    try {
      const data = await api('/api/login', { method: 'POST', json: { username, password } });
      state.signedIn = true;
      state.username = data.username;
      els.loginDialog.close();
      render();
    } catch (err) {
      setStatus(els.loginStatus, err.message, true);
      form.password.select();
    } finally {
      submit.disabled = false;
    }
  }

  async function logout() {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      // Signing out locally is still right if the server is unreachable.
    }
    state.signedIn = false;
    state.username = null;
    render();
  }

  // ------------------------------------------------------------- editor

  function setStatus(node, text, isError = false) {
    node.textContent = text;
    node.classList.toggle('is-error', isError);
  }

  function selectedKind() {
    return els.editorForm.elements.kind.value === 'install' ? 'install' : 'web';
  }

  function syncKind() {
    const kind = selectedKind();
    for (const section of els.editorForm.querySelectorAll('[data-kind]')) {
      section.hidden = section.dataset.kind !== kind;
    }
    syncOpenLink();
  }

  function syncOpenLink() {
    const game = state.editing;
    const action = game && game.kind === selectedKind() ? gameAction(game) : null;
    els.openLink.hidden = !action;
    if (!action) return;
    els.openLink.textContent = action.label;
    els.openLink.href = action.href;
    if (action.download) {
      els.openLink.setAttribute('download', action.download);
      els.openLink.removeAttribute('target');
    } else {
      els.openLink.removeAttribute('download');
      els.openLink.target = '_blank';
    }
  }

  let previewUrl = null;

  function renderPreview() {
    const form = els.editorForm.elements;
    const name = form.name.value.trim() || (state.editing && state.editing.name) || '?';
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    const file = form.thumbnailFile.files[0];
    els.thumbPreview.replaceChildren();
    if (file) {
      previewUrl = URL.createObjectURL(file);
      const img = el('img');
      img.src = previewUrl;
      img.alt = '';
      els.thumbPreview.append(img);
      return;
    }
    const typed = form.thumbnail.value.trim();
    if (typed) {
      els.thumbPreview.append(thumbImage({ name, thumbnail: typed, updated: state.editing ? state.editing.updated : Date.now() }));
    } else {
      els.thumbPreview.append(placeholder(name));
    }
  }

  let deleteTimer = 0;

  function disarmDelete() {
    clearTimeout(deleteTimer);
    els.deleteBtn.classList.remove('is-armed');
    els.deleteBtn.textContent = 'Delete';
  }

  function openEditor(game) {
    state.editing = game;
    const form = els.editorForm;
    form.reset();
    disarmDelete();
    setStatus(els.editorStatus, '');

    els.editorHeading.textContent = game ? `Edit ${game.name}` : 'Add a game';
    els.deleteBtn.hidden = !game;
    form.elements.name.value = game ? game.name : '';
    form.elements.description.value = game ? game.description : '';
    form.elements.tags.value = game ? game.tags.join(', ') : '';
    form.elements.kind.value = game ? game.kind : 'web';
    form.elements.href.value = game && game.href ? game.href : '';
    form.elements.package.value = game && game.package ? game.package : '';
    form.elements.thumbnail.value = game && game.thumbnail ? game.thumbnail : '';

    syncKind();
    renderPreview();
    setBusy(false);
    els.editorDialog.showModal();
    form.elements.name.focus();
  }

  function setBusy(busy) {
    state.busy = busy;
    for (const control of els.editorForm.querySelectorAll('input, textarea, button')) {
      control.disabled = busy;
    }
  }

  async function submitEditor(event) {
    event.preventDefault();
    if (state.busy) return;
    const form = els.editorForm.elements;
    const kind = selectedKind();
    const name = form.name.value.trim();
    const href = form.href.value.trim();
    const thumbFile = form.thumbnailFile.files[0] || null;
    const packageFile = kind === 'install' ? form.packageFile.files[0] || null : null;

    if (!name) {
      setStatus(els.editorStatus, 'Give the game a name.', true);
      form.name.focus();
      return;
    }
    if (kind === 'web' && !href) {
      setStatus(els.editorStatus, 'A web game needs a link.', true);
      form.href.focus();
      return;
    }

    const body = {
      name,
      description: form.description.value,
      tags: form.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      kind,
      href: kind === 'web' ? href : (state.editing && state.editing.href) || '',
    };
    if (!thumbFile) body.thumbnail = form.thumbnail.value.trim();
    if (!packageFile) body.package = form.package.value.trim();

    setBusy(true);
    setStatus(els.editorStatus, 'Saving...');
    try {
      let saved = state.editing
        ? await api(`/api/games/${encodeURIComponent(state.editing.id)}`, { method: 'PUT', json: body })
        : await api('/api/games', { method: 'POST', json: body });
      state.editing = saved;
      els.editorHeading.textContent = `Edit ${saved.name}`;
      els.deleteBtn.hidden = false;

      if (thumbFile) {
        setStatus(els.editorStatus, `Uploading thumbnail (${formatSize(thumbFile.size)})...`);
        saved = await uploadFile(saved.id, 'thumbnail', thumbFile);
        state.editing = saved;
      }
      if (packageFile) {
        const label = `Uploading package (${formatSize(packageFile.size)})`;
        setStatus(els.editorStatus, `${label}...`);
        saved = await uploadFile(saved.id, 'package', packageFile, (fraction) => {
          setStatus(els.editorStatus, `${label}: ${Math.round(fraction * 100)}%`);
        });
        state.editing = saved;
      }

      els.editorDialog.close();
      await loadGames();
    } catch (err) {
      setBusy(false);
      if (err.status === 401) {
        sessionExpired();
        return;
      }
      setStatus(els.editorStatus, err.message, true);
      if (state.editing) await loadGames();
    }
  }

  async function deleteGame() {
    const game = state.editing;
    if (!game) return;
    if (!els.deleteBtn.classList.contains('is-armed')) {
      els.deleteBtn.classList.add('is-armed');
      els.deleteBtn.textContent = 'Really delete?';
      deleteTimer = setTimeout(disarmDelete, 4000);
      return;
    }
    disarmDelete();
    setBusy(true);
    setStatus(els.editorStatus, 'Deleting...');
    try {
      await api(`/api/games/${encodeURIComponent(game.id)}`, { method: 'DELETE' });
      els.editorDialog.close();
      await loadGames();
    } catch (err) {
      setBusy(false);
      if (err.status === 401) {
        sessionExpired();
        return;
      }
      setStatus(els.editorStatus, err.message, true);
    }
  }

  // ------------------------------------------------------------- wiring

  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderGrid();
  });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.search.value) {
      e.preventDefault();
      setQuery('');
    }
  });

  els.loginBtn.addEventListener('click', () => openLogin());
  els.logoutBtn.addEventListener('click', logout);
  els.addBtn.addEventListener('click', () => openEditor(null));
  els.loginForm.addEventListener('submit', submitLogin);
  els.editorForm.addEventListener('submit', submitEditor);
  els.deleteBtn.addEventListener('click', deleteGame);

  for (const radio of els.editorForm.elements.kind) radio.addEventListener('change', syncKind);
  els.editorForm.elements.thumbnailFile.addEventListener('change', renderPreview);
  els.editorForm.elements.thumbnail.addEventListener('change', renderPreview);
  els.editorForm.elements.name.addEventListener('input', () => {
    if (!els.editorForm.elements.thumbnail.value.trim() && !els.editorForm.elements.thumbnailFile.files[0]) renderPreview();
  });

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  for (const dialog of [els.loginDialog, els.editorDialog]) {
    dialog.addEventListener('cancel', (e) => {
      if (state.busy) e.preventDefault();
    });
  }
  els.editorDialog.addEventListener('close', () => {
    disarmDelete();
    state.editing = null;
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  });

  (async () => {
    await loadSession();
    await loadGames();
  })();
})();
