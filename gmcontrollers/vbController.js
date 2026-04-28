// controllers/VBlinkController.js - COMPLETE FILE
const axios = require('axios');
const crypto = require('crypto');
const Logger = require('../utils/logger.js');
const GameAccount = require('../models/GameAccount.js');
const Game = require('../models/Game.js');
const Tasks = require('../lib/tasks.js');

class VBlinkController {
    constructor() {
        this.logger = Logger('VBlink');
        this.gameType = 'vblink';
        this.initialized = false;
        
        // API Configuration - Will be loaded from DB
        this.apiConfig = {
            serverDomain: 'https://www.vblink777.club', // Update with actual domain
            appid: null,
            appsecret: null,
            agentAccount: null,
            agentPassword: null
        };
        
        // Session management
        this.lastSuccessfulOperation = Date.now();
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 3;
        
        // Cache for admin balance
        this.cache = {
            adminBalance: null,
            adminBalanceTimestamp: null,
            cacheDuration: 30 * 1000 // 30 seconds
        };

        // Auto-initialize
        this.loadCredentials()
            .then(() => {
                this.log('✅ Credentials loaded, VBlink controller ready');
                this.initialized = true;
            })
            .catch(err => {
                this.error(`Failed to load credentials: ${err.message}`);
            });

        // Start queue processing
        this.checkQueue();
    }

    log(msg) { this.logger.log(msg); }
    error(msg) { this.logger.error(msg); }

    // ========================================
    // CREDENTIAL MANAGEMENT
    // ========================================

    async loadCredentials() {
        try {
            const game = await Game.findOne({ 
                shortcode: 'VB',
                status: { $in: ['active', 'maintenance'] } 
            });

            if (!game) {
                throw new Error('VBlink game not found in database');
            }

            if (!game.agentUsername || !game.agentPassword) {
                throw new Error('Agent credentials not configured for VBlink');
            }

            // Load API credentials from game config
            this.apiConfig.agentAccount = game.agentUsername;
            this.apiConfig.agentPassword = game.agentPassword;
            
            // These should be stored in game.metadata or similar
            if (game.metadata && game.metadata.appid && game.metadata.appsecret) {
                this.apiConfig.appid = game.metadata.appid;
                this.apiConfig.appsecret = game.metadata.appsecret;
            } else {
                // HARDCODED FALLBACK - Replace with actual values
                this.apiConfig.appid = 'mf0IChecUllYmr13x107';
                this.apiConfig.appsecret = 'k00CFbXeNVcQkfihkjHifuonxx4d4';
                this.log('⚠️ Using hardcoded API credentials - update game.metadata in DB');
            }

            if (game.metadata && game.metadata.apiDomain) {
                this.apiConfig.serverDomain = game.metadata.apiDomain;
            }

            this.log(`Loaded credentials for agent: ${game.agentUsername}`);
            return true;
        } catch (error) {
            this.error(`Failed to load credentials: ${error.message}`);
            throw error;
        }
    }

    // ========================================
    // API SIGNATURE & REQUEST METHODS
    // ========================================

    generateSignature(params) {
        // Remove sign field if exists
        const signParams = { ...params };
        delete signParams.sign;

        // Convert arrays and booleans to proper format
        Object.keys(signParams).forEach(key => {
            if (Array.isArray(signParams[key])) {
                signParams[key] = JSON.stringify(signParams[key]);
            } else if (typeof signParams[key] === 'boolean') {
                signParams[key] = signParams[key] ? 'true' : 'false';
            }
        });

        // Sort parameters alphabetically
        const sortedKeys = Object.keys(signParams).sort();
        
        // Create key=value pairs
        const paramString = sortedKeys
            .map(key => `${key}=${signParams[key]}`)
            .join('&');
        
        // Append appsecret
        const stringToSign = paramString + this.apiConfig.appsecret;
        
        // Generate MD5 hash
        const signature = crypto.createHash('md5').update(stringToSign).digest('hex');
        
        this.log(`Signature generated for params: ${Object.keys(signParams).join(', ')}`);
        return signature;
    }

