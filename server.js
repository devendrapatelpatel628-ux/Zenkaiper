const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');

// Baileys imports
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

// Proxy agents
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;

// ==================== DATA STORES ====================
let accounts = {};          // { id: { sock, phone, status, warmup, proxy, ... } }
let proxies = [];           // [{ id, raw, status, type, host, port, auth }]
let logs = [];              // Activity logs
let config = {              // Admin config
    typingDelay: 3,
    onlineDuration: 30,
    offlineDuration: 10,
    msgLimit: 200,
    warmupDays: 7,
    blockMinDelay: 3,
    blockMaxDelay: 10,
    blockCycles: 50,
    accountCooldown: 2,
    proxyRotation: 6,
    presenceEnabled: true
};

let blockOperations = {};   // Active block operations

// Logger
const logger = pino({ level: 'silent' });

// ==================== HELPER FUNCTIONS ====================

function addLog(type, message) {
    const entry = {
        time: new Date().toLocaleTimeString('en-US', { hour12: false }),
        date: new Date().toLocaleDateString(),
        timestamp: Date.now(),
        type,
        message
    };
    logs.unshift(entry);
    if (logs.length > 1000) logs = logs.slice(0, 1000);
    return entry;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

function parseProxy(raw) {
    raw = raw.trim();
    if (!raw) return null;
    
    let type = 'http';
    let host, port, username, password;
    
    // Check for protocol prefix
    if (raw.startsWith('socks5://') || raw.startsWith('socks4://')) {
        type = 'socks5';
        raw = raw.replace(/^socks[45]:\/\//, '');
    } else if (raw.startsWith('http://')) {
        type = 'http';
        raw = raw.replace(/^http:\/\//, '');
    } else if (raw.startsWith('https://')) {
        type = 'https';
        raw = raw.replace(/^https:\/\//, '');
    }
    
    // user:pass@host:port OR host:port:user:pass OR host:port
    if (raw.includes('@')) {
        const [auth, hostPort] = raw.split('@');
        [username, password] = auth.split(':');
        [host, port] = hostPort.split(':');
    } else {
        const parts = raw.split(':');
        if (parts.length === 4) {
            [host, port, username, password] = parts;
        } else if (parts.length === 2) {
            [host, port] = parts;
        } else {
            return null;
        }
    }
    
    return { type, host, port: parseInt(port), username, password };
}

function createProxyAgent(proxyData) {
    if (!proxyData) return null;
    
    const { type, host, port, username, password } = proxyData;
    let url;
    
    if (username && password) {
        url = `${type}://${username}:${password}@${host}:${port}`;
    } else {
        url = `${type}://${host}:${port}`;
    }
    
    if (type === 'socks5' || type === 'socks4') {
        return new SocksProxyAgent(url);
    } else if (type === 'https') {
        return new HttpsProxyAgent(url);
    } else {
        return new HttpProxyAgent(url);
    }
}

function formatJid(phone) {
    // Remove any non-numeric characters
    phone = phone.replace(/[^0-9]/g, '');
    return `${phone}@s.whatsapp.net`;
}

// ==================== ACCOUNT MANAGEMENT ====================

// Connect with a specific proxy — returns result
async function attemptConnection(id, phone, proxyRaw) {
    const authFolder = path.join(__dirname, 'auth_sessions', id);
    
    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    // Parse and create proxy agent if provided
    let agent = null;
    let fetchAgent = null;
    if (proxyRaw) {
        const proxyData = parseProxy(proxyRaw);
        if (proxyData) {
            try {
                agent = createProxyAgent(proxyData);
                fetchAgent = createProxyAgent(proxyData);
            } catch (err) {
                addLog('danger', `Proxy agent creation failed for ${proxyRaw}: ${err.message}`);
                return { success: false, error: 'proxy_failed' };
            }
        } else {
            addLog('danger', `Failed to parse proxy: ${proxyRaw}`);
            return { success: false, error: 'proxy_parse_failed' };
        }
    }
    
    return new Promise(async (resolve) => {
        let resolved = false;
        let sock;
        
        // Timeout — if no connection in 30 seconds, proxy is dead
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                addLog('danger', `Connection timeout with proxy: ${proxyRaw || 'No proxy'}`);
                try { sock.end(); } catch (e) {}
                resolve({ success: false, error: 'timeout' });
            }
        }, 30000);
        
        try {
            sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
                browser: Browsers.ubuntu('Chrome'),
                logger,
                agent,
                fetchAgent,
                connectTimeoutMs: 25000,
                defaultQueryTimeoutMs: 25000,
                keepAliveIntervalMs: 30000,
                emitOwnEvents: true,
                markOnlineOnConnect: true
            });
            
            // Connection events
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection === 'close' && !resolved) {
                    clearTimeout(timeout);
                    resolved = true;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    addLog('warn', `Connection closed during pairing (code: ${statusCode}) with proxy: ${proxyRaw || 'No proxy'}`);
                    resolve({ success: false, error: 'connection_closed' });
                } else if (connection === 'open' && accounts[id]) {
                    accounts[id].status = 'online';
                    accounts[id].lastActive = new Date().toISOString();
                    addLog('info', `Account ${phone} connected successfully!`);
                }
            });
            
            sock.ev.on('creds.update', saveCreds);
            
            // Request pairing code if not registered
            if (!sock.authState.creds.registered) {
                try {
                    // Wait a moment for socket to stabilize
                    await sleep(2000);
                    
                    if (resolved) return;
                    
                    const code = await sock.requestPairingCode(phone);
                    clearTimeout(timeout);
                    
                    if (!resolved) {
                        resolved = true;
                        
                        // Store account with this working connection
                        accounts[id] = {
                            id,
                            phone,
                            sock,
                            status: 'connecting',
                            warmupDay: 1,
                            warmupStarted: Date.now(),
                            proxy: proxyRaw,
                            messagestoday: 0,
                            lastActive: new Date().toISOString(),
                            pairingCode: code
                        };
                        
                        // Set up reconnection handler for after pairing
                        sock.ev.on('connection.update', async (update) => {
                            const { connection, lastDisconnect } = update;
                            if (connection === 'close' && accounts[id]) {
                                const statusCode = lastDisconnect?.error?.output?.statusCode;
                                accounts[id].status = 'offline';
                                addLog('warn', `Account ${phone} disconnected: ${statusCode}`);
                                
                                if (statusCode !== DisconnectReason.loggedOut) {
                                    setTimeout(() => {
                                        if (accounts[id]) {
                                            addLog('info', `Reconnecting ${phone}...`);
                                            reconnectAccount(id, phone, proxyRaw);
                                        }
                                    }, 5000);
                                } else {
                                    addLog('danger', `Account ${phone} logged out / banned.`);
                                    accounts[id].status = 'banned';
                                }
                            } else if (connection === 'open' && accounts[id]) {
                                accounts[id].status = 'online';
                                accounts[id].lastActive = new Date().toISOString();
                            }
                        });
                        
                        addLog('info', `Pairing code for ${phone}: ${code}`);
                        resolve({ success: true, pairingCode: code, sock });
                    }
                } catch (err) {
                    clearTimeout(timeout);
                    if (!resolved) {
                        resolved = true;
                        try { sock.end(); } catch (e) {}
                        addLog('danger', `Pairing code request failed with proxy ${proxyRaw || 'No proxy'}: ${err.message}`);
                        resolve({ success: false, error: err.message });
                    }
                }
            } else {
                // Already registered
                clearTimeout(timeout);
                if (!resolved) {
                    resolved = true;
                    accounts[id] = {
                        id, phone, sock,
                        status: 'online',
                        warmupDay: 1,
                        warmupStarted: Date.now(),
                        proxy: proxyRaw,
                        messagestoday: 0,
                        lastActive: new Date().toISOString(),
                        pairingCode: null
                    };
                    addLog('info', `Account ${phone} already registered, reconnected.`);
                    resolve({ success: true, pairingCode: null });
                }
            }
        } catch (err) {
            clearTimeout(timeout);
            if (!resolved) {
                resolved = true;
                addLog('danger', `Socket creation failed with proxy ${proxyRaw || 'No proxy'}: ${err.message}`);
                resolve({ success: false, error: err.message });
            }
        }
    });
}

