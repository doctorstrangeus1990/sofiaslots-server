// controllers/Juwa2Controller.js - REFACTORED TO MATCH JUWA/GAMEVAULT PATTERN
// API-based controller (Puppeteer for auth/session capture, axios for operations)
const Puppeteer = require('puppeteer');
const Captcha = require('../lib/captcha.js');
const { writeFileSync, readFileSync, existsSync, readdirSync, rmSync } = require('fs');
const Tasks = require('../lib/tasks.js');
const Logger = require('../utils/logger.js');
const GameAccount = require('../models/GameAccount.js');
const Game = require('../models/Game.js');
const path = require('path');
const axios = require('axios');
const { int } = require('../utils/types.js');

class Juwa2Controller {
    constructor() {
        this.browser = null;
        this.page = null;
        this.cookies = null;
        this.authorized = false;
        this.logger = Logger('Juwa2');
        this.gameType = 'juwa2';
        this.initialized = false;
        this.agentCredentials = null;

        this.keepAlive = true;
        this.lastActivity = Date.now();
        this.activityTimeout = 15 * 60 * 1000;

        this.cache = {
            adminBalance: null,
            adminBalanceTimestamp: null,
            cacheDuration: 30 * 1000
        };

        // QUEUE SYSTEM
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

        // RETRY LIMIT TRACKING
        this.authRetryCount = 0;
        this.maxAuthRetries = 3;
        this.lastAuthAttempt = null;
        this.authResetInterval = 5 * 60 * 1000;

        // SESSION MANAGEMENT
        this.sessionTimeout = null;
        this.lastSuccessfulOperation = Date.now();
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 3;
        this.consecutiveMonitorFailures = 0;
        this.maxMonitorFailures = 5;

        this.loadAgentCredentials()
            .then(() => this.initialize())
            .catch(err => {
                this.error(`Failed to initialize on startup: ${err.message}`);
                this.scheduleRetryInitialize();
            });

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
        return new Promise(resolve => setTimeout(resolve, ms, true));
    }

    processing(ms) {
        return (Date.now() - ms) / 1e3;
    }

    scheduleRetryInitialize() {
        this.log('🔄 Scheduling retry initialization in 30 seconds...');
        setTimeout(async () => {
            try {
                if (!this.initialized || !this.browserReady) {
                    this.log('🔄 Retrying initialization...');
                    await this.initialize();
                    this.log('✅ Retry initialization successful');
                }
            } catch (err) {
                this.error(`Retry failed: ${err.message}`);
                this.scheduleRetryInitialize();
            }
        }, 30000);
    }

    resetAuthRetryIfNeeded() {
        if (this.lastAuthAttempt &&
            Date.now() - this.lastAuthAttempt > this.authResetInterval) {
            this.log('Resetting auth retry counter after timeout');
            this.authRetryCount = 0;
        }
    }

    // ========================================
    // HTTP REQUEST HELPER
    // ========================================

