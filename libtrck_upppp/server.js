'use strict';
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { promisify } = require('util');
const path = require('path');

const scryptAsync = promisify(crypto.scrypt);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || 12));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'libtrack_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function text(value, max = 255) {
  return String(value ?? '').trim().slice(0, max);
}

function todayISO() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todayISO();
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedValue) {
  const [algorithm, saltHex, hashHex] = String(storedValue || '').split('$');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newQrToken() {
  return crypto.randomUUID();
}

function qrPayload(type, token) {
  return `LIBTRACK:${String(type || '').toUpperCase()}:${String(token || '')}`;
}

function parseQrPayload(value) {
  const raw = text(value, 300);
  const match = /^LIBTRACK:(USER|BOOK):([0-9a-f-]{36})$/i.exec(raw);
  if (!match) return null;
  return { type: match[1].toLowerCase(), token: match[2].toLowerCase() };
}

async function resolveQrEntity(code, expectedType = null) {
  const parsed = parseQrPayload(code);
  if (!parsed || (expectedType && parsed.type !== expectedType)) {
    const error = new Error(expectedType === 'user'
      ? 'Scan a valid LibTrack student or teacher QR code.'
      : expectedType === 'book'
        ? 'Scan a valid LibTrack book QR code.'
        : 'Invalid LibTrack QR code.');
    error.status = 400;
    throw error;
  }

  if (parsed.type === 'user') {
    const [rows] = await pool.execute(
      `SELECT id, username, full_name AS fullName, student_number AS studentNumber,
              section, role, qr_token AS qrToken
       FROM users
       WHERE qr_token = ? AND role IN ('student', 'teacher') AND (is_archived = 0 OR is_archived IS NULL)
       LIMIT 1`,
      [parsed.token]
    );
    if (!rows.length) {
      const error = new Error('Borrower QR code was not found or account is archived.');
      error.status = 404;
      throw error;
    }
    return { type: 'user', entity: rows[0] };
  }

  const [rows] = await pool.execute(
    `SELECT id, accession_number AS accessionNumber, title, author, category,
            total_copies AS totalCopies, available_copies AS availableCopies,
            qr_token AS qrToken
     FROM books
     WHERE qr_token = ? AND (is_archived = 0 OR is_archived IS NULL)
     LIMIT 1`,
    [parsed.token]
  );
  if (!rows.length) {
    const error = new Error('Book QR code was not found or book is archived.');
    error.status = 404;
    throw error;
  }
  return { type: 'book', entity: rows[0] };
}

function safeUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    fullName: row.full_name,
    studentNumber: row.student_number,
    section: row.section,
    role: row.role
  };
}

