// controllers/MilkyWaysController.js - FIXED VERSION (NO INFINITE LOOPS + AUTH RETRY LIMITS)
// PART 1 OF 3 - Lines 1-650
const Puppeteer = require('puppeteer');
const Captcha = require('../lib/captcha.js');
const { writeFileSync, readFileSync, existsSync } = require('fs');
const Tasks = require('../lib/tasks.js');
const Logger = require('../utils/logger.js');
const GameAccount = require('../models/GameAccount.js');
const Game = require('../models/Game.js');
const path = require('path');

class MilkyWaysController {
    constructor() {
        this.browser = null;
        this.page = null;
        this.cookies = null;
        this.authorized = false;
        this.logger = Logger('Milkyways');
        this.gameType = 'mw';
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

        // QUEUE SYSTEM (NEEDED - All operations use Puppeteer)
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.maxConcurrentRequests = 1;

        // INITIALIZATION STATE
        this.isInitializing = false;
        this.initializationPromise = null;
        this.browserReady = false;

        // AUTHORIZATION STATE
        this.isAuthorizing = false;
        this.authorizationPromise = null;
        this.authorizationInProgress = false;

        // ⭐ RETRY LIMIT TRACKING (PREVENT INFINITE LOOPS)
        this.authRetryCount = 0;
        this.maxAuthRetries = 3;
        this.lastAuthAttempt = null;
        this.authResetInterval = 5 * 60 * 1000; // Reset counter after 5 minutes

        // SESSION MANAGEMENT
        this.sessionTimeout = null;
        this.lastSuccessfulOperation = Date.now();
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 3;
        this.consecutiveMonitorFailures = 0; // ⭐ PREVENT MONITOR INFINITE LOOPS
        this.maxMonitorFailures = 5;

        this.loadAgentCredentials().catch(err => {
            this.error(`Failed to load credentials on startup: ${err.message}`);
        });

        this.startSessionMonitor(); // ⭐ ADD SESSION MONITOR

        process.on('unhandledRejection', e => {
            this.logger.error(e);
        });

        process.on('uncaughtException', e => {
            this.logger.error(e);
        });
    }

    log(log) { this.logger.log(`${log}`) }
    error(log) { this.logger.error(`${log}`) }

    // ⭐ RESET AUTH RETRY COUNTER IF ENOUGH TIME HAS PASSED
    resetAuthRetryIfNeeded() {
        if (this.lastAuthAttempt && 
            Date.now() - this.lastAuthAttempt > this.authResetInterval) {
            this.log('Resetting auth retry counter after timeout');
            this.authRetryCount = 0;
        }
    }

    // ⭐ SESSION MONITORING (WITH FAILURE LIMIT)
    startSessionMonitor() {
        setInterval(async () => {
            if (!this.initialized || !this.page || !this.browser) return;

            const timeSinceLastActivity = Date.now() - this.lastSuccessfulOperation;
            
            if (timeSinceLastActivity > this.activityTimeout) {
                // ⭐ Check if too many consecutive failures
                if (this.consecutiveMonitorFailures >= this.maxMonitorFailures) {
                    this.error(`Session monitor disabled after ${this.maxMonitorFailures} consecutive failures. Manual restart required.`);
                    return; // ⭐ STOP TRYING - NO INFINITE LOOP
                }
                
                this.log('Session timeout detected, reinitializing...');
                try {
                    await this.reinitialize();
                    this.consecutiveMonitorFailures = 0; // ⭐ Reset on success
                } catch (error) {
                    this.consecutiveMonitorFailures++; // ⭐ Increment on failure
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
        
        this.authRetryCount = 0; // ⭐ Reset retry counter
        
        try {
            await this.initialize();
            this.consecutiveMonitorFailures = 0; // ⭐ Reset on successful reinit
        } catch (error) {
            this.error(`Reinitialization failed: ${error.message}`);
            throw error; // ⭐ Throw so monitor can catch it
        }
    }

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
                    if (!this.isProcessingQueue) {
                        this.processQueue();
                    }
                }).catch(err => {
                    this.error(`Failed to initialize for queued operation: ${err.message}`);
                    // ✅ FIX: Reject ALL queued tasks
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
                this.lastSuccessfulOperation = Date.now(); // ⭐ UPDATE LAST ACTIVITY
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

    async ensureBrowserReady() {
        if (!this.browser || !this.page) {
            throw new Error('Browser not initialized. Please refresh and try again.');
        }

        try {
            if (this.page.isClosed()) {
                throw new Error('Browser page closed. Please refresh and try again.');
            }
        } catch (error) {
            throw new Error('Browser not accessible. Please refresh and try again.');
        }

        try {
            const version = await this.browser.version();
            if (!version) {
                throw new Error('Browser not responding. Please refresh and try again.');
            }
        } catch (error) {
            throw new Error('Browser disconnected. Please refresh and try again.');
        }

        if (!this.authorized) {
            throw new Error('Not authorized. Please login again.');
        }
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
                } catch (e) {
                    return false;
                }
            }, selector);
        } catch (error) {
            return false;
        }
    }

    async loadAgentCredentials() {
        try {
            const game = await Game.findOne({ 
                shortcode: 'MW', 
                status: { $in: ['active', 'maintenance'] } 
            });

            if (!game) {
                throw new Error('MilkyWays game not found in database');
            }

            if (!game.agentUsername || !game.agentPassword) {
                throw new Error('Agent credentials not configured for MilkyWays');
            }

            this.agentCredentials = {
                username: game.agentUsername,
                password: game.agentPassword
            };

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
            if (this.initialized && this.browserReady) {
                return;
            }
            throw new Error('Initialization timeout. Please try again.');
        }

        this.isInitializing = true;
        this.browserReady = false;

        try {
            if (!this.agentCredentials) {
                const credentialsLoaded = await this.loadAgentCredentials();
                if (!credentialsLoaded) {
                    throw new Error('Cannot initialize without agent credentials');
                }
            }

            this.initializationPromise = this.createBrowser();
            await this.initializationPromise;
            this.initialized = true;
            this.browserReady = true;
            this.lastSuccessfulOperation = Date.now();
            
        } catch (error) {
            this.error(`Initialization failed: ${error.message}`);
            this.initialized = false;
            this.browserReady = false;
            throw error;
        } finally {
            this.isInitializing = false;
            this.initializationPromise = null;
        }
    }

