const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 4000,
    dateStrings: true,
    ssl: {
        rejectUnauthorized: true
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

console.log("Menggunakan Connection Pool...");

// --- HELPER FUNCTION ---
const isHPlusOne = (inputDate) => {
    const today = new Date();
    const target = new Date(inputDate);
    today.setHours(0,0,0,0);
    target.setHours(0,0,0,0);
    const diffTime = target - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
    return diffDays >= 1;
};

// --- API ENDPOINTS ---

// 1. Login Dealer
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const sql = 'SELECT * FROM admins WHERE username = ? AND password = ?';
    db.query(sql, [username, password], (err, result) => {
        if (err) return res.status(500).json(err);
        if (result.length > 0) res.json({ success: true, message: 'Login berhasil' });
        else res.status(401).json({ success: false, message: 'Username/Password salah' });
    });
});

// 2. DEALER: Atur Jadwal & Kuota (Insert/Update)
app.post('/api/schedules', (req, res) => {
    const { date, quota } = req.body;
    const sql = `INSERT INTO schedules (service_date, quota) VALUES (?, ?) 
                 ON DUPLICATE KEY UPDATE quota = ?`;
    db.query(sql, [date, quota, quota], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: 'Jadwal update berhasil' });
    });
});

//  DEALER: Lihat SEMUA Jadwal
app.get('/api/schedules/all', (req, res) => {
    const sql = 'SELECT * FROM schedules ORDER BY service_date DESC';
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// DEALER: Hapus Jadwal
app.delete('/api/schedules/:id', (req, res) => {
    const id = req.params.id;
    db.query('DELETE FROM schedules WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json(err);
        res.json({ message: 'Jadwal berhasil dihapus' });
    });
});

// 3. CUSTOMER: Ambil Tanggal yang Tersedia
app.get('/api/schedules/available', (req, res) => {
    const sql = 'SELECT * FROM schedules WHERE service_date >= CURDATE() AND quota > 0';
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// 4. CUSTOMER: Submit Pemesanan
app.post('/api/bookings', (req, res) => {
    const { name, phone, car_type, plate, complaint, date, time } = req.body;

    if (!isHPlusOne(date)) {
        return res.status(400).json({ message: 'Pemesanan harus H+1' });
    }

    db.getConnection((err, connection) => {
        if (err) return res.status(500).json(err);

        connection.beginTransaction(err => {
            if (err) {
                connection.release();
                return res.status(500).json(err);
            }

            const checkQuotaSql = 'SELECT quota FROM schedules WHERE service_date = ? FOR UPDATE';
            connection.query(checkQuotaSql, [date], (err, results) => {
                if (err || results.length === 0 || results[0].quota <= 0) {
                    return connection.rollback(() => {
                        connection.release();
                        res.status(400).json({ message: 'Kuota habis atau tanggal tidak tersedia' });
                    });
                }

                const insertSql = `INSERT INTO bookings (customer_name, phone, car_type, plate_number, complaint, service_date, service_time) 
                                   VALUES (?, ?, ?, ?, ?, ?, ?)`;
                connection.query(insertSql, [name, phone, car_type, plate, complaint, date, time], (err, result) => {
                    if (err) {
                        return connection.rollback(() => {
                            connection.release();
                            res.status(500).json(err);
                        });
                    }

                    const updateQuotaSql = 'UPDATE schedules SET quota = quota - 1 WHERE service_date = ?';
                    connection.query(updateQuotaSql, [date], (err) => {
                        if (err) {
                            return connection.rollback(() => {
                                connection.release();
                                res.status(500).json(err);
                            });
                        }
                        
                        connection.commit(err => {
                            if (err) {
                                return connection.rollback(() => {
                                    connection.release();
                                    res.status(500).json(err);
                                });
                            }
                            connection.release();
                            res.json({ message: 'Pemesanan berhasil!' });
                        });
                    });
                });
            });
        });
    });
});

// 5. DEALER: Lihat Daftar Pesanan
app.get('/api/bookings', (req, res) => {
    const sql = 'SELECT * FROM bookings ORDER BY service_date DESC, id DESC';
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// 6. DEALER: Update Status
app.put('/api/bookings/:id/status', (req, res) => {
    const bookingId = req.params.id;
    const { newStatus } = req.body;

    db.query('SELECT * FROM bookings WHERE id = ?', [bookingId], (err, results) => {
        if (err || results.length === 0) return res.status(404).json({ message: 'Booking not found' });
        
        const booking = results[0];
        const oldStatus = booking.status;
        const serviceDate = booking.service_date;

        const updateSql = 'UPDATE bookings SET status = ? WHERE id = ?';
        db.query(updateSql, [newStatus, bookingId], (err) => {
            if (err) return res.status(500).json(err);

            // kembalikan kuota jika Batal
            if (newStatus === 'Konfirmasi Batal' && oldStatus !== 'Konfirmasi Batal') {
                db.query('UPDATE schedules SET quota = quota + 1 WHERE service_date = ?', [serviceDate]);
            }
            else if (oldStatus === 'Konfirmasi Batal' && newStatus !== 'Konfirmasi Batal') {
                db.query('UPDATE schedules SET quota = quota - 1 WHERE service_date = ?', [serviceDate]);
            }

            res.json({ message: 'Status berhasil diubah' });
        });
    });
});

const port = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}

module.exports = app;