const requireAuth = asyncRoute(async (req, res, next) => {
  const authHeader = req.get('authorization') || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Please log in first.' });
  }

  const tokenHash = hashToken(token);
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.full_name, u.student_number, u.section, u.role
     FROM api_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > NOW() AND (u.is_archived = 0 OR u.is_archived IS NULL)
     LIMIT 1`,
    [tokenHash]
  );

  if (!rows.length) {
    return res.status(401).json({ message: 'Your session expired or your account was archived. Please log in again.' });
  }

  req.user = rows[0];
  req.tokenHash = tokenHash;
  next();
});

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ message: `${role === 'librarian' ? 'Librarian' : role} access is required.` });
    }
    next();
  };
}

function requireBorrower(req, res, next) {
  if (!['student', 'teacher'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Student or teacher access is required.' });
  }
  next();
}

async function checkoutBook({ userId, bookId, borrowDate }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [users] = await connection.execute(
      `SELECT id, full_name, role FROM users WHERE id = ? AND (is_archived = 0 OR is_archived IS NULL) FOR UPDATE`,
      [userId]
    );
    if (!users.length || !['student', 'teacher'].includes(users[0].role)) {
      const error = new Error('Borrower account not found or archived.');
      error.status = 404;
      throw error;
    }

    const [books] = await connection.execute(
      `SELECT id, title, available_copies FROM books WHERE id = ? AND (is_archived = 0 OR is_archived IS NULL) FOR UPDATE`,
      [bookId]
    );
    if (!books.length) {
      const error = new Error('Book not found or archived.');
      error.status = 404;
      throw error;
    }
    if (Number(books[0].available_copies) < 1) {
      const error = new Error('No available copy of this book.');
      error.status = 409;
      throw error;
    }

    const [existing] = await connection.execute(
      `SELECT id FROM borrowings
       WHERE user_id = ? AND book_id = ? AND status = 'borrowed'
       LIMIT 1`,
      [userId, bookId]
    );
    if (existing.length) {
      const error = new Error('This borrower already has an active copy of this book.');
      error.status = 409;
      throw error;
    }

    const date = validDate(borrowDate);
    await connection.execute(
      `INSERT INTO borrowings (user_id, book_id, borrowed_at, due_date)
       VALUES (?, ?, ?, DATE_ADD(?, INTERVAL 7 DAY))`,
      [userId, bookId, date, date]
    );
    await connection.execute(
      `UPDATE books SET available_copies = available_copies - 1
       WHERE id = ? AND available_copies > 0`,
      [bookId]
    );

    await connection.commit();
    return {
      title: books[0].title,
      studentName: users[0].full_name,
      borrowerName: users[0].full_name,
      dueDate: new Date(`${date}T00:00:00`).toISOString().slice(0, 10)
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function returnBorrowing({ borrowingId, userId = null }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const params = [borrowingId];
    let ownerClause = '';
    if (userId !== null) {
      ownerClause = 'AND br.user_id = ?';
      params.push(userId);
    }

    const [rows] = await connection.execute(
      `SELECT br.id, br.book_id, br.status, b.title
       FROM borrowings br
       JOIN books b ON b.id = br.book_id
       WHERE br.id = ? ${ownerClause}
       FOR UPDATE`,
      params
    );

    if (!rows.length) {
      const error = new Error('Borrowing record not found.');
      error.status = 404;
      throw error;
    }
    if (rows[0].status === 'returned') {
      const error = new Error('This book is already returned.');
      error.status = 409;
      throw error;
    }

    await connection.execute(
      `UPDATE borrowings SET status = 'returned', returned_at = NOW() WHERE id = ?`,
      [borrowingId]
    );
    await connection.execute(
      `UPDATE books
       SET available_copies = LEAST(total_copies, available_copies + 1)
       WHERE id = ?`,
      [rows[0].book_id]
    );

    await connection.commit();
    return rows[0].title;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, message: 'Libtrack backend and database are connected.' });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const username = text(req.body.username, 50);
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const [rows] = await pool.execute(
    `SELECT id, username, password_hash, full_name, student_number, section, role, is_archived
     FROM users WHERE username = ? LIMIT 1`,
    [username]
  );
  if (!rows.length || Number(rows[0].is_archived) === 1 || !(await verifyPassword(password, rows[0].password_hash))) {
    return res.status(401).json({ message: 'Invalid username or password, or account is archived.' });
  }

  await pool.execute('DELETE FROM api_sessions WHERE expires_at <= NOW()');
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
  await pool.execute(
    `INSERT INTO api_sessions (user_id, token_hash, expires_at)
     VALUES (?, ?, ?)`,
    [rows[0].id, hashToken(rawToken), expiresAt]
  );

  res.json({ message: 'Login successful.', token: rawToken, user: safeUser(rows[0]) });
}));

app.post('/api/logout', requireAuth, asyncRoute(async (req, res) => {
  await pool.execute('DELETE FROM api_sessions WHERE token_hash = ?', [req.tokenHash]);
  res.json({ message: 'Logged out.' });
}));

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

app.get('/api/books', requireAuth, asyncRoute(async (req, res) => {
  const search = text(req.query.search, 100);
  const category = text(req.query.category, 80);
  const availableOnly = String(req.query.available || '') === 'true';
  const includeArchived = String(req.query.archived || '') === 'true';
  
  const clauses = [];
  const params = [];

  if (!includeArchived) {
    clauses.push('(is_archived = 0 OR is_archived IS NULL)');
  } else {
    clauses.push('is_archived = 1');
  }

  if (search) {
    clauses.push('(title LIKE ? OR author LIKE ? OR accession_number LIKE ? OR category LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (category) {
    clauses.push('category = ?');
    params.push(category);
  }
  if (availableOnly) clauses.push('available_copies > 0');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `SELECT id, accession_number AS accessionNumber, title, author, category,
            total_copies AS totalCopies, available_copies AS availableCopies,
            qr_token AS qrToken, is_archived AS isArchived, archived_at AS archivedAt, archive_reason AS archiveReason
     FROM books ${where}
     ORDER BY title ASC`,
    params
  );
  res.json({ books: rows });
}));

app.get('/api/categories', requireAuth, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query('SELECT DISTINCT category FROM books WHERE (is_archived = 0 OR is_archived IS NULL) ORDER BY category ASC');
  res.json({ categories: rows.map((row) => row.category) });
}));

app.get('/api/student/summary', requireAuth, requireBorrower, asyncRoute(async (req, res) => {
  const [[bookRows], [loanRows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS titles, COALESCE(SUM(available_copies), 0) AS availableCopies FROM books WHERE (is_archived = 0 OR is_archived IS NULL)`),
    pool.execute(
      `SELECT
         SUM(CASE WHEN status = 'borrowed' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'borrowed' AND due_date < CURDATE() THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END) AS returned
       FROM borrowings WHERE user_id = ?`,
      [req.user.id]
    )
  ]);

  res.json({
    summary: {
      titles: Number(bookRows[0].titles || 0),
      availableCopies: Number(bookRows[0].availableCopies || 0),
      active: Number(loanRows[0].active || 0),
      overdue: Number(loanRows[0].overdue || 0),
      returned: Number(loanRows[0].returned || 0)
    }
  });
}));

