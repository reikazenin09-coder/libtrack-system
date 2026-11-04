'use strict';

const currentUser = requireUser(['student', 'teacher']);
if (!currentUser) throw new Error('Borrower login required.');

const state = { books: [], borrowings: [], summary: null };
const viewMap = { overview: 'overviewView', catalog: 'catalogView', loans: 'loansView' };
const roleLabel = currentUser.role === 'teacher' ? 'Teacher' : 'Student';
const titleMap = { overview: `${roleLabel} overview`, catalog: 'Book catalog', loans: 'My borrowings' };

let currentQrFileName = 'libtrack-my-qr';
let bookScanner = null;
let bookScannerRunning = false;
let bookScannerLocked = false;

const userName = document.getElementById('userName');
userName.textContent = currentUser.fullName || currentUser.username;
document.getElementById('userMeta').textContent = [roleLabel, currentUser.studentNumber, currentUser.section].filter(Boolean).join(' · ');
document.getElementById('avatar').textContent = (currentUser.fullName || roleLabel).charAt(0).toUpperCase();
document.getElementById('pageTitle').textContent = `${roleLabel} overview`;
document.title = `${roleLabel} Portal — Libtrack`;
document.getElementById('logoutButton').addEventListener('click', logout);

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast${isError ? ' error' : ''}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 3000);
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  if (!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('modal-open');
}

document.querySelectorAll('.close-modal').forEach((button) => {
  button.addEventListener('click', () => closeModal(button.dataset.modal));
});

document.querySelectorAll('.modal').forEach((modal) => {
  modal.addEventListener('click', (event) => {
    if (event.target === modal && modal.id !== 'bookScannerModal') closeModal(modal.id);
  });
});