// Reconnect existing account
async function reconnectAccount(id, phone, proxyRaw) {
    const authFolder = path.join(__dirname, 'auth_sessions', id);
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    let agent = null;
    let fetchAgent = null;
    if (proxyRaw) {
        const proxyData = parseProxy(proxyRaw);
        if (proxyData) {
            agent = createProxyAgent(proxyData);
            fetchAgent = createProxyAgent(proxyData);
        }
    }
    
    const sock = makeWASocket({
        version, auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        logger, agent, fetchAgent,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
    });
    
    if (accounts[id]) {
        accounts[id].sock = sock;
    }
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && accounts[id]) {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            accounts[id].status = 'offline';
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => {
                    if (accounts[id]) reconnectAccount(id, phone, proxyRaw);
                }, 5000);
            } else {
                accounts[id].status = 'banned';
            }
        } else if (connection === 'open' && accounts[id]) {
            accounts[id].status = 'online';
            accounts[id].lastActive = new Date().toISOString();
            addLog('info', `Account ${phone} reconnected!`);
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

// Main connect function — tries proxies until pairing code is generated
async function connectAccount(id, phone) {
    addLog('info', `Starting connection for ${phone} — trying proxies...`);
    
    // Get all alive proxies
    let aliveProxies = proxies.filter(p => p.status === 'alive');
    
    // If no proxies loaded, try without proxy
    if (aliveProxies.length === 0) {
        addLog('warn', `No proxies available, connecting ${phone} without proxy...`);
        const result = await attemptConnection(id, phone, null);
        return result;
    }
    
    // Try each alive proxy until pairing code is generated
    let attempt = 0;
    
    while (aliveProxies.length > 0) {
        const proxy = aliveProxies[0]; // Take first alive proxy
        attempt++;
        
        addLog('info', `[Attempt ${attempt}] Trying proxy: ${proxy.raw.substring(0, 40)}... for ${phone}`);
        
        const result = await attemptConnection(id, phone, proxy.raw);
        
        if (result.success) {
            addLog('info', `SUCCESS! ${phone} paired using proxy: ${proxy.raw.substring(0, 40)}...`);
            return result;
        }
        
        // Failed — mark proxy as dead and delete it
        addLog('danger', `Proxy FAILED: ${proxy.raw.substring(0, 40)}... — Deleting...`);
        
        // Mark dead in proxies array
        const proxyIndex = proxies.findIndex(p => p.id === proxy.id);
        if (proxyIndex !== -1) {
            proxies.splice(proxyIndex, 1); // DELETE the failed proxy
        }
        
        // Remove from alive list
        aliveProxies.shift();
        
        // Clean up auth folder for retry (fresh session needed per attempt)
        const authFolder = path.join(__dirname, 'auth_sessions', id);
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true });
        }
        
        addLog('info', `Remaining alive proxies: ${aliveProxies.length}`);
        
        // Small delay before next attempt
        await sleep(2000);
    }
    
    // All proxies exhausted — try without proxy as last resort
    addLog('warn', `All proxies exhausted! Trying ${phone} without proxy as last resort...`);
    const lastResort = await attemptConnection(id, phone, null);
    
    if (!lastResort.success) {
        addLog('danger', `FAILED to pair ${phone} — all proxies dead and direct connection failed`);
    }
    
    return lastResort;
}