app.get('/api/my-borrowings', requireAuth, requireBorrower, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT br.id, br.status, b.id AS bookId, b.accession_number AS accessionNumber,
            b.title, b.author, b.category,
            DATE_FORMAT(br.borrowed_at, '%Y-%m-%d') AS borrowedAt,
            DATE_FORMAT(br.due_date, '%Y-%m-%d') AS dueDate,
            DATE_FORMAT(br.returned_at, '%Y-%m-%d %H:%i') AS returnedAt,
            (br.status = 'borrowed' AND br.due_date < CURDATE()) AS isOverdue
     FROM borrowings br
     JOIN books b ON b.id = br.book_id
     WHERE br.user_id = ?
     ORDER BY CASE WHEN br.status = 'borrowed' THEN 0 ELSE 1 END,
              br.due_date ASC, br.created_at DESC`,
    [req.user.id]
  );
  res.json({ borrowings: rows });
}));

app.post('/api/borrowings', requireAuth, requireBorrower, asyncRoute(async (req, res) => {
  const bookId = Number(req.body.bookId);
  if (!Number.isInteger(bookId) || bookId < 1) {
    return res.status(400).json({ message: 'Please select a valid book.' });
  }
  const result = await checkoutBook({
    userId: Number(req.user.id),
    bookId,
    borrowDate: text(req.body.borrowDate, 10)
  });
  res.status(201).json({ message: `“${result.title}” was borrowed successfully and is due in 7 days.` });
}));

app.post('/api/returns', requireAuth, requireBorrower, asyncRoute(async (req, res) => {
  const borrowingId = Number(req.body.borrowingId);
  if (!Number.isInteger(borrowingId) || borrowingId < 1) {
    return res.status(400).json({ message: 'Please select a valid borrowing record.' });
  }
  const title = await returnBorrowing({ borrowingId, userId: Number(req.user.id) });
  res.json({ message: `“${title}” was returned successfully.` });
}));

app.get('/api/librarian/stats', requireAuth, requireRole('librarian'), asyncRoute(async (_req, res) => {
  const [[bookRows], [loanRows], [userRows], [entryRows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS titles,
                       COALESCE(SUM(total_copies), 0) AS totalCopies,
                       COALESCE(SUM(available_copies), 0) AS availableCopies
                FROM books WHERE (is_archived = 0 OR is_archived IS NULL)`),
    pool.query(`SELECT
                  SUM(CASE WHEN status = 'borrowed' THEN 1 ELSE 0 END) AS active,
                  SUM(CASE WHEN status = 'borrowed' AND due_date < CURDATE() THEN 1 ELSE 0 END) AS overdue,
                  SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END) AS returned
                FROM borrowings`),
    pool.query(`SELECT
                  SUM(CASE WHEN role = 'student' AND (is_archived = 0 OR is_archived IS NULL) THEN 1 ELSE 0 END) AS students,
                  SUM(CASE WHEN role = 'teacher' AND (is_archived = 0 OR is_archived IS NULL) THEN 1 ELSE 0 END) AS teachers,
                  SUM(CASE WHEN role IN ('student', 'teacher') AND (is_archived = 0 OR is_archived IS NULL) THEN 1 ELSE 0 END) AS borrowers
                FROM users`),
    pool.query(`SELECT COUNT(*) AS entriesToday
                FROM library_entries
                WHERE DATE(entered_at) = CURDATE()`)
  ]);

  res.json({
    stats: {
      titles: Number(bookRows[0].titles || 0),
      totalCopies: Number(bookRows[0].totalCopies || 0),
      availableCopies: Number(bookRows[0].availableCopies || 0),
      active: Number(loanRows[0].active || 0),
      overdue: Number(loanRows[0].overdue || 0),
      returned: Number(loanRows[0].returned || 0),
      students: Number(userRows[0].students || 0),
      teachers: Number(userRows[0].teachers || 0),
      borrowers: Number(userRows[0].borrowers || 0),
      entriesToday: Number(entryRows[0].entriesToday || 0)
    }
  });
}));

