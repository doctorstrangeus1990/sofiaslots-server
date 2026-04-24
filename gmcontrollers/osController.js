// controllers/OrionStarsController.js - RAILWAY FIXED VERSION
// PART 1 OF 3 - Lines 1-700
const Puppeteer = require('puppeteer');
const Captcha = require('../lib/captcha.js');
const { writeFileSync, readFileSync, existsSync } = require('fs');
const Tasks = require('../lib/tasks.js');
const Logger = require('../utils/logger.js');
const GameAccount = require('../models/GameAccount.js');
const Game = require('../models/Game.js');
const path = require('path');

class OrionStarsController {
    constructor() {
        this.browser = null;
        this.page = null;
        this.cookies = null;
        this.authorized = false;
        this.logger = Logger('OrionStars');
        this.gameType = 'os';
        this.initialized = false;
        this.agentCredentials = null;

        this.keepAlive = true;
        this.lastActivity = Date.now();
        this.activityTimeout = 5 * 60 * 1000;

        this.cache = {
            adminBalance: null,
            adminBalanceTimestamp: null,
            cacheDuration: 30 * 1000
        };

        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.maxConcurrentRequests = 1;

        this.isInitializing = false;
        this.initializationPromise = null;
        this.browserReady = false;

        this.isAuthorizing = false;
        this.authorizationPromise = null;
        this.authorizationInProgress = false;

        this.authRetryCount = 0;
        this.maxAuthRetries = 3;
        this.lastAuthAttempt = null;
        this.authResetInterval = 5 * 60 * 1000;

        this.sessionTimeout = null;
        this.lastSuccessfulOperation = Date.now();
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 3;
        this.consecutiveMonitorFailures = 0;
        this.maxMonitorFailures = 5;

        this.loadAgentCredentials().catch(err => {
            this.error(`Failed to load credentials on startup: ${err.message}`);
        });

        this.startSessionMonitor();

        process.on('unhandledRejection', e => { this.logger.error(e); });
        process.on('uncaughtException',  e => { this.logger.error(e); });
    }

    log(log)   { this.logger.log(`${log}`) }
    error(log) { this.logger.error(`${log}`) }

    resetAuthRetryIfNeeded() {
        if (this.lastAuthAttempt &&
            Date.now() - this.lastAuthAttempt > this.authResetInterval) {
            this.log('Resetting auth retry counter after timeout');
            this.authRetryCount = 0;
        }
    }

    startSessionMonitor() {
        setInterval(async () => {
            if (!this.initialized || !this.page || !this.browser) return;
            const timeSinceLastActivity = Date.now() - this.lastSuccessfulOperation;
            if (timeSinceLastActivity > this.activityTimeout) {
                if (this.consecutiveMonitorFailures >= this.maxMonitorFailures) {
                    this.error(`Session monitor disabled after ${this.maxMonitorFailures} consecutive failures.`);
                    return;
                }
                this.log('Session timeout detected, reinitializing...');
                try {
                    await this.reinitialize();
                    this.consecutiveMonitorFailures = 0;
                } catch (error) {
                    this.consecutiveMonitorFailures++;
                    this.error(`Reinitialize failed (${this.consecutiveMonitorFailures}/${this.maxMonitorFailures}): ${error.message}`);
                }
            }
        }, 60000);
    }

    async reinitialize() {
        this.log('Reinitializing browser session...');
        this.initialized = false;
        this.browserReady = false;
        this.authorized = false;
        this.cache.adminBalance = null;
        this.cache.adminBalanceTimestamp = null;
        this.authRetryCount = 0;
        try {
            await this.initialize();
            this.consecutiveMonitorFailures = 0;
        } catch (error) {
            this.error(`Reinitialization failed: ${error.message}`);
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════
    // QUEUE SYSTEM
    // ═══════════════════════════════════════════════════════

    async queueOperation(operationName, operationFunction) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                name: operationName,
                function: operationFunction,
                resolve,
                reject,
                timestamp: Date.now()
            });
            this.log(`📥 Queued: "${operationName}" | Queue length: ${this.requestQueue.length}`);

