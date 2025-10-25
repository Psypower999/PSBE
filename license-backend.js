/**
 * Psychological Studio - License Backend Server
 * Handles license validation, user authentication, and hardware binding
 * Optimized for Render.com deployment
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors({
    origin: '*', // Allow all origins (you can restrict this to your domain)
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-admin-key']
}));
app.use(express.json());

// Database file paths - Use persistent disk on Render, fallback to local
let DATA_DIR = process.env.NODE_ENV === 'production' 
    ? '/app/data' 
    : __dirname;

// Function to determine writable data directory
async function getWritableDataDir() {
    const dirs = ['/app/data', '/tmp/psystudio-data', __dirname];
    
    for (const dir of dirs) {
        try {
            await fs.mkdir(dir, { recursive: true });
            const testFile = path.join(dir, '.test-write');
            await fs.writeFile(testFile, 'test');
            await fs.unlink(testFile);
            console.log('[Database] Using writable directory:', dir);
            return dir;
        } catch (e) {
            console.log('[Database] Directory not writable:', dir, e.message);
        }
    }
    
    throw new Error('No writable directory found');
}

let DB_PATH;
let USERS_PATH;

// Valid license codes (manage these in your admin panel)
const VALID_LICENSE_CODES = [
    'PSYSTUDIO-2024-FULL',
    'PSYSTUDIO-2024-PRO',
    'PSYSTUDIO-2024-TRIAL'
];

// Initialize database files
async function initDatabase() {
    try {
        console.log('[Database] Starting initialization...');
        
        // Find writable directory
        DATA_DIR = await getWritableDataDir();
        DB_PATH = path.join(DATA_DIR, 'license-database.json');
        USERS_PATH = path.join(DATA_DIR, 'users-database.json');
        
        console.log('[Database] DATA_DIR:', DATA_DIR);
        console.log('[Database] DB_PATH:', DB_PATH);
        console.log('[Database] USERS_PATH:', USERS_PATH);

        // Initialize license database
        try {
            await fs.access(DB_PATH);
            console.log('[Database] license-database.json exists');
        } catch {
            await fs.writeFile(DB_PATH, JSON.stringify({ licenses: {} }, null, 2));
            console.log('[Database] Created license-database.json');
        }
        
        // Initialize users database
        try {
            await fs.access(USERS_PATH);
            console.log('[Database] users-database.json exists');
        } catch {
            await fs.writeFile(USERS_PATH, JSON.stringify({ users: {} }, null, 2));
            console.log('[Database] Created users-database.json');
        }
        
        console.log('[Database] Initialization complete');
    } catch (error) {
        console.error('[Database] Initialization error:', error);
        throw error;
    }
}

// Load database
async function loadDatabase(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Failed to load database:', error);
        return null;
    }
}

// Save database
async function saveDatabase(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Failed to save database:', error);
        return false;
    }
}

// Hash password
function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

// Generate salt
function generateSalt() {
    return crypto.randomBytes(16).toString('hex');
}

// Verify password
function verifyPassword(password, salt, hash) {
    return hashPassword(password, salt) === hash;
}

/**
 * Endpoint: Validate and activate license
 * POST /api/activate-license
 * Body: { code, username, password, hardwareID }
 */