app.post('/api/books', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const accessionNumber = text(req.body.accessionNumber, 50);
  const title = text(req.body.title, 200);
  const author = text(req.body.author, 150);
  const category = text(req.body.category, 80);
  const totalCopies = Number(req.body.totalCopies);

  if (!accessionNumber || !title || !category || !Number.isInteger(totalCopies) || totalCopies < 1) {
    return res.status(400).json({ message: 'Complete the required book fields and enter at least one copy.' });
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO books
       (accession_number, title, author, category, total_copies, available_copies, qr_token, is_archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [accessionNumber, title, author || null, category, totalCopies, totalCopies, newQrToken()]
    );
    res.status(201).json({ message: 'Book added successfully.', bookId: result.insertId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That accession number already exists.' });
    throw error;
  }
}));

app.put('/api/books/:id', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const bookId = Number(req.params.id);
  const accessionNumber = text(req.body.accessionNumber, 50);
  const title = text(req.body.title, 200);
  const author = text(req.body.author, 150);
  const category = text(req.body.category, 80);
  const totalCopies = Number(req.body.totalCopies);

  if (!Number.isInteger(bookId) || bookId < 1 || !accessionNumber || !title || !category || !Number.isInteger(totalCopies) || totalCopies < 1) {
    return res.status(400).json({ message: 'Please provide valid book information.' });
  }

  const [rows] = await pool.execute(
    'SELECT total_copies, available_copies FROM books WHERE id = ? LIMIT 1',
    [bookId]
  );
  if (!rows.length) return res.status(404).json({ message: 'Book not found.' });

  const borrowedCopies = Number(rows[0].total_copies) - Number(rows[0].available_copies);
  if (totalCopies < borrowedCopies) {
    return res.status(409).json({ message: `${borrowedCopies} copies are currently borrowed, so total copies cannot be lower than that.` });
  }

  try {
    await pool.execute(
      `UPDATE books
       SET accession_number = ?, title = ?, author = ?, category = ?,
           total_copies = ?, available_copies = ?
       WHERE id = ?`,
      [accessionNumber, title, author || null, category, totalCopies, totalCopies - borrowedCopies, bookId]
    );
    res.json({ message: 'Book updated successfully.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That accession number is already used by another book.' });
    throw error;
  }
}));

/* Archive Book Endpoint */
app.post('/api/books/:id/archive', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const bookId = Number(req.params.id);
  const reason = text(req.body.reason || 'Archived by librarian', 255);
  if (!Number.isInteger(bookId) || bookId < 1) return res.status(400).json({ message: 'Invalid book ID.' });

  const [result] = await pool.execute(
    `UPDATE books SET is_archived = 1, archived_at = NOW(), archive_reason = ? WHERE id = ?`,
    [reason, bookId]
  );
  if (!result.affectedRows) return res.status(404).json({ message: 'Book not found.' });
  res.json({ message: 'Book archived successfully.' });
}));

