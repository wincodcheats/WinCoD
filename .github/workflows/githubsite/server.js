// ============================================
// WINCOD CHEAT STORE – COMPLETE SERVER
// ============================================
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2');
const axios = require('axios');
const path = require('path');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Maintenance & Beta helpers ----------
const maintenanceFile = path.join(__dirname, 'maintenance.json');
const betaFile = path.join(__dirname, 'beta.json');

function getMaintenanceStatus() {
    try {
        if (!fs.existsSync(maintenanceFile)) {
            fs.writeFileSync(maintenanceFile, JSON.stringify({ maintenance: false }));
            return false;
        }
        const data = fs.readFileSync(maintenanceFile, 'utf8');
        return JSON.parse(data).maintenance === true;
    } catch (err) { return false; }
}
function setMaintenanceStatus(status) {
    fs.writeFileSync(maintenanceFile, JSON.stringify({ maintenance: status }));
}

function getBetaStatus() {
    try {
        if (!fs.existsSync(betaFile)) {
            fs.writeFileSync(betaFile, JSON.stringify({ beta: true }));
            return true;
        }
        const data = fs.readFileSync(betaFile, 'utf8');
        return JSON.parse(data).beta === true;
    } catch (err) { return true; }
}
function setBetaStatus(status) {
    fs.writeFileSync(betaFile, JSON.stringify({ beta: status }));
}

// ---------- Database ----------
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});
const promiseDb = db.promise();

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/exports', express.static(path.join(__dirname, 'exports')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

// ---------- Maintenance middleware (blocks non-admin routes when ON) ----------
app.use((req, res, next) => {
    const allowed = ['/admin', '/api/maintenance', '/api/beta', '/maintenance', '/public', '/style.css', '/images'];
    if (allowed.some(p => req.path.startsWith(p))) return next();
    if (getMaintenanceStatus() && !req.session.isAdmin) {
        return res.status(503).render('maintenance', { adminEmail: process.env.ADMIN_EMAIL });
    }
    next();
});

// ---------- Helper Functions ----------
function getUserIP(req) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    return ip ? ip.split(',').shift().trim() : 'unknown';
}

function generateTrackingNumber() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 12; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// ---------- Currency conversion (USD → SAR, USD → EGP) ----------
let cachedRateSAR = null, rateLastFetchedSAR = null;
let cachedRateEGP = null, rateLastFetchedEGP = null;

async function getUSDtoSAR() {
    const now = Date.now();
    if (cachedRateSAR && rateLastFetchedSAR && (now - rateLastFetchedSAR) < 60 * 60 * 1000) return cachedRateSAR;
    try {
        const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
        cachedRateSAR = response.data.rates.SAR;
        rateLastFetchedSAR = now;
        return cachedRateSAR;
    } catch (error) {
        console.error('Exchange rate fetch failed for SAR, using fallback 3.75');
        return 3.75;
    }
}

async function getUSDtoEGP() {
    const now = Date.now();
    if (cachedRateEGP && rateLastFetchedEGP && (now - rateLastFetchedEGP) < 60 * 60 * 1000) return cachedRateEGP;
    try {
        const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
        cachedRateEGP = response.data.rates.EGP;
        rateLastFetchedEGP = now;
        return cachedRateEGP;
    } catch (error) {
        console.error('Exchange rate fetch failed for EGP, using fallback 52.71');
        return 52.71;
    }
}