    async makeApiRequest(endpoint, params = {}) {
        try {
            if (!this.apiConfig.appid || !this.apiConfig.appsecret) {
                throw new Error('API credentials not configured');
            }

            const timestamp = Date.now();
            const requestParams = {
                appid: this.apiConfig.appid,
                timestamp,
                ...params
            };

            // Generate signature
            const sign = this.generateSignature(requestParams);
            requestParams.sign = sign;

            const url = `${this.apiConfig.serverDomain}${endpoint}`;
            
            this.log(`Making API request to ${endpoint}`);

            const response = await axios({
                method: 'POST',
                url,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                data: new URLSearchParams(requestParams).toString(),
                timeout: 15000,
                validateStatus: () => true
            });

            this.log(`Response from ${endpoint}: Code ${response.data?.code}`);

            if (response.data?.code === 200) {
                this.lastSuccessfulOperation = Date.now();
                this.consecutiveErrors = 0;
            } else if (response.data?.code === 4) {
                this.error('Invalid signature - credentials may be incorrect');
                this.consecutiveErrors++;
            }

            return response.data;

        } catch (error) {
            this.error(`API request error: ${error.message}`);
            this.consecutiveErrors++;
            throw error;
        }
    }

    generateRequestId() {
    // ✅ Generate alphanumeric only (no underscores or special chars)
    const timestamp = Date.now().toString();
    const randomStr = Math.random().toString(36).substr(2, 9); // Only letters/numbers
    
    // Combine without underscore
    const requestId = `req${timestamp}${randomStr}`;
    
    // Ensure it's under 64 characters (should be ~28 chars)
    return requestId.substring(0, 64);
}

    // ========================================
    // AGENT LOGIN (Get appsecret if encrypted)
    // ========================================