    async makeRequest({ path: apiPath, method = 'POST', body }) {
        try {
            const sessionPath = path.join(__dirname, 'sessionjuwa2.json');
            const cookiesPath = path.join(__dirname, 'cookiesjuwa2.json');

            if (!existsSync(sessionPath)) {
                if (this.isInitializing || this.isAuthorizing) {
                    this.log('Session not ready yet, waiting for initialization...');

                    if (this.initializationPromise) {
                        await this.initializationPromise;
                    }
                    if (this.authorizationPromise) {
                        await this.authorizationPromise;
                    }

                    await new Promise(resolve => setTimeout(resolve, 1500));

                    if (!existsSync(sessionPath)) {
                        this.error('Session file still not found after initialization');
                        return { code: 401, status: 401, msg: 'Session not found' };
                    }

                    this.log('✅ Session file ready after waiting, proceeding with request...');
                } else {
                    this.error('Session file not found and not initializing. Need to login first.');
                    return { code: 401, status: 401, msg: 'Session not found' };
                }
            }

            // Read session file
            const session_details = JSON.parse(readFileSync(sessionPath).toString());

            if (!session_details.token) {
                this.error('No token found in session file');
                return { code: 401, status: 401, msg: 'Token not found' };
            }

            // Strip surrounding quotes from token (legacy behaviour)
            const token = session_details.token.replace(/\"/gi, '');

            // Build cookie header if cookies file exists
            let cookieHeader = '';
            if (existsSync(cookiesPath)) {
                const cookies_details = JSON.parse(readFileSync(cookiesPath).toString());
                cookieHeader = cookies_details
                    .map(cookie => `${cookie.name}=${cookie.value}`)
                    .join(';');
            }

            const response = await axios({
                url: `https://agent.juwa2.com/api${apiPath}`,
                method,
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Cookie": cookieHeader,
                    "Content-Type": "application/json"
                },
                data: body,
                validateStatus: () => true
            });

            this.log(`${method} ${apiPath} - Status: ${response.status}`);

            if (response.data) {
                return response.data;
            }

            return {
                code: response.status,
                status: response.status,
                msg: response.statusText || 'No response data'
            };

        } catch (error) {
            this.error(`Request error: ${error.message}`);

            if (error.response) {
                this.error(`Status: ${error.response.status}, Message: ${error.response.statusText}`);
                return {
                    code: error.response.status,
                    status: error.response.status,
                    msg: error.response.data?.msg || error.response.statusText
                };
            } else if (error.request) {
                this.error('No response received from server');
                return { code: 500, status: 500, msg: 'No response from server' };
            } else {
                this.error(`Setup error: ${error.message}`);
                return { code: 500, status: 500, msg: error.message };
            }
        }
    }

    // ========================================
    // SESSION MONITORING
    // ========================================