// ---------- Email transporter (OTP, order notifications, contact) ----------
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_PORT === '465',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function sendOTPEmail(email, otp) {
    await transporter.sendMail({
        from: `"WinCoD Cheats" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Verify your WinCoD account',
        html: `<h2>Your OTP: <strong>${otp}</strong></h2><p>Valid for 10 minutes.</p>`
    });
}

// ---------- PayPal Helpers ----------
const getPayPalAccessToken = async () => {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const res = await axios.post(
        `https://api-m.${process.env.PAYPAL_MODE === 'sandbox' ? 'sandbox.' : ''}paypal.com/v1/oauth2/token`,
        'grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return res.data.access_token;
};

const createPayPalOrder = async (amount) => {
    const token = await getPayPalAccessToken();
    const res = await axios.post(
        `https://api-m.${process.env.PAYPAL_MODE === 'sandbox' ? 'sandbox.' : ''}paypal.com/v2/checkout/orders`,
        {
            intent: 'CAPTURE',
            purchase_units: [{ amount: { currency_code: 'USD', value: amount }, description: `COD Cheat - $${amount}` }],
            application_context: {
                brand_name: 'WinCoD',
                landing_page: 'NO_PREFERENCE',
                user_action: 'PAY_NOW',
                shipping_preference: 'NO_SHIPPING'
            }
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return res.data.id;
};

const capturePayPalOrder = async (orderId) => {
    const token = await getPayPalAccessToken();
    const res = await axios.post(
        `https://api-m.${process.env.PAYPAL_MODE === 'sandbox' ? 'sandbox.' : ''}paypal.com/v2/checkout/orders/${orderId}/capture`,
        {},
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return res.data;
};

const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    next();
};

// ------------------------- USER ROUTES -------------------------
app.get('/', (req, res) => {
    const userData = req.session.userId ? { username: req.session.username, email: req.session.userEmail } : null;
    res.render('shop', { user: userData, beta: getBetaStatus() });
});
app.get('/shop', (req, res) => {
    const userData = req.session.userId ? { username: req.session.username, email: req.session.userEmail } : null;
    res.render('shop', { user: userData, beta: getBetaStatus() });
});

// Register
app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('register', { error: null });
});
app.post('/register', async (req, res) => {
    const { email, password, confirmPassword, username, phone_number } = req.body;
    if (!email || !password || !username) return res.render('register', { error: 'Email, password, username required' });
    if (password !== confirmPassword) return res.render('register', { error: 'Passwords do not match' });
    if (password.length < 6) return res.render('register', { error: 'Password min 6 characters' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.render('register', { error: 'Username 3-20 letters, numbers, underscore' });
    try {
        const [existing] = await promiseDb.execute('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
        if (existing.length) return res.render('register', { error: 'Email or username already taken' });
        const hashed = await bcrypt.hash(password, 10);
        const ip = getUserIP(req);
        const [result] = await promiseDb.execute(
            'INSERT INTO users (email, password, username, phone_number, verified, last_ip) VALUES (?, ?, ?, ?, ?, ?)',
            [email, hashed, username, phone_number || null, false, ip]
        );
        const otp = crypto.randomInt(100000, 999999).toString();
        const expires = new Date(Date.now() + 10 * 60000);
        await promiseDb.execute('UPDATE users SET otp_code = ?, otp_expires = ? WHERE id = ?', [otp, expires, result.insertId]);
        await sendOTPEmail(email, otp);
        req.session.pendingUserId = result.insertId;
        req.session.pendingEmail = email;
        res.redirect('/verify-otp');
    } catch (err) {
        console.error(err);
        res.render('register', { error: 'Registration failed' });
    }
});

// OTP
app.get('/verify-otp', (req, res) => {
    if (!req.session.pendingUserId) return res.redirect('/register');
    res.render('verify-otp', { error: null, email: req.session.pendingEmail });
});
app.post('/api/verify-otp', async (req, res) => {
    const { otp } = req.body;
    const userId = req.session.pendingUserId;
    if (!userId) return res.status(401).json({ error: 'No pending registration' });
    try {
        const [rows] = await promiseDb.execute('SELECT otp_code, otp_expires FROM users WHERE id = ?', [userId]);
        if (!rows.length) return res.status(400).json({ error: 'User not found' });
        const user = rows[0];
        if (user.otp_code !== otp) return res.status(400).json({ error: 'Invalid OTP' });
        if (new Date() > new Date(user.otp_expires)) return res.status(400).json({ error: 'OTP expired' });
        await promiseDb.execute('UPDATE users SET verified = 1, otp_code = NULL, otp_expires = NULL WHERE id = ?', [userId]);
        req.session.userId = userId;
        req.session.userEmail = req.session.pendingEmail;
        const [userData] = await promiseDb.execute('SELECT username FROM users WHERE id = ?', [userId]);
        req.session.username = userData[0].username;
        delete req.session.pendingUserId;
        delete req.session.pendingEmail;
        res.json({ success: true, redirect: '/' });
    } catch (err) {
        res.status(500).json({ error: 'Verification failed' });
    }
});
app.post('/api/resend-otp', async (req, res) => {
    const userId = req.session.pendingUserId;
    if (!userId) return res.status(401).json({ error: 'No pending registration' });
    try {
        const otp = crypto.randomInt(100000, 999999).toString();
        const expires = new Date(Date.now() + 10 * 60000);
        await promiseDb.execute('UPDATE users SET otp_code = ?, otp_expires = ? WHERE id = ?', [otp, expires, userId]);
        const [user] = await promiseDb.execute('SELECT email FROM users WHERE id = ?', [userId]);
        await sendOTPEmail(user[0].email, otp);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to resend OTP' });
    }
});

// Login
app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect(req.query.redirect || '/');
    res.render('login', { error: null, redirect: req.query.redirect || '/' });
});
app.post('/login', async (req, res) => {
    const { email, password, redirect } = req.body;
    if (!email || !password) return res.render('login', { error: 'Email and password required', redirect: redirect || '/' });
    try {
        const [rows] = await promiseDb.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (!rows.length) return res.render('login', { error: 'Invalid email or password', redirect: redirect || '/' });
        const user = rows[0];
        if (!user.verified) return res.render('login', { error: 'Please verify your email first', redirect: redirect || '/' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.render('login', { error: 'Invalid email or password', redirect: redirect || '/' });
        const ip = getUserIP(req);
        await promiseDb.execute('UPDATE users SET last_ip = ? WHERE id = ?', [ip, user.id]);
        req.session.userId = user.id;
        req.session.userEmail = user.email;
        req.session.username = user.username;
        const redirectUrl = redirect && redirect !== 'undefined' ? redirect : '/';
        res.redirect(redirectUrl);
    } catch (err) {
        res.render('login', { error: 'Login failed', redirect: redirect || '/' });
    }
});
app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// My Orders
app.get('/my-orders', requireAuth, async (req, res) => {
    const [orders] = await promiseDb.execute(`
        SELECT o.*, t.amount
        FROM orders o
        JOIN transactions t ON o.transaction_id = t.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
    `, [req.session.userId]);
    res.render('orders', { user: req.session, orders });
});

// Payment page
app.get('/payment', requireAuth, (req, res) => {
    const product = req.query.product || '3 Days';
    const amount = req.query.amount || '5';
    const days = req.query.days || '3';
    res.render('payment', {
        paypalClientId: process.env.PAYPAL_CLIENT_ID,
        username: req.session.username,
        productName: product,
        amount: parseFloat(amount).toFixed(2),
        duration: `${days} days`
    });
});

// ---------- PayPal Endpoints ----------
app.post('/api/create-order', requireAuth, async (req, res) => {
    try {
        let { amount, productName, days } = req.body;
        amount = parseFloat(amount);
        if (isNaN(amount) || amount < 1) amount = 5.00;
        if (amount > 1000) amount = 1000.00;
        const formatted = amount.toFixed(2);
        const orderId = await createPayPalOrder(formatted);
        const ip = getUserIP(req);
        req.session.pendingOrder = { productName, days: parseInt(days) };
        await promiseDb.execute(
            'INSERT INTO transactions (user_id, paypal_order_id, amount, status, user_ip) VALUES (?, ?, ?, ?, ?)',
            [req.session.userId, orderId, formatted, 'pending', ip]
        );
        res.json({ orderId });
    } catch (err) {
        console.error('Create order error:', err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data?.message || err.message });
    }
});

app.post('/api/capture-order', requireAuth, async (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Order ID required' });
    try {
        const capture = await capturePayPalOrder(orderId);
        console.log('Full capture response:', JSON.stringify(capture, null, 2));

        const captureDetails = capture.purchase_units?.[0]?.payments?.captures?.[0];
        if (!captureDetails || captureDetails.status !== 'COMPLETED') {
            await promiseDb.execute('UPDATE transactions SET status="failed" WHERE paypal_order_id=?', [orderId]);
            return res.status(400).json({ error: captureDetails?.status ? `Payment not completed: ${captureDetails.status}` : 'Capture failed' });
        }

        const amountPaid = captureDetails.amount?.value;
        if (!amountPaid) throw new Error('Amount missing in capture details');

        // Update transaction
        const payer = capture.payer || {};
        const payerName = payer.name ? `${payer.name.given_name || ''} ${payer.name.surname || ''}`.trim() : null;
        const payerEmail = payer.email_address || null;
        const paymentSource = capture.payment_source || {};
        let cardType = null, cardLast4 = null;
        if (paymentSource.card) { cardType = paymentSource.card.brand; cardLast4 = paymentSource.card.last_digits; }
        else if (paymentSource.paypal) cardType = 'PAYPAL_BALANCE';
        await promiseDb.execute(
            `UPDATE transactions SET status='completed', paypal_capture_id=?, payer_name=?, payer_email=?, card_type=?, card_last4=?
            WHERE paypal_order_id=? AND user_id=?`,
            [captureDetails.id, payerName, payerEmail, cardType, cardLast4, orderId, req.session.userId]
        );

        // Get transaction ID
        const [txnRows] = await promiseDb.execute('SELECT id FROM transactions WHERE paypal_order_id = ? AND user_id = ?', [orderId, req.session.userId]);
        const transactionId = txnRows[0].id;

        // Create order record
        const pending = req.session.pendingOrder;
        if (pending) {
            const trackingNumber = generateTrackingNumber();
            const productName = pending.productName || 'COD Cheat';
            const days = pending.days || 0;
            await promiseDb.execute(
                'INSERT INTO orders (user_id, transaction_id, tracking_number, product_name, amount, duration_days, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [req.session.userId, transactionId, trackingNumber, productName, parseFloat(amountPaid), days, 'active']
            );

            // Get user info for emails
            const [userRows] = await promiseDb.execute('SELECT email, username FROM users WHERE id = ?', [req.session.userId]);
            const user = userRows[0];

            // 1) Admin email
            await transporter.sendMail({
                from: `"WinCoD" <${process.env.EMAIL_USER}>`,
                to: process.env.EMAIL_TO,
                subject: `New Order #${trackingNumber}`,
                html: `
                    <h2>New Order Received</h2>
                    <p><strong>User:</strong> ${user.username} (${user.email})</p>
                    <p><strong>Product:</strong> ${productName}</p>
                    <p><strong>Amount:</strong> $${amountPaid}</p>
                    <p><strong>Duration:</strong> ${days} days</p>
                    <p><strong>Tracking Number:</strong> ${trackingNumber}</p>
                    <p><strong>Order Date:</strong> ${new Date().toLocaleString()}</p>
                `
            });

            // 2) Customer thank‑you email
            const durationText = days === 0 ? 'Lifetime' : `${days} days`;
            await transporter.sendMail({
                from: `"WinCoD Cheats" <${process.env.EMAIL_USER}>`,
                to: req.session.userEmail,
                subject: `Thank you for your purchase! Order #${trackingNumber}`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2 style="color: #ff4d4d;">Thank you for your purchase!</h2>
                        <p>Dear ${user.username},</p>
                        <p>Your order has been successfully processed. Here are your order details:</p>
                        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                            <tr><td style="padding: 8px; background: #222;">Product:</td><td style="padding: 8px;"><strong>${productName}</strong></td></tr>
                            <tr><td style="padding: 8px; background: #222;">Amount:</td><td style="padding: 8px;"><strong>$${amountPaid}</strong></td></tr>
                            <tr><td style="padding: 8px; background: #222;">Duration:</td><td style="padding: 8px;"><strong>${durationText}</strong></td></tr>
                            <tr><td style="padding: 8px; background: #222;">Tracking Number:</td><td style="padding: 8px;"><strong style="font-family: monospace;">${trackingNumber}</strong></td></tr>
                            <tr><td style="padding: 8px; background: #222;">Order Date:</td><td style="padding: 8px;"><strong>${new Date().toLocaleString()}</strong></td></tr>
                        </table>
                        <p>You can view your order history at any time: <a href="http://192.168.8.221:${PORT}/my-orders" style="color: #ff6666;">My Orders</a></p>
                        <p>If you have any questions, please contact our support team.</p>
                        <p>Thank you for choosing WinCoD!</p>
                        <hr>
                        <p style="font-size: 12px; color: #888;">WinCoD Cheats – Undetected Cheats</p>
                    </div>
                `
            });

            delete req.session.pendingOrder;
        }

        // Trigger export (Excel+PDF)
        const exportScript = path.join(__dirname, 'export_to_excel.js');
        if (fs.existsSync(exportScript)) {
            exec(`node "${exportScript}"`, { cwd: __dirname }, (error) => {
                if (error) console.error('Export error:', error);
                else console.log('✅ Export triggered after payment');
            });
        }
        res.json({ success: true, message: 'Payment successful!' });
    } catch (err) {
        console.error('Capture error:', err.response?.data || err.message);
        await promiseDb.execute('UPDATE transactions SET status="failed" WHERE paypal_order_id=?', [orderId]).catch(() => {});
        res.status(500).json({ error: err.message || 'Capture error' });
    }
});

// ---------- Contact Page (with user orders dropdown) ----------
app.get('/contact', requireAuth, async (req, res) => {
    try {
        const [orders] = await promiseDb.execute(`
            SELECT id, product_name, tracking_number
            FROM orders
            WHERE user_id = ?
            ORDER BY created_at DESC
        `, [req.session.userId]);
        res.render('contact', {
            userEmail: req.session.userEmail,
            orders: orders,
            error: null,
            success: null
        });
    } catch (err) {
        console.error(err);
        res.render('contact', {
            userEmail: req.session.userEmail,
            orders: [],
            error: 'Could not load orders. Please try again.',
            success: null
        });
    }
});

app.post('/contact', requireAuth, async (req, res) => {
    const { subject, order_id, message } = req.body;
    if (!subject || !message) {
        const [orders] = await promiseDb.execute(`
            SELECT id, product_name, tracking_number
            FROM orders
            WHERE user_id = ?
            ORDER BY created_at DESC
        `, [req.session.userId]).catch(() => []);
        return res.render('contact', {
            userEmail: req.session.userEmail,
            orders: orders,
            error: 'Please fill in all required fields.',
            success: null
        });
    }
    try {
        const [orders] = await promiseDb.execute(`
            SELECT id, product_name, tracking_number
            FROM orders
            WHERE user_id = ?
            ORDER BY created_at DESC
        `, [req.session.userId]);
        await transporter.sendMail({
            from: `"WinCoD Support" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_TO,
            subject: `Support Request: ${subject}`,
            html: `
                <h2>New Support Request</h2>
                <p><strong>User:</strong> ${req.session.username} (${req.session.userEmail})</p>
                <p><strong>Subject:</strong> ${subject}</p>
                <p><strong>Order ID:</strong> ${order_id || 'N/A'}</p>
                <p><strong>Message:</strong><br>${message.replace(/\n/g, '<br>')}</p>
                <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
            `
        });
        res.render('contact', {
            userEmail: req.session.userEmail,
            orders: orders,
            error: null,
            success: 'Your message has been sent. We will reply soon.'
        });
    } catch (err) {
        console.error(err);
        const [orders] = await promiseDb.execute(`
            SELECT id, product_name, tracking_number
            FROM orders
            WHERE user_id = ?
            ORDER BY created_at DESC
        `, [req.session.userId]).catch(() => []);
        res.render('contact', {
            userEmail: req.session.userEmail,
            orders: orders,
            error: 'Failed to send message. Please try again later.',
            success: null
        });
    }
});

// ------------------------- ADMIN ROUTES -------------------------
app.get('/admin/login', (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin/data');
    res.render('admin_login', { error: null, adminEmail: process.env.ADMIN_EMAIL });
});
app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        return res.redirect('/admin/data');
    }
    res.render('admin_login', { error: 'Invalid admin password', adminEmail: process.env.ADMIN_EMAIL });
});
app.get('/admin/logout', (req, res) => {
    req.session.isAdmin = false;
    res.redirect('/admin/login');
});

// Admin dashboard (financial summary, hold status, users, transactions, orders)
app.get('/admin/data', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin/login');
    try {
        const [users] = await promiseDb.execute('SELECT id, email, username, phone_number, verified, last_ip, created_at FROM users');
        const [transactions] = await promiseDb.execute(`
            SELECT t.id, u.email, t.amount, t.status, t.card_type, t.card_last4, t.created_at
            FROM transactions t JOIN users u ON t.user_id = u.id
            WHERE t.status = 'completed'
            ORDER BY t.created_at DESC
        `);

        // Fetch all orders (subscriptions) with user info
        const [orders] = await promiseDb.execute(`
            SELECT o.id, o.user_id, u.email, u.username, o.tracking_number, o.product_name, o.amount,
                   o.duration_days, o.status AS order_status, o.created_at,
                   DATE_ADD(o.created_at, INTERVAL o.duration_days DAY) AS expires_at
            FROM orders o
            JOIN users u ON o.user_id = u.id
            ORDER BY o.created_at DESC
        `);

        // Financial totals
        let totalGross = 0, totalFees = 0, totalNet = 0;
        for (const t of transactions) {
            const amount = parseFloat(t.amount);
            const fee = (amount * 0.049) + 0.30;
            totalGross += amount;
            totalFees += fee;
            totalNet += (amount - fee);
        }
        const usdToSar = await getUSDtoSAR();
        const usdToEgp = await getUSDtoEGP();
        const totalNetSAR = (totalNet * usdToSar).toFixed(2);
        const feesSAR = (totalFees * usdToSar).toFixed(2);
        const totalNetEGP = (totalNet * usdToEgp).toFixed(2);
        const feesEGP = (totalFees * usdToEgp).toFixed(2);
        const paypalMode = process.env.PAYPAL_MODE || 'sandbox';

        // Hold status with net amounts (21 days)
        const now = new Date();
        const holdDays = 21;
        let totalAvailableNet = 0, totalOnHoldNet = 0;
        const transactionsWithHold = transactions.map(t => {
            const txDate = new Date(t.created_at);
            const daysSince = Math.floor((now - txDate) / (1000 * 60 * 60 * 24));
            const daysLeft = Math.max(0, holdDays - daysSince);
            const isOnHold = daysLeft > 0;
            const amount = parseFloat(t.amount);
            const fee = (amount * 0.049) + 0.30;
            const net = amount - fee;
            if (isOnHold) totalOnHoldNet += net;
            else totalAvailableNet += net;
            return { id: t.id, email: t.email, amount, fee, net, created_at: t.created_at, daysLeft, isOnHold };
        });

        res.render('admin_data', {
            users,
            transactions,
            orders,
            transactionsWithHold,
            totalAvailableNet: totalAvailableNet.toFixed(2),
            totalOnHoldNet: totalOnHoldNet.toFixed(2),
            adminEmail: process.env.ADMIN_EMAIL,
            paypalMode,
            summary: {
                gross: totalGross.toFixed(2), fees: totalFees.toFixed(2),
                feesSAR, feesEGP, net: totalNet.toFixed(2),
                netSAR: totalNetSAR, netEGP: totalNetEGP,
                rateSAR: usdToSar, rateEGP: usdToEgp,
                count: transactions.length
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Admin data error');
    }
});

app.delete('/admin/delete-user/:id', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await promiseDb.execute('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to delete user' }); }
});

app.get('/admin/export', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    const exportScript = path.join(__dirname, 'export_to_excel.js');
    if (!fs.existsSync(exportScript)) return res.status(500).json({ error: 'Export script not found' });
    exec(`node "${exportScript}"`, { cwd: __dirname }, (error) => {
        if (error) return res.status(500).json({ error: 'Export failed' });
        res.json({ success: true, message: 'Export completed.' });
    });
});