            if (!this.isProcessingQueue && this.initialized && this.browserReady) {
                this.processQueue();
            } else if (!this.initialized || !this.browserReady) {
                this.log('Browser not ready, will process queue after initialization');
                this.initialize().then(() => {
                    if (!this.isProcessingQueue) this.processQueue();
                }).catch(err => {
                    this.error(`Failed to initialize for queued operation: ${err.message}`);
                    while (this.requestQueue.length > 0) {
                        const task = this.requestQueue.shift();
                        task.reject(new Error('Browser initialization failed'));
                    }
                });
            }
        });
    }

    async processQueue() {
        if (this.isProcessingQueue) {
            this.log('Queue processor already running');
            return;
        }
        this.isProcessingQueue = true;
        this.log('🚀 Queue processor started');

        while (this.requestQueue.length > 0) {
            const task = this.requestQueue.shift();
            const queueWaitTime = Date.now() - task.timestamp;
            this.log(`▶️  Processing: "${task.name}" (waited ${queueWaitTime}ms) | Remaining: ${this.requestQueue.length}`);
            try {
                if (!this.initialized || !this.browserReady || !await this.isBrowserValid()) {
                    throw new Error('Browser not ready. Please try again.');
                }
                const startTime = Date.now();
                const result = await task.function();
                const executionTime = Date.now() - startTime;
                this.log(`✅ Completed: "${task.name}" in ${executionTime}ms`);
                this.lastSuccessfulOperation = Date.now();
                this.consecutiveErrors = 0;
                task.resolve(result);
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                this.error(`❌ Failed: "${task.name}" - ${error.message}`);
                this.consecutiveErrors++;
                task.reject(error);
            }
        }

        this.isProcessingQueue = false;
        this.log('🏁 Queue processor stopped');
    }

    // ═══════════════════════════════════════════════════════
    // BROWSER STATE VALIDATION
    // ═══════════════════════════════════════════════════════

    async ensureBrowserReady() {
        if (!this.browser || !this.page) {
            throw new Error('Browser not initialized. Please refresh and try again.');
        }
        try {
            if (this.page.isClosed()) throw new Error('Browser page closed. Please refresh and try again.');
        } catch (error) {
            throw new Error('Browser not accessible. Please refresh and try again.');
        }
        try {
            const version = await this.browser.version();
            if (!version) throw new Error('Browser not responding. Please refresh and try again.');
        } catch (error) {
            throw new Error('Browser disconnected. Please refresh and try again.');
        }
        if (!this.authorized) throw new Error('Not authorized. Please login again.');
    }

    async isBrowserValid() {
        if (!this.browser || !this.page) return false;
        try {
            if (this.page.isClosed()) return false;
            await this.browser.version();
            return true;
        } catch (error) {
            return false;
        }
    }

    async isIframeAccessible(selector = '#frm_main_content') {
        try {
            return await this.page.evaluate((sel) => {
                try {
                    const iframe = document.querySelector(sel);
                    if (!iframe) return false;
                    const doc = iframe.contentWindow.document;
                    return doc && doc.readyState === 'complete';
                } catch (e) { return false; }
            }, selector);
        } catch (error) {
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════
    // CORE METHODS
    // ═══════════════════════════════════════════════════════

    async loadAgentCredentials() {
        try {
            const game = await Game.findOne({
                shortcode: 'OS',
                status: { $in: ['active', 'maintenance'] }
            });
            if (!game) throw new Error('OrionStars game not found in database');
            if (!game.agentUsername || !game.agentPassword) throw new Error('Agent credentials not configured for OrionStars');
            this.agentCredentials = { username: game.agentUsername, password: game.agentPassword };
            this.log(`Loaded agent credentials for user: ${game.agentUsername}`);
            return true;
        } catch (error) {
            this.error(`Failed to load agent credentials: ${error.message}`);
            return false;
        }
    }

    async initialize() {
        if (this.initialized && this.browserReady && await this.isBrowserValid()) {
            this.lastActivity = Date.now();
            return;
        }
        if (this.isInitializing) {
            this.log('Initialization already in progress, waiting...');
            if (this.initializationPromise) {
                await this.initializationPromise;
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (this.initialized && this.browserReady) return;
            throw new Error('Initialization timeout. Please try again.');
        }

        // ⭐ Wait for Railway container to be fully ready
        const uptime = process.uptime();
        if (uptime < 8) {
            this.log(`Cold start detected (uptime: ${uptime.toFixed(1)}s), waiting...`);
            await new Promise(resolve => setTimeout(resolve, (8 - uptime) * 1000));
        }

        this.isInitializing = true;
        this.browserReady = false;

        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                this.log(`Browser init attempt ${attempt}/3...`);
                if (!this.agentCredentials) {
                    const loaded = await this.loadAgentCredentials();
                    if (!loaded) throw new Error('Cannot initialize without agent credentials');
                }
                this.initializationPromise = this.createBrowser();
                await this.initializationPromise;
                this.initialized = true;
                this.browserReady = true;
                this.lastSuccessfulOperation = Date.now();
                this.log(`✅ Browser ready on attempt ${attempt}`);
                this.isInitializing = false;
                this.initializationPromise = null;
                return;
            } catch (error) {
                lastError = error;
                this.error(`Attempt ${attempt} failed: ${error.message}`);
                this.initialized = false;
                this.browserReady = false;
                if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
            }
        }

        this.isInitializing = false;
        this.initializationPromise = null;
        throw lastError;
    }

    async createBrowser() {
        this.log('Initializing browser for OrionStars...');

        if (this.browser) {
            try {
                this.browser.removeAllListeners('disconnected');
                if (this.page) {
                    this.page.removeAllListeners('error');
                    this.page.removeAllListeners('request');
                    this.page.removeAllListeners('close');
                }
                await this.browser.close();
            } catch (e) {
                this.log(`Error closing existing browser: ${e.message}`);
            }
            this.browser = null;
            this.page = null;
        }

        this.browser = await Puppeteer.launch({
            headless: 'new',
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-web-security",
                "--disable-features=VizDisplayCompositor",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-background-networking",
                "--disable-breakpad",
                "--disable-component-extensions-with-background-pages",
                "--disable-extensions",
                "--disable-features=TranslateUI",
                "--disable-ipc-flooding-protection",
                "--disable-hang-monitor",
                "--disable-prompt-on-repost",
                "--disable-sync",
                "--force-color-profile=srgb",
                "--metrics-recording-only",
                "--enable-automation",
                "--password-store=basic",
                "--use-mock-keychain",
                "--disable-blink-features=AutomationControlled",
                "--enable-features=NetworkService,NetworkServiceInProcess",
                "--force-webrtc-ip-handling-policy=default_public_interface_only"
            ],
            // pipe: true  ← REMOVED
            ignoreHTTPSErrors: true,
            defaultViewport: { width: 1312, height: 800 }
        });

        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();

        await this.page.setRequestInterception(true);

        this.page.on('request', (req) => {
            if (req.isInterceptResolutionHandled()) return;
            const resourceType = req.resourceType();
            const url = req.url();
            if (url.includes('/default.aspx') || url.includes('ImageCheck') ||
                url.includes('VerifyCode') || url.includes('captcha') || url.includes('.aspx')) {
                req.continue().catch(() => {});
                return;
            }
            if (['stylesheet', 'font', 'media'].includes(resourceType)) {
                req.abort().catch(() => {});
            } else {
                req.continue().catch(() => {});
            }
        });

        this.page.on('error', (error) => {
            this.error(`Page crashed: ${error.message}`);
            this.browserReady = false;
            this.initialized = false;
        });

        this.page.on('close', () => {
            this.log('Page closed unexpectedly');
            this.browserReady = false;
            this.initialized = false;
        });

        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        const cookiesPath = path.join(__dirname, 'cookiesos.json');
        if (existsSync(cookiesPath)) {
            try {
                const cookies = JSON.parse(readFileSync(cookiesPath).toString());
                await this.page.setCookie(...cookies);
                this.log('Cookies loaded successfully');
            } catch (error) {
                this.log('Error loading cookies, continuing without them');
            }
        }

        this.browser.once('disconnected', () => {
            this.log('Browser disconnected');
            this.browser = null;
            this.page = null;
            this.initialized = false;
            this.browserReady = false;
            this.authorized = false;
        });

        await this.checkAuthorization();
    }

    async checkAuthorization() {
        try {
            if (this.isAuthorizing) {
                this.log('Authorization already in progress, waiting...');
                if (this.authorizationPromise) await this.authorizationPromise;
                return;
            }
            if (!this.page || this.page.isClosed()) throw new Error('Page is closed, cannot check authorization');

            this.log('Checking authorization status...');

            await this.page.goto(`https://orionstars.vip:8781/Store.aspx`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000  // ⭐ was 15000
            });

            await new Promise(resolve => setTimeout(resolve, 3000)); // ⭐ was 1500

            const currentPath = await this.page.evaluate(() => location.pathname);
            this.log(`Landed on: ${currentPath}`);

            if (currentPath === '/default.aspx') {
                this.authorized = false;
                this.log('Redirected to login page - need to authorize');
                this.resetAuthRetryIfNeeded();
                if (this.authRetryCount >= this.maxAuthRetries) {
                    throw new Error(`Max authorization attempts (${this.maxAuthRetries}) reached.`);
                }
                this.authRetryCount++;
                this.lastAuthAttempt = Date.now();
                this.log(`Authorization attempt ${this.authRetryCount}/${this.maxAuthRetries}`);
                await this.authorize();
                this.authRetryCount = 0;
                return;
            }

            this.log('On Store.aspx, verifying iframe...');

            // ⭐ Step 1
            await this.page.waitForSelector('#frm_main_content', { timeout: 20000 });
            // ⭐ Step 2 — buffer
            await new Promise(resolve => setTimeout(resolve, 3000));
            // ⭐ Step 3 — readyState only
            await this.page.waitForFunction(() => {
                const iframe = document.querySelector('#frm_main_content');
                if (!iframe) return false;
                try {
                    const doc = iframe.contentWindow.document;
                    return doc && doc.readyState === 'complete';
                } catch (e) { return false; }
            }, { timeout: 30000 });
            // ⭐ Step 4 — #txtSearch non-fatal
            try {
                await this.page.waitForFunction(() => {
                    const iframe = document.querySelector('#frm_main_content');
                    if (!iframe) return false;
                    try { return iframe.contentWindow.document.querySelector('#txtSearch') !== null; }
                    catch (e) { return false; }
                }, { timeout: 15000 });
            } catch (e) {
                this.log('⚠️ #txtSearch not found in iframe but continuing (Railway slowness)');
            }

            this.log('✅ Already authorized - iframe ready');
            this.authorized = true;
            this.authRetryCount = 0;
            await new Promise(resolve => setTimeout(resolve, 1000));
            return true;

        } catch (error) {
            this.error(`Error checking authorization: ${error.message}`);
            this.authorized = false;
            throw error;
        }
    }

    async authorize() {
        if (this.authorizationInProgress) throw new Error('Authorization already in progress');
        this.resetAuthRetryIfNeeded();
        if (this.authRetryCount >= this.maxAuthRetries) {
            throw new Error(`Max authorization attempts (${this.maxAuthRetries}) reached.`);
        }

        this.authorizationInProgress = true;
        this.isAuthorizing = true;

        try {
            this.log('Starting authorization...');
            if (!this.page || this.page.isClosed()) throw new Error('Page is invalid, cannot authorize');

            await this.page.goto(`https://orionstars.vip:8781/default.aspx`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000  // ⭐ was 15000
            });

            await Promise.all([
                this.page.waitForSelector('#txtLoginName',  { timeout: 15000 }),
                this.page.waitForSelector('#txtLoginPass',  { timeout: 15000 }),
                this.page.waitForSelector('#txtVerifyCode', { timeout: 15000 }),
                this.page.waitForSelector('#ImageCheck',    { timeout: 15000 })
            ]);

            if (!this.agentCredentials) {
                const loaded = await this.loadAgentCredentials();
                if (!loaded) throw new Error('Cannot authorize without agent credentials');
            }

            this.log(`Using agent credentials: ${this.agentCredentials.username}`);

            await this.page.evaluate(() => {
                document.querySelector('#txtLoginName').value = '';
                document.querySelector('#txtLoginPass').value = '';
            });
            await this.page.type('#txtLoginName', this.agentCredentials.username);
            await this.page.type('#txtLoginPass', this.agentCredentials.password);

            await this.page.waitForFunction(() => {
                const img = document.querySelector('#ImageCheck');
                return img && img.complete && img.naturalHeight !== 0;
            }, { timeout: 15000 });

            await new Promise(resolve => setTimeout(resolve, 500));

            const base64Captcha = await this.page.evaluate(() => {
                const img = document.querySelector('#ImageCheck');
                if (!img || !img.complete || img.naturalHeight === 0) throw new Error('Captcha image not loaded');
                const canvas = document.createElement('canvas');
                canvas.width  = img.naturalWidth  || 132;
                canvas.height = img.naturalHeight || 40;
                canvas.getContext('2d').drawImage(img, 0, 0);
                return canvas.toDataURL("image/png").replace(/^data:image\/?[A-z]*;base64,/, "");
            });

            if (!base64Captcha || base64Captcha.length < 100) throw new Error('Failed to capture captcha image');

            const captchaValue = await Captcha(base64Captcha, 5);
            if (!captchaValue) throw new Error('Failed to solve captcha');
            this.log(`Captcha solved: ${captchaValue}`);

            await this.page.type('#txtVerifyCode', captchaValue);
            await this.page.click('#btnLogin');
            await new Promise(resolve => setTimeout(resolve, 3000)); // ⭐ was 2000

            const error_message = await this.page.evaluate(() => {
                const el = document.querySelector('#mb_con p');
                return el ? el.innerText : false;
            });
            if (error_message) throw new Error(`Login failed: ${error_message}`);

            const is_authorized = await this.page.evaluate(() => location.pathname === '/Store.aspx');

            if (is_authorized) {
                this.authorized = true;
                this.log('✅ Successfully authorized');
                this.authRetryCount = 0;
                await this.saveCookies();

                this.log('Waiting for Store.aspx iframe to be ready...');
                // ⭐ Step 1
                await this.page.waitForSelector('#frm_main_content', { timeout: 20000 });
                // ⭐ Step 2 — buffer
                await new Promise(resolve => setTimeout(resolve, 3000));
                // ⭐ Step 3 — readyState only
                await this.page.waitForFunction(() => {
                    const iframe = document.querySelector('#frm_main_content');
                    if (!iframe) return false;
                    try {
                        const doc = iframe.contentWindow.document;
                        return doc && doc.readyState === 'complete';
                    } catch (e) { return false; }
                }, { timeout: 30000 });
                // ⭐ Step 4 — #txtSearch non-fatal
                try {
                    await this.page.waitForFunction(() => {
                        const iframe = document.querySelector('#frm_main_content');
                        if (!iframe) return false;
                        try { return iframe.contentWindow.document.querySelector('#txtSearch') !== null; }
                        catch (e) { return false; }
                    }, { timeout: 15000 });
                    this.log('Store.aspx iframe fully loaded and ready');
                } catch (e) {
                    this.log('⚠️ #txtSearch not found after login but iframe complete — continuing');
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                throw new Error('Login failed - no redirect');
            }

        } catch (error) {
            this.error(`Error during authorization: ${error.message}`);
            this.authorized = false;
            throw error;
        } finally {
            this.authorizationInProgress = false;
            this.isAuthorizing = false;
            this.authorizationPromise = null;
        }
    }

    async saveCookies() {
        try {
            const cookies = await this.page.cookies();
            const cookiesPath = path.join(__dirname, 'cookiesos.json');
            writeFileSync(cookiesPath, JSON.stringify(cookies, null, 4));
            this.log('Cookies saved successfully');
            return true;
        } catch (error) {
            this.error(`Error saving cookies: ${error.message}`);
            return false;
        }
    }
}
// PART 2 OF 3 - paste BEFORE the closing } of the class (replace saveCookies closing brace area)
// Start pasting from here, INSIDE the class, after saveCookies()

    // ═══════════════════════════════════════════════════════
    // API METHODS WITH QUEUE
    // ═══════════════════════════════════════════════════════

    async createGameAccount(userId, game) {
        return await this.queueOperation('createGameAccount', async () => {
            try {
                const generateRandomString = () => {
                    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                    let result = '';
                    for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
                    return result;
                };

                const login    = `bc${generateRandomString()}_${generateRandomString()}`;
                const password = `bc${generateRandomString()}_${generateRandomString()}`;

                console.log(`Generated credentials for API - Login: ${login}, Password: ${password}`);

                const gameAccount = new GameAccount({
                    userId,
                    gameId: game._id,
                    gameLogin: login,
                    gamePassword: password,
                    status: 'pending',
                    metadata: { createdVia: 'api' }
                });
                await gameAccount.save();

                const result = await this.createAccount({ id: gameAccount._id.toString(), type: 'create', userId });

                if (result && result.success) {
                    gameAccount.status       = 'active';
                    gameAccount.gameLogin    = result.login;
                    gameAccount.gamePassword = result.password;
                    if (!gameAccount.metadata) gameAccount.metadata = {};
                    gameAccount.metadata.login    = result.login;
                    gameAccount.metadata.password = result.password;
                    await gameAccount.save();
                    return {
                        success: true,
                        data: {
                            _id: gameAccount._id,
                            gameLogin: result.login,
                            gamePassword: result.password,
                            gameType: gameAccount.gameType,
                            status: gameAccount.status
                        },
                        message: 'Game account created successfully'
                    };
                } else {
                    gameAccount.status = 'failed';
                    if (result && result.message) {
                        if (!gameAccount.metadata) gameAccount.metadata = {};
                        gameAccount.metadata.notes = result.message;
                    }
                    await gameAccount.save();
                    throw new Error(result ? result.message : 'Failed to create game account');
                }
            } catch (error) {
                this.error(`Error creating game account: ${error.message}`);
                throw error;
            }
        });
    }

    async getGameBalance(userId, gameLogin) {
        return await this.queueOperation(`getBalance:${gameLogin}`, async () => {
            console.log('=== getGameBalance (Queued) ===');
            try {
                const gameAccount = await GameAccount.findOne({
                    userId, gameLogin, gameType: this.gameType
                }).sort({ createdAt: -1 });
                if (!gameAccount) throw new Error('Game account not found');

                const balance = await this.getBalance({ id: gameAccount._id.toString(), login: gameLogin });

                if (balance !== null && balance !== false) {
                    await gameAccount.updateBalance(balance);
                    return {
                        success: true,
                        data: { gameLogin, balance, lastCheck: new Date(), accountId: gameAccount._id }
                    };
                } else {
                    return { success: false, data: null, message: 'Failed to retrieve balance from game server' };
                }
            } catch (error) {
                this.error(`Error getting balance: ${error.message}`);
                return { success: false, data: null, message: error.message };
            }
        });
    }

    async rechargeAccount(userId, gameLogin, totalAmount, baseAmount, remark = 'API Recharge') {
        return await this.queueOperation(`recharge:${gameLogin}:${totalAmount}`, async () => {
            try {
                console.log("Recharge (Queued) - Finding game account...");
                const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
                if (!gameAccount) throw new Error('Game account not found');

                const transactionId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const result = await this.recharge({ id: transactionId, login: gameLogin, amount: totalAmount, remark, is_manual: false });

                if (result && result !== -1) {
                    const updatedGameAccount = await GameAccount.findById(gameAccount._id);
                    return {
                        success: true,
                        data: {
                            transactionId,
                            newBalance: updatedGameAccount.balance,
                            baseAmount,
                            bonusAmount: totalAmount - baseAmount,
                            totalAmount
                        },
                        message: 'Recharge completed successfully'
                    };
                } else {
                    throw new Error('Recharge failed');
                }
            } catch (error) {
                this.error(`Error processing recharge: ${error.message}`);
                throw error;
            }
        });
    }

    async redeemFromAccount(userId, gameLogin, totalAmount, cashoutAmount, remark = 'API Redeem') {
        return await this.queueOperation(`redeem:${gameLogin}:${cashoutAmount}`, async () => {
            try {
                console.log('🔵 redeemFromAccount START:', { userId, gameLogin, totalAmount, cashoutAmount, remark });
                const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
                if (!gameAccount) throw new Error('Game account not found');
                if (gameAccount.balance < totalAmount) throw new Error('Insufficient balance');

                const result = await this.redeem({ id: null, login: gameLogin, amount: totalAmount, remark, is_manual: true });

                if (result && result !== -1) {
                    const updatedGameAccount = await GameAccount.findById(gameAccount._id);
                    return { success: true, data: { newBalance: updatedGameAccount.balance }, message: 'Redeem completed successfully' };
                } else {
                    throw new Error('Redeem failed');
                }
            } catch (error) {
                this.error(`Error processing redeem: ${error.message}`);
                throw error;
            }
        });
    }

    async getDownloadCodeForUser(userId, gameLogin) {
        return await this.queueOperation(`downloadCode:${gameLogin}`, async () => {
            try {
                const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
                if (!gameAccount) return { success: false, data: null, message: 'Game account not found' };

                const code = await this.getDownloadCode({ id: gameAccount._id.toString() });
                if (code) {
                    gameAccount.downloadCode = code;
                    await gameAccount.save();
                    return { success: true, data: { downloadCode: code }, message: 'Download code retrieved successfully' };
                } else {
                    return { success: false, data: null, message: 'Failed to get download code' };
                }
            } catch (error) {
                this.error(`Error getting download code: ${error.message}`);
                return { success: false, data: null, message: error.message || 'Error retrieving download code' };
            }
        });
    }

    async resetAccountPassword(userId, gameLogin, newPassword) {
        return await this.queueOperation(`resetPassword:${gameLogin}`, async () => {
            try {
                const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
                if (!gameAccount) return { success: false, message: 'Game account not found' };

                const result = await this.resetPassword({ id: gameAccount._id.toString(), type: 'reset', login: gameLogin, password: newPassword, userId });
                if (result) {
                    gameAccount.gamePassword = newPassword;
                    await gameAccount.save();
                    return { success: true, data: { gameLogin, message: 'Password reset successfully' }, message: 'Password reset completed successfully' };
                } else {
                    return { success: false, message: 'Password reset failed' };
                }
            } catch (error) {
                this.error(`Error resetting password: ${error.message}`);
                return { success: false, message: error.message || 'Error resetting password' };
            }
        });
    }

    async getAdminBalance() {
        return await this.queueOperation('getAdminBalance', async () => {
            if (this.cache.adminBalance !== null &&
                this.cache.adminBalanceTimestamp &&
                Date.now() - this.cache.adminBalanceTimestamp < this.cache.cacheDuration) {
                this.log(`Returning cached admin balance: ${this.cache.adminBalance}`);
                return this.cache.adminBalance;
            }
            const balance = await this._getAdminBalanceCore();
            if (balance !== false && balance !== null) {
                this.cache.adminBalance = balance;
                this.cache.adminBalanceTimestamp = Date.now();
            }
            return balance;
        });
    }

    async _getAdminBalanceCore() {
        try {
            const currentPath = await this.page.evaluate(() => location.pathname);
            if (currentPath !== '/Store.aspx') {
                await this.page.goto('https://orionstars.vip:8781/Store.aspx', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000  // ⭐ was 10000
                });
                await new Promise(resolve => setTimeout(resolve, 3000)); // ⭐ was 2000
            }

            const need_login = await this.page.evaluate(() => {
                if (location.pathname === '/default.aspx') return true;
                const msg = document.querySelector('#mb_con p');
                return msg ? msg.innerText.includes('Session timeout. Please login again.') : false;
            });
            if (need_login) throw new Error('Session expired. Please refresh the page.');

            await this.page.waitForSelector('#UserBalance', { timeout: 15000 }); // ⭐ was 10000

            const balance = await this.page.evaluate(() => {
                const el = document.querySelector('#UserBalance');
                if (!el) return null;
                const txt = el.innerText || el.textContent || '';
                const m = txt.match(/([0-9][0-9,]*\.?[0-9]*)/);
                return m ? parseFloat(m[1].replace(/,/g, '')) : null;
            });

            if (balance == null || Number.isNaN(balance)) {
                this.error('Admin balance: could not parse #UserBalance');
                return false;
            }
            this.log(`Current admin balance: ${balance}`);
            return balance;
        } catch (error) {
            this.error(`Error getting admin balance: ${error.message}`);
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════
    // CORE OPERATION METHODS
    // ═══════════════════════════════════════════════════════

    async getBalance({ id, login }) {
        console.log('getBalance called with:', id, login);
        try {
            await this.ensureBrowserReady();

            const currentPath = await this.page.evaluate(() => location.pathname);
            if (currentPath !== '/Store.aspx') {
                await this.page.goto('https://orionstars.vip:8781/Store.aspx', {
                    waitUntil: 'networkidle2',
                    timeout: 30000  // ⭐ was 15000
                });
                await this.page.waitForSelector('#frm_main_content', { timeout: 20000 }); // ⭐ was 10000
                await new Promise(resolve => setTimeout(resolve, 3000)); // ⭐ was 2000
            }

            const needLogin = await this.page.evaluate(() => location.pathname === '/default.aspx');
            if (needLogin) throw new Error('Session expired. Please refresh the page.');

            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            if (!iframeAccessible) throw new Error('Page not ready. Please try again.');

            console.log('Searching for account:', login);
            await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const doc = iframe.contentWindow.document;
                doc.querySelector('#txtSearch').value = login;
                doc.querySelectorAll('#content a')[0].click();
            }, login);

            await this.page.waitForFunction((login) => {
                try {
                    const iframe = document.querySelector('#frm_main_content');
                    if (!iframe) return false;
                    const items = iframe.contentWindow.document.querySelectorAll('#item tr');
                    if (items.length < 2) return false;
                    for (let i = 1; i < items.length; i++) {
                        const tds = items[i].querySelectorAll('td');
                        if (tds.length > 2 && tds[2].innerText.trim().toLowerCase() === login.toLowerCase()) return true;
                    }
                    return false;
                } catch (e) { return false; }
            }, { timeout: 15000 }, login); // ⭐ was 8000

            await new Promise(resolve => setTimeout(resolve, 1000));

            const login_selected = await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const doc = iframe.contentWindow.document;
                const items = doc.querySelectorAll('#item tr');
                if (items.length < 2) return false;
                let matchingRows = [];
                for (let i = 1; i < items.length; i++) {
                    const tds = items[i].querySelectorAll('td');
                    if (tds.length > 2 && tds[2].innerText.trim().toLowerCase() === login.toLowerCase()) matchingRows.push(i);
                }
                if (matchingRows.length === 0) return false;
                const tds = items[matchingRows[matchingRows.length - 1]].querySelectorAll('td');
                tds[0].querySelector('a').click();
                return true;
            }, login);

            if (!login_selected) throw new Error(`Account ${login} not found`);

            await new Promise(resolve => setTimeout(resolve, 2000));

            const balance = await this.page.evaluate(() => {
                try {
                    const iframe = document.querySelector('#frm_main_content');
                    const el = iframe.contentWindow.document.querySelector('#txtBalance');
                    if (!el) return false;
                    const val = parseFloat(el.value || el.innerText || el.textContent);
                    return isNaN(val) ? false : val;
                } catch (e) { return false; }
            });

            if (balance === false) throw new Error('Could not retrieve balance');
            this.log(`Current balance for ${login}: ${balance}`);

            try {
                const gameAccount = await GameAccount.findOne({ gameLogin: login });
                if (gameAccount) await gameAccount.updateBalance(balance);
            } catch (dbError) {
                this.error(`Error updating balance in DB: ${dbError.message}`);
            }

            if (id) await Tasks.approve(id, balance);

            await this.page.goto('https://orionstars.vip:8781/Store.aspx', {
                waitUntil: 'networkidle2',
                timeout: 30000  // ⭐ was 10000
            });
            await this.page.waitForSelector('#frm_main_content', { timeout: 20000 }); // ⭐ was 10000
            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log('Back on main store page, ready for next operation');
            return balance;

        } catch (error) {
            this.error(`Error during get balance: ${error.message}`);
            if (id) await Tasks.error(id, error.message);
            throw error;
        }
    }

    async getDownloadCode(task) {
        try {
            await this.ensureBrowserReady();

            const need_login = await this.page.evaluate(() => {
                const msg = document.querySelector('#mb_con p');
                return msg ? msg.innerText.includes('Session timeout. Please login again.') : false;
            });
            if (need_login) throw new Error('Session expired. Please refresh the page.');

            await this.page.goto('https://orionstars.vip:8781/IphoneCode.aspx', {
                waitUntil: 'domcontentloaded',
                timeout: 30000  // ⭐ was 10000
            });
            await new Promise(resolve => setTimeout(resolve, 1000));

            const code = await this.page.evaluate(() => {
                const el = document.querySelector("#IphoneCodeTex");
                return el ? el.innerText : null;
            });
            if (!code) throw new Error('Download code not found');
            this.log(`Download code: ${code}`);

            try {
                const gameAccount = await GameAccount.findById(task.id);
                if (gameAccount) { gameAccount.downloadCode = code; await gameAccount.save(); }
            } catch (error) {
                this.error(`Error saving download code to DB: ${error.message}`);
            }

            await Tasks.approve(task.id, code);
            await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }); // ⭐ was 10000
            return code;

        } catch (error) {
            this.error(`Error getting download code: ${error.message}`);
            await Tasks.error(task.id, error.message);
            throw error;
        }
    }

    async createAccount({ id, userId }) {
        console.log('🔴 CREATE ACCOUNT START:', { id, userId });
        try {
            await this.ensureBrowserReady();

            const generateRandomString = () => {
                const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                let result = '';
                for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
                return result;
            };
            const login    = `bc${generateRandomString()}_${generateRandomString()}`;
            const password = `bc${generateRandomString()}_${generateRandomString()}`;
            console.log(`Generated credentials - Login: ${login}, Password: ${password}`);

            // ── Step 1
            console.log('Step 1: Checking page state...');
            const currentPath = await this.page.evaluate(() => location.pathname);
            if (currentPath === '/default.aspx') throw new Error('Session expired. Please refresh the page.');
            console.log('✅ On correct page');

            // ── Step 2
            console.log('Step 2: Waiting for main iframe to be ready...');
            await this.page.waitForSelector('#frm_main_content', { timeout: 30000 }); // ⭐ was 10000
            await new Promise(resolve => setTimeout(resolve, 3000)); // ⭐ added buffer

            await this.page.waitForFunction(() => {
                const iframe = document.querySelector('#frm_main_content');
                if (!iframe) return false;
                try {
                    const doc = iframe.contentWindow.document;
                    return doc && doc.readyState === 'complete'; // ⭐ removed #txtSearch requirement
                } catch (e) { return false; }
            }, { timeout: 30000 }); // ⭐ was 15000

            try {
                await this.page.waitForFunction(() => {
                    const iframe = document.querySelector('#frm_main_content');
                    if (!iframe) return false;
                    try { return iframe.contentWindow.document.querySelector('#txtSearch') !== null; }
                    catch (e) { return false; }
                }, { timeout: 15000 });
            } catch (e) {
                this.log('⚠️ #txtSearch not found but iframe complete — continuing');
            }

            console.log('✅ Main iframe ready');
            await new Promise(resolve => setTimeout(resolve, 1500));

            // ── Step 3
            console.log('Step 3: Verifying iframe accessibility...');
            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            if (!iframeAccessible) throw new Error('Page not ready. Please try again.');
            console.log('✅ Iframe verified accessible');

            // ── Step 4
            console.log('Step 4: Clicking Add Account button...');
            await this.page.evaluate(() => {
                const iframe = document.querySelector('#frm_main_content');
                iframe.contentWindow.document.querySelectorAll('#content a')[1].click();
            });
            console.log('✅ Add Account button clicked');

            // ── Step 5
            console.log('Step 5: Waiting for account creation dialog...');
            await this.page.waitForSelector('#DialogBySHF iframe', { timeout: 30000 }); // ⭐ was 15000
            console.log('✅ Dialog selector found');
            await new Promise(resolve => setTimeout(resolve, 3000)); // ⭐ was 2000

            // ── Step 6
            console.log('Step 6: Verifying dialog iframe accessibility...');
            await this.page.waitForFunction(() => {
                const iframe = document.querySelector('#DialogBySHF iframe');
                if (!iframe) return false;
                try {
                    const doc = iframe.contentWindow.document;
                    return doc.querySelector('#txtAccount')    !== null &&
                           doc.querySelector('#txtNickName')   !== null &&
                           doc.querySelector('#txtLogonPass')  !== null &&
                           doc.querySelector('#txtLogonPass2') !== null &&
                           doc.querySelector('a')              !== null;
                } catch (e) { return false; }
            }, { timeout: 30000 }); // ⭐ was 10000
            console.log('✅ Dialog iframe verified and form elements ready');
            await new Promise(resolve => setTimeout(resolve, 500));

            // ── Step 7
            console.log('Step 7: Filling account creation form...');
            const formFilled = await this.page.evaluate(({ login, password }) => {
                try {
                    const iframe = document.querySelector('#DialogBySHF iframe');
                    if (!iframe) return false;
                    const doc = iframe.contentWindow.document;
                    const a  = doc.querySelector('#txtAccount');
                    const n  = doc.querySelector('#txtNickName');
                    const p  = doc.querySelector('#txtLogonPass');
                    const p2 = doc.querySelector('#txtLogonPass2');
                    const b  = doc.querySelector('a');
                    if (!a || !n || !p || !p2 || !b) return false;
                    a.value = login; n.value = login; p.value = password; p2.value = password;
                    b.click();
                    return true;
                } catch (e) { return false; }
            }, { login, password });
            if (!formFilled) throw new Error('Failed to fill account creation form');
            console.log('✅ Form filled and submitted');

            // ── Step 8
            console.log('Step 8: Waiting for result message...');
            await this.page.waitForSelector('#mb_con p', { timeout: 60000 }); // ⭐ was 30000
            const message = await this.page.evaluate(() => {
                const el = document.querySelector('#mb_con p');
                return el ? el.innerText : 'No message found';
            });
            console.log('Result message:', message);

            // ── Step 9
            console.log('Step 9: Closing dialogs...');
            await this.page.click("#mb_btn_ok");
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
                const closeButton = await this.page.$('#Close');
                if (closeButton) { await this.page.click('#Close'); console.log('✅ Dialog closed'); }
            } catch (e) { console.log('No close button found or already closed'); }
            await new Promise(resolve => setTimeout(resolve, 500));

            // ── Step 10
            console.log('Step 10: Processing result...');
            const successMessages = [
                "Added successfully",
                "Users added successfully, but failed to obtain the game ID number, the system will assign you later!"
            ];

            if (successMessages.includes(message)) {
                console.log('✅ SUCCESS! Account created');
                this.log(`New account created ${login}:${password}`);
                try {
                    const gameAccount = await GameAccount.findById(id);
                    if (gameAccount) {
                        gameAccount.status       = 'active';
                        gameAccount.gameLogin    = login;
                        gameAccount.gamePassword = password;
                        if (!gameAccount.metadata) gameAccount.metadata = {};
                        gameAccount.metadata.login    = login;
                        gameAccount.metadata.password = password;
                        await gameAccount.save();
                        console.log('✅ Database updated');
                    }
                } catch (error) { console.log('DB update error:', error.message); }
                await Tasks.approve(id);
                console.log('✅ CREATE ACCOUNT COMPLETE');
                return { success: true, login, password };
            } else {
                console.log('❌ Account creation failed:', message);
                this.error(`Error while creating account: ${message}`);
                try {
                    const gameAccount = await GameAccount.findById(id);
                    if (gameAccount) {
                        gameAccount.status = 'failed';
                        if (!gameAccount.metadata) gameAccount.metadata = {};
                        gameAccount.metadata.notes = message;
                        await gameAccount.save();
                    }
                } catch (error) { console.log('DB update error:', error.message); }
                await Tasks.error(id, message);
                throw new Error(message);
            }
        } catch (error) {
            console.log('❌ CREATE ACCOUNT ERROR:', error.message);
            this.error(`Error creating account: ${error.message}`);
            try {
                const gameAccount = await GameAccount.findById(id);
                if (gameAccount) {
                    gameAccount.status = 'failed';
                    if (!gameAccount.metadata) gameAccount.metadata = {};
                    gameAccount.metadata.notes = error.message;
                    await gameAccount.save();
                }
            } catch (dbError) { console.log('Failed to update DB with error:', dbError.message); }
            throw error;
        }
    }// PART 3 OF 3 - paste AFTER Part 2, still INSIDE the class

    async recharge({ id, login, amount, remark, is_manual }) {
        console.log('🔴 RECHARGE START:', { id, login, amount, remark, is_manual });
        try {
            await this.ensureBrowserReady();

            const currentPath = await this.page.evaluate(() => location.pathname);
            if (currentPath === '/default.aspx') throw new Error('Session expired. Please refresh the page.');

            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            if (!iframeAccessible) throw new Error('Page not ready. Please try again.');

            await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const doc = iframe.contentWindow.document;
                doc.querySelector('#txtSearch').value = login;
                doc.querySelectorAll('#content a')[0].click();
            }, login);

            await this.page.waitForFunction((login) => {
                const iframe = document.querySelector('#frm_main_content');
                if (!iframe) return false;
                const items = iframe.contentWindow.document.querySelectorAll('#item tr');
                return items.length >= 2;
            }, { timeout: 15000 }, login); // ⭐ was 5000

            await new Promise(resolve => setTimeout(resolve, 1000));

            const login_selected = await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const items = iframe.contentWindow.document.querySelectorAll('#item tr');
                if (items.length < 2) return false;
                for (let i = 1; i < items.length; i++) {
                    const tds = items[i].querySelectorAll('td');
                    if (tds[2].innerText.trim().toLowerCase() === login.toLowerCase()) {
                        tds[0].querySelector('a').click();
                        return true;
                    }
                }
                return false;
            }, login);
            if (!login_selected) throw new Error(`Account ${login} not found`);

            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.page.evaluate(() => {
                const iframe = document.querySelector('#frm_main_content');
                iframe.contentWindow.document.querySelectorAll('.btn12')[2].click();
                return true;
            });

            await this.page.waitForSelector('#Container iframe', { timeout: 20000 }); // ⭐ was 10000
            await new Promise(resolve => setTimeout(resolve, 1000));

            const current_balance = await this.page.evaluate(() => {
                const iframe = document.querySelector('#Container iframe');
                const doc = iframe.contentWindow.document;
                const el = doc.querySelector('#txtLeScore');
                if (!el) return false;
                return parseInt(el.value);
            });

            if (current_balance >= 2) throw new Error(`Balance is more than $2 (${current_balance}). Cannot recharge.`);

            const session_amount = await this.page.evaluate(({ amount, remark }) => {
                const iframe = document.querySelector('#Container iframe');
                const doc = iframe.contentWindow.document;
                const amount_input = doc.querySelector('#txtAddGold');
                const remark_input = doc.querySelector('#txtReason');
                const button       = doc.querySelector('#Button1');
                const balance_input = doc.querySelector('#txtLeScore');
                if (!amount_input || !remark_input || !button) return false;
                const session_amount = parseInt(balance_input.value) + amount;
                amount_input.value = amount;
                remark_input.value = remark;
                button.click();
                return session_amount;
            }, { amount, remark });
            if (!session_amount) throw new Error('Failed to submit recharge form');

            await this.page.waitForSelector('#mb_con p', { timeout: 60000 });

            const result = await this.page.evaluate(() => {
                const closeButton = document.querySelector('#Close');
                if (closeButton) closeButton.click();
                return document.querySelector('#mb_con p').innerText;
            });
            await this.page.click("#mb_btn_ok");

            if (result === "Confirmed successful") {
                this.log(`Successfully deposit ${amount} to login ${login}`);
                try {
                    const gameAccount = await GameAccount.findOne({ gameLogin: login });
                    if (gameAccount) await gameAccount.updateBalance(session_amount, id);
                } catch (dbError) { this.error(`Error updating balance in DB: ${dbError.message}`); }
                await Tasks.approve(id, session_amount);
                this.cache.adminBalance = null;
                this.cache.adminBalanceTimestamp = null;
                console.log('✅ RECHARGE COMPLETE');
                return true;
            } else {
                throw new Error(`Recharge failed: ${result}`);
            }

        } catch (error) {
            console.log('❌ RECHARGE ERROR:', error.message);
            this.error(`Error during recharge: ${error.message}`);
            await Tasks.error(id, error.message);
            throw error;
        }
    }

    async redeem({ id, login, amount, remark, is_manual = false }) {
        console.log('🔴 REDEEM START:', { id, login, amount, remark, is_manual });
        try {
            await this.ensureBrowserReady();

            const currentPath = await this.page.evaluate(() => location.pathname);
            if (currentPath === '/default.aspx') throw new Error('Session expired. Please refresh the page.');

            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            if (!iframeAccessible) throw new Error('Page not ready. Please try again.');

            await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const doc = iframe.contentWindow.document;
                const checkbox = doc.querySelector('#ShowHideAccount_0');
                if (checkbox && !checkbox.checked) checkbox.click();
                doc.querySelector('#txtSearch').value = login;
                doc.querySelectorAll('#content a')[0].click();
            }, login);

            await this.page.waitForFunction((login) => {
                const iframe = document.querySelector('#frm_main_content');
                if (!iframe) return false;
                const items = iframe.contentWindow.document.querySelectorAll('#item tr');
                return items.length >= 2;
            }, { timeout: 15000 }, login); // ⭐ was 5000

            await new Promise(resolve => setTimeout(resolve, 1000));

            const login_selected = await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const items = iframe.contentWindow.document.querySelectorAll('#item tr');
                if (items.length < 2) return false;
                for (let i = 1; i < items.length; i++) {
                    const tds = items[i].querySelectorAll('td');
                    if (tds[2].innerText.trim().toLowerCase() === login.toLowerCase()) {
                        tds[0].querySelector('a').click();
                        return true;
                    }
                }
                return false;
            }, login);
            if (!login_selected) throw new Error(`Account ${login} not found`);

            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.page.evaluate(() => {
                const iframe = document.querySelector('#frm_main_content');
                iframe.contentWindow.document.querySelectorAll('.btn12')[3].click();
                return true;
            });

            await this.page.waitForSelector('#Container iframe', { timeout: 20000 }); // ⭐ was 10000
            await new Promise(resolve => setTimeout(resolve, 1000));

            const current_balance = await this.page.evaluate(() => {
                const iframe = document.querySelector('#Container iframe');
                if (!iframe) return false;
                const el = iframe.contentWindow.document.querySelector('#txtLeScore');
                if (!el) return false;
                return parseFloat(parseFloat(el.value).toFixed(2));
            });
            if (current_balance === false) throw new Error('Could not read balance from redeem dialog');

            if (!is_manual && parseInt(current_balance) !== parseInt(amount)) {
                await Tasks.cancel(id, parseInt(current_balance));
                return true;
            }
            if (is_manual && parseInt(current_balance) < parseInt(amount)) {
                await Tasks.cancel(id, parseInt(current_balance));
                return true;
            }

            const processed = await this.page.evaluate(({ amount, remark }) => {
                const iframe = document.querySelector('#Container iframe');
                if (!iframe) return false;
                const doc = iframe.contentWindow.document;
                const amount_input = doc.querySelector('#txtAddGold');
                const remark_input = doc.querySelector('#txtReason');
                const button       = doc.querySelector('#Button1');
                if (!amount_input || !remark_input || !button) return false;
                amount_input.value = amount;
                remark_input.value = remark;
                button.click();
                return true;
            }, { amount, remark });
            if (!processed) throw new Error('Failed to fill redeem form');

            await this.page.waitForSelector('#mb_con p', { timeout: 30000 });

            const result = await this.page.evaluate(() => {
                const closeButton = document.querySelector('#Close');
                if (closeButton) closeButton.click();
                const el = document.querySelector('#mb_con p');
                return el ? el.innerText : 'No message found';
            });
            await this.page.click("#mb_btn_ok");
            await new Promise(resolve => setTimeout(resolve, 500));

            if (result === "Confirmed successful") {
                const newBalance = parseFloat((current_balance - amount).toFixed(2));
                this.log(`Successfully cashout ${amount} from login ${login}`);
                try {
                    const gameAccount = await GameAccount.findOne({ gameLogin: login });
                    if (gameAccount) await gameAccount.updateBalance(newBalance, id);
                } catch (dbError) { this.error(`Error updating balance in DB: ${dbError.message}`); }
                await Tasks.approve(id, newBalance);
                this.cache.adminBalance = null;
                this.cache.adminBalanceTimestamp = null;
                console.log('✅ REDEEM COMPLETE');
                return true;
            } else {
                if (result === "Sorry, there is not enough gold for the operator!") {
                    await Tasks.cancel(id);
                } else {
                    await Tasks.error(id, result);
                }
                throw new Error(`Redeem failed: ${result}`);
            }

        } catch (error) {
            console.log('❌ REDEEM ERROR:', error.message);
            this.error(`Error during redeem: ${error.message}`);
            throw error;
        }
    }

    async resetPassword({ id, login, password }) {
        console.log('🔴 RESET PASSWORD START:', { id, login, password: '***' });
        try {
            await this.ensureBrowserReady();

            const currentPath = await this.page.evaluate(() => location.pathname);
            if (currentPath === '/default.aspx') throw new Error('Session expired. Please refresh the page.');

            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            if (!iframeAccessible) throw new Error('Page not ready. Please try again.');

            await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const doc = iframe.contentWindow.document;
                const checkbox = doc.querySelector('#ShowHideAccount_0');
                if (checkbox && !checkbox.checked) checkbox.click();
                doc.querySelector('#txtSearch').value = login;
                doc.querySelectorAll('#content a')[0].click();
            }, login);

            await this.page.waitForFunction((login) => {
                const iframe = document.querySelector('#frm_main_content');
                if (!iframe) return false;
                const items = iframe.contentWindow.document.querySelectorAll('#item tr');
                return items.length >= 2;
            }, { timeout: 15000 }, login); // ⭐ was 5000

            await new Promise(resolve => setTimeout(resolve, 1000));

            const login_selected = await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const items = iframe.contentWindow.document.querySelectorAll('#item tr');
                if (items.length < 2) return false;
                for (let i = 1; i < items.length; i++) {
                    const tds = items[i].querySelectorAll('td');
                    if (tds[2].innerText.trim().toLowerCase() === login.toLowerCase()) {
                        tds[0].querySelector('a').click();
                        return true;
                    }
                }
                return false;
            }, login);
            if (!login_selected) throw new Error(`Account ${login} not found`);

            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.page.evaluate(() => {
                const iframe = document.querySelector('#frm_main_content');
                iframe.contentWindow.document.querySelectorAll('.btn13')[2].click();
                return true;
            });

            await this.page.waitForSelector('#Container iframe', { timeout: 20000 }); // ⭐ was 10000
            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.page.waitForFunction(() => {
                const iframe = document.querySelector('#Container iframe');
                if (!iframe) return false;
                try {
                    const doc = iframe.contentWindow.document;
                    return doc.querySelector('#txtConfirmPass')     !== null &&
                           doc.querySelector('#txtSureConfirmPass') !== null &&
                           doc.querySelector('#Button1')            !== null;
                } catch (e) { return false; }
            }, { timeout: 20000 }); // ⭐ was 10000

            await new Promise(resolve => setTimeout(resolve, 500));

            const processed = await this.page.evaluate(({ password }) => {
                const iframe = document.querySelector('#Container iframe');
                if (!iframe) return false;
                const doc = iframe.contentWindow.document;
                const np = doc.querySelector('#txtConfirmPass');
                const cp = doc.querySelector('#txtSureConfirmPass');
                const b  = doc.querySelector('#Button1');
                if (!np || !cp || !b) return false;
                np.value = password;
                cp.value = password;
                b.click();
                return true;
            }, { password });
            if (!processed) throw new Error('Failed to fill reset password form');

            await this.page.waitForSelector('#mb_con p', { timeout: 30000 });

            const result = await this.page.evaluate(() => {
                const closeButton = document.querySelector('#Close');
                if (closeButton) closeButton.click();
                const el = document.querySelector('#mb_con p');
                return el ? el.innerText : 'No message found';
            });
            await this.page.click("#mb_btn_ok");
            await new Promise(resolve => setTimeout(resolve, 500));

            if (result === "Modified success!") {
                this.log(`Password for login ${login} has been restored!`);
                try {
                    const gameAccount = await GameAccount.findOne({ gameLogin: login });
                    if (gameAccount) { gameAccount.gamePassword = password; await gameAccount.save(); }
                } catch (dbError) { this.error(`Error updating password in DB: ${dbError.message}`); }
                await Tasks.approve(id, password);
                console.log('✅ RESET PASSWORD COMPLETE');
                return true;
            } else {
                await Tasks.error(id, `password reset failed: ${result}`);
                throw new Error(`Password reset failed: ${result}`);
            }

        } catch (error) {
            console.log('❌ RESET PASSWORD ERROR:', error.message);
            this.error(`Error during password reset: ${error.message}`);
            throw error;
        }
    }

    async getBalanceAdmin(task) {
        try {
            await this.ensureBrowserReady();
            const balance = await this.page.evaluate(() => {
                const el = document.querySelector('#UserBalance');
                if (!el) return null;
                const txt = el.innerText || el.textContent || '';
                const m = txt.match(/([0-9][0-9,]*\.?[0-9]*)/);
                return m ? parseFloat(m[1].replace(/,/g, '')) : null;
            });
            if (balance !== null && !isNaN(balance)) {
                this.log(`Current admin balance: ${balance}`);
                this.cache.adminBalance = balance;
                this.cache.adminBalanceTimestamp = Date.now();
                await Tasks.approve(task.id, balance);
                return balance;
            }
            throw new Error('Could not retrieve admin balance');
        } catch (error) {
            this.error(`Error in getBalanceAdmin: ${error.message}`);
            throw error;
        }
    }

    async checkQueue() {
        try {
            const task = await Tasks.get('orionstars');
            if (!task) return setTimeout(this.checkQueue.bind(this), 1000);

            console.log('Processing task:', task);
            let task_result = null;

            switch (task.type) {
                case 'get_balance':       task_result = await this.getBalance(task);       break;
                case 'get_admin_balance': task_result = await this.getBalanceAdmin(task);  break;
                case 'recharge':          task_result = await this.recharge(task);          break;
                case 'redeem':            task_result = await this.redeem(task);            break;
                case 'create':            task_result = await this.createAccount(task);    break;
                case 'reset':             task_result = await this.resetPassword(task);    break;
                case 'download_code':     task_result = await this.getDownloadCode(task);  break;
                default: this.error(`Unknown task type: ${task.type}`);
            }

            if (task_result === -1) return;
            return setTimeout(this.checkQueue.bind(this), 5000);

        } catch (error) {
            this.error(`Error in checkQueue: ${error.message}`);
            setTimeout(this.checkQueue.bind(this), 5000);
        }
    }
}

// Export singleton instance
const orionStarsController = new OrionStarsController();
module.exports = orionStarsController;