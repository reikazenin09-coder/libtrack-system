require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function setup() {
    const pool = mysql.createPool({
        host: process.env.MYSQLHOST || 'localhost',
        user: process.env.MYSQLUSER || 'root',
        password: process.env.MYSQLPASSWORD || 'root',
        database: process.env.MYSQLDATABASE || 'libtrack_db',
        port: process.env.MYSQLPORT || 3307
    });

    console.log('Running database setup...');

    // Default Librarian
    const libPass = await bcrypt.hash('LibTrack2026!', 10);
    await pool.query(`
        INSERT INTO users (username, password_hash, role, qr_token)
        VALUES ('admin_lib', ?, 'librarian', 'QR_ADMIN_001')
        ON DUPLICATE KEY UPDATE role='librarian';
    `, [libPass]);

    // Sample Student
    const studPass = await bcrypt.hash('LibTrack2026!', 10);
    await pool.query(`
        INSERT INTO users (username, password_hash, role, qr_token)
        VALUES ('jdelacruz', ?, 'student', 'QR_STUD_001')
        ON DUPLICATE KEY UPDATE role='student';
    `, [studPass]);

    // Sample Teacher
    const teachPass = await bcrypt.hash('LibTrack2026!', 10);
    await pool.query(`
        INSERT INTO users (username, password_hash, role, qr_token)
        VALUES ('aramos', ?, 'teacher', 'QR_TEACH_001')
        ON DUPLICATE KEY UPDATE role='teacher';
    `, [teachPass]);

    // Sample Book
    await pool.query(`
        INSERT INTO books (title, author, total_copies, available_copies, qr_token)
        VALUES ('Introduction to Computer Science', 'John Smith', 5, 5, 'QR_BOOK_001')
        ON DUPLICATE KEY UPDATE title=VALUES(title);
    `);

    console.log('Database setup complete!');
    process.exit(0);
}

setup().catch(err => {
    console.error('Setup error:', err);
    process.exit(1);
});