    startSessionMonitor() {
        setInterval(async () => {
            if (!this.initialized || !this.page || !this.browser) return;

            const timeSinceLastActivity = Date.now() - this.lastSuccessfulOperation;

            if (timeSinceLastActivity > this.activityTimeout) {
                if (this.consecutiveMonitorFailures >= this.maxMonitorFailures) {
                    this.error(`Session monitor disabled after ${this.maxMonitorFailures} consecutive failures. Manual restart required.`);
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

    // ========================================
    // QUEUE SYSTEM
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

    // ========================================
    // BROWSER STATE VALIDATION
    // ========================================

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

    async ensureBrowserReady() {
        if (this.isInitializing && this.initializationPromise) {
            this.log('Waiting for initialization to complete...');
            await this.initializationPromise;
        }
        if (this.isAuthorizing && this.authorizationPromise) {
            this.log('Waiting for authorization to complete...');
            await this.authorizationPromise;
        }
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
            if (!version) throw new Error('Browser not responding');
        } catch (error) {
            this.log('Browser not responding, reinitializing...');
            await this.initialize();
            return;
        }
        if (!this.authorized) {
            this.log('Not authorized, waiting for authorization...');
            if (this.isAuthorizing && this.authorizationPromise) {
                await this.authorizationPromise;
            } else {
                await this.checkAuthorization();
            }
        }
    }

    // ========================================
    // CORE METHODS
    // ========================================

    async loadAgentCredentials() {
        try {
            const game = await Game.findOne({
                shortcode: 'JUWA2',
                status: { $in: ['active', 'maintenance'] }
            });

            if (!game) {
                throw new Error('Juwa2 game not found in database');
            }

            if (!game.agentUsername || !game.agentPassword) {
                throw new Error('Agent credentials not configured for Juwa2');
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

    async createBrowser() {
        this.log('Initializing browser for Juwa2...');

        if (this.browser) {
            try {
                this.browser.removeAllListeners('disconnected');
                if (this.page) {
                    this.page.removeAllListeners('error');
                    this.page.removeAllListeners('close');
                }
                await this.browser.close();
            } catch (e) {
                this.log(`Error closing existing browser: ${e.message}`);
            }
        }

        this.browser = await Puppeteer.launch({
            headless: true,
            args: ["--fast-start", "--disable-extensions", "--no-sandbox"],
            ignoreHTTPSErrors: true,
            ignoreDefaultArgs: ['--disable-extensions']
        });

        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1312, height: 800 });

        // Load cookies if present
        const cookiesPath = path.join(__dirname, 'cookiesjuwa2.json');
        if (existsSync(cookiesPath)) {
            const cookies_parsed = JSON.parse(readFileSync(cookiesPath).toString());
            await this.page.setCookie(...cookies_parsed);
        }

        await this.checkAuthorization();
    }

    async isLoginPage() {
        const pathname = await this.page.evaluate(() => window.location.pathname === '/login');
        if (pathname) return 'pathname';

        const hasLoginTimeoutModal = await this.page.evaluate(() => {
            const modal = document.querySelector('div[aria-label="Login timeout"]');
            return modal ? true : false;
        });
        if (hasLoginTimeoutModal) return 'modal';

        const hasAlertMessage = await this.page.evaluate(() => {
            const message = document.querySelector('.el-message__content');
            return message ? message.innerText : '';
        });
        if (hasAlertMessage === "Please login") return 'alert';

        return false;
    }

    async checkAuthorization() {
        await this.page.goto('https://agent.juwa2.com/userManagement', { waitUntil: 'load' });

        const sessionPath = path.join(__dirname, 'sessionjuwa2.json');
        if (existsSync(sessionPath)) {
            const session_parsed = JSON.parse(readFileSync(sessionPath).toString());

            await this.page.evaluate(session_parsed => {
                for (const key of Object.keys(session_parsed))
                    sessionStorage.setItem(key, session_parsed[key]);
            }, session_parsed);

            await this.page.goto('https://agent.juwa2.com/userManagement', { waitUntil: 'load' });
        }

        const isLoginPage = await this.isLoginPage();

        if (isLoginPage) {
            this.authorized = false;
            this.error('Session closed, authorization required...');
            await this.authorize();
            return false;
        } else {
            this.log('The session is open and ready to go!');
            this.authorized = true;
            this.checkQueue();
            return true;
        }
    }

    async reload() {
        this.log('Reloading and clearing session files...');

        const dir = readdirSync(__dirname);
        for (const file of dir) {
            if (["sessionjuwa2.json", "cookiesjuwa2.json"].includes(file)) {
                try {
                    rmSync(path.join(__dirname, file));
                    this.log(`Removed ${file}`);
                } catch (error) {
                    this.log(`Failed to remove ${file}: ${error.message}`);
                }
            }
        }

        this.authorized = false;
        this.authRetryCount = 0;

        await this.authorize();
        return true;
    }

    async authorize() {
        if (this.authorizationInProgress && this.authorizationPromise) {
            this.log('Authorization already in progress, waiting for it...');
            await this.authorizationPromise;
            return;
        }

        this.resetAuthRetryIfNeeded();

        if (this.authRetryCount >= this.maxAuthRetries) {
            this.error(`Max authorization attempts (${this.maxAuthRetries}) reached. Waiting 30 seconds before reset...`);
            this.authRetryCount = 0;
            await new Promise(resolve => setTimeout(resolve, 30000));
        }

        this.authorizationInProgress = true;
        this.isAuthorizing = true;
        this.authRetryCount++;
        this.lastAuthAttempt = Date.now();

        this.authorizationPromise = (async () => {
            try {
                this.log(`Starting authorization (attempt ${this.authRetryCount}/${this.maxAuthRetries})...`);

                if (!this.page || this.page.isClosed()) {
                    this.log('Page is invalid, cannot authorize');
                    throw new Error('Browser not ready - please initialize first');
                }

                await this.page.goto('https://agent.juwa2.com/login', {
                    waitUntil: 'load',
                    timeout: 10000
                });

                if (!this.agentCredentials) {
                    const credentialsLoaded = await this.loadAgentCredentials();
                    if (!credentialsLoaded) {
                        throw new Error('Unable to find login and password to access the control panel');
                    }
                }

                await this.page.evaluate(() => {
                    const inputs = document.querySelectorAll('input');
                    inputs[0].setAttribute('id', 'login');
                    inputs[0].value = '';
                    inputs[1].setAttribute('id', 'password');
                    inputs[1].value = '';
                    inputs[2].setAttribute('id', 'captcha');
                    inputs[3].click();
                });

                await this.page.type('#login', this.agentCredentials.username);
                await this.page.type('#password', this.agentCredentials.password);

                await this.timeout(2e3);

                const base64Captcha = await this.page.evaluate(() => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 132;
                    canvas.height = 40;
                    const context = canvas.getContext('2d');
                    context.drawImage(document.querySelector('.imgCode'), 0, 0, 132, 40);
                    return canvas.toDataURL("image/png").replace(/^data:image\/?[A-z]*;base64,/, "");
                });

                const captchaValue = await Captcha(base64Captcha, 4);
                this.log(`Captcha: ${captchaValue}`);

                await this.page.type('#captcha', captchaValue);
                await this.page.evaluate(() => {
                    const buttons = document.querySelectorAll('button');
                    buttons[0].click();
                });

                await this.timeout(5e3);

                const is_logged_in = await this.page.evaluate(() => location.pathname === '/HomeDetail');

                if (is_logged_in) {
                    this.authorized = true;
                    this.authRetryCount = 0;
                    this.log('Successfully logged in! Your session is ready to go!');
                    await this.saveCookies();
                    this.checkQueue();
                } else {
                    const error_message = await this.page.evaluate(() => {
                        const message = document.querySelector('p.el-message__content');
                        return message ? message.innerText : 'unknown';
                    });
                    throw new Error(`Login failed: ${error_message}`);
                }

            } catch (error) {
                this.error(`Error during authorization: ${error.message}`);
                this.authorized = false;

                if (error.message.includes('detached Frame') ||
                    error.message.includes('Target closed') ||
                    error.message.includes('Session closed') ||
                    error.message.includes('Browser not ready')) {
                    this.log('Browser session lost or not ready');
                    this.browserReady = false;
                    this.initialized = false;
                    this.authorizationInProgress = false;
                    this.isAuthorizing = false;
                    this.authorizationPromise = null;
                    throw error;
                }

                if (this.authRetryCount < this.maxAuthRetries) {
                    this.log(`Retrying authorization in 3 seconds (attempt ${this.authRetryCount + 1}/${this.maxAuthRetries})...`);
                    this.authorizationInProgress = false;
                    this.isAuthorizing = false;
                    this.authorizationPromise = null;
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    return await this.authorize();
                } else {
                    this.error(`Max authorization attempts (${this.maxAuthRetries}) reached.`);
                    throw error;
                }
            } finally {
                this.authorizationInProgress = false;
                this.isAuthorizing = false;
            }
        })();

        await this.authorizationPromise;
        this.authorizationPromise = null;
    }

    async saveCookies() {
        const cookies = await this.page.cookies();
        await writeFileSync(path.join(__dirname, 'cookiesjuwa2.json'), JSON.stringify(cookies, null, 4));

        const session = await this.page.evaluate(() => {
            return {
                i18n: sessionStorage.getItem('i18n'),
                user: sessionStorage.getItem('user'),
                token: sessionStorage.getItem('token')
            };
        });

        await writeFileSync(path.join(__dirname, 'sessionjuwa2.json'), JSON.stringify(session, null, 4));
        return true;
    }

    // ========================================
    // HELPER METHODS FOR API CALLS
    // ========================================

    async getUser(login) {
        const response = await this.makeRequest({
            path: '/user/userList',
            method: 'POST',
            body: { limit: 20, page: 1, search: login, type: 1 }
        });

        if (!response) return false;

        if (response.code !== 200) {
            if ([400, 401].includes(response.status)) {
                await this.reload();
                return -1;
            }
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            return false;
        }

        if (response.msg !== 'success') {
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            return false;
        }

        if (response.data.list.length < 1) {
            this.error(`No login information ${login}`);
            return false;
        }

        const user = response.data.list[0];
        return {
            agent_login_name: user.agent_login_name,
            login: user.login_name,
            id: user.user_id,
            balance: user.balance,
            balance_int: int(user.balance),
            bonus: user.bonus
        };
    }

    async agentBalance() {
        const response = await this.makeRequest({ path: '/agent/balance' });

        if (!response) return false;

        if (response.code !== 200) {
            if ([400, 401].includes(response.status)) {
                await this.reload();
                return -1;
            }
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            return false;
        }

        if (response.msg !== 'success') {
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            return false;
        }

        return response.data.t;
    }

    // ========================================
    // TASK OPERATIONS
    // ========================================

    async getStoreBalance({ id }) {
        const start_at = Date.now();
        const balance = await this.agentBalance();

        if (balance === false) return false;
        if (balance === -1) return -1;

        await Tasks.approve(id, balance);
        this.log(`Received the current store balance ($${balance}) in ${this.processing(start_at)} s`);
        return true;
    }

    async createUser({ id, login, password }) {
        this.log(`Create a user ${login}`);
        const start_at = Date.now();

        const response = await this.makeRequest({
            path: '/user/addUser',
            method: 'POST',
            body: {
                account: login,
                nickname: login,
                rechargeamount: "",
                login_pwd: password,
                check_pwd: password
            }
        });

        if (!response) return false;

        if (response.code !== 200) {
            if ([400, 401].includes(response.status)) {
                await this.reload();
                return -1;
            }
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            await Tasks.error(id, response.msg || `Error code: ${response.code}`);
            return false;
        }

        if (response.msg !== 'success') {
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            await Tasks.error(id, response.msg || 'createUser failed');
            return false;
        }

        await Tasks.approve(id, { login, password });
        this.log(`Created a user ${login} in ${this.processing(start_at)} s`);
        return true;
    }

    async resetPassword({ id, login, password }) {
        this.log(`Recovering login password ${login}...`);
        const start_at = Date.now();

        const user = await this.getUser(login);
        if (!user) return false;
        if (user === -1) return -1;

        const response = await this.makeRequest({
            path: '/user/resetUserPwd',
            method: 'POST',
            body: {
                uid: user.id,
                login_pwd: password,
                check_pwd: password
            }
        });

        if (!response) return false;

        if (response.code !== 200) {
            if ([400, 401].includes(response.status)) {
                await this.reload();
                return -1;
            }
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            await Tasks.error(id, response.msg || 'resetPassword failed');
            return false;
        }

        if (response.msg !== 'success') {
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            await Tasks.error(id, response.msg || 'resetPassword failed');
            return false;
        }

        await Tasks.approve(id, { password, balance: user.balance });
        this.log(`The login password has been restored ${login} in ${this.processing(start_at)} s.`);
        return true;
    }

    async recharge({ id, login, amount, remark, transactionId, is_manual = false }) {
        this.log(`Recharge $${amount} for ${login}...`);
        const start_at = Date.now();

        const user = await this.getUser(login);
        if (!user) return false;
        if (user === -1) return -1;

        const agentBalance = await this.agentBalance();
        if (agentBalance === false) return false;
        if (agentBalance === -1) return -1;

        if (user.balance >= 2) {
            await Tasks.reject(id, 'balance', user.balance);
            return false;
        }
        if (user.bonus > 0) {
            await Tasks.reject(id, 'user_in_bonus');
            return false;
        }
        if (agentBalance < amount) {
            await Tasks.reject(id, 'store_balance');
            return false;
        }

        const response = await this.makeRequest({
            path: '/user/rechargeRedeem',
            method: 'POST',
            body: {
                account: user.agent_login_name,
                amount,
                balance: user.balance,
                remark,
                type: 1,
                user_id: user.id
            }
        });

        if (!response) return false;

        if (response.code !== 200) {
            if ([400, 401].includes(response.status)) {
                await this.reload();
                return -1;
            }
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            return false;
        }

        if (response.msg !== 'success') {
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            return false;
        }

        await Tasks.approve(id, parseFloat(response.data.Balance));
        this.log(`Recharged $${amount} for ${login} in ${this.processing(start_at)} s`);
        return true;
    }

    async redeem({ id, login, amount, remark, transactionId, minimal = 0, is_manual = false }) {
        this.log(`Redeem balance from ${login}...`);
        const start_at = Date.now();

        const user = await this.getUser(login);
        if (!user) return false;
        if (user === -1) return -1;

        if (user.balance_int < minimal) {
            await Tasks.reject(id, 'minimal', minimal);
            return false;
        }
        if (user.bonus > 0) {
            await Tasks.reject(id, 'user_in_bonus');
            return false;
        }

        const response = await this.makeRequest({
            path: '/user/rechargeRedeem',
            method: 'POST',
            body: {
                account: user.agent_login_name,
                amount: user.balance_int,
                balance: user.balance,
                remark,
                type: 2,
                user_id: user.id
            }
        });

        if (!response) return false;

        if (response.code !== 200) {
            if ([400, 401].includes(response.status)) {
                await this.reload();
                return -1;
            }
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            return false;
        }

        if (response.msg !== 'success') {
            this.error(`Unknown response from the server ${JSON.stringify(response)}`);
            return false;
        }

        await Tasks.approve(id, user.balance_int);
        this.log(`Redeemed $${user.balance_int} from ${login} in ${this.processing(start_at)} s`);
        return true;
    }

    async getUsersBalances({ id, logins }) {
        this.log(`Updating login balances (${logins.length})`);
        const start_at = Date.now();

        const balances = {};
        for (const login of logins) {
            const user = await this.getUser(login);
            if (!user) continue;
            if (user === -1) return -1;
            balances[login] = user.balance;
        }

        await Tasks.approve(id, balances);
        this.log(`Balances updated ${logins.length} in ${this.processing(start_at)} s.`);
        return true;
    }

    // ========================================
    // PUBLIC API METHODS (called by gameController)
    // ========================================

    async createUserAccount(userId, gameLogin, password) {
        return await this.queueOperation(`createUser:${gameLogin}`, async () => {
            const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
            const taskId = gameAccount ? gameAccount._id.toString() : `task_${Date.now()}`;

            const result = await this.createUser({ id: taskId, login: gameLogin, password });
            if (result === -1) return -1;
            if (!result) throw new Error('Create user failed');

            return { success: true, data: { gameLogin }, message: 'User created successfully' };
        });
    }

    async rechargeAccount(userId, gameLogin, totalAmount, baseAmount, remark = 'API Recharge') {
        return await this.queueOperation(`recharge:${gameLogin}:${totalAmount}`, async () => {
            const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
            if (!gameAccount) throw new Error('Game account not found');

            const transactionId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const task = { id: transactionId, login: gameLogin, amount: totalAmount, remark, is_manual: false };

            const result = await this.recharge(task);
            if (result === -1) return -1;
            if (!result) throw new Error('Recharge failed');

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
        });
    }

    async redeemFromAccount(userId, gameLogin, totalAmount, cashoutAmount, remark = 'API Redeem') {
        return await this.queueOperation(`redeem:${gameLogin}:${cashoutAmount}`, async () => {
            const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
            if (!gameAccount) throw new Error('Game account not found');

            const task = { id: null, login: gameLogin, amount: totalAmount, remark, is_manual: true };

            const result = await this.redeem(task);
            if (result === -1) return -1;
            if (!result) throw new Error('Redeem failed');

            const updatedGameAccount = await GameAccount.findById(gameAccount._id);
            return {
                success: true,
                data: { newBalance: updatedGameAccount.balance },
                message: 'Redeem completed successfully'
            };
        });
    }

    async resetAccountPassword(userId, gameLogin, newPassword) {
        return await this.queueOperation(`resetPassword:${gameLogin}`, async () => {
            const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
            if (!gameAccount) return { success: false, message: 'Game account not found' };

            const task = { id: gameAccount._id.toString(), login: gameLogin, password: newPassword };

            const result = await this.resetPassword(task);
            if (result === -1) return -1;
            if (!result) throw new Error('Password reset failed');

            gameAccount.gamePassword = newPassword;
            await gameAccount.save();

            return { success: true, data: { gameLogin }, message: 'Password reset successfully' };
        });
    }

    // ========================================
    // QUEUE POLLING
    // ========================================

    async checkQueue() {
        try {
            const task = await Tasks.get('juwa2');

            if (!task) {
                return setTimeout(this.checkQueue.bind(this), 5000);
            }

            this.log(JSON.stringify(task));

            let task_result = null;

            if (task.type === 'createUser')
                task_result = await this.createUser(task);
            if (task.type === 'getStoreBalance')
                task_result = await this.getStoreBalance(task);
            if (task.type === 'getUsersBalances')
                task_result = await this.getUsersBalances(task);
            if (task.type === 'recharge')
                task_result = await this.recharge(task);
            if (task.type === 'redeem')
                task_result = await this.redeem(task);
            if (task.type === 'resetPassword')
                task_result = await this.resetPassword(task);

            if (task_result === -1) {
                await this.authorize();
            }
        } catch (error) {
            this.error(`Error in checkQueue: ${error.message}`);
        }

        return setTimeout(this.checkQueue.bind(this), 500);
    }
}

module.exports = new Juwa2Controller();