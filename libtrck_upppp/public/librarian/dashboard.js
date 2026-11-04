'use strict';

const currentUser = requireUser('librarian');
if (!currentUser) throw new Error('Librarian login required.');

const state = {
  stats: null,
  books: [],
  borrowings: [],
  users: [],
  entries: [],
  categories: []
};

const dataTables = {
  books: null,
  borrowings: null,
  users: null,
  entries: null
};

const viewMap = {
  overview: 'overviewView',
  books: 'booksView',
  borrowings: 'borrowingsView',
  entries: 'entriesView',
  users: 'usersView'
};

const titleMap = {
  overview: 'Library overview',
  books: 'Book management',
  borrowings: 'Borrowing records',
  entries: 'QR & entry logs',
  users: 'Users accounts'
};

let currentQrFileName = 'libtrack-qr';
let html5QrScanner = null;
let scannerRunning = false;
let scannerLocked = false;
let scanMode = 'entry';
let pendingUserCode = '';

function isOverdue(record) {
  return Number(record.isOverdue) === 1;
}

function destroyDataTable(key) {
  if (dataTables[key]) {
    dataTables[key].destroy();
    dataTables[key] = null;
  }
}

function initDataTable(key, selector, options = {}) {
  if (typeof DataTable !== 'function') return;
  dataTables[key] = new DataTable(selector, {
    pageLength: 10,
    lengthMenu: [5, 10, 25, 50],
    order: options.order || [],
    columnDefs: options.columnDefs || [],
    language: {
      search: 'Search:',
      searchPlaceholder: options.searchPlaceholder || 'Type to filter...',
      lengthMenu: 'Show _MENU_ entries',
      info: 'Showing _START_ to _END_ of _TOTAL_ entries',
      emptyTable: 'No records available'
    }
  });
}

document.getElementById('userName').textContent = currentUser.fullName || currentUser.username;
document.getElementById('avatar').textContent = (currentUser.fullName || 'L').charAt(0).toUpperCase();
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
    if (event.target === modal && modal.id !== 'scannerModal') closeModal(modal.id);
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

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

document.querySelectorAll('[data-open-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.openView));
});

