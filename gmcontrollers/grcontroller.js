// controllers/GameRoomController.js - REFACTORED TO MATCH JUWA/GAMEVAULT PATTERN
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

class GameRoomController {
    constructor() {
        this.browser = null;
        this.page = null;
        this.cookies = null;
        this.authorized = false;
        this.logger = Logger('GameRoom');
        this.gameType = 'gameroom';
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

    time(ms) {
        return parseFloat((ms / 1e3).toFixed(3));
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

    async makeRequest({ path: apiPath, method = 'GET', body }) {
        try {
            const sessionPath = path.join(__dirname, 'sessiongameroom.json');
            const cookiesPath = path.join(__dirname, 'cookiesgameroom.json');

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
                        return { status_code: 410, _: { path: apiPath, body } };
                    }

                    this.log('✅ Session file ready after waiting, proceeding with request...');
                } else {
                    this.error('Session file not found and not initializing. Need to login first.');
                    return { status_code: 410, _: { path: apiPath, body } };
                }
            }

            const session_details = JSON.parse(readFileSync(sessionPath).toString());

            if (!session_details.token) {
                this.error('No token found in session file');
                return { status_code: 410, _: { path: apiPath, body } };
            }

            let cookieHeader = '';
            if (existsSync(cookiesPath)) {
                const cookies_details = JSON.parse(readFileSync(cookiesPath).toString());
                if (cookies_details[0]) {
                    cookieHeader = `gameroom_session=${cookies_details[0].value}`;
                }
            }

            const response = await axios({
                url: `https://agentserver1.gameroom777.com/api${apiPath}`,
                method,
                headers: {
                    "Authorization": `Bearer ${session_details.token}`,
                    "Cookie": cookieHeader,
                    "Content-Type": "application/json"
                },
                data: body,
                validateStatus: () => true
            });

            this.log(`${method} ${apiPath} - Status: ${response.status}`);

            if (response.data) {
                return { ...response.data, _: { path: apiPath, body } };
            }

            return { status_code: response.status, _: { path: apiPath, body } };

        } catch (error) {
            this.error(`Request error: ${error.message}`);

            if (error.response) {
                this.error(`Status: ${error.response.status}, Message: ${error.response.statusText}`);
                return { status_code: error.response.status, _: { path: apiPath, body } };
            } else if (error.request) {
                this.error('No response received from server');
                return { status_code: 500, _: { path: apiPath, body } };
            } else {
                this.error(`Setup error: ${error.message}`);
                return { status_code: 500, _: { path: apiPath, body } };
            }
        }
    }

    checkResponse(response) {
        if (!response) return false;

        if (response.status_code === 200)
            return response;

        if (response.status_code === 410) {
            this.error('Session expired...');
            return -1;
        }

        this.error(`Unknown response [${response._?.path}]: ${JSON.stringify(response)}`);
        return false;
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
                shortcode: 'GR',
                status: { $in: ['active', 'maintenance'] }
            });

            if (!game) {
                throw new Error('GameRoom game not found in database');
            }

            if (!game.agentUsername || !game.agentPassword) {
                throw new Error('Agent credentials not configured for GameRoom');
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
        this.log('Initializing browser for GameRoom...');

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
            this.browser = null;
            this.page = null;
        }

        this.browser = await Puppeteer.launch({
            headless: 'new',
            args: [
                "--fast-start",
                "--disable-extensions",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--no-zygote",
                "--single-process",
                "--disable-dev-shm-usage",
                "--disable-gpu"
            ],
            ignoreHTTPSErrors: true
        });

        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1312, height: 800 });

        const cookiesPath = path.join(__dirname, 'cookiesgameroom.json');
        if (existsSync(cookiesPath)) {
            try {
                const cookies_parsed = JSON.parse(readFileSync(cookiesPath).toString());
                await this.page.setCookie(...cookies_parsed);
                this.log('Cookies loaded successfully');
            } catch (error) {
                this.log('Error loading cookies, continuing without them');
            }
        }

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

        this.browser.once('disconnected', () => {
            this.log('Browser disconnected — will auto-reinitialize...');
            this.browser = null;
            this.page = null;
            this.initialized = false;
            this.browserReady = false;
            this.authorized = false;
            this.isProcessingQueue = false;
            while (this.requestQueue?.length > 0) {
                const task = this.requestQueue.shift();
                task.reject(new Error('Browser disconnected. Please try again.'));
            }
            this.scheduleRetryInitialize();
        });

        await this.checkAuthorization();
    }

    async clearBrowserCookies() {
        const client = await this.page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        return true;
    }

    async isLoginPage() {
        await this.timeout(2e3);

        const isLoginPage = await this.page.evaluate(() => {
            if (location.pathname === '/admin/login')
                return 'login';

            const modalTitle = document.querySelector('.layui-layer-title');
            if (modalTitle && modalTitle.innerText === 'Login timeout') {
                const button = document.querySelector('.layui-layer-btn0');
                if (button) button.click();
                return 'modal';
            }

            const div = document.querySelector('div[aria-label="Login timeout"]');
            if (div) return 'div-login';

            return false;
        });

        return isLoginPage;
    }

    async checkAuthorization() {
        this.log('Check auth...');

        await this.page.goto('https://agentserver1.gameroom777.com/admin', { waitUntil: 'networkidle0' });

        const sessionPath = path.join(__dirname, 'sessiongameroom.json');
        if (existsSync(sessionPath)) {
            const session_parsed = JSON.parse(readFileSync(sessionPath).toString());

            await this.page.evaluate(session_parsed => {
                for (const key of Object.keys(session_parsed))
                    sessionStorage.setItem(key, session_parsed[key]);
            }, session_parsed);

            await this.page.goto('https://agentserver1.gameroom777.com/admin', { waitUntil: 'networkidle0' });
        }

        await this.timeout(3e3);

        const isLoginPage = await this.isLoginPage();

        if (isLoginPage) {
            this.error('Auth required');
            this.authorized = false;
            await this.authorize();
            return false;
        } else {
            this.log('Session exist! Ready to work');
            this.authorized = true;
            this.checkQueue();
            return true;
        }
    }

    async reload() {
        this.log('Reloading and clearing session files...');

        const dir = readdirSync(__dirname);
        for (const file of dir) {
            if (["sessiongameroom.json", "cookiesgameroom.json"].includes(file)) {
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

                await this.clearBrowserCookies();

                if (!this.agentCredentials) {
                    const credentialsLoaded = await this.loadAgentCredentials();
                    if (!credentialsLoaded) {
                        throw new Error('No credentials available');
                    }
                }

                await this.page.goto('https://agentserver1.gameroom777.com/admin/login', { waitUntil: 'load' });
                await this.page.type('input[name="username"]', this.agentCredentials.username);
                await this.page.type('input[name="password"]', this.agentCredentials.password);

                await this.timeout(1e3); // Waiting captcha

                const captcha_image = await this.page.evaluate(() => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 132;
                    canvas.height = 40;
                    const context = canvas.getContext('2d');
                    context.drawImage(document.querySelector('#verifyCanvas'), 0, 0, 132, 40);
                    return canvas.toDataURL("image/png").replace(/^data:image\/?[A-z]*;base64,/, "");
                });

                this.log('Sending captcha...');
                const captchaValue = await Captcha(captcha_image, 4);
                this.log(`Captcha solved: ${captchaValue}`);

                await this.page.type('input[name="captcha"]', captchaValue);
                await this.page.click('button');

                await this.page.waitForSelector('.layui-layer-msg');

                const error_message = await this.page.evaluate(() => {
                    const element = document.querySelector('.layui-layer-msg');
                    return element ? element.innerText : false;
                });

                if (error_message && error_message !== "Users login succeeded") {
                    throw new Error(`Auth error: ${error_message}`);
                }

                await this.page.waitForNavigation({ waitUntil: 'load' });
                await this.timeout(2e3);

                const isLoginPage = await this.isLoginPage();

                if (!isLoginPage) {
                    await this.saveCookies();
                    this.authorized = true;
                    this.authRetryCount = 0;

                    await this.page.goto('https://agentserver1.gameroom777.com/admin/player/index', { waitUntil: 'load' });

                    this.log('Auth success');
                    this.checkQueue();
                } else {
                    throw new Error('No redirect after auth');
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
                    this.log(`Retrying authorization in 5 seconds (attempt ${this.authRetryCount + 1}/${this.maxAuthRetries})...`);
                    this.authorizationInProgress = false;
                    this.isAuthorizing = false;
                    this.authorizationPromise = null;
                    await new Promise(resolve => setTimeout(resolve, 5000));
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
        await writeFileSync(path.join(__dirname, 'cookiesgameroom.json'), JSON.stringify(cookies, null, 4));

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
            };
        });

        await writeFileSync(path.join(__dirname, 'sessiongameroom.json'), JSON.stringify(session, null, 4));
        return true;
    }

    // ========================================
    // HELPER METHODS FOR API CALLS
    // ========================================

    async getUserDetails(login) {
        const start_at = Date.now();
        this.log(`Get login information ${login}...`);

        const users_list_response = this.checkResponse(await this.makeRequest({
            path: `/player/userList?page=1&limit=1&account=${login}`,
            method: 'GET'
        }));

        if (users_list_response === -1) return -1;
        if (!users_list_response) return false;

        if (users_list_response.count < 1 || users_list_response.data[0].Account !== login) {
            this.error(`Login ${login} not found...`);
            return false;
        }

        const user_details = {
            id: users_list_response.data[0].Id,
            login: users_list_response.data[0].Account,
            balance: users_list_response.data[0].score,
            balance_int: parseInt(users_list_response.data[0].score),
            can_recharge: users_list_response.data[0].can_recharge,
            can_withdraw: users_list_response.data[0].can_withdraw,
            store_balance: null
        };

        const is_game_user_response = this.checkResponse(await this.makeRequest({
            path: `/player/isGame?id=${user_details.id}`
        }));

        if (is_game_user_response === -1) return -1;
        if (!is_game_user_response) return false;

        user_details.is_game = is_game_user_response.is_game;

        const agent_money_response = this.checkResponse(await this.makeRequest({
            path: `/player/agentMoney?id=${user_details.id}`
        }));

        if (agent_money_response === -1) return -1;
        if (!agent_money_response) return false;

        user_details.store_balance = parseFloat(agent_money_response.data.cusBlance);

        this.log(`Login info loaded ${login} in ${this.time(Date.now() - start_at)} s.`);
        return user_details;
    }

    async getUsersList() {
        const start_at = Date.now();

        let parsed = false,
            page = 1,
            users_list = {};

        while (!parsed) {
            const response = this.checkResponse(await this.makeRequest({
                path: `/player/userList?page=${page}&limit=100`,
                method: 'GET'
            }));

            if (response === -1) return -1;
            if (!response) return false;

            for (const user of response.data)
                users_list[user.Account] = parseFloat(user.score);

            if (Object.keys(users_list).length >= response.count)
                parsed = true;
            else
                page++;
        }

        this.log(`Got users ${Object.keys(users_list).length} in ${this.time(Date.now() - start_at)} s`);
        return users_list;
    }

    // ========================================
    // TASK OPERATIONS
    // ========================================

    async getStoreBalance({ id }) {
        this.log('Loading store balance...');

        const response = this.checkResponse(await this.makeRequest({
            path: '/agent/getMoney',
            method: 'POST'
        }));

        if (response === -1) return -1;
        if (!response) return false;

        this.log(`Current store balance: ${response.data}`);
        if (id) await Tasks.approve(id, response.data);
        return true;
    }

    async createUser({ id, login, password }) {
        const response = this.checkResponse(await this.makeRequest({
            path: '/player/playerInsert',
            method: 'POST',
            body: {
                username: login,
                nickname: login,
                money: 0,
                password: password,
                password_confirmation: password
            }
        }));

        if (response === -1) return -1;
        if (!response) {
            if (id) await Tasks.error(id, 'createUser failed');
            return false;
        }

        this.log(`Created ${login}`);
        if (id) await Tasks.approve(id, { login, password });
        return true;
    }

    async resetPassword({ id, login, password }) {
        const start_at = Date.now();
        this.log(`Reset password for login ${login}...`);

        const user_details = await this.getUserDetails(login);
        if (user_details === -1) return -1;
        if (!user_details) return false;

        const response = this.checkResponse(await this.makeRequest({
            path: '/player/reset',
            method: 'POST',
            body: {
                id: user_details.id,
                password,
                password_confirmation: password
            }
        }));

        if (response === -1) return -1;
        if (!response) {
            if (id) await Tasks.error(id, 'resetPassword failed');
            return false;
        }

        if (id) await Tasks.approve(id, { password, balance: user_details.balance });
        this.log(`Password reset ${login} in ${this.time(Date.now() - start_at)} s.`);
        return true;
    }

    async recharge({ id, login, amount, remark, transactionId, is_manual = false }) {
        const start_at = Date.now();
        this.log(`Recharge $${amount} to ${login}`);

        const user_details = await this.getUserDetails(login);
        if (user_details === -1) return -1;
        if (!user_details) return false;

        if (user_details.balance >= 2) {
            if (id) await Tasks.reject(id, 'balance', user_details.balance);
            return false;
        }
        if (user_details.is_game) {
            if (id) await Tasks.reject(id, 'user_in_game');
            return false;
        }
        if (!user_details.can_recharge) {
            if (id) await Tasks.reject(id, 'user_in_bonus');
            return false;
        }
        if (user_details.store_balance < amount) {
            if (id) await Tasks.reject(id, 'store_balance');
            return false;
        }

        const response = this.checkResponse(await this.makeRequest({
            path: '/player/agentRecharge',
            method: 'POST',
            body: {
                id: user_details.id,
                available_balance: user_details.store_balance.toFixed(2),
                opera_type: 0,
                bonus: 0,
                balance: amount,
                remark: (transactionId || '').replace(/[^a-zA-Z0-9]/gi, '')
            }
        }));

        if (response === -1) return -1;
        if (!response) return false;

        if (id) await Tasks.approve(id, parseFloat(response.data.total_balance));
        this.log(`Recharged ${login} for $${amount} in ${this.time(Date.now() - start_at)} s.`);
        return true;
    }

    async redeem({ id, login, minimal = 0, transactionId, remark, is_manual = false }) {
        const start_at = Date.now();
        this.log(`Redeem ${login}`);

        const user_details = await this.getUserDetails(login);
        if (user_details === -1) return -1;
        if (!user_details) return false;

        if (user_details.balance_int < minimal) {
            if (id) await Tasks.reject(id, 'minimal', minimal);
            return false;
        }
        if (user_details.is_game) {
            if (id) await Tasks.reject(id, 'user_in_game');
            return false;
        }
        if (!user_details.can_withdraw) {
            if (id) await Tasks.reject(id, 'user_in_bonus');
            return false;
        }

        const response = this.checkResponse(await this.makeRequest({
            path: '/player/agentWithdraw',
            method: 'POST',
            body: {
                id: user_details.id,
                customer_balance: user_details.balance,
                opera_type: 1,
                balance: user_details.balance_int,
                remark: (transactionId || '').replace(/[^a-zA-Z0-9]/gi, '')
            }
        }));

        if (response === -1) return -1;
        if (!response) return false;

        if (id) await Tasks.approve(id, user_details.balance_int);
        this.log(`Redeemed ${user_details.balance_int} from ${login} in ${this.time(Date.now() - start_at)} s.`);
        return true;
    }

    async getUsersBalances({ id }) {
        const balances = await this.getUsersList();

        if (balances === -1) return -1;
        if (!balances) {
            this.error("Can't get users list");
            return false;
        }

        await Tasks.approve(id, balances);
        return true;
    }

    // ========================================
    // PUBLIC API METHODS (called by gameController)
    // ========================================

    // Standard interface method that gameController.js calls.
    async createGameAccount(userId, game) {
        const generateRandomString = () => {
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            let result = '';
            for (let i = 0; i < 4; i++) {
                result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return result;
        };

        const login = `bc${generateRandomString()}${generateRandomString()}`;
        const password = `Bc${generateRandomString()}${Math.floor(Math.random() * 99)}`;

        this.log(`Creating game account - Login: ${login}`);

        const gameAccount = new GameAccount({
            userId,
            gameId: game._id,
            gameLogin: login,
            gamePassword: password,
            gameType: this.gameType,
            status: 'pending',
            metadata: { createdVia: 'api' }
        });

        await gameAccount.save();

        try {
            const result = await this.queueOperation(`createUser:${login}`, async () => {
                return await this.createUser({ id: null, login, password });
            });

            if (result === -1 || !result) {
                gameAccount.status = 'failed';
                await gameAccount.save();
                throw new Error('Failed to create game account on server');
            }

            gameAccount.status = 'active';
            gameAccount.gameLogin = login;
            gameAccount.gamePassword = password;
            await gameAccount.save();

            return {
                success: true,
                data: {
                    _id: gameAccount._id,
                    gameLogin: login,
                    gamePassword: password,
                    gameType: gameAccount.gameType,
                    status: gameAccount.status
                },
                message: 'Game account created successfully'
            };
        } catch (error) {
            gameAccount.status = 'failed';
            if (!gameAccount.metadata) gameAccount.metadata = {};
            gameAccount.metadata.notes = error.message;
            await gameAccount.save();
            this.error(`Error creating game account: ${error.message}`);
            throw error;
        }
    }

    // Alternate creation entry point (kept for backwards compatibility).
    async createUserAccount(userId, gameLogin, password) {
        return await this.queueOperation(`createUser:${gameLogin}`, async () => {
            const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
            const taskId = gameAccount ? gameAccount._id.toString() : null;

            const result = await this.createUser({ id: taskId, login: gameLogin, password });
            if (result === -1) return -1;
            if (!result) throw new Error('Create user failed');

            return { success: true, data: { gameLogin }, message: 'User created successfully' };
        });
    }

    async getGameBalance(userId, gameLogin) {
        try {
            const gameAccount = await GameAccount.findOne({
                userId,
                gameLogin,
                gameType: this.gameType
            }).sort({ createdAt: -1 });

            if (!gameAccount) {
                throw new Error('Game account not found');
            }

            const user = await this.queueOperation(`getBalance:${gameLogin}`, async () => {
                return await this.getUserDetails(gameLogin);
            });

            if (!user || user === -1) {
                return {
                    success: false,
                    data: null,
                    message: 'Failed to retrieve balance from game server'
                };
            }

            await gameAccount.updateBalance(user.balance);

            return {
                success: true,
                data: {
                    gameLogin,
                    balance: user.balance,
                    lastCheck: new Date(),
                    accountId: gameAccount._id
                }
            };
        } catch (error) {
            this.error(`Error getting balance: ${error.message}`);
            return { success: false, data: null, message: error.message };
        }
    }

    async rechargeAccount(userId, gameLogin, totalAmount, baseAmount, remark = 'API Recharge') {
        return await this.queueOperation(`recharge:${gameLogin}:${totalAmount}`, async () => {
            const gameAccount = await GameAccount.findOne({ userId, gameLogin, gameType: this.gameType });
            if (!gameAccount) throw new Error('Game account not found');

            const transactionId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const task = { id: null, login: gameLogin, amount: totalAmount, remark, transactionId, is_manual: false };

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

            const transactionId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const task = { id: null, login: gameLogin, minimal: 0, remark, transactionId, is_manual: true };

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

            const task = { id: null, login: gameLogin, password: newPassword };

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
            const task = await Tasks.get('gameroom');

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

module.exports = new GameRoomController();