async function disconnectAccount(id) {
    if (accounts[id] && accounts[id].sock) {
        try {
            await accounts[id].sock.logout();
        } catch (e) {}
        try { accounts[id].sock.end(); } catch (e) {}
        delete accounts[id];
        addLog('warn', `Account ${id} disconnected and removed`);
        return true;
    }
    return false;
}

// ==================== BLOCK ENGINE ====================

async function executeBlockCycle(operationId, targetPhone, accountIds) {
    const operation = blockOperations[operationId];
    if (!operation) return;
    
    const jid = formatJid(targetPhone);
    const totalCycles = config.blockCycles;
    
    addLog('danger', `Block operation started on ${targetPhone} | ${accountIds.length} accounts | ${totalCycles} cycles`);
    
    for (let cycle = 0; cycle < totalCycles; cycle++) {
        if (!blockOperations[operationId] || blockOperations[operationId].aborted) {
            addLog('warn', `Block operation aborted at cycle ${cycle}`);
            break;
        }
        
        operation.currentCycle = cycle + 1;
        operation.action = 'blocking';
        
        // Block on all accounts
        for (const accId of accountIds) {
            if (!accounts[accId] || accounts[accId].status !== 'online') continue;
            
            try {
                await accounts[accId].sock.updateBlockStatus(jid, 'block');
                operation.logs.push({
                    time: new Date().toLocaleTimeString(),
                    message: `BLOCKED on ${accounts[accId].phone}`,
                    type: 'success'
                });
                addLog('block', `Blocked ${targetPhone} on ${accounts[accId].phone} (Cycle ${cycle + 1})`);
            } catch (err) {
                operation.logs.push({
                    time: new Date().toLocaleTimeString(),
                    message: `FAILED to block on ${accounts[accId].phone}: ${err.message}`,
                    type: 'error'
                });
            }
            
            // Cooldown between accounts
            await sleep(config.accountCooldown * 1000);
        }
        
        // Random delay before unblock
        const delay1 = getRandomDelay(config.blockMinDelay, config.blockMaxDelay);
        await sleep(delay1);
        
        if (!blockOperations[operationId] || blockOperations[operationId].aborted) break;
        
        operation.action = 'unblocking';
        
        // Unblock on all accounts
        for (const accId of accountIds) {
            if (!accounts[accId] || accounts[accId].status !== 'online') continue;
            
            try {
                await accounts[accId].sock.updateBlockStatus(jid, 'unblock');
                operation.logs.push({
                    time: new Date().toLocaleTimeString(),
                    message: `UNBLOCKED on ${accounts[accId].phone}`,
                    type: 'success'
                });
                addLog('block', `Unblocked ${targetPhone} on ${accounts[accId].phone} (Cycle ${cycle + 1})`);
            } catch (err) {
                operation.logs.push({
                    time: new Date().toLocaleTimeString(),
                    message: `FAILED to unblock on ${accounts[accId].phone}: ${err.message}`,
                    type: 'error'
                });
            }
            
            await sleep(config.accountCooldown * 1000);
        }
        
        operation.blocksCompleted = (cycle + 1) * 2 * accountIds.length;
        
        // Random delay before next cycle
        const delay2 = getRandomDelay(config.blockMinDelay, config.blockMaxDelay);
        await sleep(delay2);
    }
    
    operation.status = 'complete';
    operation.action = 'complete';
    addLog('info', `Block operation completed on ${targetPhone}. Total cycles: ${operation.currentCycle}`);
}

