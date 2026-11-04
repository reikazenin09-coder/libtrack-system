CREATE DATABASE IF NOT EXISTS libtrack;
USE libtrack;

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('student', 'teacher', 'librarian') NOT NULL,
    qr_token VARCHAR(255) UNIQUE,
    is_archived TINYINT(1) DEFAULT 0,
    archived_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Books Table
CREATE TABLE IF NOT EXISTS books (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    author VARCHAR(255) NOT NULL,
    isbn VARCHAR(50) UNIQUE,
    total_copies INT DEFAULT 1,
    available_copies INT DEFAULT 1,
    qr_token VARCHAR(255) UNIQUE,
    is_archived TINYINT(1) DEFAULT 0,
    archived_at TIMESTAMP NULL,
    archive_reason VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Borrowings Table
CREATE TABLE IF NOT EXISTS borrowings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    book_id INT NOT NULL,
    borrowed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    due_date TIMESTAMP NULL,
    returned_at TIMESTAMP NULL,
    status ENUM('borrowed', 'returned') DEFAULT 'borrowed',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- Library Entry Logs Table
CREATE TABLE IF NOT EXISTS library_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    role VARCHAR(50) NOT NULL,
    entry_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Safe Migration Script for Existing LibTrack Databases

ALTER TABLE books 
ADD COLUMN IF NOT EXISTS is_archived TINYINT(1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP NULL,
ADD COLUMN IF NOT EXISTS archive_reason VARCHAR(255) NULL;

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS is_archived TINYINT(1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP NULL;

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS qr_token VARCHAR(255) UNIQUE;

ALTER TABLE books 
ADD COLUMN IF NOT EXISTS qr_token VARCHAR(255) UNIQUE;

CREATE TABLE IF NOT EXISTS library_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    role VARCHAR(50) NOT NULL,
    entry_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- LibTrack: bring an existing database in line with server.js
-- Works on MySQL 5.7+/8.x and MariaDB. Safe to run more than once.
-- server.js connects to DB_NAME (default: libtrack_db). Change the next line
-- if your .env uses a different database name.

USE libtrack_db;

DROP PROCEDURE IF EXISTS lt_add_col;
DROP PROCEDURE IF EXISTS lt_rename_col;

DELIMITER $$

CREATE PROCEDURE lt_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', t, '` ADD COLUMN `', c, '` ', ddl);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$

CREATE PROCEDURE lt_rename_col(IN t VARCHAR(64), IN old_c VARCHAR(64), IN new_c VARCHAR(64), IN ddl TEXT)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = old_c
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = new_c
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', t, '` CHANGE `', old_c, '` `', new_c, '` ', ddl);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$

DELIMITER ;

-- ---------- users ----------
CALL lt_add_col('users', 'full_name',      'VARCHAR(100) NULL');
CALL lt_add_col('users', 'student_number', 'VARCHAR(50) NULL');
CALL lt_add_col('users', 'section',        'VARCHAR(50) NULL');
CALL lt_add_col('users', 'qr_token',       'VARCHAR(255) NULL UNIQUE');
CALL lt_add_col('users', 'is_archived',    'TINYINT(1) NOT NULL DEFAULT 0');
CALL lt_add_col('users', 'archived_at',    'TIMESTAMP NULL');

UPDATE users SET full_name = username WHERE full_name IS NULL OR full_name = '';
UPDATE users SET qr_token = UUID() WHERE qr_token IS NULL;

-- ---------- books ----------
CALL lt_add_col('books', 'accession_number', 'VARCHAR(50) NULL UNIQUE');
CALL lt_add_col('books', 'category',         'VARCHAR(100) NULL');
CALL lt_add_col('books', 'qr_token',         'VARCHAR(255) NULL UNIQUE');
CALL lt_add_col('books', 'is_archived',      'TINYINT(1) NOT NULL DEFAULT 0');
CALL lt_add_col('books', 'archived_at',      'TIMESTAMP NULL');
CALL lt_add_col('books', 'archive_reason',   'VARCHAR(255) NULL');

-- server.js allows a book with no author
ALTER TABLE books MODIFY author VARCHAR(255) NULL;

UPDATE books SET accession_number = CONCAT('ACC-', LPAD(id, 5, '0')) WHERE accession_number IS NULL;
UPDATE books SET category = 'General' WHERE category IS NULL OR category = '';
UPDATE books SET qr_token = UUID() WHERE qr_token IS NULL;

-- ---------- borrowings ----------
CALL lt_add_col('borrowings', 'created_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP');

-- ---------- library_entries ----------
CALL lt_rename_col('library_entries', 'entry_time', 'entered_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
CALL lt_add_col('library_entries', 'entered_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
CALL lt_add_col('library_entries', 'scanned_by', 'INT NULL');
CALL lt_add_col('library_entries', 'source',     'VARCHAR(20) NOT NULL DEFAULT ''manual''');

-- server.js inserts (user_id, scanned_by, source) only, so role must not be required
ALTER TABLE library_entries MODIFY role VARCHAR(50) NULL;

-- ---------- api_sessions (login tokens) ----------
CREATE TABLE IF NOT EXISTS api_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_api_sessions_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

DROP PROCEDURE IF EXISTS lt_add_col;
DROP PROCEDURE IF EXISTS lt_rename_col;