app.post('/api/activate-license', async (req, res) => {
    try {
        console.log('[Activate] Request received:', { 
            code: req.body.code, 
            username: req.body.username,
            hardwareID: req.body.hardwareID ? req.body.hardwareID.substring(0, 50) + '...' : 'missing'
        });
        
        const { code, username, password, hardwareID } = req.body;
        
        // Validate input
        if (!code || !username || !password || !hardwareID) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }
        
        // Validate license code
        if (!VALID_LICENSE_CODES.includes(code)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid license code' 
            });
        }
        
        // Load databases
        const licenseDB = await loadDatabase(DB_PATH);
        const usersDB = await loadDatabase(USERS_PATH);
        
        console.log('[Activate] Databases loaded:', { 
            licensesCount: licenseDB ? Object.keys(licenseDB.licenses || {}).length : 'ERROR',
            usersCount: usersDB ? Object.keys(usersDB.users || {}).length : 'ERROR'
        });
        
        if (!licenseDB || !usersDB) {
            console.error('[Activate] Database loading failed');
            return res.status(500).json({ 
                success: false, 
                error: 'Database error' 
            });
        }
        
        // Check if license code is already activated
        if (licenseDB.licenses[code]) {
            const existingLicense = licenseDB.licenses[code];
            
            // If already activated on different hardware, reject
            if (existingLicense.hardwareID !== hardwareID) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'License already activated on another device',
                    activatedBy: existingLicense.username,
                    activatedAt: existingLicense.activatedAt
                });
            }
            
            // If same hardware, check if username matches
            if (existingLicense.username !== username) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'License already activated with different username' 
                });
            }
            
            // Same hardware and username - allow (re-activation)
            return res.json({ 
                success: true, 
                message: 'License re-activated',
                licenseType: code.includes('TRIAL') ? 'trial' : 'full',
                user: {
                    username: existingLicense.username,
                    activatedAt: existingLicense.activatedAt
                }
            });
        }
        
        // Check if username already exists
        if (usersDB.users[username]) {
            return res.status(400).json({ 
                success: false, 
                error: 'Username already taken' 
            });
        }
        
        // Create new user
        const salt = generateSalt();
        const passwordHash = hashPassword(password, salt);
        
        usersDB.users[username] = {
            username: username,
            passwordHash: passwordHash,
            salt: salt,
            licenseCode: code,
            hardwareID: hardwareID,
            devices: [hardwareID],
            createdAt: new Date().toISOString(),
            lastLogin: new Date().toISOString()
        };
        
        // Activate license
        licenseDB.licenses[code] = {
            code: code,
            username: username,
            hardwareID: hardwareID,
            activatedAt: new Date().toISOString(),
            status: 'active'
        };
        
        // Save databases
        const saveResult1 = await saveDatabase(USERS_PATH, usersDB);
        const saveResult2 = await saveDatabase(DB_PATH, licenseDB);
        
        console.log('[Activate] Save results:', { users: saveResult1, licenses: saveResult2 });
        
        if (!saveResult1 || !saveResult2) {
            console.error('[Activate] Failed to save databases');
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to save activation data' 
            });
        }
        
        console.log(`[License] Activated: ${code} for user ${username}`);
        
        res.json({ 
            success: true, 
            message: 'License activated successfully',
            licenseType: code.includes('TRIAL') ? 'trial' : 'full',
            user: {
                username: username,
                activatedAt: licenseDB.licenses[code].activatedAt
            }
        });
        
    } catch (error) {
        console.error('[Activate] Activation error:', error);
        console.error('[Activate] Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: 'Server error during activation',
            details: error.message
        });
    }
});

/**
 * Endpoint: Login with username and password
 * POST /api/login
 * Body: { username, password, hardwareID }
 */