/* Restore Book Endpoint */
app.post('/api/books/:id/restore', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const bookId = Number(req.params.id);
  if (!Number.isInteger(bookId) || bookId < 1) return res.status(400).json({ message: 'Invalid book ID.' });

  const [result] = await pool.execute(
    `UPDATE books SET is_archived = 0, archived_at = NULL, archive_reason = NULL WHERE id = ?`,
    [bookId]
  );
  if (!result.affectedRows) return res.status(404).json({ message: 'Book not found.' });
  res.json({ message: 'Book restored successfully.' });
}));

async function listBorrowerUsers(req, res) {
  const search = text(req.query.search, 100);
  const role = text(req.query.role, 20);
  const includeArchived = String(req.query.archived || '') === 'true';
  const params = [];
  let where = `WHERE u.role IN ('student', 'teacher')`;

  if (!includeArchived) {
    where += ` AND (u.is_archived = 0 OR u.is_archived IS NULL)`;
  } else {
    where += ` AND u.is_archived = 1`;
  }

  if (role === 'student' || role === 'teacher') {
    where += ' AND u.role = ?';
    params.push(role);
  }
  if (search) {
    where += ' AND (u.full_name LIKE ? OR u.username LIKE ? OR u.student_number LIKE ? OR u.section LIKE ? OR u.role LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.full_name AS fullName,
            u.student_number AS studentNumber, u.section, u.role, u.qr_token AS qrToken,
            u.is_archived AS isArchived, u.archived_at AS archivedAt,
            COUNT(br.id) AS totalBorrowings,
            SUM(CASE WHEN br.status = 'borrowed' THEN 1 ELSE 0 END) AS activeBorrowings
     FROM users u
     LEFT JOIN borrowings br ON br.user_id = u.id
     ${where}
     GROUP BY u.id, u.username, u.full_name, u.student_number, u.section, u.role, u.qr_token, u.is_archived, u.archived_at
     ORDER BY u.role ASC, u.full_name ASC`,
    params
  );
  res.json({ users: rows, students: rows.filter((row) => row.role === 'student') });
}

async function createBorrowerUser(req, res) {
  const username = text(req.body.username, 50);
  const password = String(req.body.password || '');
  const fullName = text(req.body.fullName, 120);
  const studentNumber = text(req.body.studentNumber || req.body.idNumber, 50);
  const section = text(req.body.section || req.body.sectionDepartment, 80);
  const role = text(req.body.role, 20) || 'student';

  if (!['student', 'teacher'].includes(role)) {
    return res.status(400).json({ message: 'Account type must be Student or Teacher.' });
  }
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) {
    return res.status(400).json({ message: 'Username must be 3–50 characters and may use letters, numbers, dot, dash, or underscore.' });
  }
  if (password.length < 6 || !fullName || !studentNumber || !section) {
    return res.status(400).json({ message: 'Complete all user fields and use a password with at least 6 characters.' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const [result] = await pool.execute(
      `INSERT INTO users
       (username, password_hash, full_name, student_number, section, role, qr_token, is_archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [username, passwordHash, fullName, studentNumber, section, role, newQrToken()]
    );
    res.status(201).json({
      message: `${role === 'teacher' ? 'Teacher' : 'Student'} account created successfully.`,
      userId: result.insertId
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Username or ID number already exists.' });
    }
    throw error;
  }
}

async function updateBorrowerUser(req, res) {
  const userId = Number(req.params.id);
  const username = text(req.body.username, 50);
  const password = String(req.body.password || '');
  const fullName = text(req.body.fullName, 120);
  const studentNumber = text(req.body.studentNumber || req.body.idNumber, 50);
  const section = text(req.body.section || req.body.sectionDepartment, 80);
  const role = text(req.body.role, 20) || 'student';

  if (!Number.isInteger(userId) || userId < 1 ||
      !/^[A-Za-z0-9._-]{3,50}$/.test(username) ||
      !fullName || !studentNumber || !section ||
      !['student', 'teacher'].includes(role)) {
    return res.status(400).json({ message: 'Please provide valid user information.' });
  }
  if (password && password.length < 6) {
    return res.status(400).json({ message: 'New password must have at least 6 characters.' });
  }

  const [exists] = await pool.execute(
    `SELECT id FROM users WHERE id = ? AND role IN ('student', 'teacher')`,
    [userId]
  );
  if (!exists.length) return res.status(404).json({ message: 'User account not found.' });

  try {
    if (password) {
      const passwordHash = await hashPassword(password);
      await pool.execute(
        `UPDATE users
         SET username = ?, full_name = ?, student_number = ?, section = ?, role = ?, password_hash = ?
         WHERE id = ? AND role IN ('student', 'teacher')`,
        [username, fullName, studentNumber, section, role, passwordHash, userId]
      );
      await pool.execute('DELETE FROM api_sessions WHERE user_id = ?', [userId]);
    } else {
      await pool.execute(
        `UPDATE users
         SET username = ?, full_name = ?, student_number = ?, section = ?, role = ?
         WHERE id = ? AND role IN ('student', 'teacher')`,
        [username, fullName, studentNumber, section, role, userId]
      );
    }
    res.json({ message: 'User account updated successfully.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Username or ID number is already used.' });
    }
    throw error;
  }
}

