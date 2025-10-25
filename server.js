const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize SQLite database
const dbPath = path.join(dataDir, 'licenses.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        license_code TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        is_activated INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        hardware_id TEXT NOT NULL,
        device_name TEXT,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, hardware_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        session_token TEXT UNIQUE NOT NULL,
        hardware_id TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
`);

console.log('Database initialized at:', dbPath);

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// Helper: Hash password with PBKDF2
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    const [salt, hash] = storedHash.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return hash === verifyHash;
}

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateLicenseCode() {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
}

// === ENDPOINTS ===

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Register new user (admin only - for generating license codes)
app.post('/api/register', (req, res) => {
    try {
        const { username, adminKey } = req.body;

        // Admin authentication
        if (adminKey !== 'PSYPOWER_ADMIN_2025') {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!username || username.length < 3) {
            return res.status(400).json({ error: 'Username must be at least 3 characters' });
        }

        const licenseCode = generateLicenseCode();

        // Create user WITHOUT password (set during first activation)
        const stmt = db.prepare('INSERT INTO users (username, license_code, is_activated) VALUES (?, ?, 0)');
        const result = stmt.run(username, licenseCode);

        res.json({
            success: true,
            username,
            license_code: licenseCode,
            user_id: result.lastInsertRowid
        });

    } catch (error) {
        console.error('Registration error:', error);
        if (error.message.includes('UNIQUE constraint')) {
            res.status(400).json({ error: 'Username already exists' });
        } else {
            res.status(500).json({ error: 'Registration failed' });
        }
    }
});

// Login with username/password (up to 3 devices)
app.post('/api/login', (req, res) => {
    try {
        const { username, password, hardware_id } = req.body;

        if (!username || !password || !hardware_id) {
            return res.status(400).json({ error: 'Username, password, and hardware ID required' });
        }

        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

        if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (user.is_activated === 0) {
            return res.status(401).json({ error: 'License not activated. Please activate first.' });
        }

        // Check current device count
        const devices = db.prepare('SELECT * FROM devices WHERE user_id = ?').all(user.id);
        const existingDevice = devices.find(d => d.hardware_id === hardware_id);

        if (!existingDevice) {
            // New device
            if (devices.length >= 3) {
                return res.status(403).json({ 
                    error: 'Maximum device limit reached (3 devices). Please deactivate a device first.',
                    device_count: devices.length
                });
            }

            // Add new device
            db.prepare('INSERT INTO devices (user_id, hardware_id, device_name) VALUES (?, ?, ?)').run(
                user.id,
                hardware_id,
                `Device ${devices.length + 1}`
            );
        } else {
            // Update last seen
            db.prepare('UPDATE devices SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(existingDevice.id);
        }

        // Generate session token (30 days)
        const sessionToken = generateSessionToken();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        db.prepare('INSERT INTO sessions (user_id, session_token, hardware_id, expires_at) VALUES (?, ?, ?, ?)').run(
            user.id,
            sessionToken,
            hardware_id,
            expiresAt.toISOString()
        );

        // Update last login
        db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

        res.json({
            success: true,
            session_token: sessionToken,
            expires_at: expiresAt.toISOString(),
            username: user.username,
            device_count: existingDevice ? devices.length : devices.length + 1,
            is_new_device: !existingDevice
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Activate license with hardware binding (first time setup)
app.post('/api/activate-license', (req, res) => {
    try {
        const { license_code, hardware_id, password } = req.body;

        if (!license_code || !hardware_id || !password) {
            return res.status(400).json({ error: 'License code, hardware ID, and password required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const user = db.prepare('SELECT * FROM users WHERE license_code = ?').get(license_code);

        if (!user) {
            return res.status(404).json({ error: 'Invalid license code' });
        }

        // Check if already activated
        if (user.is_activated === 1) {
            return res.status(400).json({ error: 'License already activated. Please use login instead.' });
        }

        // Set password and activate
        const passwordHash = hashPassword(password);
        db.prepare('UPDATE users SET password_hash = ?, is_activated = 1 WHERE id = ?').run(passwordHash, user.id);

        // Add first device
        db.prepare('INSERT INTO devices (user_id, hardware_id, device_name) VALUES (?, ?, ?)').run(
            user.id,
            hardware_id,
            'Device 1'
        );

        // Generate session
        const sessionToken = generateSessionToken();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        db.prepare('INSERT INTO sessions (user_id, session_token, hardware_id, expires_at) VALUES (?, ?, ?, ?)').run(
            user.id,
            sessionToken,
            hardware_id,
            expiresAt.toISOString()
        );

        res.json({
            success: true,
            session_token: sessionToken,
            expires_at: expiresAt.toISOString(),
            username: user.username,
            message: 'License activated successfully'
        });

    } catch (error) {
        console.error('Activation error:', error);
        res.status(500).json({ error: 'Activation failed' });
    }
});

// Verify session
app.post('/api/verify-session', (req, res) => {
    try {
        const { session_token, hardware_id } = req.body;

        if (!session_token || !hardware_id) {
            return res.status(400).json({ error: 'Session token and hardware ID required' });
        }

        const session = db.prepare(`
            SELECT s.*, u.username, u.license_code 
            FROM sessions s 
            JOIN users u ON s.user_id = u.id 
            WHERE s.session_token = ? AND s.hardware_id = ? AND s.expires_at > datetime('now')
        `).get(session_token, hardware_id);

        if (!session) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        res.json({
            valid: true,
            username: session.username,
            license_code: session.license_code,
            expires_at: session.expires_at
        });

    } catch (error) {
        console.error('Session verification error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    try {
        const { session_token } = req.body;

        if (session_token) {
            db.prepare('DELETE FROM sessions WHERE session_token = ?').run(session_token);
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Logout failed' });
    }
});

// Get user info
app.get('/api/user/:username', (req, res) => {
    try {
        const { username } = req.params;
        const { session_token } = req.headers;

        // Verify session
        const session = db.prepare('SELECT user_id FROM sessions WHERE session_token = ? AND expires_at > datetime(\'now\')').get(session_token);
        
        if (!session) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = db.prepare('SELECT username, license_code, created_at, last_login FROM users WHERE username = ?').get(username);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(user);

    } catch (error) {
        console.error('User fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ License backend running on port ${PORT}`);
    console.log(`Database: ${dbPath}`);
});