// ==================== HUMAN BEHAVIOR ENGINE ====================

async function simulateHumanPresence(accId) {
    if (!config.presenceEnabled) return;
    
    const account = accounts[accId];
    if (!account || account.status !== 'online') return;
    
    try {
        // Go online
        await account.sock.sendPresenceUpdate('available');
        
        // Schedule going offline
        setTimeout(async () => {
            if (accounts[accId] && accounts[accId].status === 'online') {
                await accounts[accId].sock.sendPresenceUpdate('unavailable');
                
                // Schedule coming back online
                setTimeout(() => {
                    simulateHumanPresence(accId);
                }, config.offlineDuration * 60 * 1000);
            }
        }, config.onlineDuration * 60 * 1000);
    } catch (e) {}
}

// Warm-up tracker
setInterval(() => {
    const now = Date.now();
    Object.values(accounts).forEach(acc => {
        const daysPassed = Math.floor((now - acc.warmupStarted) / (24 * 60 * 60 * 1000));
        acc.warmupDay = Math.min(daysPassed + 1, config.warmupDays);
    });
}, 60000);

// ==================== API ENDPOINTS ====================

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Get all accounts
app.get('/api/accounts', (req, res) => {
    const accountList = Object.values(accounts).map(acc => ({
        id: acc.id,
        phone: acc.phone,
        status: acc.status,
        warmupDay: acc.warmupDay,
        proxy: acc.proxy ? acc.proxy.substring(0, 30) + '...' : 'None',
        messagestoday: acc.messagestoday,
        lastActive: acc.lastActive,
        pairingCode: acc.pairingCode
    }));
    res.json(accountList);
});