app.get('/admin/reports', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin/login');
    const exportsDir = path.join(__dirname, 'exports');
    const excelFile = fs.existsSync(path.join(exportsDir, 'transactions_latest.xlsx')) ? 'transactions_latest.xlsx' : null;
    const pdfFile = fs.existsSync(path.join(exportsDir, 'transactions_latest.pdf')) ? 'transactions_latest.pdf' : null;
    res.render('admin_reports', { excelFile, pdfFile });
});

app.post('/admin/clear-transactions', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await promiseDb.execute('DELETE FROM transactions');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to clear transactions' }); }
});

app.get('/admin/status', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin/login');
    res.render('admin_status', { adminEmail: process.env.ADMIN_EMAIL });
});

// API endpoints for status page
app.get('/api/transaction-stats', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    const [rows] = await promiseDb.execute(`
        SELECT DATE(created_at) as date, COUNT(*) as count, SUM(amount) as total_gross,
               SUM(amount - ((amount * 0.049) + 0.30)) as total_net
        FROM transactions WHERE status = 'completed' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY DATE(created_at) ORDER BY date ASC
    `);
    res.json({
        labels: rows.map(r => r.date),
        counts: rows.map(r => r.count),
        gross: rows.map(r => parseFloat(r.total_gross).toFixed(2)),
        net: rows.map(r => parseFloat(r.total_net).toFixed(2))
    });
});