/* Archive User Endpoint */
app.post('/api/librarian/users/:id/archive', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ message: 'Invalid user ID.' });

  const [result] = await pool.execute(
    `UPDATE users SET is_archived = 1, archived_at = NOW() WHERE id = ? AND role IN ('student', 'teacher')`,
    [userId]
  );
  if (!result.affectedRows) return res.status(404).json({ message: 'User account not found.' });
  await pool.execute('DELETE FROM api_sessions WHERE user_id = ?', [userId]);
  res.json({ message: 'User account archived successfully.' });
}));

/* Restore User Endpoint */
app.post('/api/librarian/users/:id/restore', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ message: 'Invalid user ID.' });

  const [result] = await pool.execute(
    `UPDATE users SET is_archived = 0, archived_at = NULL WHERE id = ? AND role IN ('student', 'teacher')`,
    [userId]
  );
  if (!result.affectedRows) return res.status(404).json({ message: 'User account not found.' });
  res.json({ message: 'User account restored successfully.' });
}));

app.get('/api/librarian/users', requireAuth, requireRole('librarian'), asyncRoute(listBorrowerUsers));
app.post('/api/librarian/users', requireAuth, requireRole('librarian'), asyncRoute(createBorrowerUser));
app.put('/api/librarian/users/:id', requireAuth, requireRole('librarian'), asyncRoute(updateBorrowerUser));

/* Backward-compatible student endpoints for older frontend copies. */
app.get('/api/librarian/students', requireAuth, requireRole('librarian'), asyncRoute(listBorrowerUsers));
app.post('/api/librarian/students', requireAuth, requireRole('librarian'), asyncRoute(createBorrowerUser));
app.put('/api/librarian/students/:id', requireAuth, requireRole('librarian'), asyncRoute(updateBorrowerUser));

app.get('/api/librarian/borrowings', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const search = text(req.query.search, 100);
  const status = text(req.query.status, 20) || 'all';
  const category = text(req.query.category, 80);
  const clauses = [];
  const params = [];

  if (search) {
    clauses.push('(u.full_name LIKE ? OR u.student_number LIKE ? OR u.section LIKE ? OR b.title LIKE ? OR b.accession_number LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  if (status === 'borrowed' || status === 'returned') {
    clauses.push('br.status = ?');
    params.push(status);
  } else if (status === 'overdue') {
    clauses.push(`br.status = 'borrowed' AND br.due_date < CURDATE()`);
  }
  if (category) {
    clauses.push('b.category = ?');
    params.push(category);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `SELECT br.id, br.status, br.user_id AS userId, br.book_id AS bookId,
            u.full_name AS fullName, u.student_number AS studentNumber, u.section, u.role,
            b.accession_number AS accessionNumber, b.title, b.author, b.category,
            DATE_FORMAT(br.borrowed_at, '%Y-%m-%d') AS borrowedAt,
            DATE_FORMAT(br.due_date, '%Y-%m-%d') AS dueDate,
            DATE_FORMAT(br.returned_at, '%Y-%m-%d %H:%i') AS returnedAt,
            (br.status = 'borrowed' AND br.due_date < CURDATE()) AS isOverdue
     FROM borrowings br
     JOIN users u ON u.id = br.user_id
     JOIN books b ON b.id = br.book_id
     ${where}
     ORDER BY CASE WHEN br.status = 'borrowed' THEN 0 ELSE 1 END,
              br.due_date ASC, br.created_at DESC`,
    params
  );
  res.json({ borrowings: rows });
}));

