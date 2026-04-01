// controllers/GameVaultController.js - REFACTORED TO MATCH JUWA PATTERN
// PART 1 OF 3 - Lines 1-500
const Puppeteer = require('puppeteer');
const Captcha = require('../lib/captcha.js');
const { writeFileSync, readFileSync, existsSync, readdirSync, rmSync } = require('fs');
const Tasks = require('../lib/tasks.js');
const Logger = require('../utils/logger.js');
const GameAccount = require('../models/GameAccount.js');
const Game = require('../models/Game.js');
const path = require('path');
const axios = require('axios');

class GameVaultController {
   constructor() {
    this.browser = null;
    this.page = null;
    this.cookies = null;
    this.authorized = false;
    this.logger = Logger('GameVault');
    this.gameType = 'gv';
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
    this.authResetInterval = 5 * 60 * 1000; // Reset counter after 5 minutes

    // SESSION MANAGEMENT
    this.sessionTimeout = null;
    this.lastSuccessfulOperation = Date.now();
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;
    this.consecutiveMonitorFailures = 0;
    this.maxMonitorFailures = 5;

    // ⭐ AUTO-INITIALIZE - Start browser when controller is created
    this.loadAgentCredentials()
        .then(() => {
            this.log('Credentials loaded, starting browser initialization...');
            return this.initialize();
        })
        .then(() => {
            this.log('✅ Browser initialized and ready');
        })
        .catch(err => {
            this.error(`Failed to initialize on startup: ${err.message}`);
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

    // RESET AUTH RETRY COUNTER IF ENOUGH TIME HAS PASSED
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

   async makeRequest({ url, method, body }) {
    try {
        const sessionPath = path.join(__dirname, 'sessiongv.json');
        
        // ⭐ If no session during startup, wait for initialization
        if (!existsSync(sessionPath)) {
            // Check if we're initializing
            if (this.isInitializing || this.isAuthorizing) {
                this.log('Session not ready yet, waiting for initialization...');
                
                // Wait for initialization to complete
                if (this.initializationPromise) {
                    await this.initializationPromise;
                }
                
                // Wait for authorization to complete
                if (this.authorizationPromise) {
                    await this.authorizationPromise;
                }
                
                // Wait a bit for session file to be written
                await new Promise(resolve => setTimeout(resolve, 1500));
                
                // Check if session file exists now
                if (!existsSync(sessionPath)) {
                    this.error('Session file still not found after initialization');
                    return {
                        code: 401,
                        status: 401,
                        msg: 'Session not found'
                    };
                }
                
                // ✅ Session file now exists, continue to make the request
                this.log('✅ Session file ready after waiting, proceeding with request...');
            } else {
                this.error('Session file not found and not initializing. Need to login first.');
                return {
                    code: 401,
                    status: 401,
                    msg: 'Session not found'
                };
            }
        }

        // ⭐ Read session file (this code runs for both cases now)
        const buffer = readFileSync(sessionPath);
        const json = buffer.toString();
        const session_details = JSON.parse(json);

        if (!session_details.token) {
            this.error('No token found in session file');
            return {
                code: 401,
                status: 401,
                msg: 'Token not found'
            };
        }

        // ⭐ Make the actual HTTP request
        const response = await axios({
            url,
            method,
            headers: {
                "Authorization": `Bearer ${session_details.token}`,
                "Content-Type": "application/json"
            },
            data: body,
            validateStatus: () => true
        });

        this.log(`${method} ${url} - Status: ${response.status}`);

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
            return {
                code: 500,
                status: 500,
                msg: 'No response from server'
            };
        } else {
            this.error(`Setup error: ${error.message}`);
            return {
                code: 500,
                status: 500,
                msg: error.message
            };
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
    // BROWSER STATE VALIDATION
    // ========================================

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
            if (!version) {
                throw new Error('Browser not responding');
            }
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
                shortcode: 'GV', 
                status: { $in: ['active', 'maintenance'] } 
            });

            if (!game) {
                throw new Error('GameVault game not found in database');
            }

            if (!game.agentUsername || !game.agentPassword) {
                throw new Error('Agent credentials not configured for GameVault');
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
        this.log('Initializing browser for GameVault...');
        
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
                "--disable-dev-shm-usage",
                "--disable-gpu"
            ],
            ignoreHTTPSErrors: true
        });

        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1312, height: 800 });

        const cookiesPath = path.join(__dirname, 'cookiesgv.json');
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
            this.log('Browser disconnected');
            this.browser = null;
            this.page = null;
            this.initialized = false;
            this.browserReady = false;
            this.authorized = false;
        });

        this.browserReady = true;
        await this.checkAuthorization();
    }// PART 2 OF 3 - Lines 501-1000