app.get('/api/all-time-totals', async (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    const [rows] = await promiseDb.execute(`
        SELECT COUNT(*) as count, SUM(amount) as gross, SUM(amount - ((amount * 0.049) + 0.30)) as net
        FROM transactions WHERE status = 'completed'
    `);
    const count = rows[0].count || 0;
    const gross = parseFloat(rows[0].gross || 0).toFixed(2);
    const net = parseFloat(rows[0].net || 0).toFixed(2);
    const usdToSar = await getUSDtoSAR();
    const netSAR = (parseFloat(net) * usdToSar).toFixed(2);
    res.json({ count, gross, net, netSAR });
});

let startTime = Date.now();
app.get('/api/server-uptime', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    res.json({ uptime: `${days}d ${hours}h ${minutes}m ${seconds}s`, startTime: new Date(startTime).toISOString() });
});

// Maintenance & Beta APIs
app.get('/api/maintenance-status', (req, res) => res.json({ maintenance: getMaintenanceStatus() }));
app.post('/api/toggle-maintenance', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    const newStatus = !getMaintenanceStatus();
    setMaintenanceStatus(newStatus);
    res.json({ maintenance: newStatus });
});
app.get('/api/beta-status', (req, res) => res.json({ beta: getBetaStatus() }));
app.post('/api/toggle-beta', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    const newStatus = !getBetaStatus();
    setBetaStatus(newStatus);
    res.json({ beta: newStatus });
});

app.get('/maintenance', (req, res) => res.render('maintenance', { adminEmail: process.env.ADMIN_EMAIL }));

// Start server
app.listen(PORT, () => {
    startTime = Date.now();
    console.log(`🚀 WinCoD cheat store running on http://localhost:${PORT}`);
    console.log(`Admin login: http://localhost:${PORT}/admin/login (password only)`);
});