app.post('/api/librarian/borrowings', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const userId = Number(req.body.userId);
  const bookId = Number(req.body.bookId);
  if (!Number.isInteger(userId) || userId < 1 || !Number.isInteger(bookId) || bookId < 1) {
    return res.status(400).json({ message: 'Select a valid borrower and book.' });
  }
  const result = await checkoutBook({ userId, bookId, borrowDate: text(req.body.borrowDate, 10) });
  res.status(201).json({ message: `“${result.title}” was checked out to ${result.borrowerName || result.studentName}.` });
}));

app.post('/api/librarian/borrowings/:id/return', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const borrowingId = Number(req.params.id);
  if (!Number.isInteger(borrowingId) || borrowingId < 1) {
    return res.status(400).json({ message: 'Invalid borrowing record.' });
  }
  const title = await returnBorrowing({ borrowingId });
  res.json({ message: `“${title}” was marked as returned.` });
}));

/* ---------------- QR code and library-entry features ---------------- */

app.get('/api/qr/me', requireAuth, requireBorrower, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, username, full_name AS fullName, student_number AS studentNumber,
            section, role, qr_token AS qrToken
     FROM users WHERE id = ? LIMIT 1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'User account not found.' });
  res.json({
    qr: {
      type: 'user',
      payload: qrPayload('USER', rows[0].qrToken),
      label: rows[0].fullName,
      detail: rows[0].studentNumber || rows[0].username
    }
  });
}));

app.get('/api/librarian/users/:id/qr', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  const [rows] = await pool.execute(
    `SELECT id, full_name AS fullName, student_number AS studentNumber, username, role, qr_token AS qrToken
     FROM users
     WHERE id = ? AND role IN ('student', 'teacher')
     LIMIT 1`,
    [userId]
  );
  if (!rows.length) return res.status(404).json({ message: 'User account not found.' });
  res.json({
    qr: {
      type: 'user',
      payload: qrPayload('USER', rows[0].qrToken),
      label: rows[0].fullName,
      detail: `${rows[0].role === 'teacher' ? 'Teacher' : 'Student'} · ${rows[0].studentNumber || rows[0].username}`
    }
  });
}));

app.get('/api/librarian/books/:id/qr', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const bookId = Number(req.params.id);
  const [rows] = await pool.execute(
    `SELECT id, title, accession_number AS accessionNumber, qr_token AS qrToken
     FROM books WHERE id = ? LIMIT 1`,
    [bookId]
  );
  if (!rows.length) return res.status(404).json({ message: 'Book not found.' });
  res.json({
    qr: {
      type: 'book',
      payload: qrPayload('BOOK', rows[0].qrToken),
      label: rows[0].title,
      detail: rows[0].accessionNumber
    }
  });
}));

app.post('/api/qr/book/resolve', requireAuth, requireBorrower, asyncRoute(async (req, res) => {
  const resolved = await resolveQrEntity(req.body.code, 'book');
  res.json({ book: resolved.entity });
}));

app.post('/api/qr/borrow', requireAuth, requireBorrower, asyncRoute(async (req, res) => {
  const resolved = await resolveQrEntity(req.body.code, 'book');
  const result = await checkoutBook({
    userId: Number(req.user.id),
    bookId: Number(resolved.entity.id),
    borrowDate: text(req.body.borrowDate, 10)
  });
  res.status(201).json({
    message: `“${result.title}” was borrowed successfully and is due in 7 days.`
  });
}));

