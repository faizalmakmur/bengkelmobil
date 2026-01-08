const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Koneksi Database
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 4000,
    dateStrings: true, 
    ssl: {
        rejectUnauthorized: true 
    }
});

db.connect(err => {
    if (err) console.error('Koneksi Database Gagal:', err);
    else console.log('Database Cloud Connected!');
});

// Cek apakah tanggal H+1
const isHPlusOne = (inputDate) => {
    const today = new Date();
    const target = new Date(inputDate);
    // Reset jam agar perbandingan murni tanggal
    today.setHours(0,0,0,0);
    target.setHours(0,0,0,0);
    
    const diffTime = target - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
    return diffDays >= 1;
};


// 1.  Login Dealer
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const sql = 'SELECT * FROM admins WHERE username = ? AND password = ?';
    db.query(sql, [username, password], (err, result) => {
        if (err) return res.status(500).json(err);
        if (result.length > 0) res.json({ success: true, message: 'Login berhasil' });
        else res.status(401).json({ success: false, message: 'Username/Password salah' });
    });
});

// 2. DEALER: Atur Jadwal & Kuota
app.post('/api/schedules', (req, res) => {
    const { date, quota } = req.body;
    // Insert atau Update jika tanggal sudah ada
    const sql = `INSERT INTO schedules (service_date, quota) VALUES (?, ?) 
                 ON DUPLICATE KEY UPDATE quota = ?`;
    db.query(sql, [date, quota, quota], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: 'Jadwal update berhasil' });
    });
});

// 3. CUSTOMER: Ambil Tanggal yang Tersedia (H+1 dan Kuota > 0)
app.get('/api/schedules/available', (req, res) => {
    const sql = 'SELECT * FROM schedules WHERE service_date > CURDATE() AND quota > 0';
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// 4. CUSTOMER: Submit Pemesanan
app.post('/api/bookings', (req, res) => {
    const { name, phone, car_type, plate, complaint, date, time } = req.body;

    // Validasi H+1
    if (!isHPlusOne(date)) {
        return res.status(400).json({ message: 'Pemesanan harus H+1' });
    }

    // Cek Kuota & Kurangi Kuota (Transaction)
    db.beginTransaction(err => {
        if (err) return res.status(500).json(err);

        const checkQuotaSql = 'SELECT quota FROM schedules WHERE service_date = ? FOR UPDATE';
        db.query(checkQuotaSql, [date], (err, results) => {
            if (err || results.length === 0 || results[0].quota <= 0) {
                return db.rollback(() => res.status(400).json({ message: 'Kuota habis atau tanggal tidak tersedia' }));
            }

            const insertSql = `INSERT INTO bookings (customer_name, phone, car_type, plate_number, complaint, service_date, service_time) 
                               VALUES (?, ?, ?, ?, ?, ?, ?)`;
            db.query(insertSql, [name, phone, car_type, plate, complaint, date, time], (err, result) => {
                if (err) return db.rollback(() => res.status(500).json(err));

                const updateQuotaSql = 'UPDATE schedules SET quota = quota - 1 WHERE service_date = ?';
                db.query(updateQuotaSql, [date], (err) => {
                    if (err) return db.rollback(() => res.status(500).json(err));
                    
                    db.commit(err => {
                        if (err) return db.rollback(() => res.status(500).json(err));
                        res.json({ message: 'Pemesanan berhasil!' });
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

// 6. DEALER: Update Status (Termasuk logika pengembalian kuota)
app.put('/api/bookings/:id/status', (req, res) => {
    const bookingId = req.params.id;
    const { newStatus } = req.body;

    // Ambil data booking lama dulu untuk cek status sebelumnya
    db.query('SELECT * FROM bookings WHERE id = ?', [bookingId], (err, results) => {
        if (err || results.length === 0) return res.status(404).json({ message: 'Booking not found' });
        
        const booking = results[0];
        const oldStatus = booking.status;
        const serviceDate = booking.service_date;

        const updateSql = 'UPDATE bookings SET status = ? WHERE id = ?';
        db.query(updateSql, [newStatus, bookingId], (err) => {
            if (err) return res.status(500).json(err);

            // Jika status berubah JADI "Konfirmasi Batal" DARI status lain (kecuali batal), kuota +1
            if (newStatus === 'Konfirmasi Batal' && oldStatus !== 'Konfirmasi Batal') {
                db.query('UPDATE schedules SET quota = quota + 1 WHERE service_date = ?', [serviceDate]);
            }
            // Optional: Jika status diubah DARI "Konfirmasi Batal" KE status aktif (misal admin salah klik), kuota -1
            else if (oldStatus === 'Konfirmasi Batal' && newStatus !== 'Konfirmasi Batal') {
                db.query('UPDATE schedules SET quota = quota - 1 WHERE service_date = ?', [serviceDate]);
            }

            res.json({ message: 'Status berhasil diubah' });
        });
    });
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});



db.connect(err => {
    if (err) console.error('Koneksi Database Gagal:', err);
    else console.log('Database Cloud Connected!');
});

const port = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}

module.exports = app;