async function loadEverything() {
  try {
    const showArchivedBooks = document.getElementById('showArchivedBooks').checked;
    const showArchivedUsers = document.getElementById('showArchivedUsers').checked;

    const [statsData, booksData, categoriesData, usersData, borrowingsData, entriesData] = await Promise.all([
      apiFetch('/api/librarian/stats'),
      apiFetch(`/api/books?archived=${showArchivedBooks}`),
      apiFetch('/api/categories'),
      apiFetch(`/api/librarian/users?archived=${showArchivedUsers}`),
      apiFetch('/api/librarian/borrowings'),
      apiFetch('/api/librarian/entries')
    ]);

    state.stats = statsData.stats;
    state.books = booksData.books;
    state.categories = categoriesData.categories;
    state.users = usersData.users;
    state.borrowings = borrowingsData.borrowings;
    state.entries = entriesData.entries;

    populateCategoryFilters();
    renderStats();
    renderAvailability();
    renderOverduePreview();
    renderRecentEntries();
    renderBooks();
    renderBorrowings();
    renderEntries();
    renderUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderStats() {
  const stats = state.stats;
  const cards = [
    ['Book titles', stats.titles, `${stats.totalCopies} total copies`],
    ['Available copies', stats.availableCopies, 'Ready for checkout'],
    ['Active borrowings', stats.active, `${stats.overdue} overdue`],
    ['Borrower accounts', stats.borrowers, `${stats.students} students · ${stats.teachers} teachers`],
    ['Entries today', stats.entriesToday, 'QR-recorded library visits']
  ];

  document.getElementById('statsGrid').innerHTML = cards.map((card, index) => `
    <article class="stat-card reveal-card" style="--delay:${index * 45}ms"><span>${card[0]}</span><strong>${card[1]}</strong><small>${card[2]}</small></article>
  `).join('');
}

function renderAvailability() {
  const grouped = new Map();
  state.books.forEach((book) => {
    if (Number(book.isArchived) === 1) return;
    if (!grouped.has(book.category)) grouped.set(book.category, { total: 0, available: 0 });
    const group = grouped.get(book.category);
    group.total += Number(book.totalCopies);
    group.available += Number(book.availableCopies);
  });

  const entries = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 8);
  document.getElementById('availabilitySummary').innerHTML = entries.length ? entries.map(([category, values]) => {
    const percent = values.total ? Math.round((values.available / values.total) * 100) : 0;
    return `<div class="availability-row"><span>${escapeHtml(category)}</span><div class="bar"><span style="width:${percent}%"></span></div><strong>${values.available}/${values.total}</strong></div>`;
  }).join('') : '<div class="empty">No active books have been added yet.</div>';
}

function renderOverduePreview() {
  const rows = state.borrowings.filter(isOverdue).slice(0, 5);
  document.getElementById('overduePreview').innerHTML = rows.length ? rows.map((record) => `
    <div class="compact-item">
      <div><strong>${escapeHtml(record.fullName)}</strong><span>${escapeHtml(record.title)} · due ${escapeHtml(record.dueDate)}</span></div>
      <span class="badge overdue">Overdue</span>
    </div>
  `).join('') : '<div class="empty">No overdue books.</div>';
}

function renderRecentEntries() {
  const rows = state.entries.slice(0, 5);
  document.getElementById('recentEntriesPreview').innerHTML = rows.length ? rows.map((record) => `
    <div class="compact-item">
      <div><strong>${escapeHtml(record.fullName)}</strong><span>${escapeHtml(record.role === 'teacher' ? 'Teacher' : 'Student')} · ${escapeHtml(record.enteredAt)}</span></div>
      <span class="badge available">Entered</span>
    </div>
  `).join('') : '<div class="empty">No QR entries recorded yet.</div>';
}

function populateCategoryFilters() {
  ['bookCategoryFilter', 'borrowingCategoryFilter'].forEach((id) => {
    const select = document.getElementById(id);
    const current = select.value;
    select.innerHTML = '<option value="">All categories</option>' + state.categories
      .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join('');
    select.value = current;
  });
}

function renderBooks() {
  destroyDataTable('books');
  const category = document.getElementById('bookCategoryFilter').value;
  const rows = state.books.filter((book) => !category || book.category === category);

  document.getElementById('booksTableBody').innerHTML = rows.map((book) => {
    const available = Number(book.availableCopies);
    const total = Number(book.totalCopies);
    const isArchived = Number(book.isArchived) === 1;
    const statusClass = isArchived ? 'overdue' : (available === 0 ? 'unavailable' : available <= Math.max(1, Math.floor(total * 0.25)) ? 'low' : 'available');
    const statusLabel = isArchived ? 'Archived' : (available === 0 ? 'Unavailable' : statusClass === 'low' ? 'Low stock' : 'Available');

    return `
      <tr>
        <td class="primary-cell"><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.author || 'Unknown author')}</span></td>
        <td>${escapeHtml(book.accessionNumber)}</td>
        <td>${escapeHtml(book.category)}</td>
        <td>${available} / ${total}</td>
        <td><span class="badge ${statusClass}">${statusLabel}</span></td>
        <td>
          <div class="actions">
            ${isArchived 
              ? `<button class="action edit restore-book" data-id="${book.id}" type="button">Restore</button>`
              : `<button class="action edit edit-book" data-id="${book.id}" type="button">Edit</button>
                 <button class="action qr qr-book" data-id="${book.id}" type="button">QR</button>
                 <button class="action delete archive-book" data-id="${book.id}" type="button">Archive</button>`
            }
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('booksEmpty').classList.toggle('hidden', rows.length > 0);
  initDataTable('books', '#booksTable', {
    order: [[0, 'asc']],
    searchPlaceholder: 'Search books...',
    columnDefs: [{ targets: -1, orderable: false, searchable: false }]
  });
}

function renderBorrowings() {
  destroyDataTable('borrowings');
  const status = document.getElementById('borrowingStatusFilter').value;
  const category = document.getElementById('borrowingCategoryFilter').value;
  const rows = state.borrowings.filter((record) => {
    const matchesCategory = !category || record.category === category;
    let matchesStatus = status === 'all' || record.status === status;
    if (status === 'overdue') matchesStatus = isOverdue(record);
    return matchesCategory && matchesStatus;
  });

  document.getElementById('borrowingsTableBody').innerHTML = rows.map((record) => {
    const overdue = isOverdue(record);
    const statusClass = overdue ? 'overdue' : record.status;
    const statusLabel = overdue ? 'Overdue' : record.status === 'borrowed' ? 'Borrowed' : 'Returned';
    const roleLabel = record.role === 'teacher' ? 'Teacher' : 'Student';

    return `
      <tr>
        <td class="primary-cell"><strong>${escapeHtml(record.fullName)}</strong><span>${roleLabel} · ${escapeHtml(record.studentNumber || 'No ID')} · ${escapeHtml(record.section || 'No section/department')}</span></td>
        <td class="primary-cell"><strong>${escapeHtml(record.title)}</strong><span>${escapeHtml(record.accessionNumber)} · ${escapeHtml(record.category)}</span></td>
        <td>${escapeHtml(record.borrowedAt)}</td>
        <td>${escapeHtml(record.dueDate)}</td>
        <td><span class="badge ${statusClass}">${statusLabel}</span></td>
        <td>${record.status === 'borrowed' ? `<button class="action return mark-returned" data-id="${record.id}" type="button">Mark returned</button>` : `<span>${escapeHtml(record.returnedAt || 'Completed')}</span>`}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('borrowingsEmpty').classList.toggle('hidden', rows.length > 0);
  initDataTable('borrowings', '#borrowingsTable', {
    order: [[2, 'desc']],
    searchPlaceholder: 'Search borrowers or books...',
    columnDefs: [{ targets: -1, orderable: false, searchable: false }]
  });
}

function renderEntries() {
  destroyDataTable('entries');
  const date = document.getElementById('entryDateFilter').value;
  const rows = state.entries.filter((record) => !date || String(record.enteredAt).startsWith(date));

  document.getElementById('entriesTableBody').innerHTML = rows.map((record) => {
    const roleLabel = record.role === 'teacher' ? 'Teacher' : 'Student';
    const roleClass = record.role === 'teacher' ? 'teacher-role' : 'student-role';
    return `
      <tr>
        <td class="primary-cell"><strong>${escapeHtml(record.fullName)}</strong><span>${escapeHtml(record.username)}</span></td>
        <td>${escapeHtml(record.studentNumber || '—')}</td>
        <td>${escapeHtml(record.section || '—')}</td>
        <td><span class="role-pill ${roleClass}">${roleLabel}</span></td>
        <td>${escapeHtml(record.enteredAt)}</td>
        <td>${escapeHtml(record.scannedBy || 'System')}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('entriesEmpty').classList.toggle('hidden', rows.length > 0);
  initDataTable('entries', '#entriesTable', {
    order: [[4, 'desc']],
    searchPlaceholder: 'Search library entries...'
  });
}

function renderUsers() {
  destroyDataTable('users');
  const role = document.getElementById('userRoleFilter').value;
  const rows = state.users.filter((user) => role === 'all' || user.role === role);

  document.getElementById('usersTableBody').innerHTML = rows.map((user) => {
    const roleLabel = user.role === 'teacher' ? 'Teacher' : 'Student';
    const roleClass = user.role === 'teacher' ? 'teacher-role' : 'student-role';
    const isArchived = Number(user.isArchived) === 1;

    return `
      <tr>
        <td class="primary-cell"><strong>${escapeHtml(user.fullName)}</strong><span>${isArchived ? '[Archived Account]' : Number(user.activeBorrowings || 0) + ' active borrowing(s)'}</span></td>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.studentNumber || '—')}</td>
        <td>${escapeHtml(user.section || '—')}</td>
        <td><span class="role-pill ${roleClass}">${roleLabel}</span></td>
        <td>${Number(user.totalBorrowings || 0)}</td>
        <td>
          <div class="actions">
            ${isArchived
              ? `<button class="action edit restore-user" data-id="${user.id}" type="button">Restore</button>`
              : `<button class="action edit edit-user" data-id="${user.id}" type="button">Edit</button>
                 <button class="action qr qr-user" data-id="${user.id}" type="button">QR</button>
                 <button class="action delete archive-user" data-id="${user.id}" type="button">Archive</button>`
            }
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('usersEmpty').classList.toggle('hidden', rows.length > 0);
  initDataTable('users', '#usersTable', {
    order: [[4, 'asc'], [0, 'asc']],
    searchPlaceholder: 'Search users...',
    columnDefs: [{ targets: -1, orderable: false, searchable: false }]
  });
}

document.getElementById('bookCategoryFilter').addEventListener('change', renderBooks);
document.getElementById('showArchivedBooks').addEventListener('change', loadEverything);
document.getElementById('showArchivedUsers').addEventListener('change', loadEverything);
document.getElementById('borrowingStatusFilter').addEventListener('change', renderBorrowings);
document.getElementById('borrowingCategoryFilter').addEventListener('change', renderBorrowings);
document.getElementById('entryDateFilter').addEventListener('change', renderEntries);
document.getElementById('userRoleFilter').addEventListener('change', renderUsers);

function openBookModal(book = null) {
  document.getElementById('bookForm').reset();
  document.getElementById('bookId').value = book?.id || '';
  document.getElementById('bookModalTitle').textContent = book ? 'Edit book' : 'Add book';
  document.getElementById('accessionNumber').value = book?.accessionNumber || '';
  document.getElementById('bookTitle').value = book?.title || '';
  document.getElementById('bookAuthor').value = book?.author || '';
  document.getElementById('bookCategory').value = book?.category || '';
  document.getElementById('totalCopies').value = book?.totalCopies || 1;
  document.getElementById('bookFormMessage').textContent = '';
  openModal('bookModal');
}

document.getElementById('addBookButton').addEventListener('click', () => openBookModal());

document.getElementById('booksTableBody').addEventListener('click', async (event) => {
  const editButton = event.target.closest('.edit-book');
  const qrButton = event.target.closest('.qr-book');
  const archiveButton = event.target.closest('.archive-book');
  const restoreButton = event.target.closest('.restore-book');

  if (editButton) {
    openBookModal(state.books.find((book) => Number(book.id) === Number(editButton.dataset.id)));
    return;
  }

  if (qrButton) {
    try {
      const data = await apiFetch(`/api/librarian/books/${qrButton.dataset.id}/qr`);
      openQrModal(data.qr);
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }

  if (archiveButton) {
    const book = state.books.find((item) => Number(item.id) === Number(archiveButton.dataset.id));
    if (!book || !window.confirm(`Archive “${book.title}”? It will be hidden from active inventory while preserving historical circulation records.`)) return;
    try {
      const data = await apiFetch(`/api/books/${book.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Archived by librarian' })
      });
      showToast(data.message);
      await loadEverything();
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }

  if (restoreButton) {
    const book = state.books.find((item) => Number(item.id) === Number(restoreButton.dataset.id));
    if (!book || !window.confirm(`Restore “${book.title}” back to active inventory?`)) return;
    try {
      const data = await apiFetch(`/api/books/${book.id}/restore`, { method: 'POST' });
      showToast(data.message);
      await loadEverything();
    } catch (error) {
      showToast(error.message, true);
    }
  }
});

document.getElementById('bookForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = document.getElementById('bookId').value;
  const payload = {
    accessionNumber: document.getElementById('accessionNumber').value,
    title: document.getElementById('bookTitle').value,
    author: document.getElementById('bookAuthor').value,
    category: document.getElementById('bookCategory').value,
    totalCopies: Number(document.getElementById('totalCopies').value)
  };

  try {
    const data = await apiFetch(id ? `/api/books/${id}` : '/api/books', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    closeModal('bookModal');
    showToast(data.message);
    await loadEverything();
  } catch (error) {
    document.getElementById('bookFormMessage').textContent = error.message;
  }
});

function openUserModal(user = null) {
  document.getElementById('userForm').reset();
  document.getElementById('userId').value = user?.id || '';
  document.getElementById('userModalTitle').textContent = user ? 'Edit user' : 'Add user';
  document.getElementById('userRole').value = user?.role || 'student';
  document.getElementById('accountFullName').value = user?.fullName || '';
  document.getElementById('accountIdNumber').value = user?.studentNumber || '';
  document.getElementById('accountSection').value = user?.section || '';
  document.getElementById('accountUsername').value = user?.username || '';
  document.getElementById('accountPassword').required = !user;
  document.getElementById('passwordLabel').textContent = user ? 'New password (optional)' : 'Password';
  document.getElementById('userFormMessage').textContent = '';
  openModal('userModal');
}

document.getElementById('addUserButton').addEventListener('click', () => openUserModal());

document.getElementById('usersTableBody').addEventListener('click', async (event) => {
  const editButton = event.target.closest('.edit-user');
  const qrButton = event.target.closest('.qr-user');
  const archiveButton = event.target.closest('.archive-user');
  const restoreButton = event.target.closest('.restore-user');

  if (editButton) {
    openUserModal(state.users.find((user) => Number(user.id) === Number(editButton.dataset.id)));
    return;
  }

  if (qrButton) {
    try {
      const data = await apiFetch(`/api/librarian/users/${qrButton.dataset.id}/qr`);
      openQrModal(data.qr);
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }

  if (archiveButton) {
    const user = state.users.find((item) => Number(item.id) === Number(archiveButton.dataset.id));
    if (!user || !window.confirm(`Archive ${user.fullName}'s account? They will no longer be able to log in, while past transaction records remain secure.`)) return;
    try {
      const data = await apiFetch(`/api/librarian/users/${user.id}/archive`, { method: 'POST' });
      showToast(data.message);
      await loadEverything();
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }

  if (restoreButton) {
    const user = state.users.find((item) => Number(item.id) === Number(restoreButton.dataset.id));
    if (!user || !window.confirm(`Restore ${user.fullName}'s account?`)) return;
    try {
      const data = await apiFetch(`/api/librarian/users/${user.id}/restore`, { method: 'POST' });
      showToast(data.message);
      await loadEverything();
    } catch (error) {
      showToast(error.message, true);
    }
  }
});

document.getElementById('userForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = document.getElementById('userId').value;
  const payload = {
    role: document.getElementById('userRole').value,
    fullName: document.getElementById('accountFullName').value,
    studentNumber: document.getElementById('accountIdNumber').value,
    section: document.getElementById('accountSection').value,
    username: document.getElementById('accountUsername').value,
    password: document.getElementById('accountPassword').value
  };

  try {
    const data = await apiFetch(id ? `/api/librarian/users/${id}` : '/api/librarian/users', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    closeModal('userModal');
    showToast(data.message);
    await loadEverything();
  } catch (error) {
    document.getElementById('userFormMessage').textContent = error.message;
  }
});

function openCheckoutModal() {
  const users = [...state.users].filter(u => Number(u.isArchived) !== 1).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const books = state.books
    .filter((book) => Number(book.availableCopies) > 0 && Number(book.isArchived) !== 1)
    .sort((a, b) => a.title.localeCompare(b.title));

  document.getElementById('checkoutUser').innerHTML = '<option value="">Select a student or teacher</option>' + users.map((user) => {
    const roleLabel = user.role === 'teacher' ? 'Teacher' : 'Student';
    return `<option value="${user.id}">${escapeHtml(user.fullName)} — ${roleLabel} — ${escapeHtml(user.studentNumber || user.username)}</option>`;
  }).join('');

  document.getElementById('checkoutBook').innerHTML = '<option value="">Select a book</option>' + books
    .map((book) => `<option value="${book.id}">${escapeHtml(book.title)} — ${book.availableCopies} available</option>`)
    .join('');

  document.getElementById('checkoutDate').value = todayISO();
  document.getElementById('checkoutDate').max = todayISO();
  document.getElementById('checkoutFormMessage').textContent = '';
  openModal('checkoutModal');
}

document.getElementById('newCheckoutButton').addEventListener('click', openCheckoutModal);

document.getElementById('checkoutForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await apiFetch('/api/librarian/borrowings', {
      method: 'POST',
      body: JSON.stringify({
        userId: Number(document.getElementById('checkoutUser').value),
        bookId: Number(document.getElementById('checkoutBook').value),
        borrowDate: document.getElementById('checkoutDate').value
      })
    });
    closeModal('checkoutModal');
    showToast(data.message);
    await loadEverything();
    switchView('borrowings');
  } catch (error) {
    document.getElementById('checkoutFormMessage').textContent = error.message;
  }
});

document.getElementById('borrowingsTableBody').addEventListener('click', async (event) => {
  const button = event.target.closest('.mark-returned');
  if (!button || !window.confirm('Mark this book as returned?')) return;
  button.disabled = true;

  try {
    const data = await apiFetch(`/api/librarian/borrowings/${button.dataset.id}/return`, {
      method: 'POST',
      body: '{}'
    });
    showToast(data.message);
    await loadEverything();
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
});

/* ---------------- QR display ---------------- */

function safeFileName(value) {
  return String(value || 'libtrack-qr').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function openQrModal(qr) {
  const box = document.getElementById('qrCode');
  box.innerHTML = '';
  document.getElementById('qrModalTitle').textContent = qr.label || 'LibTrack QR';
  document.getElementById('qrModalDetail').textContent = qr.detail || '';
  currentQrFileName = `libtrack-${qr.type || 'qr'}-${safeFileName(qr.label)}`;

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
}

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

document.getElementById('systemQrButton').addEventListener('click', () => {
  openQrModal({
    type: 'system',
    payload: `${window.location.origin}/login/login.html`,
    label: 'LibTrack System Access',
    detail: 'Scan to open the LibTrack login page'
  });
});

/* ---------------- QR scanner ---------------- */

function setScannerMessage(message, isError = false) {
  const element = document.getElementById('scannerMessage');
  element.textContent = message || '';
  element.classList.toggle('success', Boolean(message) && !isError);
}

function setScanProgress(title, detail) {
  const progress = document.getElementById('scanProgress');
  progress.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
}

function resetScanState() {
  pendingUserCode = '';
  setScannerMessage('');
  if (scanMode === 'entry') {
    setScanProgress('Scan a user QR', 'Student or teacher entry will be recorded automatically.');
  } else {
    setScanProgress('Step 1 of 2 — Scan user QR', `Scan the student or teacher first, then scan the book to ${scanMode}.`);
  }
}

function selectScanMode(mode) {
  scanMode = mode;
  document.querySelectorAll('.scanner-mode').forEach((button) => {
    button.classList.toggle('active', button.dataset.scanMode === mode);
  });
  resetScanState();
}

document.querySelectorAll('.scanner-mode').forEach((button) => {
  button.addEventListener('click', () => selectScanMode(button.dataset.scanMode));
});

async function startScanner() {
  if (scannerRunning) return;
  if (typeof Html5Qrcode !== 'function') {
    setScannerMessage('Camera QR scanner could not load. Check the internet connection and refresh.', true);
    return;
  }

  try {
    if (!html5QrScanner) html5QrScanner = new Html5Qrcode('qrReader');
    await html5QrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1 },
      (decodedText) => processScannedCode(decodedText),
      () => {}
    );
    scannerRunning = true;
    setScannerMessage('Camera ready. Point it at a LibTrack QR code.');
  } catch (error) {
    setScannerMessage(`Camera could not start: ${error.message || error}`, true);
  }
}

async function stopScanner() {
  if (!html5QrScanner || !scannerRunning) return;
  try {
    await html5QrScanner.stop();
  } catch {
    // Camera may already be stopped by the browser.
  }
  scannerRunning = false;
}

async function openScanner() {
  resetScanState();
  openModal('scannerModal');
  await startScanner();
}

async function closeScanner() {
  await stopScanner();
  closeModal('scannerModal');
}

document.getElementById('quickScanButton').addEventListener('click', openScanner);
document.getElementById('openScannerButton').addEventListener('click', openScanner);
document.getElementById('startScannerButton').addEventListener('click', startScanner);
document.getElementById('stopScannerButton').addEventListener('click', stopScanner);
document.getElementById('resetScanButton').addEventListener('click', resetScanState);
document.querySelector('.close-scanner').addEventListener('click', closeScanner);

document.getElementById('scannerModal').addEventListener('click', async (event) => {
  if (event.target === event.currentTarget) await closeScanner();
});

document.getElementById('processManualQrButton').addEventListener('click', async () => {
  const code = document.getElementById('manualQrCode').value.trim();
  if (!code) return setScannerMessage('Paste or type a LibTrack QR value first.', true);
  await processScannedCode(code);
  document.getElementById('manualQrCode').value = '';
});

async function processScannedCode(code) {
  if (scannerLocked) return;
  scannerLocked = true;

  try {
    if (scanMode === 'entry') {
      const data = await apiFetch('/api/librarian/qr/entry', {
        method: 'POST',
        body: JSON.stringify({ userCode: code })
      });
      setScanProgress('Entry recorded', `${data.user.fullName} · ${data.user.role === 'teacher' ? 'Teacher' : 'Student'}`);
      setScannerMessage(data.message);
      showToast(data.message);
      await loadEverything();
      window.setTimeout(resetScanState, 1000);
      return;
    }

    if (!pendingUserCode) {
      const resolved = await apiFetch('/api/librarian/qr/resolve', {
        method: 'POST',
        body: JSON.stringify({ code })
      });
      if (resolved.type !== 'user') throw new Error('Scan the student or teacher QR first.');
      pendingUserCode = code;
      setScanProgress(`Selected: ${resolved.entity.fullName}`, `Step 2 of 2 — now scan the book QR to ${scanMode}.`);
      setScannerMessage('Borrower QR accepted. Scan the book next.');
      return;
    }

    const endpoint = scanMode === 'checkout' ? '/api/librarian/qr/checkout' : '/api/librarian/qr/return';
    const data = await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        userCode: pendingUserCode,
        bookCode: code,
        borrowDate: todayISO()
      })
    });
    showToast(data.message);
    setScanProgress(scanMode === 'checkout' ? 'Checkout complete' : 'Return complete', data.message);
    setScannerMessage(data.message);
    pendingUserCode = '';
    await loadEverything();
    window.setTimeout(resetScanState, 1200);
  } catch (error) {
    setScannerMessage(error.message, true);
    showToast(error.message, true);
  } finally {
    window.setTimeout(() => { scannerLocked = false; }, 850);
  }
}