function switchView(viewName) {
  Object.values(viewMap).forEach((id) => document.getElementById(id).classList.remove('active'));
  const view = document.getElementById(viewMap[viewName]);
  view.classList.add('active');
  view.classList.remove('view-animate');
  requestAnimationFrame(() => view.classList.add('view-animate'));
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });
  document.getElementById('pageTitle').textContent = titleMap[viewName];
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
document.querySelectorAll('[data-open-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.openView)));

async function loadEverything() {
  try {
    const [summaryData, booksData, borrowingsData, categoriesData] = await Promise.all([
      apiFetch('/api/student/summary'),
      apiFetch('/api/books'),
      apiFetch('/api/my-borrowings'),
      apiFetch('/api/categories')
    ]);
    state.summary = summaryData.summary;
    state.books = booksData.books;
    state.borrowings = borrowingsData.borrowings;
    renderStats();
    renderOverview();
    populateCategories(categoriesData.categories);
    renderCatalog();
    renderLoans();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderStats() {
  const summary = state.summary;
  const cards = [
    ['Available copies', summary.availableCopies, `${summary.titles} book titles`],
    ['Active borrowings', summary.active, 'Books currently with you'],
    ['Overdue', summary.overdue, summary.overdue ? 'Please return soon' : 'No overdue books'],
    ['Completed returns', summary.returned, 'Borrowing history']
  ];
  document.getElementById('statsGrid').innerHTML = cards.map((card, index) => `
    <article class="stat-card reveal-card" style="--delay:${index * 45}ms"><span>${card[0]}</span><strong>${card[1]}</strong><small>${card[2]}</small></article>
  `).join('');
}

function renderOverview() {
  const active = state.borrowings.filter((item) => item.status === 'borrowed').slice(0, 5);
  document.getElementById('activePreview').innerHTML = active.length ? active.map((item) => `
    <div class="compact-item">
      <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.category)} · due ${escapeHtml(item.dueDate)}</span></div>
      <span class="badge ${item.isOverdue ? 'overdue' : 'borrowed'}">${item.isOverdue ? 'Overdue' : 'Borrowed'}</span>
    </div>
  `).join('') : '<div class="empty">You have no active borrowed books.</div>';
}

function populateCategories(categories) {
  const select = document.getElementById('catalogCategory');
  const current = select.value;
  select.innerHTML = '<option value="">All categories</option>' + categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  select.value = current;
}

function renderCatalog() {
  const query = document.getElementById('catalogSearch').value.trim().toLowerCase();
  const category = document.getElementById('catalogCategory').value;
  const activeBookIds = new Set(state.borrowings.filter((item) => item.status === 'borrowed').map((item) => Number(item.bookId)));
  const books = state.books.filter((book) => {
    const matchesSearch = !query || [book.title, book.author, book.category, book.accessionNumber].some((value) => String(value || '').toLowerCase().includes(query));
    return matchesSearch && (!category || book.category === category);
  });

  document.getElementById('catalogGrid').innerHTML = books.map((book, index) => {
    const available = Number(book.availableCopies);
    const alreadyBorrowed = activeBookIds.has(Number(book.id));
    const disabled = available < 1 || alreadyBorrowed;
    const buttonText = alreadyBorrowed ? 'Already borrowed' : available < 1 ? 'Unavailable' : 'Borrow book';
    return `
      <article class="book-card reveal-card" style="--delay:${Math.min(index, 10) * 35}ms">
        <div class="book-icon">📘</div>
        <h3>${escapeHtml(book.title)}</h3>
        <p>${escapeHtml(book.author || 'Unknown author')}</p>
        <p>${escapeHtml(book.category)} · ${escapeHtml(book.accessionNumber)}</p>
        <div class="book-meta">
          <span class="badge ${available > 0 ? 'available' : 'unavailable'}">${available}/${book.totalCopies} available</span>
          <button class="primary borrow-book" data-id="${book.id}" type="button" ${disabled ? 'disabled' : ''}>${buttonText}</button>
        </div>
      </article>
    `;
  }).join('');
  document.getElementById('catalogEmpty').classList.toggle('hidden', books.length > 0);
}

function renderLoans() {
  const query = document.getElementById('loanSearch').value.trim().toLowerCase();
  const status = document.getElementById('loanStatus').value;
  const rows = state.borrowings.filter((item) => {
    const matchesSearch = !query || [item.title, item.author, item.category, item.accessionNumber].some((value) => String(value || '').toLowerCase().includes(query));
    let matchesStatus = status === 'all' || item.status === status;
    if (status === 'overdue') matchesStatus = Boolean(item.isOverdue);
    return matchesSearch && matchesStatus;
  });

  document.getElementById('loansTableBody').innerHTML = rows.map((item) => {
    const statusClass = item.isOverdue ? 'overdue' : item.status;
    const statusLabel = item.isOverdue ? 'Overdue' : item.status === 'borrowed' ? 'Borrowed' : 'Returned';
    return `
      <tr>
        <td class="primary-cell"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.author || 'Unknown author')} · ${escapeHtml(item.category)}</span></td>
        <td>${escapeHtml(item.borrowedAt)}</td>
        <td>${escapeHtml(item.dueDate)}</td>
        <td><span class="badge ${statusClass}">${statusLabel}</span></td>
        <td>${item.status === 'borrowed' ? `<button class="action return return-book" data-id="${item.id}" type="button">Return</button>` : `<span>${escapeHtml(item.returnedAt || 'Completed')}</span>`}</td>
      </tr>
    `;
  }).join('');
  document.getElementById('loansEmpty').classList.toggle('hidden', rows.length > 0);
}

document.getElementById('catalogSearch').addEventListener('input', renderCatalog);
document.getElementById('catalogCategory').addEventListener('change', renderCatalog);
document.getElementById('loanSearch').addEventListener('input', renderLoans);
document.getElementById('loanStatus').addEventListener('change', renderLoans);

async function borrowBookById(bookId, button = null) {
  const book = state.books.find((item) => Number(item.id) === Number(bookId));
  if (!book || !window.confirm(`Borrow “${book.title}” for 7 days?`)) return;

  if (button) {
    button.disabled = true;
    button.textContent = 'Saving...';
  }
  try {
    const data = await apiFetch('/api/borrowings', {
      method: 'POST',
      body: JSON.stringify({ bookId: Number(book.id), borrowDate: todayISO() })
    });
    showToast(data.message);
    await loadEverything();
  } catch (error) {
    showToast(error.message, true);
    if (button) {
      button.disabled = false;
      button.textContent = 'Borrow book';
    }
  }
}

document.getElementById('catalogGrid').addEventListener('click', async (event) => {
  const button = event.target.closest('.borrow-book');
  if (!button || button.disabled) return;
  await borrowBookById(button.dataset.id, button);
});

document.getElementById('loansTableBody').addEventListener('click', async (event) => {
  const button = event.target.closest('.return-book');
  if (!button || !window.confirm('Return this book now?')) return;
  button.disabled = true;
  try {
    const data = await apiFetch('/api/returns', {
      method: 'POST',
      body: JSON.stringify({ borrowingId: Number(button.dataset.id) })
    });
    showToast(data.message);
    await loadEverything();
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
});

/* ---------------- Personal QR ---------------- */

function safeFileName(value) {
  return String(value || 'libtrack-user').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

async function openMyQr() {
  try {
    const data = await apiFetch('/api/qr/me');
    const qr = data.qr;
    const box = document.getElementById('qrCode');
    box.innerHTML = '';
    document.getElementById('qrModalTitle').textContent = qr.label || 'My QR code';
    document.getElementById('qrModalDetail').textContent = qr.detail || '';
    currentQrFileName = `libtrack-user-${safeFileName(qr.label)}`;

    if (typeof QRCode !== 'function') {
      box.innerHTML = '<p class="message">QR generator could not load. Check the internet connection and refresh.</p>';
    } else {
      new QRCode(box, {
        text: qr.payload,
        width: 240,
        height: 240,
        correctLevel: QRCode.CorrectLevel.H
      });
    }
    openModal('qrModal');
  } catch (error) {
    showToast(error.message, true);
  }
}

document.getElementById('myQrButton').addEventListener('click', openMyQr);

document.getElementById('downloadQrButton').addEventListener('click', () => {
  const box = document.getElementById('qrCode');
  const canvas = box.querySelector('canvas');
  const image = box.querySelector('img');
  const href = canvas ? canvas.toDataURL('image/png') : image?.src;
  if (!href) return showToast('QR image is not ready yet.', true);
  const link = document.createElement('a');
  link.href = href;
  link.download = `${currentQrFileName}.png`;
  link.click();
});

/* ---------------- Book QR scanner ---------------- */

function setBookScannerMessage(message, isError = false) {
  const element = document.getElementById('bookScannerMessage');
  element.textContent = message || '';
  element.classList.toggle('success', Boolean(message) && !isError);
}

function setBookScanProgress(title, detail) {
  document.getElementById('bookScanProgress').innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
}

async function startBookScanner() {
  if (bookScannerRunning) return;
  if (typeof Html5Qrcode !== 'function') {
    setBookScannerMessage('Camera QR scanner could not load. Check the internet connection and refresh.', true);
    return;
  }
  try {
    if (!bookScanner) bookScanner = new Html5Qrcode('bookQrReader');
    await bookScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1 },
      (decodedText) => processBookQr(decodedText),
      () => {}
    );
    bookScannerRunning = true;
    setBookScannerMessage('Camera ready. Point it at a LibTrack book QR code.');
  } catch (error) {
    setBookScannerMessage(`Camera could not start: ${error.message || error}`, true);
  }
}

async function stopBookScanner() {
  if (!bookScanner || !bookScannerRunning) return;
  try {
    await bookScanner.stop();
  } catch {
    // Browser may already have stopped the camera.
  }
  bookScannerRunning = false;
}

async function openBookScanner() {
  setBookScannerMessage('');
  setBookScanProgress('Ready to scan', 'Point the camera at a LibTrack book QR code.');
  openModal('bookScannerModal');
  await startBookScanner();
}

async function closeBookScanner() {
  await stopBookScanner();
  closeModal('bookScannerModal');
}

document.getElementById('scanBookButton').addEventListener('click', openBookScanner);
document.getElementById('startBookScannerButton').addEventListener('click', startBookScanner);
document.getElementById('stopBookScannerButton').addEventListener('click', stopBookScanner);
document.querySelector('.close-book-scanner').addEventListener('click', closeBookScanner);
document.getElementById('bookScannerModal').addEventListener('click', async (event) => {
  if (event.target === event.currentTarget) await closeBookScanner();
});

document.getElementById('processManualBookQrButton').addEventListener('click', async () => {
  const code = document.getElementById('manualBookQrCode').value.trim();
  if (!code) return setBookScannerMessage('Paste or type a LibTrack book QR value first.', true);
  document.getElementById('manualBookQrCode').value = '';
  await processBookQr(code);
});

async function processBookQr(code) {
  if (bookScannerLocked) return;
  bookScannerLocked = true;
  try {
    const resolved = await apiFetch('/api/qr/book/resolve', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
    const book = resolved.book;
    setBookScanProgress(book.title, `${book.accessionNumber} · ${book.availableCopies}/${book.totalCopies} available`);
    if (Number(book.availableCopies) < 1) {
      throw new Error('This book currently has no available copies.');
    }
    if (!window.confirm(`Borrow “${book.title}” for 7 days?`)) {
      setBookScannerMessage('Borrowing cancelled.');
      return;
    }
    const data = await apiFetch('/api/qr/borrow', {
      method: 'POST',
      body: JSON.stringify({ code, borrowDate: todayISO() })
    });
    showToast(data.message);
    setBookScannerMessage(data.message);
    await loadEverything();
    await closeBookScanner();
    switchView('loans');
  } catch (error) {
    setBookScannerMessage(error.message, true);
    showToast(error.message, true);
  } finally {
    window.setTimeout(() => { bookScannerLocked = false; }, 900);
  }
}

loadEverything();