app.post('/api/login', async (req, res) => {
    try {
        const { username, password, hardwareID } = req.body;
        
        // Validate input
        if (!username || !password || !hardwareID) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }
        
        // Load users database
        const usersDB = await loadDatabase(USERS_PATH);
        
        if (!usersDB) {
            return res.status(500).json({ 
                success: false, 
                error: 'Database error' 
            });
        }
        
        // Check if user exists
        const user = usersDB.users[username];
        if (!user) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid username or password' 
            });
        }
        
        // Verify password
        if (!verifyPassword(password, user.salt, user.passwordHash)) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid username or password' 
            });
        }
        
        // Check hardware ID - allow up to 3 different devices
        if (!user.devices) {
            user.devices = [hardwareID];
        } else if (!user.devices.includes(hardwareID)) {
            if (user.devices.length >= 3) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Maximum device limit reached (3 devices)',
                    devices: user.devices.length
                });
            }
            user.devices.push(hardwareID);
        }
        
        // Update last login
        user.lastLogin = new Date().toISOString();
        await saveDatabase(USERS_PATH, usersDB);
        
        // Generate session token
        const sessionToken = crypto.randomBytes(32).toString('hex');
        
        console.log(`[Login] User ${username} logged in from device ${user.devices.length}`);
        
        res.json({ 
            success: true, 
            message: 'Login successful',
            token: sessionToken,
            user: {
                username: user.username,
                licenseCode: user.licenseCode,
                licenseType: user.licenseCode.includes('TRIAL') ? 'trial' : 'full',
                devicesUsed: user.devices.length
            }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Server error during login' 
        });
    }
});

/**
 * Endpoint: Verify existing session
 * POST /api/verify-session
 * Body: { username, token, hardwareID }
 */
app.post('/api/verify-session', async (req, res) => {
    try {
        const { username, token, hardwareID } = req.body;
        
        const usersDB = await loadDatabase(USERS_PATH);
        const user = usersDB.users[username];
        
        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid session' });
        }
        
        // Verify hardware is in allowed devices
        if (user.devices && !user.devices.includes(hardwareID)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Device not authorized' 
            });
        }
        
        res.json({ 
            success: true, 
            user: {
                username: user.username,
                licenseType: user.licenseCode.includes('TRIAL') ? 'trial' : 'full'
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

/**
 * Endpoint: Check if license code is valid and available
 * POST /api/check-license
 * Body: { code }
 */
app.post('/api/check-license', async (req, res) => {
    try {
        const { code } = req.body;
        
        if (!code) {
            return res.status(400).json({ 
                success: false, 
                error: 'License code required' 
            });
        }
        
        // Check if code is valid
        if (!VALID_LICENSE_CODES.includes(code)) {
            return res.json({ 
                success: true,
                valid: false, 
                available: false,
                error: 'Invalid license code' 
            });
        }
        
        // Check if already activated
        const licenseDB = await loadDatabase(DB_PATH);
        const isActivated = licenseDB.licenses[code] !== undefined;
        
        res.json({ 
            success: true,
            valid: true,
            available: !isActivated,
            activated: isActivated ? licenseDB.licenses[code].activatedAt : null
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

/**
 * Endpoint: Admin - List all activations (protected)
 * GET /api/admin/activations
 * Headers: { 'x-admin-key': 'your-secret-admin-key' }
 */
app.get('/api/admin/activations', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        
        // Simple admin key check (in production, use proper authentication)
        if (adminKey !== process.env.ADMIN_KEY && adminKey !== 'PSYSTUDIO-ADMIN-2024') {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        
        const licenseDB = await loadDatabase(DB_PATH);
        const usersDB = await loadDatabase(USERS_PATH);
        
        res.json({ 
            success: true,
            licenses: licenseDB.licenses,
            users: Object.values(usersDB.users).map(u => ({
                username: u.username,
                licenseCode: u.licenseCode,
                createdAt: u.createdAt,
                lastLogin: u.lastLogin,
                devices: u.devices ? u.devices.length : 1
            }))
        });
        
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Psychological Studio License Server',
        version: '1.0.0',
        status: 'running',
        endpoints: [
            'POST /api/activate-license',
            'POST /api/login',
            'POST /api/verify-session',
            'POST /api/check-license',
            'GET /api/admin/activations',
            'GET /health'
        ]
    });
});

// Start server
async function startServer() {
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log('===========================================');
        console.log('  Psychological Studio - License Server');
        console.log('===========================================');
        console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`  Server running on port ${PORT}`);
        console.log(`  Health check: http://localhost:${PORT}/health`);
        console.log('===========================================');
    });
}

startServer();

module.exports = app;