    async createBrowser() {
        this.log('Initializing browser for MilkyWays...');
        
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
            pipe: true,
            ignoreHTTPSErrors: true,
            defaultViewport: {
                width: 1312,
                height: 800
            }
        });

        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();
        
        await this.page.setRequestInterception(true);
        
        this.page.on('request', (req) => {
            if (req.isInterceptResolutionHandled()) {
                return;
            }

            const resourceType = req.resourceType();
            const url = req.url();
            
            if (url.includes('/default.aspx') || 
                url.includes('ImageCheck') || 
                url.includes('VerifyCode') || 
                url.includes('captcha') ||
                url.includes('.aspx')) {
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

        const cookiesPath = path.join(__dirname, 'cookiesmw.json');
        if (existsSync(cookiesPath)) {
            try {
                const cookies = readFileSync(cookiesPath).toString();
                const cookies_parsed = JSON.parse(cookies);
                await this.page.setCookie(...cookies_parsed);
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
            // ⭐ Prevent multiple authorization attempts
            if (this.isAuthorizing) {
                this.log('Authorization already in progress, waiting...');
                if (this.authorizationPromise) {
                    await this.authorizationPromise;
                }
                return;
            }

            if (!this.page || this.page.isClosed()) {
                throw new Error('Page is closed, cannot check authorization');
            }

            this.log('Checking authorization status...');
            
            await this.page.goto(`https://milkywayapp.xyz:8781/Store.aspx`, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });

            await new Promise(resolve => setTimeout(resolve, 1500));

            const currentPath = await this.page.evaluate(() => location.pathname);
            this.log(`Landed on: ${currentPath}`);

            if (currentPath === '/default.aspx') {
                this.authorized = false;
                this.log('Redirected to login page - need to authorize');
                
                // ⭐ ADD RETRY LIMIT CHECK
                this.resetAuthRetryIfNeeded();
                
                if (this.authRetryCount >= this.maxAuthRetries) {
                    throw new Error(`Max authorization attempts (${this.maxAuthRetries}) reached. Please wait a few minutes and refresh.`);
                }
                
                this.authRetryCount++;
                this.lastAuthAttempt = Date.now();
                this.log(`Authorization attempt ${this.authRetryCount}/${this.maxAuthRetries}`);
                
                await this.authorize();
                
                // ⭐ RESET ON SUCCESS
                this.authRetryCount = 0;
                return;
            } else {
                this.log('On Store.aspx, verifying iframe...');
                
                await this.page.waitForSelector('#frm_main_content', { timeout: 10000 });
                
                await this.page.waitForFunction(() => {
                    const iframe = document.querySelector('#frm_main_content');
                    if (!iframe) return false;
                    
                    try {
                        const iframe_document = iframe.contentWindow.document;
                        if (!iframe_document) return false;
                        
                        const hasContent = iframe_document.querySelector('#txtSearch') !== null;
                        return iframe_document.readyState === 'complete' && hasContent;
                    } catch (e) {
                        return false;
                    }
                }, { timeout: 10000 });
                
                this.log('✅ Already authorized - iframe ready');
                this.authorized = true;
                
                // ⭐ RESET RETRY COUNTER ON SUCCESS
                this.authRetryCount = 0;
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                return true;
            }
        } catch (error) {
            this.error(`Error checking authorization: ${error.message}`);
            this.authorized = false;
            throw error; // ⭐ Don't retry, just throw
        }
    }

    async authorize() {
        if (this.authorizationInProgress) {
            throw new Error('Authorization already in progress');
        }

        // ⭐ CHECK RETRY LIMIT AT START
        this.resetAuthRetryIfNeeded();
        
        if (this.authRetryCount >= this.maxAuthRetries) {
            throw new Error(`Max authorization attempts (${this.maxAuthRetries}) reached. Please wait ${Math.ceil(this.authResetInterval / 60000)} minutes.`);
        }

        this.authorizationInProgress = true;
        this.isAuthorizing = true;
        
        try {
            this.log('Starting authorization...');
            
            if (!this.page || this.page.isClosed()) {
                throw new Error('Page is invalid, cannot authorize');
            }

            await this.page.goto(`https://milkywayapp.xyz:8781/default.aspx`, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });

            await Promise.all([
                this.page.waitForSelector('#txtLoginName', { timeout: 10000 }),
                this.page.waitForSelector('#txtLoginPass', { timeout: 10000 }),
                this.page.waitForSelector('#txtVerifyCode', { timeout: 10000 }),
                this.page.waitForSelector('#ImageCheck', { timeout: 10000 })
            ]);

            if (!this.agentCredentials) {
                const credentialsLoaded = await this.loadAgentCredentials();
                if (!credentialsLoaded) {
                    throw new Error('Cannot authorize without agent credentials');
                }
            }

            this.log(`Using agent credentials: ${this.agentCredentials.username}`);
            
            await this.page.evaluate(() => {
                document.querySelector('#txtLoginName').value = '';
                document.querySelector('#txtLoginPass').value = '';
            });
            
            await this.page.type('#txtLoginName', this.agentCredentials.username);
            await this.page.type('#txtLoginPass', this.agentCredentials.password);

            await this.page.waitForSelector('#ImageCheck', { timeout: 10000 });
            
            await this.page.waitForFunction(() => {
                const img = document.querySelector('#ImageCheck');
                return img && img.complete && img.naturalHeight !== 0;
            }, { timeout: 10000 });

            await new Promise(resolve => setTimeout(resolve, 500));

            const base64Captcha = await this.page.evaluate(() => {
                const img = document.querySelector('#ImageCheck');
                if (!img || !img.complete || img.naturalHeight === 0) {
                    throw new Error('Captcha image not loaded');
                }
                
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || 132;
                canvas.height = img.naturalHeight || 40;
                const context = canvas.getContext('2d');
                context.drawImage(img, 0, 0);
                return canvas.toDataURL("image/png").replace(/^data:image\/?[A-z]*;base64,/, "");
            });

            if (!base64Captcha || base64Captcha.length < 100) {
                throw new Error('Failed to capture captcha image');
            }

            const captchaValue = await Captcha(base64Captcha, 5);
            
            if (!captchaValue) {
                throw new Error('Failed to solve captcha');
            }
            
            this.log(`Captcha solved: ${captchaValue}`);
            
            await this.page.type('#txtVerifyCode', captchaValue);
            await this.page.click('#btnLogin');

            await new Promise(resolve => setTimeout(resolve, 2000));

            const error_message = await this.page.evaluate(() => {
                const element = document.querySelector('#mb_con p');
                if (!element) return false;
                return element.innerText;
            });

            if (error_message) {
                this.error(`Error while login: ${error_message}`);
                throw new Error(`Login failed: ${error_message}`);
            }

            const is_authorized = await this.page.evaluate(() => {
                return location.pathname === '/Store.aspx';
            });

            if (is_authorized) {
                this.authorized = true;
                this.log('✅ Successfully authorized');
                
                // ⭐ RESET RETRY COUNTER ON SUCCESS
                this.authRetryCount = 0;
                
                await this.saveCookies();
                
                this.log('Waiting for Store.aspx iframe to be ready...');
                await this.page.waitForSelector('#frm_main_content', { timeout: 10000 });
                
                await this.page.waitForFunction(() => {
                    const iframe = document.querySelector('#frm_main_content');
                    if (!iframe) return false;
                    
                    try {
                        const iframe_document = iframe.contentWindow.document;
                        if (!iframe_document) return false;
                        
                        const hasContent = iframe_document.querySelector('#txtSearch') !== null;
                        return iframe_document.readyState === 'complete' && hasContent;
                    } catch (e) {
                        return false;
                    }
                }, { timeout: 10000 });
                
                this.log('Store.aspx iframe is fully loaded and ready');
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                this.log('Failed login - not redirected to Store.aspx');
                throw new Error('Login failed - no redirect');
            }
            
        } catch (error) {
            this.error(`Error during authorization: ${error.message}`);
            this.authorized = false;
            throw error; // ⭐ Don't retry, just throw
        } finally {
            this.authorizationInProgress = false;
            this.isAuthorizing = false;
            this.authorizationPromise = null;
        }
    }

    async saveCookies() {
        try {
            const cookies = await this.page.cookies();
            const cookiesPath = path.join(__dirname, 'cookiesmw.json');
            writeFileSync(cookiesPath, JSON.stringify(cookies, null, 4));
            this.log('Cookies saved successfully');
            return true;
        } catch (error) {
            this.error(`Error saving cookies: ${error.message}`);
            return false;
        }
    }// PART 2 OF 3 - Lines 651-1300
// Paste this AFTER Part 1

    async createGameAccount(userId, game) {
        return await this.queueOperation('createGameAccount', async () => {
            try {
                const generateRandomString = () => {
                    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                    let result = '';
                    for (let i = 0; i < 4; i++) {
                        result += chars.charAt(Math.floor(Math.random() * chars.length));
                    }
                    return result;
                };
                
                const login = `bc${generateRandomString()}_${generateRandomString()}`;
                const password = `bc${generateRandomString()}_${generateRandomString()}`;

                const gameAccount = new GameAccount({
                    userId,
                    gameId: game._id,
                    gameLogin: login,
                    gamePassword: password,
                    status: 'pending',
                    metadata: { createdVia: 'api' }
                });

                await gameAccount.save();

                const task = {
                    id: gameAccount._id.toString(),
                    type: 'create',
                    userId
                };

                const result = await this.createAccount(task);

                if (result && result.success) {
                    gameAccount.status = 'active';
                    gameAccount.gameLogin = result.login;
                    gameAccount.gamePassword = result.password;
                    
                    if (!gameAccount.metadata) {
                        gameAccount.metadata = {};
                    }
                    gameAccount.metadata.login = result.login;
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
                        if (!gameAccount.metadata) {
                            gameAccount.metadata = {};
                        }
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
            try {
                const gameAccount = await GameAccount.findOne({
                    userId,
                    gameLogin,
                    gameType: this.gameType
                }).sort({ createdAt: -1 });

                if (!gameAccount) {
                    throw new Error('Game account not found');
                }

                const task = {
                    id: gameAccount._id.toString(),
                    login: gameLogin
                };

                const balance = await this.getBalance(task);

                if (balance !== null && balance !== false) {
                    await gameAccount.updateBalance(balance);

                    return {
                        success: true,
                        data: {
                            gameLogin,
                            balance,
                            lastCheck: new Date(),
                            accountId: gameAccount._id
                        }
                    };
                } else {
                    return {
                        success: false,
                        data: null,
                        message: 'Failed to retrieve balance from game server'
                    };
                }

            } catch (error) {
                this.error(`Error getting balance: ${error.message}`);
                return {
                    success: false,
                    data: null,
                    message: error.message
                };
            }
        });
    }

    async rechargeAccount(userId, gameLogin, totalAmount, baseAmount, remark = 'API Recharge') {
        return await this.queueOperation(`recharge:${gameLogin}:${totalAmount}`, async () => {
            try {
                const gameAccount = await GameAccount.findOne({
                    userId,
                    gameLogin,
                    gameType: this.gameType
                });

                if (!gameAccount) {
                    throw new Error('Game account not found');
                }

                const transactionId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                const task = {
                    id: transactionId,
                    login: gameLogin,
                    amount: totalAmount,
                    remark,
                    is_manual: false
                };

                const result = await this.recharge(task);

                if (result && result !== -1) {
                    const updatedGameAccount = await GameAccount.findById(gameAccount._id);
                    
                    return {
                        success: true,
                        data: {
                            transactionId,
                            newBalance: updatedGameAccount.balance,
                            baseAmount: baseAmount,
                            bonusAmount: totalAmount - baseAmount,
                            totalAmount: totalAmount
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
                const gameAccount = await GameAccount.findOne({
                    userId,
                    gameLogin,
                    gameType: this.gameType
                });

                if (!gameAccount) {
                    throw new Error('Game account not found');
                }

                if (gameAccount.balance < totalAmount) {
                    throw new Error('Insufficient balance');
                }

                const task = {
                    id: null,
                    login: gameLogin,
                    amount: totalAmount,
                    remark,
                    is_manual: true
                };

                const result = await this.redeem(task);

                if (result && result !== -1) {
                    const updatedGameAccount = await GameAccount.findById(gameAccount._id);
                    
                    return {
                        success: true,
                        data: {
                            newBalance: updatedGameAccount.balance
                        },
                        message: 'Redeem completed successfully'
                    };
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
                const gameAccount = await GameAccount.findOne({
                    userId,
                    gameLogin,
                    gameType: this.gameType
                });

                if (!gameAccount) {
                    return {
                        success: false,
                        data: null,
                        message: 'Game account not found'
                    };
                }

                const task = {
                    id: gameAccount._id.toString()
                };

                const code = await this.getDownloadCode(task);

                if (code) {
                    gameAccount.downloadCode = code;
                    await gameAccount.save();

                    return {
                        success: true,
                        data: { downloadCode: code },
                        message: 'Download code retrieved successfully'
                    };
                } else {
                    return {
                        success: false,
                        data: null,
                        message: 'Failed to get download code'
                    };
                }

            } catch (error) {
                this.error(`Error getting download code: ${error.message}`);
                return {
                    success: false,
                    data: null,
                    message: error.message || 'Error retrieving download code'
                };
            }
        });
    }

    async resetAccountPassword(userId, gameLogin, newPassword) {
        return await this.queueOperation(`resetPassword:${gameLogin}`, async () => {
            try {
                const gameAccount = await GameAccount.findOne({
                    userId,
                    gameLogin,
                    gameType: this.gameType
                });

                if (!gameAccount) {
                    return {
                        success: false,
                        message: 'Game account not found'
                    };
                }

                const task = {
                    id: gameAccount._id.toString(),
                    type: 'reset',
                    login: gameLogin,
                    password: newPassword,
                    userId
                };

                const result = await this.resetPassword(task);

                if (result) {
                    gameAccount.gamePassword = newPassword;
                    await gameAccount.save();

                    return {
                        success: true,
                        data: {
                            gameLogin: gameLogin,
                            message: 'Password reset successfully'
                        },
                        message: 'Password reset completed successfully'
                    };
                } else {
                    return {
                        success: false,
                        message: 'Password reset failed'
                    };
                }

            } catch (error) {
                this.error(`Error resetting password: ${error.message}`);
                return {
                    success: false,
                    message: error.message || 'Error resetting password'
                };
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
                await this.page.goto('https://milkywayapp.xyz:8781/Store.aspx', { 
                    waitUntil: 'domcontentloaded',
                    timeout: 10000 
                });
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            const need_login = await this.page.evaluate(() => {
                const login_pathname = location.pathname === '/default.aspx';
                if (login_pathname) return true;
                const msg = document.querySelector('#mb_con p');
                return msg ? msg.innerText.indexOf('Session timeout. Please login again.') >= 0 : false;
            });

            if (need_login) {
                throw new Error('Session expired. Please refresh the page.');
            }

            await this.page.waitForSelector('#UserBalance', { timeout: 10000 });

            const balance = await this.page.evaluate(() => {
                const el = document.querySelector('#UserBalance');
                if (!el) return null;
                const txt = el.innerText || el.textContent || '';
                const m = txt.match(/([0-9][0-9,]*\.?[0-9]*)/);
                if (!m) return null;
                return parseFloat(m[1].replace(/,/g, ''));
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

    async getBalance({ id, login }) {
        console.log('getBalance called with:', id, login);
        
        try {
            await this.ensureBrowserReady();
            
            const currentPath = await this.page.evaluate(() => location.pathname);
            console.log('Current path:', currentPath);
            
            if (currentPath !== '/Store.aspx') {
                console.log('Not on Store.aspx, navigating...');
                await this.page.goto('https://milkywayapp.xyz:8781/Store.aspx', {
                    waitUntil: 'networkidle2',
                    timeout: 15000
                });
                
                await this.page.waitForSelector('#frm_main_content', { timeout: 10000 });
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            const needLogin = await this.page.evaluate(() => {
                return location.pathname === '/default.aspx';
            });
            
            if (needLogin) {
                throw new Error('Session expired. Please refresh the page.');
            }
            
            console.log('Checking iframe accessibility...');
            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            
            if (!iframeAccessible) {
                throw new Error('Page not ready. Please try again.');
            }
            
            console.log('Searching for account:', login);
            
            await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                const searchBox = iframe_document.querySelector('#txtSearch');
                
                searchBox.value = '';
                searchBox.value = login;
                
                iframe_document.querySelectorAll('#content a')[0].click();
            }, login);
            
            console.log('Search initiated, waiting for results...');
            
            await this.page.waitForFunction((login) => {
                try {
                    const iframe = document.querySelector('#frm_main_content');
                    if (!iframe) return false;
                    const iframe_document = iframe.contentWindow.document;
                    const items = iframe_document.querySelectorAll('#item tr');
                    
                    if (items.length < 2) return false;
                    
                    for (let i = 1; i < items.length; i++) {
                        const tds = items[i].querySelectorAll('td');
                        if (tds.length > 2) {
                            const accountName = tds[2].innerText.trim().toLowerCase();
                            if (accountName === login.toLowerCase()) {
                                return true;
                            }
                        }
                    }
                    return false;
                } catch (e) {
                    return false;
                }
            }, { timeout: 8000 }, login);
            
            console.log('Search results appeared');
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const login_selected = await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                const items = iframe_document.querySelectorAll('#item tr');
                
                console.log('Found', items.length, 'rows in search results');
                
                if (items.length < 2) {
                    console.log('No results found');
                    return false;
                }
                
                let matchingRows = [];
                
                for (let i = 1; i < items.length; i++) {
                    const tds = items[i].querySelectorAll('td');
                    if (tds.length > 2) {
                        const accountName = tds[2].innerText.trim().toLowerCase();
                        if (accountName === login.toLowerCase()) {
                            matchingRows.push(i);
                        }
                    }
                }
                
                console.log('Found', matchingRows.length, 'matching rows');
                
                if (matchingRows.length === 0) {
                    return false;
                }
                
                const latestRowIndex = matchingRows[matchingRows.length - 1];
                const latestRow = items[latestRowIndex];
                const tds = latestRow.querySelectorAll('td');
                
                console.log('Clicking on row', latestRowIndex);
                tds[0].querySelector('a').click();
                return true;
            }, login);
            
            console.log('Account selection result:', login_selected);
            
            if (!login_selected) {
                throw new Error(`Account ${login} not found`);
            }
            
            console.log('Waiting for account details to load...');
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const balance = await this.page.evaluate(() => {
                try {
                    const iframe = document.querySelector('#frm_main_content');
                    const iframe_document = iframe.contentWindow.document;
                    const balance_element = iframe_document.querySelector('#txtBalance');
                    
                    if (!balance_element) {
                        return false;
                    }
                    
                    const balanceText = balance_element.value || balance_element.innerText || balance_element.textContent;
                    const balanceValue = parseFloat(balanceText);
                    
                    return isNaN(balanceValue) ? false : balanceValue;
                } catch (e) {
                    return false;
                }
            });
            
            console.log('Balance retrieved:', balance);
            
            if (balance === false) {
                throw new Error('Could not retrieve balance');
            }
            
            this.log(`Current balance for ${login}: ${balance}`);
            
            try {
                const gameAccount = await GameAccount.findOne({ gameLogin: login });
                if (gameAccount) {
                    await gameAccount.updateBalance(balance);
                }
            } catch (dbError) {
                this.error(`Error updating balance in DB: ${dbError.message}`);
            }
            
            if (id) {
                await Tasks.approve(id, balance);
            }
            
            console.log('Navigating back to store main page...');
            await this.page.goto('https://milkywayapp.xyz:8781/Store.aspx', {
                waitUntil: 'networkidle2',
                timeout: 10000
            });
            
            await this.page.waitForSelector('#frm_main_content', { timeout: 10000 });
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            console.log('Back on main store page, ready for next operation');
            
            return balance;
            
        } catch (error) {
            console.error('Error during get balance:', error.message);
            this.error(`Error during get balance: ${error.message}`);
            
            if (id) {
                await Tasks.error(id, error.message);
            }
            
            throw error;
        }
    }

    async getDownloadCode(task) {
        try {
            await this.ensureBrowserReady();
            
            const need_login = await this.page.evaluate(() => {
                const msg = document.querySelector('#mb_con p');
                return msg ? msg.innerText.indexOf('Session timeout. Please login again.') >= 0 : false;
            });

            if (need_login) {
                throw new Error('Session expired. Please refresh the page.');
            }

            await this.page.goto('https://milkywayapp.xyz:8781/IphoneCode.aspx', {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            await new Promise(resolve => setTimeout(resolve, 1000));

            const code = await this.page.evaluate(() => {
                const codeEl = document.querySelector("#IphoneCodeTex");
                return codeEl ? codeEl.innerText : null;
            });

            if (!code) {
                throw new Error('Download code not found');
            }

            this.log(`Download code: ${code}`);

            try {
                const gameAccount = await GameAccount.findById(task.id);
                if (gameAccount) {
                    gameAccount.downloadCode = code;
                    await gameAccount.save();
                }
            } catch (error) {
                this.error(`Error saving download code to DB: ${error.message}`);
            }

            await Tasks.approve(task.id, code);
            
            await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });

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
                for (let i = 0; i < 4; i++) {
                    result += chars.charAt(Math.floor(Math.random() * chars.length));
                }
                return result;
            };
            
            const login = `bc${generateRandomString()}_${generateRandomString()}`;
            const password = `bc${generateRandomString()}_${generateRandomString()}`;
            
            console.log(`Generated credentials - Login: ${login}, Password: ${password}`);

            console.log('Step 1: Checking page state...');
            const currentPath = await this.page.evaluate(() => location.pathname);
            console.log('Current path:', currentPath);
            
            if (currentPath === '/default.aspx') {
                throw new Error('Session expired. Please refresh the page.');
            }
            console.log('✅ On correct page');

            console.log('Step 2: Waiting for main iframe to be ready...');
            await this.page.waitForSelector('#frm_main_content', { timeout: 10000 });
            
            await this.page.waitForFunction(() => {
                const iframe = document.querySelector('#frm_main_content');
                if (!iframe) return false;
                
                try {
                    const iframe_document = iframe.contentWindow.document;
                    if (!iframe_document) return false;
                    
                    const hasContent = iframe_document.querySelector('#txtSearch') !== null;
                    return iframe_document.readyState === 'complete' && hasContent;
                } catch (e) {
                    return false;
                }
            }, { timeout: 15000 });
            
            console.log('✅ Main iframe ready');
            await new Promise(resolve => setTimeout(resolve, 1500));

            console.log('Step 3: Verifying iframe accessibility...');
            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            
            if (!iframeAccessible) {
                throw new Error('Page not ready. Please try again.');
            }
            console.log('✅ Iframe verified accessible');

            console.log('Step 4: Clicking Add Account button...');
            await this.page.evaluate(() => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                const buttons = iframe_document.querySelectorAll('#content a');
                buttons[1].click();
            });
            console.log('✅ Add Account button clicked');

            console.log('Step 5: Waiting for account creation dialog...');
            await this.page.waitForSelector('#DialogBySHF iframe', { timeout: 15000 });
            console.log('✅ Dialog selector found');
            
            await new Promise(resolve => setTimeout(resolve, 2000));

            console.log('Step 6: Verifying dialog iframe accessibility...');
            await this.page.waitForFunction(() => {
                const iframe = document.querySelector('#DialogBySHF iframe');
                if (!iframe) return false;
                
                try {
                    const iframe_document = iframe.contentWindow.document;
                    if (!iframe_document) return false;
                    
                    const accountInput = iframe_document.querySelector('#txtAccount');
                    const nickNameInput = iframe_document.querySelector('#txtNickName');
                    const passInput = iframe_document.querySelector('#txtLogonPass');
                    const pass2Input = iframe_document.querySelector('#txtLogonPass2');
                    const button = iframe_document.querySelector('a');
                    
                    return accountInput && nickNameInput && passInput && pass2Input && button;
                } catch (e) {
                    return false;
                }
            }, { timeout: 10000 });
            
            console.log('✅ Dialog iframe verified and form elements ready');
            await new Promise(resolve => setTimeout(resolve, 500));

            console.log('Step 7: Filling account creation form...');
            const formFilled = await this.page.evaluate(({ login, password }) => {
                try {
                    const iframe = document.querySelector('#DialogBySHF iframe');
                    if (!iframe) return false;
                    
                    const iframe_document = iframe.contentWindow.document;
                    
                    const accountInput = iframe_document.querySelector('#txtAccount');
                    const nickNameInput = iframe_document.querySelector('#txtNickName');
                    const passInput = iframe_document.querySelector('#txtLogonPass');
                    const pass2Input = iframe_document.querySelector('#txtLogonPass2');
                    const button = iframe_document.querySelector('a');
                    
                    if (!accountInput || !nickNameInput || !passInput || !pass2Input || !button) {
                        return false;
                    }
                    
                    accountInput.value = login;
                    nickNameInput.value = login;
                    passInput.value = password;
                    pass2Input.value = password;
                    
                    button.click();
                    
                    return true;
                } catch (e) {
                    return false;
                }
            }, { login, password });

            if (!formFilled) {
                throw new Error('Failed to fill account creation form');
            }
            console.log('✅ Form filled and submitted');

            console.log('Step 8: Waiting for result message...');
            await this.page.waitForSelector('#mb_con p', { timeout: 30000 });
            
            const message = await this.page.evaluate(() => {
                const msgEl = document.querySelector('#mb_con p');
                return msgEl ? msgEl.innerText : 'No message found';
            });
            
            console.log('Result message:', message);

            console.log('Step 9: Closing dialogs...');
            await this.page.click("#mb_btn_ok");
            await new Promise(resolve => setTimeout(resolve, 500));
            
            try {
                const closeButton = await this.page.$('#Close');
                if (closeButton) {
                    await this.page.click('#Close');
                    console.log('✅ Dialog closed');
                }
            } catch (e) {
                console.log('No close button found or already closed');
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));

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
                        gameAccount.status = 'active';
                        gameAccount.gameLogin = login;
                        gameAccount.gamePassword = password;
                        
                        if (!gameAccount.metadata) {
                            gameAccount.metadata = {};
                        }
                        gameAccount.metadata.login = login;
                        gameAccount.metadata.password = password;
                        await gameAccount.save();
                        console.log('✅ Database updated');
                    }
                } catch (error) {
                    console.log('DB update error:', error.message);
                }

                await Tasks.approve(id);
                
                console.log('✅ CREATE ACCOUNT COMPLETE');
                return {
                    success: true,
                    login: login,
                    password: password
                };
                
            } else {
                console.log('❌ Account creation failed:', message);
                this.error(`Error while creating account: ${message}`);

                try {
                    const gameAccount = await GameAccount.findById(id);
                    if (gameAccount) {
                        gameAccount.status = 'failed';
                        if (!gameAccount.metadata) {
                            gameAccount.metadata = {};
                        }
                        gameAccount.metadata.notes = message;
                        await gameAccount.save();
                    }
                } catch (error) {
                    console.log('DB update error:', error.message);
                }

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
                    if (!gameAccount.metadata) {
                        gameAccount.metadata = {};
                    }
                    gameAccount.metadata.notes = error.message;
                    await gameAccount.save();
                }
            } catch (dbError) {
                console.log('Failed to update DB with error:', dbError.message);
            }
            
            throw error;
        }
    }// PART 3 OF 3 - Lines 1301-End (FINAL)
// Paste this AFTER Part 2

    async recharge({ id, login, amount, remark, is_manual }) {
        console.log('🔴 RECHARGE START:', { id, login, amount, remark, is_manual });
        
        try {
            await this.ensureBrowserReady();
            
            const currentPath = await this.page.evaluate(() => location.pathname);
            
            if (currentPath === '/default.aspx') {
                throw new Error('Session expired. Please refresh the page.');
            }

            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            if (!iframeAccessible) {
                throw new Error('Page not ready. Please try again.');
            }

            await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                iframe_document.querySelector('#txtSearch').value = login;
                iframe_document.querySelectorAll('#content a')[0].click();
            }, login);

            await this.page.waitForFunction((login) => {
                const iframe = document.querySelector('#frm_main_content');
                if (!iframe) return false;
                const iframe_document = iframe.contentWindow.document;
                const items = iframe_document.querySelectorAll('#item tr');
                return items.length >= 2;
            }, { timeout: 5000 }, login);

            await new Promise(resolve => setTimeout(resolve, 1000));

            const login_selected = await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                const items = iframe_document.querySelectorAll('#item tr');

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

            if (!login_selected) {
                throw new Error(`Account ${login} not found`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.page.evaluate(() => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                const links = iframe_document.querySelectorAll('.btn12');
                links[1].click();
            });

            await this.page.waitForSelector('#Container iframe', { timeout: 10000 });
            
            await this.page.waitForFunction(() => {
                const iframe = document.querySelector('#Container iframe');
                if (!iframe) return false;
                
                try {
                    const iframe_document = iframe.contentWindow.document;
                    const balance_input = iframe_document.querySelector('#txtLeScore');
                    const amount_input = iframe_document.querySelector('#txtAddGold');
                    const remark_input = iframe_document.querySelector('#txtReason');
                    const button = iframe_document.querySelector('#Button1');
                    
                    return balance_input && amount_input && remark_input && button;
                } catch (e) {
                    return false;
                }
            }, { timeout: 10000 });
            
            await new Promise(resolve => setTimeout(resolve, 1500));

            const current_balance = await this.page.evaluate(() => {
                const iframe = document.querySelector('#Container iframe');
                const iframe_document = iframe.contentWindow.document;
                const balance_input = iframe_document.querySelector('#txtLeScore');

                if (!balance_input) return false;
                return parseInt(balance_input.value);
            });

            if (current_balance >= 2) {
                throw new Error(`Balance is more than $2 (${current_balance}). Cannot recharge.`);
            }

            const session_amount = await this.page.evaluate(({ amount, remark }) => {
                const iframe = document.querySelector('#Container iframe');
                const iframe_document = iframe.contentWindow.document;

                const amount_input = iframe_document.querySelector('#txtAddGold');
                const remark_input = iframe_document.querySelector('#txtReason');
                const button = iframe_document.querySelector('#Button1');

                if (!amount_input || !remark_input || !button) return false;

                const balance_input = iframe_document.querySelector('#txtLeScore');
                const session_amount = parseInt(balance_input.value) + amount;

                amount_input.value = '';
                amount_input.focus();
                amount_input.value = amount.toString();
                amount_input.dispatchEvent(new Event('input', { bubbles: true }));
                amount_input.dispatchEvent(new Event('change', { bubbles: true }));
                
                remark_input.value = '';
                remark_input.value = remark;
                
                button.click();

                return session_amount;
            }, { amount, remark });

            if (!session_amount) {
                throw new Error('Failed to submit recharge form');
            }

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
                    if (gameAccount) {
                        await gameAccount.updateBalance(session_amount, id);
                    }
                } catch (dbError) {
                    this.error(`Error updating balance in DB: ${dbError.message}`);
                }
                
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
            
            if (currentPath === '/default.aspx') {
                throw new Error('Session expired. Please refresh the page.');
            }

            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            if (!iframeAccessible) {
                throw new Error('Page not ready. Please try again.');
            }

            await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;

                const checkbox = iframe_document.querySelector('#ShowHideAccount_0');
                if (checkbox && !checkbox.checked) {
                    checkbox.click();
                }

                iframe_document.querySelector('#txtSearch').value = login;
                iframe_document.querySelectorAll('#content a')[0].click();
            }, login);

            await this.page.waitForFunction((login) => {
                const iframe = document.querySelector('#frm_main_content');
                if (!iframe) return false;
                const iframe_document = iframe.contentWindow.document;
                const items = iframe_document.querySelectorAll('#item tr');
                return items.length >= 2;
            }, { timeout: 5000 }, login);

            await new Promise(resolve => setTimeout(resolve, 1000));

            const login_selected = await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                const items = iframe_document.querySelectorAll('#item tr');

                if (items.length < 2) return false;

                for (let i = 1; i < items.length; i++) {
                    const tds = items[i].querySelectorAll('td');
                    const accountName = tds[2].innerText.trim().toLowerCase();
                    
                    if (accountName === login.toLowerCase()) {
                        tds[0].querySelector('a').click();
                        return true;
                    }
                }
                
                return false;
            }, login);

            if (!login_selected) {
                throw new Error(`Account ${login} not found`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.page.evaluate(() => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                const links = iframe_document.querySelectorAll('.btn12');
                links[2].click();
            });

            await this.page.waitForSelector('#Container iframe', { timeout: 10000 });
            await new Promise(resolve => setTimeout(resolve, 1000));

            const current_balance = await this.page.evaluate(() => {
                const iframe = document.querySelector('#Container iframe');
                if (!iframe) return false;
                
                const iframe_document = iframe.contentWindow.document;
                const balance_input = iframe_document.querySelector('#txtLeScore');

                if (!balance_input) return false;
                
                const balanceValue = balance_input.value;
                return parseFloat(parseFloat(balanceValue).toFixed(2));
            });

            if (current_balance === false) {
                throw new Error('Could not read balance from redeem dialog');
            }

            if (!is_manual) {
                if (parseInt(current_balance) !== parseInt(amount)) {
                    await Tasks.cancel(id, parseInt(current_balance));
                    return true;
                }
            }

            if (is_manual) {
                if (parseInt(current_balance) < parseInt(amount)) {
                    await Tasks.cancel(id, parseInt(current_balance));
                    return true;
                }
            }

            const processed = await this.page.evaluate(({ amount, remark }) => {
                const iframe = document.querySelector('#Container iframe');
                if (!iframe) return false;
                
                const iframe_document = iframe.contentWindow.document;

                const amount_input = iframe_document.querySelector('#txtAddGold');
                const remark_input = iframe_document.querySelector('#txtReason');
                const button = iframe_document.querySelector('#Button1');

                if (!amount_input || !remark_input || !button) return false;

                amount_input.value = amount;
                remark_input.value = remark;
                button.click();

                return true;
            }, { amount, remark });

            if (!processed) {
                throw new Error('Failed to fill redeem form');
            }

            await this.page.waitForSelector('#mb_con p', { timeout: 30000 });

            const result = await this.page.evaluate(() => {
                const closeButton = document.querySelector('#Close');
                if (closeButton) closeButton.click();
                const messageEl = document.querySelector('#mb_con p');
                return messageEl ? messageEl.innerText : 'No message found';
            });

            await this.page.click("#mb_btn_ok");
            await new Promise(resolve => setTimeout(resolve, 500));

            if (result === "Confirmed successful") {
                const newBalance = parseFloat((current_balance - amount).toFixed(2));
                this.log(`Successfully cashout ${amount} from login ${login}`);
                
                try {
                    const gameAccount = await GameAccount.findOne({ gameLogin: login });
                    if (gameAccount) {
                        await gameAccount.updateBalance(newBalance, id);
                    }
                } catch (dbError) {
                    this.error(`Error updating balance in DB: ${dbError.message}`);
                }
                
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
            
            if (currentPath === '/default.aspx') {
                throw new Error('Session expired. Please refresh the page.');
            }

            const iframeAccessible = await this.isIframeAccessible('#frm_main_content');
            if (!iframeAccessible) {
                throw new Error('Page not ready. Please try again.');
            }

            await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;

                const checkbox = iframe_document.querySelector('#ShowHideAccount_0');
                if (checkbox && !checkbox.checked) {
                    checkbox.click();
                }

                iframe_document.querySelector('#txtSearch').value = login;
                iframe_document.querySelectorAll('#content a')[0].click();
            }, login);

            await this.page.waitForFunction((login) => {
                const iframe = document.querySelector('#frm_main_content');
                if (!iframe) return false;
                const iframe_document = iframe.contentWindow.document;
                const items = iframe_document.querySelectorAll('#item tr');
                return items.length >= 2;
            }, { timeout: 5000 }, login);

            await new Promise(resolve => setTimeout(resolve, 1000));

            const login_selected = await this.page.evaluate(login => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                const items = iframe_document.querySelectorAll('#item tr');

                if (items.length < 2) return false;

                for (let i = 1; i < items.length; i++) {
                    const tds = items[i].querySelectorAll('td');
                    const accountName = tds[2].innerText.trim().toLowerCase();
                    
                    if (accountName === login.toLowerCase()) {
                        tds[0].querySelector('a').click();
                        return true;
                    }
                }
                
                return false;
            }, login);

            if (!login_selected) {
                throw new Error(`Account ${login} not found`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.page.evaluate(() => {
                const iframe = document.querySelector('#frm_main_content');
                const iframe_document = iframe.contentWindow.document;
                const links = iframe_document.querySelectorAll('.btn13');
                links[1].click();
            });

            await this.page.waitForSelector('#Container iframe', { timeout: 10000 });
            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.page.waitForFunction(() => {
                const iframe = document.querySelector('#Container iframe');
                if (!iframe) return false;
                
                try {
                    const iframe_document = iframe.contentWindow.document;
                    const new_password = iframe_document.querySelector('#txtConfirmPass');
                    const confirm_password = iframe_document.querySelector('#txtSureConfirmPass');
                    const button = iframe_document.querySelector('#Button1');
                    
                    return new_password && confirm_password && button;
                } catch (e) {
                    return false;
                }
            }, { timeout: 10000 });

            await new Promise(resolve => setTimeout(resolve, 500));

            const processed = await this.page.evaluate(({ password }) => {
                const iframe = document.querySelector('#Container iframe');
                if (!iframe) return false;
                
                const iframe_document = iframe.contentWindow.document;

                const new_password = iframe_document.querySelector('#txtConfirmPass');
                const confirm_password = iframe_document.querySelector('#txtSureConfirmPass');
                const button = iframe_document.querySelector('#Button1');

                if (!new_password || !confirm_password || !button) return false;

                new_password.value = password;
                confirm_password.value = password;
                button.click();

                return true;
            }, { password });

            if (!processed) {
                throw new Error('Failed to fill reset password form');
            }

            await this.page.waitForSelector('#mb_con p', { timeout: 30000 });

            const result = await this.page.evaluate(() => {
                const closeButton = document.querySelector('#Close');
                if (closeButton) closeButton.click();
                const messageEl = document.querySelector('#mb_con p');
                return messageEl ? messageEl.innerText : 'No message found';
            });

            await this.page.click("#mb_btn_ok");
            await new Promise(resolve => setTimeout(resolve, 500));

            if (result === "Modified success!") {
                this.log(`Password for login ${login} has been restored!`);
                
                try {
                    const gameAccount = await GameAccount.findOne({ gameLogin: login });
                    if (gameAccount) {
                        gameAccount.gamePassword = password;
                        await gameAccount.save();
                    }
                } catch (dbError) {
                    this.error(`Error updating password in DB: ${dbError.message}`);
                }
                
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
                if (!m) return null;
                return parseFloat(m[1].replace(/,/g, ''));
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
            const task = await Tasks.get('milkyways');

            if (!task) {
                return setTimeout(this.checkQueue.bind(this), 1000);
            }

            console.log('Processing task:', task);

            let task_result = null;

            switch (task.type) {
                case 'get_balance':
                    task_result = await this.getBalance(task);
                    break;
                case 'get_admin_balance':
                    task_result = await this.getBalanceAdmin(task);
                    break;
                case 'recharge':
                    task_result = await this.recharge(task);
                    break;
                case 'redeem':
                    task_result = await this.redeem(task);
                    break;
                case 'create':
                    task_result = await this.createAccount(task);
                    break;
                case 'reset':
                    task_result = await this.resetPassword(task);
                    break;
                case 'download_code':
                    task_result = await this.getDownloadCode(task);
                    break;
                default:
                    this.error(`Unknown task type: ${task.type}`);
            }

            if (task_result === -1) {
                return;
            }

            return setTimeout(this.checkQueue.bind(this), 5000);
        } catch (error) {
            this.error(`Error in checkQueue: ${error.message}`);
            setTimeout(this.checkQueue.bind(this), 5000);
        }
    }
}

// Export singleton instance
const milkyWaysController = new MilkyWaysController();
module.exports = milkyWaysController;