'use strict';

const SESSION_TOKEN_KEY = 'libtrackToken';
const SESSION_USER_KEY = 'libtrackUser';

function getToken() {
  return localStorage.getItem(SESSION_TOKEN_KEY) || '';
}

function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_USER_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSession(token, user) {
  localStorage.setItem(SESSION_TOKEN_KEY, token);
  localStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem(SESSION_TOKEN_KEY);
  localStorage.removeItem(SESSION_USER_KEY);
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch {
    throw new Error('Cannot reach the Libtrack server. Make sure npm start is still running.');
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = { message: 'The server returned an invalid response.' };
  }

  if (response.status === 401 && url !== '/api/login') {
    clearSession();
    window.location.href = '/login/login.html';
    throw new Error(data.message || 'Please log in again.');
  }

  if (!response.ok) throw new Error(data.message || 'Request failed.');
  return data;
}

function requireUser(roles = null) {
  const token = getToken();
  const user = getStoredUser();
  if (!token || !user) {
    window.location.href = '/login/login.html';
    return null;
  }

  if (roles) {
    const allowedRoles = Array.isArray(roles) ? roles : [roles];
    if (!allowedRoles.includes(user.role)) {
      window.location.href = user.role === 'librarian'
        ? '/librarian/dashboard.html'
        : '/student/dashboard.html';
      return null;
    }
  }

  return user;
}

async function logout() {
  try {
    if (getToken()) await apiFetch('/api/logout', { method: 'POST', body: '{}' });
  } catch {
    // Local logout still works if the server is temporarily unavailable.
  } finally {
    clearSession();
    window.location.href = '/login/login.html';
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function todayISO() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}


/* ---------------- Global premium motion ---------------- */
(function initLibtrackMotion() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const animated = new WeakSet();

  function animateNode(node, index = 0) {
    if (!(node instanceof HTMLElement) || animated.has(node)) return;
    if (!node.matches('.panel,.stat-card,.book-card,.compact-item,.feature,.qr-code-box')) return;
    animated.add(node);
    node.classList.add('lt-motion-node', 'lt-enter');
    node.style.setProperty('--lt-delay', `${Math.min(index, 12) * 34}ms`);
    window.setTimeout(() => node.classList.remove('lt-enter'), 900);
  }

  function animateRows(scope = document) {
    scope.querySelectorAll('tbody tr').forEach((row, index) => {
      if (animated.has(row)) return;
      animated.add(row);
      row.classList.add('lt-row-enter');
      row.style.setProperty('--row-delay', `${Math.min(index, 14) * 24}ms`);
      window.setTimeout(() => row.classList.remove('lt-row-enter'), 850);
    });
  }

  function countStat(element) {
    if (!(element instanceof HTMLElement) || element.dataset.countAnimated === element.textContent) return;
    const raw = element.textContent.trim();
    if (!/^\d+$/.test(raw)) return;
    element.dataset.countAnimated = raw;
    const target = Number(raw);
    if (target <= 0 || target > 999999) return;
    const started = performance.now();
    const duration = 560;
    const tick = (now) => {
      const p = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      element.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(tick);
      else {
        element.textContent = raw;
        element.classList.add('lt-count-pop');
        window.setTimeout(() => element.classList.remove('lt-count-pop'), 500);
      }
    };
    requestAnimationFrame(tick);
  }

  function scan(scope = document) {
    scope.querySelectorAll('.panel,.stat-card,.book-card,.compact-item,.feature,.qr-code-box').forEach(animateNode);
    scope.querySelectorAll('.stat-card strong').forEach(countStat);
    animateRows(scope);
  }

  const observer = new MutationObserver((mutations) => {
    let index = 0;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        animateNode(node, index++);
        if (node.matches('.stat-card strong')) countStat(node);
        node.querySelectorAll?.('.panel,.stat-card,.book-card,.compact-item,.feature,.qr-code-box').forEach((item) => animateNode(item, index++));
        node.querySelectorAll?.('.stat-card strong').forEach(countStat);
        animateRows(node);
      }
    }
  });

  const start = () => {
    scan(document);
    observer.observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();