// Add new account
app.post('/api/accounts', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    
    const id = uuidv4();
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    
    addLog('info', `Adding account ${cleanPhone} — will try all proxies until paired...`);
    
    // connectAccount now handles proxy rotation internally
    const result = await connectAccount(id, cleanPhone);
    
    if (result.success) {
        res.json({
            success: true,
            id,
            phone: cleanPhone,
            pairingCode: result.pairingCode,
            proxyUsed: accounts[id] ? accounts[id].proxy : null
        });
    } else {
        // Clean up failed auth folder
        const authFolder = path.join(__dirname, 'auth_sessions', id);
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true });
        }
        res.status(500).json({ success: false, error: result.error });
    }
});

// Toggle account status
app.post('/api/accounts/:id/toggle', (req, res) => {
    const { id } = req.params;
    if (!accounts[id]) return res.status(404).json({ error: 'Account not found' });
    
    const acc = accounts[id];
    if (acc.status === 'online') {
        acc.status = 'paused';
        addLog('warn', `Account ${acc.phone} paused`);
    } else if (acc.status === 'paused') {
        acc.status = 'online';
        addLog('info', `Account ${acc.phone} resumed`);
    }
    
    res.json({ success: true, status: acc.status });
});

// Remove account
app.delete('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    const phone = accounts[id]?.phone;
    const result = await disconnectAccount(id);
    
    if (result) {
        // Remove auth folder
        const authFolder = path.join(__dirname, 'auth_sessions', id);
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true });
        }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Account not found' });
    }
});

// ==================== PROXY ENDPOINTS ====================

app.get('/api/proxies', (req, res) => {
    res.json(proxies);
});

app.post('/api/proxies', (req, res) => {
    const { proxyList } = req.body;
    if (!proxyList) return res.status(400).json({ error: 'Proxy list required' });
    
    const lines = proxyList.split('\n').filter(l => l.trim());
    
    let loadedCount = 0;
    let skippedCount = 0;
    
    const allParsed = lines.map((raw, i) => {
        const parsed = parseProxy(raw);
        if (parsed) {
            loadedCount++;
            return {
                id: i,
                raw: raw.trim(),
                status: 'alive',
                ...parsed
            };
        } else {
            skippedCount++;
            addLog('warn', `Skipped unparseable proxy: ${raw.trim().substring(0, 40)}...`);
            return null;
        }
    }).filter(p => p !== null); // Remove dead/unparseable proxies immediately
    
    proxies = allParsed;
    
    addLog('info', `Loaded ${loadedCount} valid proxies | Skipped ${skippedCount} dead/invalid proxies`);
    res.json({ success: true, count: loadedCount, skipped: skippedCount });
});

