// controllers/AllInOneController.js
const Puppeteer = require('puppeteer');
const Captcha = require('../lib/captcha.js');
const { writeFileSync, readFileSync, existsSync } = require('fs');
const Tasks = require('../lib/tasks.js');
const Logger = require('../utils/logger.js');
const GameAccount = require('../models/GameAccount.js');
const Game = require('../models/Game.js');
const path = require('path');

class AllInOneController {
    constructor() {
        this.browser = null;
        this.page = null;
        this.cookies = null;
        this.authorized = false;
        this.logger = Logger('AllInOne');
        this.gameType = 'allinone';
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

        // ⭐ QUEUE SYSTEM
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.maxConcurrentRequests = 1;

        // ⭐ INITIALIZATION STATE
        this.isInitializing = false;
        this.initializationPromise = null;
        this.browserReady = false;

        // ⭐ AUTHORIZATION STATE
        this.isAuthorizing = false;
        this.authorizationPromise = null;
        this.authorizationInProgress = false;

        // ⭐ SESSION MANAGEMENT
        this.sessionTimeout = null;
        this.lastSuccessfulOperation = Date.now();
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 3;

        this.loadAgentCredentials().catch(err => {
            this.error(`Failed to load credentials on startup: ${err.message}`);
        });

        // Session timeout checker
        this.startSessionMonitor();

        process.on('unhandledRejection', e => {
            this.logger.error(e);
        });

        process.on('uncaughtException', e => {
            this.logger.error(e);
        });
    }

    log(log) { this.logger.log(`${log}`) }
    error(log) { this.logger.error(`${log}`) }