    async agentLogin() {
        try {
            const params = {
                requestid: this.generateRequestId(),
                account: this.apiConfig.agentAccount,
                passwd: this.apiConfig.agentPassword,
                sign: '' // Will be generated
            };

            const result = await this.makeApiRequest('/fast/agent/login', params);

            if (result.code === 200) {
                this.log('✅ Agent login successful');
                
                // If appsecret is encrypted, decrypt it
                if (result.data?.appsecret_encrypted) {
                    this.apiConfig.appsecret = this.aesDecrypt(
                        result.data.appsecret_encrypted,
                        this.apiConfig.agentPassword
                    );
                    this.log('Decrypted appsecret from login response');
                }

                return {
                    success: true,
                    balance: result.data?.balance,
                    appid: result.data?.appid
                };
            } else {
                this.error(`Agent login failed: ${result.message || 'Unknown error'}`);
                return { success: false, message: result.message };
            }

        } catch (error) {
            this.error(`Agent login error: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    aesDecrypt(encryptedData, password) {
        try {
            // Decode base64
            const data = Buffer.from(encryptedData, 'base64');
            
            // Extract IV (first 16 bytes)
            const iv = data.slice(0, 16);
            
            // Extract encrypted data (remaining bytes)
            const encrypted = data.slice(16);
            
            // Generate key from password (lowercase, double MD5)
            const passwordLower = password.toLowerCase();
            const hash1 = crypto.createHash('md5').update(passwordLower).digest('hex');
            const key = crypto.createHash('md5').update(hash1).digest('hex');
            
            // Decrypt using AES-256-CBC
            const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
            let decrypted = decipher.update(encrypted);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            
            return decrypted.toString();
        } catch (error) {
            this.error(`AES decryption failed: ${error.message}`);
            throw error;
        }
    }

    // ========================================
    // CORE API OPERATIONS
    // ========================================

    async createPlayer(login, password) {
    try {
        this.log(`Creating player: ${login}`);

        const params = {
            requestid: this.generateRequestId(),
            account: login,
            passwd: password
        };

        const result = await this.makeApiRequest('/fast/user/create', params);

        // ✅ DEBUG: Log the entire response
        this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log('🔍 CREATE PLAYER API RESPONSE:');
        this.log(JSON.stringify(result, null, 2));
        this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (result.code === 200 || result.code === 1) {
            // ✅ DEBUG: Check what's in result.data
            this.log('✅ Success! Checking result.data:');
            this.log(`   result.data = ${JSON.stringify(result.data)}`);
            this.log(`   result.data?.full_account = ${result.data?.full_account}`);
            
            // ✅ Try different possible field names
            const fullAccount = result.data?.full_account 
                             || result.data?.fullAccount 
                             || result.data?.full_name
                             || result.data?.account
                             || login; // Fallback to login
            
            this.log(`   Using fullAccount: ${fullAccount}`);
            
            return {
                success: true,
                fullAccount: fullAccount,
                login: login,
                message: result.code === 1 ? 'New user created' : 'Success'
            };
        } else if (result.code === 12) {
            this.log(`Player already exists: ${login}`);
            return { success: false, message: 'User already exists', code: 12 };
        } else {
            this.error(`Create player failed: ${result.message || `Code ${result.code}`}`);
            return { success: false, message: result.message, code: result.code };
        }

    } catch (error) {
        this.error(`Create player error: ${error.message}`);
        return { success: false, message: error.message };
    }
}

    async depositToPlayer(login, amount) {
    try {
        this.log(`Depositing ${amount} to ${login}`);

        // ✅ Get account from DB
        const gameAccount = await GameAccount.findOne({ gameLogin: login });
        
        let accountToUse = login;
        
        // Try to use full_account if available
        if (gameAccount && gameAccount.metadata && gameAccount.metadata.fullAccount) {
            accountToUse = gameAccount.metadata.fullAccount;
            this.log(`Found full_account in metadata: ${accountToUse}`);
        } else {
            this.log(`No full_account found, using login: ${accountToUse}`);
        }

        const params = {
            requestid: this.generateRequestId(),
            account: accountToUse,
            amount: amount.toFixed(2)
        };

        // ✅ DEBUG: Log request params
        this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log('🔍 DEPOSIT REQUEST PARAMS:');
        this.log(JSON.stringify(params, null, 2));
        this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const result = await this.makeApiRequest('/fast/user/deposit', params);

        // ✅ DEBUG: Log full response
        this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log('🔍 DEPOSIT API RESPONSE:');
        this.log(JSON.stringify(result, null, 2));
        this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (result.code === 200) {
            this.log(`✅ Deposit successful. New balance: ${result.data?.balance}`);
            return {
                success: true,
                balance: result.data?.balance,
                orderNum: result.data?.order_num,
                requestid: result.data?.requestid,
                timestamp: result.data?.time
            };
        } else if (result.code === 3) {
            // ✅ DEBUG: Parameter error - let's see what's wrong
            this.error('❌ Parameter Error (Code 3)');
            this.error(`   Account used: ${accountToUse}`);
            this.error(`   Amount: ${amount.toFixed(2)}`);
            this.error(`   Message: ${result.message || result.msg || 'No message'}`);
            
            return { 
                success: false, 
                message: `Parameter error - ${result.message || result.msg || 'Check account format'}`, 
                code: 3 
            };
        } else {
            this.error(`Deposit failed: ${result.message || `Code ${result.code}`}`);
            return { success: false, message: result.message, code: result.code };
        }

    } catch (error) {
        this.error(`Deposit error: ${error.message}`);
        return { success: false, message: error.message };
    }
}

    async withdrawFromPlayer(login, amount) {
        try {
            this.log(`Withdrawing ${amount} from ${login}`);

            const params = {
                requestid: this.generateRequestId(),
                account: login,
                amount: amount.toFixed(2)
            };

            const result = await this.makeApiRequest('/fast/user/withdrawal', params);

            if (result.code === 200) {
                this.log(`✅ Withdrawal successful. New balance: ${result.data?.balance}`);
                return {
                    success: true,
                    balance: result.data?.balance,
                    orderNum: result.data?.order_num
                };
            } else if (result.code === 14) {
                this.error('Insufficient credit for withdrawal');
                return { success: false, message: 'Insufficient credit', code: 14 };
            } else {
                this.error(`Withdrawal failed: ${result.message || `Code ${result.code}`}`);
                return { success: false, message: result.message, code: result.code };
            }

        } catch (error) {
            this.error(`Withdrawal error: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    async getPlayerBalance(login, usePassword = false, password = null) {
        try {
            const endpoint = usePassword ? '/fast/user/balanceWithPasswd' : '/fast/user/balance';
            
            const params = {
                requestid: this.generateRequestId(),
                account: login
            };

            if (usePassword && password) {
                params.passwd = password;
            }

            const result = await this.makeApiRequest(endpoint, params);

            if (result.code === 200) {
                return {
                    success: true,
                    balance: result.data?.balance
                };
            } else if (result.code === 2) {
                return { success: false, message: 'User does not exist', code: 2 };
            } else if (result.code === 20) {
                return { success: false, message: 'Password error', code: 20 };
            } else {
                this.error(`Get balance failed: ${result.message || `Code ${result.code}`}`);
                return { success: false, message: result.message, code: result.code };
            }

        } catch (error) {
            this.error(`Get balance error: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    async changePlayerPassword(login, oldPassword, newPassword) {
        try {
            this.log(`Changing password for ${login}`);

            const params = {
                requestid: this.generateRequestId(),
                account: login,
                passwd: oldPassword,
                new_passwd: newPassword
            };

            const result = await this.makeApiRequest('/fast/user/updatePasswd', params);

            if (result.code === 200) {
                this.log(`✅ Password changed successfully for ${login}`);
                return { success: true };
            } else {
                this.error(`Password change failed: ${result.message || `Code ${result.code}`}`);
                return { success: false, message: result.message, code: result.code };
            }

        } catch (error) {
            this.error(`Password change error: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    async getTradeList(login, startDate, endDate, page = 0, pageNum = 20) {
        try {
            const params = {
                requestid: this.generateRequestId(),
                account: login,
                start_date: startDate,
                end_date: endDate,
                page: page.toString(),
                page_num: pageNum.toString()
            };

            const result = await this.makeApiRequest('/fast/user/tradeList', params);

            if (result.code === 200) {
                return {
                    success: true,
                    total: result.data?.total,
                    pages: result.data?.pages,
                    list: result.data?.list
                };
            } else {
                return { success: false, message: result.message, code: result.code };
            }

        } catch (error) {
            this.error(`Get trade list error: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    async getGameLogList(login) {
        try {
            const params = {
                requestid: this.generateRequestId(),
                account: login
            };

            const result = await this.makeApiRequest('/fast/user/gameLogList', params);

            if (result.code === 200) {
                return {
                    success: true,
                    list: result.data?.list
                };
            } else {
                return { success: false, message: result.message, code: result.code };
            }

        } catch (error) {
            this.error(`Get game log error: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    // ========================================
    // API WRAPPER METHODS (For compatibility with other controllers)
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
            
            const login = `bc${generateRandomString()}${generateRandomString()}`;
            const password = `Bc${generateRandomString()}${Math.floor(Math.random() * 9999)}!`;

            this.log(`Creating game account - Login: ${login}`);

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

            const result = await this.createPlayer(login, password);

            if (result.success) {
                gameAccount.status = 'active';
                gameAccount.gameLogin = login;
                gameAccount.gamePassword = password;
                
                if (!gameAccount.metadata) {
                    gameAccount.metadata = {};
                }
                gameAccount.metadata.fullAccount = result.fullAccount;
                
                await gameAccount.save();

                return {
                    success: true,
                    data: {
                        _id: gameAccount._id,
                        gameLogin: login,
                        gamePassword: password,
                        fullAccount: result.fullAccount,
                        status: gameAccount.status
                    },
                    message: 'Game account created successfully'
                };
            } else {
                gameAccount.status = 'failed';
                if (result.message) {
                    if (!gameAccount.metadata) {
                        gameAccount.metadata = {};
                    }
                    gameAccount.metadata.notes = result.message;
                }
                await gameAccount.save();
                throw new Error(result.message || 'Failed to create game account');
            }

        } catch (error) {
            this.error(`Error creating game account: ${error.message}`);
            throw error;
        }
    }

    async getGameBalance(userId, gameLogin) {
        try {
            const gameAccount = await GameAccount.findOne({
                userId,
                gameLogin
            }).sort({ createdAt: -1 });

            if (!gameAccount) {
                throw new Error('Game account not found');
            }

            const result = await this.getPlayerBalance(gameLogin);

            if (!result.success) {
                return {
                    success: false,
                    data: null,
                    message: result.message || 'Failed to retrieve balance'
                };
            }

            const balance = result.balance;
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
            this.log(`Recharge - Base: ${baseAmount}, Total (with bonus): ${totalAmount}`);
            
            const gameAccount = await GameAccount.findOne({
                userId,
                gameLogin
            }).sort({ createdAt: -1 });

            if (!gameAccount) {
                throw new Error('Game account not found');
            }

            const result = await this.depositToPlayer(gameLogin, totalAmount);

            if (result.success) {
                const updatedGameAccount = await GameAccount.findById(gameAccount._id);
                
                this.log(`✅ Recharge successful`);
                this.log(`   - User paid: ${baseAmount}`);
                this.log(`   - Bonus: ${totalAmount - baseAmount}`);
                this.log(`   - Total recharged: ${totalAmount}`);
                this.log(`   - New balance: ${result.balance}`);
                
                await updatedGameAccount.updateBalance(result.balance);
                
                return {
                    success: true,
                    data: {
                        transactionId: result.orderNum,
                        newBalance: result.balance,
                        baseAmount: baseAmount,
                        bonusAmount: totalAmount - baseAmount,
                        totalAmount: totalAmount
                    },
                    message: 'Recharge completed successfully'
                };
            } else {
                throw new Error(result.message || 'Recharge failed');
            }

        } catch (error) {
            this.error(`Error processing recharge: ${error.message}`);
            throw error;
        }
    }

    async redeemFromAccount(userId, gameLogin, totalAmount, cashoutAmount, remark = 'API Redeem') {
        try {
            this.log(`Redeem - Amount: ${totalAmount}, Cashout: ${cashoutAmount}`);
            
            const gameAccount = await GameAccount.findOne({
                userId,
                gameLogin
            }).sort({ createdAt: -1 });

            if (!gameAccount) {
                throw new Error('Game account not found');
            }

            if (gameAccount.balance < totalAmount) {
                throw new Error('Insufficient balance');
            }

            const result = await this.withdrawFromPlayer(gameLogin, totalAmount);

            if (result.success) {
                const updatedGameAccount = await GameAccount.findById(gameAccount._id);
                await updatedGameAccount.updateBalance(result.balance);
                
                return {
                    success: true,
                    data: {
                        newBalance: result.balance,
                        orderNum: result.orderNum
                    },
                    message: 'Redeem completed successfully'
                };
            } else {
                throw new Error(result.message || 'Redeem failed');
            }

        } catch (error) {
            this.error(`Error processing redeem: ${error.message}`);
            throw error;
        }
    }

    async resetAccountPassword(userId, gameLogin, newPassword) {
        try {
            const gameAccount = await GameAccount.findOne({
                userId,
                gameLogin
            }).sort({ createdAt: -1 });

            if (!gameAccount) {
                return {
                    success: false,
                    message: 'Game account not found'
                };
            }

            const oldPassword = gameAccount.gamePassword;
            const result = await this.changePlayerPassword(gameLogin, oldPassword, newPassword);
            
            if (result.success) {
                gameAccount.gamePassword = newPassword;
                await gameAccount.save();
                
                return {
                    success: true,
                    message: 'Password reset successfully'
                };
            } else {
                return {
                    success: false,
                    message: result.message || 'Password reset failed'
                };
            }

        } catch (error) {
            this.error(`Error resetting password: ${error.message}`);
            return {
                success: false,
                message: error.message
            };
        }
    }

    async getDownloadCodeForUser(userId, gameLogin) {
        try {
            this.log(`Getting download code for ${gameLogin}`);
            
            // VBlink doesn't support download codes via API
            return {
                success: false,
                message: 'Download codes are not supported for VBlink',
                data: null
            };
            
        } catch (error) {
            this.error(`Error getting download code: ${error.message}`);
            return {
                success: false,
                message: error.message
            };
        }
    }

    // ========================================
    // ADMIN BALANCE (Cached)
    // ========================================

    async getAdminBalance() {
        if (this.cache.adminBalance !== null && 
            this.cache.adminBalanceTimestamp && 
            Date.now() - this.cache.adminBalanceTimestamp < this.cache.cacheDuration) {
            this.log(`Returning cached admin balance: ${this.cache.adminBalance}`);
            return this.cache.adminBalance;
        }
        
        const loginResult = await this.agentLogin();
        
        if (loginResult.success && loginResult.balance !== undefined) {
            this.cache.adminBalance = loginResult.balance;
            this.cache.adminBalanceTimestamp = Date.now();
            return loginResult.balance;
        }
        
        return false;
    }

    // ========================================
    // TASK QUEUE PROCESSING
    // ========================================

    async processCreateTask(task) {
        try {
            const result = await this.createPlayer(task.login, task.password);

            if (result.success) {
                this.log(`✅ Account created: ${task.login}`);
                
                try {
                    const gameAccount = await GameAccount.findById(task.id);
                    if (gameAccount) {
                        gameAccount.status = 'active';
                        gameAccount.gameLogin = task.login;
                        gameAccount.gamePassword = task.password;
                        if (!gameAccount.metadata) gameAccount.metadata = {};
                        gameAccount.metadata.fullAccount = result.fullAccount;
                        await gameAccount.save();
                    }
                } catch (dbError) {
                    this.log(`DB update error: ${dbError.message}`);
                }

                await Tasks.approve(task.id);
                return { success: true, login: task.login, password: task.password };
            } else {
                this.error(`Create failed: ${result.message}`);
                await Tasks.error(task.id, result.message);
                return { success: false, message: result.message };
            }

        } catch (error) {
            this.error(`Create task error: ${error.message}`);
            await Tasks.error(task.id, error.message);
            return { success: false, message: error.message };
        }
    }

    async processRechargeTask(task) {
        try {
            // Check balance first to prevent recharge if already high
            const balanceResult = await this.getPlayerBalance(task.login);
            
            if (balanceResult.success && balanceResult.balance >= 2) {
                this.log(`Balance too high: ${balanceResult.balance}`);
                await Tasks.error(task.id, `balance is more than $2 (${balanceResult.balance})`);
                return false;
            }

            const result = await this.depositToPlayer(task.login, task.amount);

            if (result.success) {
                this.log(`✅ Deposit successful. New balance: ${result.balance}`);
                
                try {
                    const gameAccount = await GameAccount.findOne({ gameLogin: task.login });
                    if (gameAccount) {
                        await gameAccount.updateBalance(result.balance, task.id);
                    }
                } catch (dbError) {
                    this.log(`DB update error: ${dbError.message}`);
                }

                await Tasks.approve(task.id, result.balance);
                this.cache.adminBalance = null;
                return true;
            } else {
                this.error(`Recharge failed: ${result.message}`);
                await Tasks.error(task.id, result.message);
                return false;
            }

        } catch (error) {
            this.error(`Recharge task error: ${error.message}`);
            await Tasks.error(task.id, error.message);
            return false;
        }
    }

    async processRedeemTask(task) {
        try {
            const balanceResult = await this.getPlayerBalance(task.login);
            
            if (!balanceResult.success) {
                await Tasks.error(task.id, balanceResult.message);
                return false;
            }

            if (!task.is_manual && balanceResult.balance !== task.amount) {
                this.log(`Balance mismatch: Expected ${task.amount}, got ${balanceResult.balance}`);
                await Tasks.cancel(task.id, balanceResult.balance);
                return true;
            }

            if (task.is_manual && balanceResult.balance < task.amount) {
                this.log(`Insufficient balance for manual redeem`);
                await Tasks.cancel(task.id, balanceResult.balance);
                return true;
            }

            const result = await this.withdrawFromPlayer(task.login, task.amount);

            if (result.success) {
                this.log(`✅ Withdrawal successful. New balance: ${result.balance}`);
                
                try {
                    const gameAccount = await GameAccount.findOne({ gameLogin: task.login });
                    if (gameAccount) {
                        await gameAccount.updateBalance(result.balance, task.id);
                    }
                } catch (dbError) {
                    this.log(`DB update error: ${dbError.message}`);
                }

                await Tasks.approve(task.id, result.balance);
                this.cache.adminBalance = null;
                return true;
            } else {
                this.error(`Redeem failed: ${result.message}`);
                await Tasks.cancel(task.id);
                return false;
            }

        } catch (error) {
            this.error(`Redeem task error: ${error.message}`);
            await Tasks.cancel(task.id);
            return false;
        }
    }

    async processResetPasswordTask(task) {
        try {
            const gameAccount = await GameAccount.findOne({ gameLogin: task.login });
            
            if (!gameAccount) {
                await Tasks.error(task.id, 'Account not found');
                return false;
            }

            const result = await this.changePlayerPassword(
                task.login, 
                gameAccount.gamePassword, 
                task.password
            );

            if (result.success) {
                this.log(`✅ Password reset successful for ${task.login}`);
                
                gameAccount.gamePassword = task.password;
                await gameAccount.save();
                
                await Tasks.approve(task.id, task.password);
                return true;
            } else {
                this.error(`Password reset failed: ${result.message}`);
                await Tasks.error(task.id, result.message);
                return false;
            }

        } catch (error) {
            this.error(`Reset password task error: ${error.message}`);
            await Tasks.error(task.id, error.message);
            return false;
        }
    }

    async processGetBalanceTask(task) {
        try {
            const balance = await this.getAdminBalance();
            
            if (balance !== false && balance !== null && !isNaN(balance)) {
                this.log(`Admin balance: ${balance}`);
                await Tasks.approve(task.id, balance);
                return balance;
            } else {
                this.error('Failed to get admin balance');
                await Tasks.error(task.id, 'Failed to get balance');
                return false;
            }

        } catch (error) {
            this.error(`Get balance task error: ${error.message}`);
            await Tasks.error(task.id, error.message);
            return false;
        }
    }

    async checkQueue() {
        try {
            const task = await Tasks.get('vblink');

            if (!task) {
                return setTimeout(this.checkQueue.bind(this), 5000);
            }

            this.log(`Processing task: ${task.type} (ID: ${task.id})`);

            let task_result = null;

            switch (task.type) {
                case 'create':
                    task_result = await this.processCreateTask(task);
                    break;

                case 'recharge':
                    task_result = await this.processRechargeTask(task);
                    break;

                case 'redeem':
                    task_result = await this.processRedeemTask(task);
                    break;

                case 'reset':
                case 'reset_password':
                    task_result = await this.processResetPasswordTask(task);
                    break;

                case 'get_balance':
                case 'get_admin_balance':
                    task_result = await this.processGetBalanceTask(task);
                    break;

                case 'get_download_code':
                    this.log('Download codes not supported for VBlink');
                    await Tasks.error(task.id, 'Download codes not supported');
                    task_result = false;
                    break;

                default:
                    this.error(`Unknown task type: ${task.type}`);
                    await Tasks.error(task.id, `Unknown task type: ${task.type}`);
                    task_result = false;
            }

            if (task_result === -1) {
                this.log('Task returned -1, may need retry');
            }

            return setTimeout(this.checkQueue.bind(this), 5000);

        } catch (error) {
            this.error(`Error in checkQueue: ${error.message}`);
            setTimeout(this.checkQueue.bind(this), 5000);
        }
    }

    // ========================================
    // UTILITY METHODS
    // ========================================

    timeout(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async isLoginExist(login) {
        try {
            const result = await this.getPlayerBalance(login);
            return result.success;
        } catch (error) {
            this.error(`Error checking login existence: ${error.message}`);
            return false;
        }
    }

    async reload() {
        this.log('Reloading controller...');
        this.cache.adminBalance = null;
        this.cache.adminBalanceTimestamp = null;
        this.consecutiveErrors = 0;
        
        // Re-login to refresh credentials
        await this.agentLogin();
        
        this.log('Reload complete');
        return true;
    }
}

// Export singleton instance
const vBlinkController = new VBlinkController();
module.exports = vBlinkController;