// Paste this AFTER Part 1

    async checkAuthorization() {
    try {
        // ⭐ FIX: If authorize() is already running, just wait for it
        if (this.isAuthorizing && this.authorizationPromise) {
            this.log('Authorization already in progress, skipping check...');
            await this.authorizationPromise;
            return;
        }

        if (!this.page || this.page.isClosed()) {
            this.log('Page is closed, cannot check authorization');
            return;
        }

        this.log('Checking authorization status...');
        
        await this.page.goto('https://agent.gamevault999.com/userManagement', {
            waitUntil: 'domcontentloaded',
            timeout: 15000
        });

        const sessionPath = path.join(__dirname, 'sessiongv.json');
        if (existsSync(sessionPath)) {
            try {
                const session = readFileSync(sessionPath).toString();
                const session_parsed = JSON.parse(session);

                await this.page.evaluate((session_parsed) => {
                    for (const key of Object.keys(session_parsed)) {
                        localStorage.setItem(key, session_parsed[key]);
                    }
                }, session_parsed);

                await this.page.goto('https://agent.gamevault999.com/userManagement', {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
                
                this.log('Session storage loaded');
            } catch (error) {
                this.log('Error loading session, continuing without it');
            }
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        const isLoginPage = await this.page.evaluate(() => {
            const errorPage = document.querySelector('.error-page');
            if (errorPage) return true;
            return location.pathname === '/login';
        });

        if (isLoginPage) {
            this.authorized = false;
            this.log('Not authorized - need to login');
            await this.authorize();
            return;
        } else {
            this.log('✅ Already authorized (session valid)');
            this.authorized = true;
            this.initialized = true;
            this.browserReady = true;
            
            return true;
        }
    } catch (error) {
        this.error(`Error checking authorization: ${error.message}`);
        
        if (error.message.includes('detached Frame') || 
            error.message.includes('Target closed') ||
            error.message.includes('Session closed')) {
            this.log('Detected detached frame, need browser restart');
            this.browserReady = false;
            this.initialized = false;
            return;
        }
        
        // Don't retry automatically - let it be handled elsewhere
        this.log('Check authorization failed, will retry on next operation');
    }
}

    async reload() {
        this.log('Reloading and clearing session files...');
        
        const dir = readdirSync(__dirname);
        
        for (const file of dir) {
            if (["sessiongv.json", "cookiesgv.json", "localgv.json"].includes(file)) {
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

    // ⭐ CHECK RETRY LIMIT BEFORE STARTING
    this.resetAuthRetryIfNeeded();
    
    if (this.authRetryCount >= this.maxAuthRetries) {
        this.error(`Max authorization attempts (${this.maxAuthRetries}) reached. Waiting 30 seconds before reset...`);
        this.authRetryCount = 0;
        await new Promise(resolve => setTimeout(resolve, 30000));
    }

    this.authorizationInProgress = true;
    this.isAuthorizing = true;
    this.authRetryCount++; // ⭐ Increment retry counter
    this.lastAuthAttempt = Date.now();
    
    this.authorizationPromise = (async () => {
        try {
            this.log(`Starting authorization (attempt ${this.authRetryCount}/${this.maxAuthRetries})...`);
            
            // ⭐ FIX: Just check if page exists, don't call initialize
            if (!this.page || this.page.isClosed()) {
                this.log('Page is invalid, cannot authorize');
                throw new Error('Browser not ready - please initialize first');
            }

            // ⭐ Proceed directly to login page
            await this.page.goto('https://agent.gamevault999.com/login', {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });

            if (!this.agentCredentials) {
                const credentialsLoaded = await this.loadAgentCredentials();
                if (!credentialsLoaded) {
                    throw new Error('Cannot authorize without agent credentials');
                }
            }

            this.log(`Using agent credentials: ${this.agentCredentials.username}`);

            await this.page.evaluate(() => {
                const inputs = document.querySelectorAll('input');
                if (inputs.length < 4) {
                    throw new Error('Login form not found - not enough input fields');
                }
                inputs[0].setAttribute('id', 'login');
                inputs[0].value = '';
                inputs[1].setAttribute('id', 'password');
                inputs[1].value = '';
                inputs[2].setAttribute('id', 'captcha');
                inputs[3].click();
            });

            await new Promise(resolve => setTimeout(resolve, 300));

            await this.page.type('#login', this.agentCredentials.username);
            await this.page.type('#password', this.agentCredentials.password);
            await new Promise(resolve => setTimeout(resolve, 500));

            this.log('Waiting for captcha image...');
            await this.page.waitForSelector('.imgCode', { timeout: 5000 });
            
            await this.page.waitForFunction(() => {
                const img = document.querySelector('.imgCode');
                return img && img.complete && img.naturalHeight !== 0;
            }, { timeout: 5000 });

            await new Promise(resolve => setTimeout(resolve, 200));

            const base64Captcha = await this.page.evaluate(() => {
                const captchaImg = document.querySelector('.imgCode');
                
                if (!captchaImg || !captchaImg.complete || captchaImg.naturalHeight === 0) {
                    throw new Error('Captcha image not loaded');
                }
                
                const canvas = document.createElement('canvas');
                canvas.width = captchaImg.naturalWidth || 132;
                canvas.height = captchaImg.naturalHeight || 40;
                const context = canvas.getContext('2d');
                context.drawImage(captchaImg, 0, 0);
                return canvas.toDataURL("image/png").replace(/^data:image\/?[A-z]*;base64,/, "");
            });

            if (!base64Captcha || base64Captcha.length < 100) {
                throw new Error('Failed to capture captcha image');
            }

            this.log('Solving captcha...');
            const captchaValue = await Captcha(base64Captcha, 4);
            
            if (!captchaValue) {
                throw new Error('Failed to solve captcha');
            }
            
            this.log(`Captcha solved: ${captchaValue}`);

            await this.page.type('#captcha', captchaValue);
            
            await this.page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                buttons[2].click();
            });

            await new Promise(resolve => setTimeout(resolve, 3000));

            const currentUrl = this.page.url();
            const currentPath = await this.page.evaluate(() => location.pathname);
            this.log(`After login click - URL: ${currentUrl}, Path: ${currentPath}`);

            const is_logged_in = await this.page.evaluate(() => {
                return location.pathname === '/userManagement' || location.pathname === '/HomeDetail';
            });

            if (is_logged_in) {
                this.authorized = true;
                this.log('✅ Successfully authorized');
                
                // ⭐ RESET RETRY COUNT ON SUCCESS
                this.authRetryCount = 0;
                
                if (currentPath === '/HomeDetail') {
                    this.log('Redirected to HomeDetail, navigating to userManagement...');
                    await this.page.goto('https://agent.gamevault999.com/userManagement', {
                        waitUntil: 'domcontentloaded',
                        timeout: 15000
                    });
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                await this.saveCookies();
                await this.saveSession();
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                this.log('Session and cookies saved, authorization complete');
            } else {
                const error_message = await this.page.evaluate(() => {
                    const message = document.querySelector('p.el-message__content');
                    if (message) return message.innerText;
                    
                    if (location.pathname === '/login') {
                        return 'Still on login page - possibly wrong captcha or credentials';
                    }
                    
                    return 'Login failed - unknown reason';
                });

                this.log(`❌ Failed login: ${error_message}`);
                
                // ⭐ CHECK RETRY LIMIT
                if (error_message.includes('captcha') || error_message.includes('Still on login')) {
                    if (this.authRetryCount < this.maxAuthRetries) {
                        this.log(`Retrying login in 3 seconds (attempt ${this.authRetryCount + 1}/${this.maxAuthRetries})...`);
                        
                        // ⭐ Clear flags before retry
                        this.authorizationInProgress = false;
                        this.isAuthorizing = false;
                        this.authorizationPromise = null;
                        
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        return await this.authorize();
                    } else {
                        throw new Error(`Max retry attempts reached: ${error_message}`);
                    }
                } else {
                    throw new Error(`Login failed: ${error_message}`);
                }
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
                
                // ⭐ Clear flags and let initialize handle it
                this.authorizationInProgress = false;
                this.isAuthorizing = false;
                this.authorizationPromise = null;
                
                throw error; // Re-throw so makeRequest can handle it
            }
            
            // ⭐ CHECK RETRY LIMIT BEFORE RETRYING
            if (this.authRetryCount < this.maxAuthRetries) {
                this.log(`Retrying authorization in 3 seconds (attempt ${this.authRetryCount + 1}/${this.maxAuthRetries})...`);
                this.authorizationInProgress = false;
                this.isAuthorizing = false;
                this.authorizationPromise = null;
                
                await new Promise(resolve => setTimeout(resolve, 3000));
                return await this.authorize();
            } else {
                this.error(`Max authorization attempts (${this.maxAuthRetries}) reached. Will retry after cooldown.`);
                this.authRetryCount = 0; // Reset for next attempt
                throw error;
            }
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
            const cookiesPath = path.join(__dirname, 'cookiesgv.json');
            writeFileSync(cookiesPath, JSON.stringify(cookies, null, 4));
            this.log('Cookies saved successfully');
            return true;
        } catch (error) {
            this.error(`Error saving cookies: ${error.message}`);
            return false;
        }
    }

    async saveSession() {
        try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const session = await this.page.evaluate(() => {
                return {
                    i18n: localStorage.getItem('i18n'),
                    user: localStorage.getItem('user'),
                    token: localStorage.getItem('token'),
                    ElMessageBox_tip: localStorage.getItem('ElMessageBox_tip'),
                    timezone: localStorage.getItem('timezone')
                };
            });

            if (!session.token) {
                this.error('Warning: No token found in localStorage after login!');
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                const retrySession = await this.page.evaluate(() => {
                    return {
                        i18n: localStorage.getItem('i18n'),
                        user: localStorage.getItem('user'),
                        token: localStorage.getItem('token'),
                        ElMessageBox_tip: localStorage.getItem('ElMessageBox_tip'),
                        timezone: localStorage.getItem('timezone')
                    };
                });
                
                if (!retrySession.token) {
                    throw new Error('Failed to get token from localStorage after retry');
                }
                
                this.log('Token retrieved on retry');
                const sessionPath = path.join(__dirname, 'sessiongv.json');
                writeFileSync(sessionPath, JSON.stringify(retrySession, null, 4));
                this.log('Session saved successfully (after retry)');
                return true;
            }

            const sessionPath = path.join(__dirname, 'sessiongv.json');
            writeFileSync(sessionPath, JSON.stringify(session, null, 4));
            this.log(`Session saved successfully - Token: ${session.token ? session.token.substring(0, 20) + '...' : 'NONE'}`);
            return true;
        } catch (error) {
            this.error(`Error saving session: ${error.message}`);
            return false;
        }
    }

    // ========================================
    // HELPER METHODS FOR API CALLS
    // ========================================

    async getSessionData() {
        try {
            const sessionPath = path.join(__dirname, 'sessiongv.json');
            const buffer = readFileSync(sessionPath);
            const json = buffer.toString();
            const session_data = JSON.parse(json);
            const session_user_data = JSON.parse(session_data.user);
            return { session_data, session_user_data };
        } catch (error) {
            this.error(`Error reading session data: ${error.message}`);
            return null;
        }
    }

    async isLoginExist(login) {
        try {
            const response = await this.makeRequest({
                url: "https://agent.gamevault999.com/api/user/userList",
                method: "POST",
                body: {
                    limit: 20,
                    locale: "en",
                    page: 1,
                    search: login,
                    timezone: "cst",
                    type: 1
                }
            });

            if (response.code !== 200) {
                if ([400, 401].includes(response.status)) {
                    await this.reload();
                    return -1;
                }
                
                this.error(`${response.status}, ${response.msg}`);
                return false;
            }

            for (const user of response.data.list) {
                if (user.login_name == login) {
                    return true;
                }
            }

            return false;
        } catch (error) {
            this.error(`Error checking login existence: ${error.message}`);
            return false;
        }
    }

    async getLoginBalance(login) {
        try {
            const response = await this.makeRequest({
                url: "https://agent.gamevault999.com/api/user/userList",
                method: "POST",
                body: {
                    limit: 20,
                    locale: "en",
                    page: 1,
                    search: login,
                    timezone: "cst",
                    type: 1
                }
            });

            if (response.code !== 200) {
                if ([400, 401].includes(response.status)) {
                    await this.reload();
                    return -1;
                }
                
                this.error(`${response.status}, ${response.msg}`);
                return false;
            }

            for (const user of response.data.list) {
                if (user.login_name == login) {
                    return {
                        balance: user.balance,
                        user_id: user.user_id
                    };
                }
            }

            return false;
        } catch (error) {
            this.error(`Error getting login balance: ${error.message}`);
            return false;
        }
    }

    async redeemRecharge({ amount, balance, remark, user_id, type = 1 }) {
        try {
            if (!this.agentCredentials) {
                await this.loadAgentCredentials();
            }

            const response = await this.makeRequest({
                url: "https://agent.gamevault999.com/api/user/rechargeRedeem",
                method: "POST",
                body: {
                    account: this.agentCredentials.username,
                    amount,
                    balance,
                    remark,
                    user_id,
                    locale: "en",
                    timezone: "cst",
                    type
                }
            });

            if (response.code !== 200) {
                if ([400, 401].includes(response.status)) {
                    await this.reload();
                    return -1;
                }
                return false;
            }

            return response;
        } catch (error) {
            this.error(`Error in redeemRecharge: ${error.message}`);
            return false;
        }
    }

    timeout(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms, true));
    }

    async _getAdminBalanceCore() {
        try {
            const sessionData = await this.getSessionData();
            
            if (!sessionData) {
                this.error('Could not read session data');
                return false;
            }

            const response = await this.makeRequest({
                url: "https://agent.gamevault999.com/api/agent/balance",
                method: "POST",
                body: {
                    agent_id: sessionData.session_user_data.agent_id,
                    locale: "en",
                    timezone: "cst"
                }
            });

            if (response.code !== 200) {
                if ([400, 401].includes(response.status)) {
                    await this.reload();
                    return -1;
                }

                this.error(`${response.status}, ${response.msg}`);
                return false;
            }

            const balance = response.data.t;
            this.log(`Current admin balance: ${balance}`);
            return balance;
            
        } catch (error) {
            this.error(`Error getting admin balance: ${error.message}`);
            return false;
        }
    }// PART 3 OF 3 - Lines 1001-End (FINAL)
// Paste this AFTER Part 2

    // ========================================
    // API METHODS (WITHOUT QUEUE)
    // ========================================

    async createGameAccount(userId, game) {
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
                login,
                password,
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
    }

    async getGameBalance(userId, gameLogin) {
        console.log('=== getGameBalance ===');
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

            const userInfo = await this.getLoginBalance(gameLogin);

            if (!userInfo || userInfo === -1) {
                return {
                    success: false,
                    data: null,
                    message: 'Failed to retrieve balance from game server'
                };
            }

            const balance = userInfo.balance;

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

        } catch (error) {
            this.error(`Error getting balance: ${error.message}`);
            return {
                success: false,
                data: null,
                message: error.message
            };
        }
    }

    async rechargeAccount(userId, gameLogin, totalAmount, baseAmount, remark = 'API Recharge') {
        try {
            console.log("Recharge - Finding game account...");
            console.log(`Base Amount: ${baseAmount}, Total Amount (with bonus): ${totalAmount}`);
            
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

            console.log(`Calling recharge with total amount: ${totalAmount}`);
            const result = await this.recharge(task);

            if (result && result !== -1) {
                const updatedGameAccount = await GameAccount.findById(gameAccount._id);
                
                console.log(`✅ Recharge successful`);
                console.log(`   - User paid: ${baseAmount}`);
                console.log(`   - Bonus: ${totalAmount - baseAmount}`);
                console.log(`   - Total recharged in game: ${totalAmount}`);
                console.log(`   - New balance: ${updatedGameAccount.balance}`);
                
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
    }

    async redeemFromAccount(userId, gameLogin, totalAmount, cashoutAmount, remark = 'API Redeem') {
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
    }

    async resetAccountPassword(userId, gameLogin, newPassword) {
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

            this.log('Password reset not supported for GameVault');
            
            return {
                success: false,
                message: 'Password reset not supported for GameVault platform'
            };

        } catch (error) {
            this.error(`Error resetting password: ${error.message}`);
            return {
                success: false,
                message: error.message || 'Error resetting password'
            };
        }
    }

    async getAdminBalance() {
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
    }

    // ========================================
    // CORE OPERATION METHODS
    // ========================================

    async getBalance({ id }) {
        console.log('🔴 GET BALANCE ADMIN START:', { id });
        
        try {
            const balance = await this._getAdminBalanceCore();

            if (balance === false || balance === -1) {
                this.error('Failed to get admin balance');
                await Tasks.error(id, 'failed to get balance');
                return false;
            }

            this.log(`Current admin balance: ${balance}`);
            await Tasks.approve(id, balance);
            
            console.log('✅ GET BALANCE ADMIN COMPLETE');
            return balance;
            
        } catch (error) {
            console.error('❌ GET BALANCE ADMIN ERROR:', error.message);
            this.error(`Error during get balance: ${error.message}`);
            return false;
        }
    }

    async createAccount({ id, login, password }) {
        console.log('🔴 CREATE ACCOUNT START:', { id, login, password: '***' });
        
        try {
            const response = await this.makeRequest({
                url: "https://agent.gamevault999.com/api/user/addUser",
                method: "POST",
                body: {
                    account: login,
                    check_pwd: password,
                    locale: "en",
                    login_pwd: password,
                    nickname: login,
                    rechargeamount: "0.01",
                    timezone: "cst"
                }
            });

            const responseCode = response.code || response.status;

            if (responseCode !== 200) {
                if ([400, 401].includes(responseCode)) {
                    this.error('Authentication error detected, reloading session...');
                    await this.reload();
                    return -1;
                }

                const errorMsg = response.msg || `Error code: ${responseCode}`;
                this.error(errorMsg);

                try {
                    const gameAccount = await GameAccount.findById(id);
                    if (gameAccount) {
                        gameAccount.status = 'failed';
                        if (!gameAccount.metadata) {
                            gameAccount.metadata = {};
                        }
                        gameAccount.metadata.notes = errorMsg;
                        await gameAccount.save();
                    }
                } catch (dbError) {
                    console.log('DB update error:', dbError.message);
                }

                await Tasks.error(id, errorMsg);
                return { success: false, message: errorMsg };
            }

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
            } catch (dbError) {
                console.log('DB update error:', dbError.message);
                this.error(`Error updating account status in DB: ${dbError.message}`);
            }

            await Tasks.approve(id);
            
            console.log('✅ CREATE ACCOUNT COMPLETE');
            return {
                success: true,
                login: login,
                password: password
            };
            
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
            
            return { success: false, message: error.message };
        }
    }

    async recharge({ id, login, amount, remark, is_manual = false }) {
        console.log('🔴 RECHARGE START:', { id, login, amount, remark, is_manual });
        
        try {
            const hasLogin = await this.isLoginExist(login);
            
            if (!hasLogin) {
                this.error(`Login ${login} not found`);
                await Tasks.error(id, 'login not found');
                return false;
            }

            await this.timeout(500);
        
            const userInfo = await this.getLoginBalance(login);

            if (!userInfo || userInfo === -1) {
                this.error(`Failed to get balance for ${login}`);
                await Tasks.error(id, 'failed to get balance');
                return false;
            }

            if (userInfo.balance >= 2) {
                this.log(`Balance too high: ${userInfo.balance}`);
                
                if (is_manual) {
                    await Tasks.cancel(id, ` balance is more than $2 (${userInfo.balance})`);
                }

                await Tasks.error(id, 'balance');
                return false;
            }

            await this.timeout(500);

            const result = await this.redeemRecharge({
                amount,
                balance: userInfo.balance,
                remark,
                user_id: userInfo.user_id,
                type: 1
            });

            console.log('Recharge result:', result);

            if (!result || result === -1 || result.code !== 200) {
                await Tasks.error(id, 'wrong response status');

                if (result && [400, 401].includes(result.status)) {
                    await this.reload();
                    return -1;
                }

                const errorMsg = result ? `${result.status}, ${result.msg}` : 'Recharge failed';
                this.error(errorMsg);
                return false;
            }

            const newBalance = result.data.Balance;
            console.log('✅ SUCCESS! New balance:', newBalance);
            this.log(`Successfully recharged ${amount} to ${login}`);

            try {
                const gameAccount = await GameAccount.findOne({ gameLogin: login });
                if (gameAccount) {
                    await gameAccount.updateBalance(newBalance, id);
                    console.log('Database updated with new balance');
                }
            } catch (dbError) {
                console.log('DB update error:', dbError.message);
                this.error(`Error updating balance in DB: ${dbError.message}`);
            }

            await Tasks.approve(id, newBalance);
            
            this.cache.adminBalance = null;
            this.cache.adminBalanceTimestamp = null;
            
            console.log('✅ RECHARGE COMPLETE');
            return true;
            
        } catch (error) {
            console.log('❌ RECHARGE ERROR:', error.message);
            this.error(`Error during recharge: ${error.message}`);
            return false;
        }
    }

    async redeem({ id, login, amount, remark, is_manual = false }) {
        console.log('🔴 REDEEM START:', { id, login, amount, remark, is_manual });
        
        try {
            const hasLogin = await this.isLoginExist(login);
        
            if (!hasLogin) {
                this.error(`Login ${login} not found`);
                await Tasks.error(id, 'login not found');
                return false;
            }

            await this.timeout(500);
        
            const userInfo = await this.getLoginBalance(login);

            if (!userInfo || userInfo === -1) {
                this.error(`Failed to get balance for ${login}`);
                await Tasks.error(id, 'failed to get balance');
                return false;
            }

            console.log('Current balance:', userInfo.balance);

            if (!is_manual) {
                if (parseInt(userInfo.balance) !== parseInt(amount)) {
                    console.log(`Balance mismatch: Expected ${amount}, got ${userInfo.balance}`);
                    await Tasks.cancel(id, parseInt(userInfo.balance));
                    return true;
                }
            }

            if (is_manual) {
                if (parseInt(userInfo.balance) < parseInt(amount)) {
                    console.log(`Insufficient balance: Has ${userInfo.balance}, needs ${amount}`);
                    await Tasks.cancel(id, parseInt(userInfo.balance));
                    return true;
                }
            }

            await this.timeout(500);

            const result = await this.redeemRecharge({
                amount,
                balance: userInfo.balance,
                remark,
                user_id: userInfo.user_id,
                type: 2
            });

            if (!result || result === -1 || result.code !== 200) {
                if (result && [400, 401].includes(result.status)) {
                    await this.reload();
                    return -1;
                }

                const errorMsg = result ? `${result.status}, ${result.msg}` : 'Redeem failed';
                this.error(errorMsg);
                await Tasks.cancel(id);
                return false;
            }

            const newBalance = result.data.Balance;
            console.log('✅ SUCCESS! New balance:', newBalance);
            this.log(`Successfully withdrew ${amount} from ${login}`);

            try {
                const gameAccount = await GameAccount.findOne({ gameLogin: login });
                if (gameAccount) {
                    await gameAccount.updateBalance(newBalance, id);
                    console.log('Database updated with new balance');
                }
            } catch (dbError) {
                console.log('DB update error:', dbError.message);
                this.error(`Error updating balance in DB: ${dbError.message}`);
            }

            await Tasks.approve(id, newBalance);
            
            this.cache.adminBalance = null;
            this.cache.adminBalanceTimestamp = null;
            
            console.log('✅ REDEEM COMPLETE');
            return true;
            
        } catch (error) {
            console.log('❌ REDEEM ERROR:', error.message);
            this.error(`Error during redeem: ${error.message}`);
            return false;
        }
    }

    async resetPassword({ id, login, password }) {
        console.log('🔴 RESET PASSWORD START:', { id, login, password: '***' });
        
        this.log('Password reset not supported for GameVault');
        await Tasks.error(id, 'Password reset not supported');
        
        console.log('✅ RESET PASSWORD COMPLETE (Not supported)');
        return false;
    }

    async getBalanceAdmin(task) {
        try {
            const balance = await this._getAdminBalanceCore();

            if (balance !== null && !isNaN(balance) && balance !== false && balance !== -1) {
                this.log(`Current admin balance: ${balance}`);
                
                this.cache.adminBalance = balance;
                this.cache.adminBalanceTimestamp = Date.now();
                
                await Tasks.approve(task.id, balance);
                return balance;
            }

            this.error('Could not retrieve admin balance');
            return false;
        } catch (error) {
            this.error(`Error in getBalanceAdmin: ${error.message}`);
            return false;
        }
    }

    async getDownloadCode(task) {
        this.log('Download codes not supported for GameVault');
        await Tasks.error(task.id, 'Download codes not supported');
        return false;
    }

    async checkQueue() {
        try {
            const task = await Tasks.get('gamevault');

            if (!task) {
                return setTimeout(this.checkQueue.bind(this), 5000);
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
const gameVaultController = new GameVaultController();
module.exports = gameVaultController;