// ==================== BLOCK ENGINE ENDPOINTS ====================

app.post('/api/block/start', async (req, res) => {
    const { target } = req.body;
    if (!target) return res.status(400).json({ error: 'Target number required' });
    
    const onlineAccounts = Object.values(accounts).filter(a => a.status === 'online');
    if (onlineAccounts.length === 0) {
        return res.status(400).json({ error: 'No online accounts available' });
    }
    
    const operationId = uuidv4();
    const accountIds = onlineAccounts.map(a => a.id);
    
    blockOperations[operationId] = {
        id: operationId,
        target,
        status: 'running',
        action: 'starting',
        currentCycle: 0,
        totalCycles: config.blockCycles,
        blocksCompleted: 0,
        accountCount: accountIds.length,
        logs: [],
        aborted: false,
        startedAt: Date.now()
    };
    
    // Start async operation
    executeBlockCycle(operationId, target, accountIds);
    
    res.json({ success: true, operationId });
});

app.get('/api/block/:id/status', (req, res) => {
    const { id } = req.params;
    const op = blockOperations[id];
    
    if (!op) return res.status(404).json({ error: 'Operation not found' });
    
    res.json({
        id: op.id,
        target: op.target,
        status: op.status,
        action: op.action,
        currentCycle: op.currentCycle,
        totalCycles: op.totalCycles,
        blocksCompleted: op.blocksCompleted,
        accountCount: op.accountCount,
        logs: op.logs.slice(-50),
        progress: Math.round((op.currentCycle / op.totalCycles) * 100)
    });
});

app.post('/api/block/:id/abort', (req, res) => {
    const { id } = req.params;
    if (blockOperations[id]) {
        blockOperations[id].aborted = true;
        blockOperations[id].status = 'aborted';
        addLog('warn', `Block operation ${id} aborted by admin`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Operation not found' });
    }
});

// ==================== ADMIN CONFIG ENDPOINTS ====================

app.get('/api/config', (req, res) => {
    res.json(config);
});

app.post('/api/config', (req, res) => {
    const newConfig = req.body;
    config = { ...config, ...newConfig };
    addLog('info', 'Admin configuration updated');
    res.json({ success: true, config });
});

// ==================== LOGS ENDPOINTS ====================

app.get('/api/logs', (req, res) => {
    const { type, limit = 100 } = req.query;
    let filtered = logs;
    
    if (type && type !== 'all') {
        filtered = logs.filter(l => l.type === type);
    }
    
    res.json(filtered.slice(0, parseInt(limit)));
});

app.delete('/api/logs', (req, res) => {
    logs = [];
    addLog('info', 'Logs cleared by admin');
    res.json({ success: true });
});

// ==================== STATS ENDPOINT ====================

app.get('/api/stats', (req, res) => {
    const accountList = Object.values(accounts);
    res.json({
        totalAccounts: accountList.length,
        onlineAccounts: accountList.filter(a => a.status === 'online').length,
        offlineAccounts: accountList.filter(a => a.status === 'offline' || a.status === 'banned').length,
        warmingUp: accountList.filter(a => a.warmupDay < config.warmupDays).length,
        totalProxies: proxies.length,
        aliveProxies: proxies.filter(p => p.status === 'alive').length,
        deadProxies: proxies.filter(p => p.status === 'dead').length,
        activeBlockOps: Object.values(blockOperations).filter(o => o.status === 'running').length
    });
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║                                               ║
║      ☠️  PHANTOM CTRL v3.0.7  ☠️              ║
║                                               ║
║      Server running on port ${PORT}              ║
║      http://localhost:${PORT}                    ║
║                                               ║
╚═══════════════════════════════════════════════╝
    `);
    addLog('info', 'PHANTOM CTRL server started');
    addLog('info', 'Human behavior engine: ACTIVE');
    addLog('info', 'Block engine: STANDBY');
});