app.post('/api/librarian/qr/resolve', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const resolved = await resolveQrEntity(req.body.code);
  res.json(resolved);
}));

app.post('/api/librarian/qr/entry', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const resolved = await resolveQrEntity(req.body.userCode || req.body.code, 'user');
  await pool.execute(
    `INSERT INTO library_entries (user_id, scanned_by, source)
     VALUES (?, ?, 'qr')`,
    [resolved.entity.id, req.user.id]
  );
  res.status(201).json({
    message: `${resolved.entity.fullName} was recorded as entering the library.`,
    user: resolved.entity
  });
}));

app.post('/api/librarian/qr/checkout', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const user = await resolveQrEntity(req.body.userCode, 'user');
  const book = await resolveQrEntity(req.body.bookCode, 'book');
  const result = await checkoutBook({
    userId: Number(user.entity.id),
    bookId: Number(book.entity.id),
    borrowDate: text(req.body.borrowDate, 10)
  });
  res.status(201).json({
    message: `“${result.title}” was checked out to ${result.borrowerName}.`
  });
}));

app.post('/api/librarian/qr/return', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const user = await resolveQrEntity(req.body.userCode, 'user');
  const book = await resolveQrEntity(req.body.bookCode, 'book');
  const [rows] = await pool.execute(
    `SELECT id
     FROM borrowings
     WHERE user_id = ? AND book_id = ? AND status = 'borrowed'
     ORDER BY borrowed_at DESC
     LIMIT 1`,
    [user.entity.id, book.entity.id]
  );
  if (!rows.length) {
    return res.status(404).json({ message: 'No active borrowing was found for this user and book.' });
  }
  const title = await returnBorrowing({ borrowingId: Number(rows[0].id) });
  res.json({ message: `“${title}” was returned successfully.` });
}));

app.get('/api/librarian/entries', requireAuth, requireRole('librarian'), asyncRoute(async (req, res) => {
  const search = text(req.query.search, 100);
  const date = text(req.query.date, 10);
  const clauses = [];
  const params = [];

  if (search) {
    clauses.push('(u.full_name LIKE ? OR u.username LIKE ? OR u.student_number LIKE ? OR u.section LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    clauses.push('DATE(le.entered_at) = ?');
    params.push(date);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `SELECT le.id, le.user_id AS userId,
            u.full_name AS fullName, u.username, u.student_number AS studentNumber,
            u.section, u.role,
            COALESCE(scanner.full_name, 'System') AS scannedBy,
            DATE_FORMAT(le.entered_at, '%Y-%m-%d %H:%i:%s') AS enteredAt
     FROM library_entries le
     JOIN users u ON u.id = le.user_id
     LEFT JOIN users scanner ON scanner.id = le.scanned_by
     ${where}
     ORDER BY le.entered_at DESC
     LIMIT 1000`,
    params
  );
  res.json({ entries: rows });
}));

app.use('/api', (_req, res) => {
  res.status(404).json({ message: 'API route not found.' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.status) return res.status(error.status).json({ message: error.message });
  if (error.code === 'ECONNREFUSED') {
    return res.status(503).json({ message: 'MySQL is not running. Start UniServerZ/MySQL first.' });
  }
  if (error.code === 'ER_BAD_DB_ERROR') {
    return res.status(503).json({ message: 'Database not found. Run npm run setup first.' });
  }
  if (error.code === 'ER_NO_SUCH_TABLE') {
    return res.status(503).json({ message: 'Database tables are incomplete. Run npm run setup.' });
  }
  if (error.code === 'ER_ACCESS_DENIED_ERROR') {
    return res.status(503).json({ message: 'MySQL login failed. Check DB_USER and DB_PASSWORD in .env.' });
  }
  res.status(500).json({ message: 'Unexpected server error. Check the terminal for details.' });
});

async function start() {
  try {
    await pool.query('SELECT 1');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Libtrack is running at http://localhost:${PORT}`);
      console.log('Database connection successful.');
    });
  } catch (error) {
    console.error('Libtrack could not start:', error.message);
    console.error('Check MySQL, your .env credentials, and run: npm run setup');
    process.exitCode = 1;
  }
}

start();