    timeout(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms, true));
    }

    // ========================================
    // SESSION MONITORING
    // ========================================

    startSessionMonitor() {
        setInterval(async () => {
            if (!this.initialized || !this.page || !this.browser) return;

            const timeSinceLastActivity = Date.now() - this.lastSuccessfulOperation;
            
            if (timeSinceLastActivity > this.activityTimeout) {
                this.log('Session timeout detected, reinitializing...');
                await this.reinitialize();
            }
        }, 60000); // Check every minute
    }

    async reinitialize() {
        this.log('Reinitializing browser session...');
        this.initialized = false;
        this.browserReady = false;
        this.authorized = false;
        
        // Clear cache
        this.cache.adminBalance = null;
        this.cache.adminBalanceTimestamp = null;
        
        try {
            await this.initialize();
        } catch (error) {
            this.error(`Reinitialization failed: ${error.message}`);
        }
    }

    // ========================================
    // QUEUE SYSTEM IMPLEMENTATION
    // ========================================

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
                await this.ensureBrowserReady();
                
                const startTime = Date.now();
                const result = await task.function();
                const executionTime = Date.now() - startTime;
                
                this.log(`✅ Completed: "${task.name}" in ${executionTime}ms`);
                this.lastSuccessfulOperation = Date.now();
                this.consecutiveErrors = 0;
                task.resolve(result);
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                this.error(`❌ Failed: "${task.name}" - ${error.message}`);
                this.consecutiveErrors++;
                
                if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
                    this.error(`Too many consecutive errors (${this.consecutiveErrors}), reinitializing...`);
                    await this.reinitialize();
                    this.consecutiveErrors = 0;
                }
                
                task.reject(error);
            }
        }
        
        this.isProcessingQueue = false;
        this.log('🏁 Queue processor stopped');
    }

    // ========================================
    // BROWSER STATE VALIDATION
    // ========================================

    async ensureBrowserReady() {
        if (!this.browser || !this.page) {
            this.log('Browser or page missing, reinitializing...');
            await this.initialize();
            return;
        }

        try {
            if (this.page.isClosed()) {
                this.log('Page is closed, reinitializing...');
                await this.initialize();
                return;
            }
        } catch (error) {
            this.log('Error checking page state, reinitializing...');
            await this.initialize();
            return;
        }

        try {
            const version = await this.browser.version();
            if (!version) {
                throw new Error('Browser not responding');
            }
        } catch (error) {
            this.log('Browser not responding, reinitializing...');
            await this.initialize();
            return;
        }

        if (!this.authorized) {
            this.log('Not authorized, checking authorization...');
            await this.checkAuthorization();
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

    // ========================================
    // CORE METHODS
    // ========================================

    async loadAgentCredentials() {
        try {
            const game = await Game.findOne({ 
                shortcode: 'AIO',
                status: { $in: ['active', 'maintenance'] } 
            });

            if (!game) {
                throw new Error('AllInOne game not found in database');
            }

            if (!game.agentUsername || !game.agentPassword) {
                throw new Error('Agent credentials not configured for AllInOne');
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
            return this.initialize();
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

    async clearBrowserCookies() {
        try {
            const client = await this.page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            return true;
        } catch (error) {
            this.error(`Error clearing cookies: ${error.message}`);
            return false;
        }
    }

    async createBrowser() {
        this.log('Initializing browser for AllInOne...');
        
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
                "--no-default-browser-check"
            ],
            ignoreHTTPSErrors: true,
            defaultViewport: {
                width: 1312,
                height: 800
            }
        });

        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();

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

        // Load cookies
        const cookiesPath = path.join(__dirname, 'cookies.json');
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

        // Load session
        const sessionPath = path.join(__dirname, 'session.json');
        if (existsSync(sessionPath)) {
            try {
                const session = readFileSync(sessionPath).toString();
                const session_parsed = JSON.parse(session);

                await this.page.evaluateOnNewDocument(session_parsed => {
                    for (const key of Object.keys(session_parsed)) {
                        sessionStorage.setItem(key, session_parsed[key]);
                    }
                }, session_parsed);
                
                this.log('Session loaded successfully');
            } catch (error) {
                this.log('Error loading session, continuing without it');
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
                this.log('Authorization already in progress, skipping...');
                return;
            }

            if (!this.page || this.page.isClosed()) {
                this.log('Page is closed, recreating browser...');
                await this.createBrowser();
                return;
            }

            this.log('Checking authorization status...');
            
            await this.page.goto(`https://agentserver.mrallinone777.com/admin/player/index`, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });

            await new Promise(resolve => setTimeout(resolve, 1500));

            const isLoginPage = await this.page.evaluate(() => {
                if (location.pathname === '/admin/login') return true;
                const div = document.querySelector('div[aria-label="Login timeout"]');
                if (div) return true;
                return false;
            });

            if (isLoginPage) {
                this.authorized = false;
                this.log('Redirected to login page - need to authorize');
                await this.authorize();
                return;
            } else {
                this.log('Already authorized');
                this.authorized = true;
                await new Promise(resolve => setTimeout(resolve, 1000));
                this.checkQueue();
                return true;
            }
        } catch (error) {
            this.error(`Error checking authorization: ${error.message}`);
            
            if (error.message.includes('detached Frame') || 
                error.message.includes('Target closed') ||
                error.message.includes('Session closed')) {
                this.log('Detected detached frame, recreating browser...');
                this.browserReady = false;
                this.initialized = false;
                await this.createBrowser();
                return;
            }
            
            if (!this.isAuthorizing) {
                setTimeout(() => this.checkAuthorization(), 5000);
            }
        }
    }

    async authorize() {
        if (this.authorizationInProgress) {
            this.log('Authorization already in progress, waiting...');
            if (this.authorizationPromise) {
                await this.authorizationPromise;
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
            return;
        }

        this.authorizationInProgress = true;
        this.isAuthorizing = true;
        
        this.authorizationPromise = (async () => {
            try {
                this.log('Starting authorization...');
                
                if (!this.page || this.page.isClosed()) {
                    this.log('Page is invalid, recreating browser...');
                    await this.createBrowser();
                    return;
                }

                await this.clearBrowserCookies();
                await this.page.goto(`https://agentserver.mrallinone777.com/admin/login`, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });

                await this.page.waitForSelector('input[name="username"]', { timeout: 10000 });
                await this.page.waitForSelector('input[name="password"]', { timeout: 10000 });
                await this.page.waitForSelector('#verifyCanvas', { timeout: 10000 });

                if (!this.agentCredentials) {
                    const credentialsLoaded = await this.loadAgentCredentials();
                    if (!credentialsLoaded) {
                        throw new Error('Cannot authorize without agent credentials');
                    }
                }

                this.log(`Using agent credentials: ${this.agentCredentials.username}`);
                
                await this.page.type('input[name="username"]', this.agentCredentials.username);
                await this.page.type('input[name="password"]', this.agentCredentials.password);

                await this.timeout(1000);

                // Get captcha image
                const base64Captcha = await this.page.evaluate(() => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 132;
                    canvas.height = 40;

                    const context = canvas.getContext('2d');
                    context.drawImage(document.querySelector('#verifyCanvas'), 0, 0, 132, 40);

                    return canvas.toDataURL("image/png").replace(/^data:image\/?[A-z]*;base64,/, "");
                });

                this.log('Solving captcha...');
                const captchaValue = await Captcha(base64Captcha, 4);
                this.log(`Captcha solved: ${captchaValue}`);

                await this.page.type('input[name="captcha"]', captchaValue);
                await this.page.click('button[type="submit"]');

                await this.timeout(2000);

                const error_message = await this.page.evaluate(() => {
                    const element = document.querySelector('.layui-layer-msg');
                    if (element) return element.innerText;
                    return false;
                });

                if (error_message && error_message !== "Users login succeeded") {
                    this.error(`Failed login: ${error_message}`);
                    throw new Error(`Login failed: ${error_message}`);
                }

                await this.timeout(2000);

                const is_logged_in = await this.page.evaluate(() => {
                    return location.pathname === '/admin';
                });

                if (is_logged_in) {
                    this.authorized = true;
                    this.log('Successfully authorized');
                    await this.saveCookies();
                    
                    await this.page.goto(`https://agentserver.mrallinone777.com/admin/player/index`, {
                        waitUntil: 'domcontentloaded',
                        timeout: 15000
                    });
                    
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    this.checkQueue();
                } else {
                    this.log('Failed login - not redirected to admin page');
                    throw new Error('Login failed - no redirect');
                }
                
            } catch (error) {
                this.error(`Error during authorization: ${error.message}`);
                this.authorized = false;
                
                if (error.message.includes('detached Frame') || 
                    error.message.includes('Target closed') ||
                    error.message.includes('Session closed')) {
                    this.log('Browser session lost, recreating...');
                    this.browserReady = false;
                    this.initialized = false;
                    setTimeout(async () => {
                        await this.createBrowser();
                    }, 5000);
                    return;
                }
                
                setTimeout(() => this.authorize(), 5000);
            } finally {
                this.authorizationInProgress = false;
                this.isAuthorizing = false;
                this.authorizationPromise = null;
            }
        })();

        await this.authorizationPromise;
    }

    async saveCookies() {
        try {
            const cookies = await this.page.cookies();
            const cookiesPath = path.join(__dirname, 'cookies.json');
            writeFileSync(cookiesPath, JSON.stringify(cookies, null, 4));

            const session = await this.page.evaluate(() => {
                return {
                    expires_time: sessionStorage.getItem('expires_time'),
                    money_error: sessionStorage.getItem('money_error'),
                    money_timer: sessionStorage.getItem('money_timer'),
                    ajax_error: sessionStorage.getItem('ajax_error'),
                    roleName: sessionStorage.getItem('roleName'),
                    money: sessionStorage.getItem('money'),
                    userName: sessionStorage.getItem('userName'),
                    token: sessionStorage.getItem('token'),
                    "lay-id": sessionStorage.getItem('lay-id')
                }
            });

            const sessionPath = path.join(__dirname, 'session.json');
            writeFileSync(sessionPath, JSON.stringify(session, null, 4));

            this.log('Cookies and session saved successfully');
            return true;
        } catch (error) {
            this.error(`Error saving cookies: ${error.message}`);
            return false;
        }
    }

    async checkQueue() {
        try {
            const task = await Tasks.get('allinone');

            if (!task) {
                return setTimeout(this.checkQueue.bind(this), 5000);
            }

            console.log('Processing task:', task);

            let task_result = null;

            switch (task.type) {
                case 'download_code':
                    task_result = await this.getDownloadCode(task);
                    break;
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

    // ========================================
    // API METHODS WITH QUEUE
    // ========================================

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

                console.log(`Generated credentials for API - Login: ${login}, Password: ${password}`);

                const gameAccount = new GameAccount({
                    userId,
                    gameId: game._id,
                    gameLogin: login,
                    gamePassword: password,
                    status: 'pending',
                    metadata: {
                        createdVia: 'api'
                    }
                });

                await gameAccount.save();

                const task = {
                    id: gameAccount._id.toString(),
                    type: 'create',
                    userId,
                    login,
                    password
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
            console.log('=== getGameBalance (Queued) ===');
            console.log('userId:', userId);
            console.log('gameLogin:', gameLogin);
            
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

                if (balance !== null && balance !== false && balance !== -1) {
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
                console.log("Recharge (Queued) - Finding game account...");
                console.log(`Base Amount: $${baseAmount}, Total Amount (with bonus): $${totalAmount}`);
                
                const gameAccount = await GameAccount.findOne({
                    userId,
                    gameLogin,
                    gameType: this.gameType
                });

                if (!gameAccount) {
                    throw new Error('Game account not found');
                }

                const transaction = {
                    type: 'recharge',
                    amount: baseAmount,
                    remark,
                    status: 'pending',
                    metadata: {
                        baseAmount: baseAmount,
                        bonusAmount: totalAmount - baseAmount,
                        totalAmount: totalAmount,
                        note: 'Includes 10% bonus'
                    }
                };

                await gameAccount.addTransaction(transaction);
                const transactionId = gameAccount.transactions[gameAccount.transactions.length - 1]._id;
                console.log(`✅ Transaction created: ${transactionId} with base amount: $${baseAmount}`);

                const task = {
                    id: transactionId.toString(),
                    login: gameLogin,
                    amount: totalAmount,
                    remark,
                    is_manual: false
                };

                console.log(`Calling recharge with total amount: $${totalAmount}`);
                const result = await this.recharge(task);

                if (result && result !== -1) {
                    const updatedGameAccount = await GameAccount.findById(gameAccount._id);
                    
                    console.log(`✅ Recharge successful`);
                    console.log(`   - User paid: $${baseAmount}`);
                    console.log(`   - Bonus: $${totalAmount - baseAmount}`);
                    console.log(`   - Total recharged in game: $${totalAmount}`);
                    console.log(`   - New balance: $${updatedGameAccount.balance}`);
                    
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
                console.log('🔵 redeemFromAccount START:', { userId, gameLogin, totalAmount, cashoutAmount, remark });
                
                const gameAccount = await GameAccount.findOne({
                    userId,
                    gameLogin,
                    gameType: this.gameType
                });

                if (!gameAccount) {
                    console.log('❌ Game account not found in database');
                    throw new Error('Game account not found');
                }
                console.log('✅ Game account found:', gameAccount._id);

                if (gameAccount.balance < totalAmount) {
                    console.log(`❌ Insufficient balance: Has ${gameAccount.balance}, needs ${totalAmount}`);
                    throw new Error('Insufficient balance');
                }
                console.log('✅ Balance sufficient');

                const task = {
                    id: null,
                    login: gameLogin,
                    amount: totalAmount,
                    remark,
                    is_manual: true
                };

                console.log('Calling redeem with task:', task);
                const result = await this.redeem(task);
                console.log('Redeem result:', result);

                if (result && result !== -1) {
                    console.log('✅ Redeem successful, fetching updated balance...');
                    const updatedGameAccount = await GameAccount.findById(gameAccount._id);
                    
                    return {
                        success: true,
                        data: {
                            newBalance: updatedGameAccount.balance
                        },
                        message: 'Redeem completed successfully'
                    };
                } else {
                    console.log('❌ Redeem returned false or -1');
                    throw new Error('Redeem failed');
                }

            } catch (error) {
                console.log('❌ redeemFromAccount ERROR:', error.message);
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

                if (code && code !== -1) {
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

                if (result && result !== -1) {
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
            
            if (balance !== false && balance !== -1 && balance !== null) {
                this.cache.adminBalance = balance;
                this.cache.adminBalanceTimestamp = Date.now();
            }
            
            return balance;
        });
    }

    async _getAdminBalanceCore() {
        try {
            await this.page.goto('https://agentserver.mrallinone777.com/admin', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await this.timeout(5000);

            const isLoginPage = await this.page.evaluate(() => {
                const modalTitle = document.querySelector('.layui-layer-title');
                if (modalTitle && modalTitle.innerText === 'Login timeout') return true;
                return false;
            });

            if (isLoginPage) {
                this.log('Session timeout detected, re-authorizing...');
                this.authorized = false;
                await this.page.click('.layui-layer-btn0');
                setTimeout(() => this.authorize(), 3000);
                return -1;
            }

            const balance = await this.page.evaluate(() => {
                const balanceEl = document.querySelector('#money');
                if (!balanceEl) return false;
                return parseFloat(balanceEl.innerText);
            });

            if (balance === false) {
                this.error('Could not find balance element');
                return false;
            }

            this.log(`Current admin balance: ${balance}`);
            return balance;

        } catch (error) {
            this.error(`Error getting admin balance: ${error.message}`);
            
            if (error.message.includes('Session closed') || 
                error.message.includes('Target closed')) {
                this.browserReady = false;
                this.initialized = false;
                await this.reinitialize();
                return -1;
            }
            
            return false;
        }
    }

    // ========================================
    // CORE OPERATION METHODS
    // ========================================

    async getBalance({ id, login }) {
        console.log('getBalance called with:', id, login);
        
        try {
            await this.ensureBrowserReady();
            
            await this.page.goto('https://agentserver.mrallinone777.com/admin/player/index', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await this.timeout(2000);

            const isLoginPage = await this.page.evaluate(() => {
                const modalTitle = document.querySelector('.layui-layer-title');
                if (modalTitle && modalTitle.innerText === 'Login timeout') return true;
                return false;
            });

            if (isLoginPage) {
                console.log('Need to login');
                this.authorized = false;
                await this.page.click('.layui-layer-btn0');
                setTimeout(() => this.authorize(), 3000);
                return -1;
            }

            console.log('Searching for account:', login);
            await this.page.type('input[name="nickname"]', login);
            
            const buttonExist = await this.page.evaluate(() => {
                const button = document.querySelector('button[lay-filter="search"]');
                if (!button) return false;
                button.click();
                return true;
            });

            if (!buttonExist) {
                await Tasks.error(id, 'search button not found');
                return false;
            }

            console.log('Waiting for results...');
            await this.timeout(10000);

            const accountData = await this.page.evaluate((login) => {
                const accounts = document.querySelectorAll('td[data-field="Account"]');
                
                for (let i = 0; i < accounts.length; i++) {
                    if (accounts[i].innerText.toLowerCase() === login.toLowerCase()) {
                        const row = accounts[i].parentElement;
                        const balanceCell = row.querySelector('td[data-field="Balance"]');
                        
                        if (balanceCell) {
                            const balanceText = balanceCell.innerText.trim();
                            const balance = parseFloat(balanceText);
                            return { found: true, balance: isNaN(balance) ? 0 : balance };
                        }
                    }
                }
                return { found: false, balance: null };
            }, login);

            if (!accountData.found) {
                this.error(`Account ${login} not found`);
                await Tasks.error(id, 'login not found');
                return false;
            }

            console.log('Balance retrieved:', accountData.balance);
            this.log(`Current balance for ${login}: ${accountData.balance}`);

            try {
                const gameAccount = await GameAccount.findOne({ gameLogin: login });
                if (gameAccount) {
                    await gameAccount.updateBalance(accountData.balance);
                }
            } catch (dbError) {
                this.error(`Error updating balance in DB: ${dbError.message}`);
            }

            await Tasks.approve(id, accountData.balance);
            return accountData.balance;

        } catch (error) {
            console.error('Error during get balance:', error.message);
            this.error(`Error during get balance: ${error.message}`);
            
            if (error.message.includes('Session closed') || 
                error.message.includes('Target closed') ||
                error.message.includes('detached Frame')) {
                this.browserReady = false;
                this.initialized = false;
                await this.reinitialize();
                return -1;
            }
            
            return false;
        }
    }

    async recharge({ id, login, amount, remark, is_manual = false }) {
        console.log('🔴 RECHARGE START:', { id, login, amount, remark, is_manual });
        
        try {
            await this.ensureBrowserReady();
            
            await this.page.goto('https://agentserver.mrallinone777.com/admin/player/index', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await this.timeout(2000);

            console.log('Step 1: Searching for account...');
            await this.page.type('input[name="nickname"]', login);
            
            const buttonExist = await this.page.evaluate(() => {
                const button = document.querySelector('button[lay-filter="search"]');
                if (!button) return false;
                button.click();
                return true;
            });

            if (!buttonExist) {
                await Tasks.error(id, 'search button not found');
                return false;
            }

            await this.timeout(10000);

            const isLoginPage = await this.page.evaluate(() => {
                const modalTitle = document.querySelector('.layui-layer-title');
                if (modalTitle && modalTitle.innerText === 'Login timeout') return true;
                return false;
            });

            if (isLoginPage) {
                this.authorized = false;
                await this.page.click('.layui-layer-btn0');
                setTimeout(() => this.authorize(), 3000);
                return -1;
            }

            console.log('Step 2: Selecting account...');
            const isAccountFound = await this.page.evaluate((login) => {
                const accounts = document.querySelectorAll('td[data-field="Account"]');
                
                for (let i = 0; i < accounts.length; i++) {
                    if (accounts[i].innerText.toLowerCase() === login.toLowerCase()) {
                        accounts[i].parentElement.querySelector('a[title="Recharge"]').click();
                        return true;
                    }
                }
                return false;
            }, login);

            if (!isAccountFound) {
                await Tasks.error(id, 'login not found');
                return false;
            }

            console.log('✅ Account found');

            await this.page.goto('https://agentserver.mrallinone777.com/admin/player/recharge', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await this.timeout(2000);

            console.log('Step 3: Reading current balance...');
            const current_balance = await this.page.evaluate(() => {
                const balance = document.querySelector('#player_balance');
                return balance ? parseFloat(balance.value) : false;
            });

            if (current_balance === false) {
                await Tasks.error(id, `can't find current user balance`);
                return false;
            }

            console.log('Current balance:', current_balance);

            if (current_balance > 2) {
                if (is_manual) {
                    await Tasks.cancel(id, ` balance is more than $2 (${current_balance})`);
                }
                await Tasks.error(id, `balance is more than $2 (${current_balance})`);
                return false;
            }

            console.log('Step 4: Submitting recharge...');
            await this.page.type('input[name="balance"]', amount.toString());
            await this.page.click('button[type="submit"]');

            await this.page.waitForSelector('.layui-layer-msg', { timeout: 30000 });

            const message = await this.page.evaluate(() => {
                const element = document.querySelector('.layui-layer-msg');
                return element.innerText;
            });

            console.log('Result message:', message);

            if (message === "Recharge successful") {
                const newBalance = parseFloat(current_balance + amount);
                console.log('✅ SUCCESS! New balance:', newBalance);
                this.log(`Successfully recharged ${amount} to login ${login}`);

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
                
                return true;
            } else {
                console.log('❌ Unexpected result:', message);
                await Tasks.error(id, `wrong message: ${message}`);
                
                await this.page.screenshot({
                    path: path.join(__dirname, 'error.jpg'),
                    type: "jpeg",
                    fullPage: true
                });
                
                return false;
            }

        } catch (error) {
            console.log('❌ RECHARGE ERROR:', error.message);
            this.error(`Error during recharge: ${error.message}`);
            
            if (error.message.includes('Session closed') || 
                error.message.includes('Target closed') ||
                error.message.includes('detached Frame')) {
                this.browserReady = false;
                this.initialized = false;
                await this.reinitialize();
                return -1;
            }
            
            return false;
        }
    }

    async redeem({ id, login, amount, remark, is_manual = false }) {
        console.log('🔴 REDEEM START:', { id, login, amount, remark, is_manual });
        
        try {
            await this.ensureBrowserReady();
            
            await this.page.goto('https://agentserver.mrallinone777.com/admin/player/index', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await this.timeout(2000);

            console.log('Step 1: Searching for account...');
            await this.page.type('input[name="nickname"]', login);
            
            const buttonExist = await this.page.evaluate(() => {
                const button = document.querySelector('button[lay-filter="search"]');
                if (!button) return false;
                button.click();
                return true;
            });

            if (!buttonExist) {
                return false;
            }

            await this.timeout(10000);

            const isLoginPage = await this.page.evaluate(() => {
                const modalTitle = document.querySelector('.layui-layer-title');
                if (modalTitle && modalTitle.innerText === 'Login timeout') return true;
                return false;
            });

            if (isLoginPage) {
                this.authorized = false;
                await this.page.click('.layui-layer-btn0');
                setTimeout(() => this.authorize(), 3000);
                return -1;
            }

            console.log('Step 2: Selecting account...');
            const isAccountFound = await this.page.evaluate((login) => {
                const accounts = document.querySelectorAll('td[data-field="Account"]');
                
                for (let i = 0; i < accounts.length; i++) {
                    if (accounts[i].innerText.toLowerCase() === login.toLowerCase()) {
                        accounts[i].parentElement.querySelector('a[title="Withdraw"]').click();
                        return true;
                    }
                }
                return false;
            }, login);

            if (!isAccountFound) {
                return false;
            }

            console.log('✅ Account found');

            await this.timeout(2000);
            await this.page.goto('https://agentserver.mrallinone777.com/admin/player/withdraw', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await this.timeout(2000);

            console.log('Step 3: Reading current balance...');
            const current_balance = await this.page.evaluate(() => {
                const balance = document.querySelector('#player_balance');
                return balance ? parseFloat(balance.value) : false;
            });

            if (current_balance === false) {
                return false;
            }

            console.log('Current balance:', current_balance);

            const total_balance = current_balance;

            if (!is_manual) {
                if (total_balance !== parseInt(amount)) {
                    await Tasks.cancel(id, total_balance);
                    return true;
                }
            }

            if (is_manual) {
                if (total_balance < parseInt(amount)) {
                    await Tasks.cancel(id, total_balance);
                    return true;
                }
            }

            console.log('Step 4: Submitting redeem...');
            await this.page.type('input[name="balance"]', amount.toString());
            await this.page.click('button[type="submit"]');

            await this.page.waitForSelector('.layui-layer-msg', { timeout: 30000 });

            const message = await this.page.evaluate(() => {
                const element = document.querySelector('.layui-layer-msg');
                return element.innerText;
            });

            console.log('Result message:', message);

            if (message === "Withdraw successful") {
                const newBalance = parseFloat(total_balance - amount);
                console.log('✅ SUCCESS! New balance:', newBalance);
                this.log(`Successfully redeemed ${amount} from login ${login}`);

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
                
                return true;
            } else {
                console.log('❌ Unexpected result:', message);
                await Tasks.cancel(id);
                return false;
            }

        } catch (error) {
            console.log('❌ REDEEM ERROR:', error.message);
            this.error(`Error during redeem: ${error.message}`);
            
            if (error.message.includes('Session closed') || 
                error.message.includes('Target closed') ||
                error.message.includes('detached Frame')) {
                this.browserReady = false;
                this.initialized = false;
                await this.reinitialize();
                return -1;
            }
            
            return false;
        }
    }

    async createAccount({ id, login, password }) {
        console.log('🔴 CREATE ACCOUNT START:', { id, login, password: '***' });
        
        try {
            await this.ensureBrowserReady();
            
            await this.page.goto('https://agentserver.mrallinone777.com/admin/player/insert', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await this.timeout(5000);

            const isLoginPage = await this.page.evaluate(() => {
                const modalTitle = document.querySelector('.layui-layer-title');
                if (modalTitle && modalTitle.innerText === 'Login timeout') return true;
                return false;
            });

            if (isLoginPage) {
                this.authorized = false;
                await this.page.click('.layui-layer-btn0');
                setTimeout(() => this.authorize(), 3000);
                return -1;
            }

            console.log('Step 1: Filling account creation form...');
            await this.page.type('input[name="username"]', login);
            await this.page.type('input[name="nickname"]', login);
            await this.page.type('input[name="password"]', password);
            await this.page.type('input[name="money"]', "0");
            await this.page.type('input[name="password_confirmation"]', password);
            
            console.log('Step 2: Submitting form...');
            await this.page.click('button[lay-filter="add"]');

            await this.page.waitForSelector('.layui-layer-msg', { timeout: 30000 });

            const message = await this.page.evaluate(() => {
                const element = document.querySelector('.layui-layer-msg');
                return element.innerText;
            });

            console.log('Result message:', message);

            if (message === "Insert successful") {
                console.log('✅ SUCCESS! Account created');
                this.log(`Successfully created account ${login}:${password}`);

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
                    this.error(`Error updating account status in DB: ${error.message}`);
                }

                await Tasks.approve(id);
                
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
                
                await this.page.screenshot({
                    path: path.join(__dirname, 'error.jpg'),
                    type: "jpeg",
                    fullPage: true
                });
                
                return { success: false, message: message };
            }
            
        } catch (error) {
            console.log('❌ CREATE ACCOUNT ERROR:', error.message);
            this.error(`Error creating account: ${error.message}`);
            
            if (error.message.includes('Session closed') || 
                error.message.includes('Target closed') ||
                error.message.includes('detached Frame')) {
                this.browserReady = false;
                this.initialized = false;
                await this.reinitialize();
                return -1;
            }
            
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
            
            return { success: false, message: error.message };
        }
    }

    async resetPassword({ id, login, password }) {
        console.log('🔴 RESET PASSWORD START:', { id, login, password: '***' });
        
        try {
            await this.ensureBrowserReady();
            
            await this.page.goto('https://agentserver.mrallinone777.com/admin/player/index', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await this.timeout(7000);

            console.log('Step 1: Searching for account...');
            await this.page.type('input[name="nickname"]', login);
            
            const buttonExist = await this.page.evaluate(() => {
                const button = document.querySelector('button[lay-filter="search"]');
                if (!button) return false;
                button.click();
                return true;
            });

            if (!buttonExist) {
                await Tasks.error(id, `search button not found`);
                return false;
            }

            await this.timeout(3000);

            const isLoginPage = await this.page.evaluate(() => {
                const modalTitle = document.querySelector('.layui-layer-title');
                if (modalTitle && modalTitle.innerText === 'Login timeout') return true;
                return false;
            });

            if (isLoginPage) {
                this.authorized = false;
                await this.page.click('.layui-layer-btn0');
                setTimeout(() => this.authorize(), 3000);
                return -1;
            }

            console.log('Step 2: Selecting account...');
            const isAccountFound = await this.page.evaluate((login) => {
                const accounts = document.querySelectorAll('td[data-field="Account"]');
                
                for (let i = 0; i < accounts.length; i++) {
                    if (accounts[i].innerText.toLowerCase() === login.toLowerCase()) {
                        accounts[i].parentElement.querySelector('a[title="Reset password"]').click();
                        return true;
                    }
                }
                return false;
            }, login);

            if (!isAccountFound) {
                await Tasks.error(id, 'login not found');
                return false;
            }

            console.log('✅ Account found');

            await this.page.goto('https://agentserver.mrallinone777.com/admin/player/resetpw', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await this.timeout(2000);

            console.log('Step 3: Setting new password...');
            await this.page.type('#password', password);
            await this.page.type(`input[name="password_confirmation"]`, password);
            await this.page.click('button[type="submit"]');

            await this.page.waitForSelector('.layui-layer-msg', { timeout: 30000 });

            const message = await this.page.evaluate(() => {
                const element = document.querySelector('.layui-layer-msg');
                return element.innerText;
            });

            console.log('Result message:', message);

            if (message === "Reset successful") {
                console.log('✅ SUCCESS! Password reset complete');
                this.log(`Password for login ${login} has been reset`);

                try {
                    const gameAccount = await GameAccount.findOne({ gameLogin: login });
                    if (gameAccount) {
                        gameAccount.gamePassword = password;
                        await gameAccount.save();
                        console.log('Database updated with new password');
                    }
                } catch (dbError) {
                    console.log('DB update error:', dbError.message);
                    this.error(`Error updating password in DB: ${dbError.message}`);
                }

                await Tasks.approve(id, password);
                return true;
            } else {
                console.log('❌ Unexpected result:', message);
                await Tasks.error(id, `password reset failed: ${message}`);
                return false;
            }

        } catch (error) {
            console.log('❌ RESET PASSWORD ERROR:', error.message);
            this.error(`Error during password reset: ${error.message}`);
            
            if (error.message.includes('Session closed') || 
                error.message.includes('Target closed') ||
                error.message.includes('detached Frame')) {
                this.browserReady = false;
                this.initialized = false;
                await this.reinitialize();
                return -1;
            }
            
            return false;
        }
    }

    async getDownloadCode({ id }) {
        try {
            await this.ensureBrowserReady();
            
            // AllInOne doesn't have a download code feature like OrionStars
            // This would need to be implemented based on your specific requirements
            this.log('Download code not implemented for AllInOne');
            await Tasks.error(id, 'Download code not available for this game');
            return false;
            
        } catch (error) {
            this.error(`Error getting download code: ${error.message}`);
            return false;
        }
    }

    async getBalanceAdmin(task) {
        try {
            await this.ensureBrowserReady();
            
            const balance = await this._getAdminBalanceCore();

            if (balance !== false && balance !== -1 && balance !== null) {
                await Tasks.approve(task.id, balance);
                return balance;
            }

            this.error('Could not retrieve admin balance');
            return false;
        } catch (error) {
            this.error(`Error in getBalanceAdmin: ${error.message}`);
            
            if (error.message.includes('Session closed') || 
                error.message.includes('Target closed')) {
                this.browserReady = false;
                this.initialized = false;
                await this.reinitialize();
                return -1;
            }
            
            return false;
        }
    }
}

// Export singleton instance
const allInOneController = new AllInOneController();
module.exports = allInOneController;