/* ---------------- CSV reports ---------------- */

function csvCell(value) {
  const textValue = String(value ?? '');
  return `"${textValue.replace(/"/g, '""')}"`;
}

function exportCsv(fileName, headers, rows) {
  const csv = [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

document.getElementById('exportBooksButton').addEventListener('click', () => {
  exportCsv(`libtrack-inventory-${todayISO()}.csv`,
    ['Accession', 'Title', 'Author', 'Category', 'Total copies', 'Available copies', 'Status'],
    state.books.map((book) => [book.accessionNumber, book.title, book.author, book.category, book.totalCopies, book.availableCopies, Number(book.isArchived) === 1 ? 'Archived' : 'Active']));
});

document.getElementById('exportBorrowingsButton').addEventListener('click', () => {
  exportCsv(`libtrack-borrowings-${todayISO()}.csv`,
    ['Borrower', 'Role', 'ID number', 'Book', 'Accession', 'Borrow date', 'Due date', 'Status', 'Returned at'],
    state.borrowings.map((item) => [item.fullName, item.role, item.studentNumber, item.title, item.accessionNumber, item.borrowedAt, item.dueDate, isOverdue(item) ? 'overdue' : item.status, item.returnedAt || '']));
});

document.getElementById('exportEntriesButton').addEventListener('click', () => {
  exportCsv(`libtrack-entry-logs-${todayISO()}.csv`,
    ['User', 'Username', 'ID number', 'Section / Department', 'Role', 'Entry time', 'Recorded by'],
    state.entries.map((item) => [item.fullName, item.username, item.studentNumber, item.section, item.role, item.enteredAt, item.scannedBy]));
});

document.getElementById('exportUsersButton').addEventListener('click', () => {
  exportCsv(`libtrack-users-${todayISO()}.csv`,
    ['Full name', 'Username', 'ID number', 'Section / Department', 'Role', 'Total borrowings', 'Active borrowings', 'Status'],
    state.users.map((user) => [user.fullName, user.username, user.studentNumber, user.section, user.role, user.totalBorrowings, user.activeBorrowings, Number(user.isArchived) === 1 ? 'Archived' : 'Active']));
});

loadEverything();