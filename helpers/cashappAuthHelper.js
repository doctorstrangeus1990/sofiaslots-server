// helpers/cashappAuthHelper.js
const axios = require('axios');
const Captcha = require('../lib/captcha');
const PaymentMethod = require('../models/PaymentMethod');

/**
 * Get captcha from CashApp gateway
 * @param {string} baseUrl - Base API URL
 * @returns {Promise<{captchaBase64: string, key: string}>}
 */
const getCaptcha = async (baseUrl) => {
    try {
        const timestamp = Date.now();
        const response = await axios.get(`${baseUrl}/getCaptcha`, {
            params: { timestamp },
            timeout: 10000
        });

        console.log('Captcha response:', JSON.stringify(response.data, null, 2));

        if (!response.data || !response.data.data) {
            throw new Error('Invalid captcha response');
        }

        // The response has captchaImg field, not base64
        const captchaImg = response.data.data.captchaImg;
        const key = response.data.data.key;

        if (!captchaImg || !key) {
            throw new Error('Missing captchaImg or key in response');
        }

        return {
            captchaBase64: captchaImg,
            key: key
        };
    } catch (error) {
        console.error('Error getting captcha:', error.message);
        throw new Error('Failed to get captcha from gateway');
    }
};

/**
 * Solve captcha using 2Captcha service
 * @param {string} captchaBase64 - Base64 captcha image (can be data URL or raw base64)
 * @returns {Promise<string>} - Solved captcha code
 */
const solveCaptcha = async (captchaBase64) => {
    try {
        if (!captchaBase64) {
            throw new Error('Captcha base64 is empty or undefined');
        }

        console.log('Captcha base64 length:', captchaBase64.length);
        console.log('Captcha base64 prefix:', captchaBase64.substring(0, 50));
        
        // Remove data:image prefix if exists (e.g., "data:image/png;base64,")
        let cleanBase64 = captchaBase64;
        if (captchaBase64.includes('base64,')) {
            cleanBase64 = captchaBase64.split('base64,')[1];
        } else if (captchaBase64.startsWith('data:')) {
            // In case format is different, try to extract after comma
            const commaIndex = captchaBase64.indexOf(',');
            if (commaIndex !== -1) {
                cleanBase64 = captchaBase64.substring(commaIndex + 1);
            }
        }
        
        console.log('Clean base64 length:', cleanBase64.length);
        console.log('Sending to 2Captcha...');
        
        const captchaCode = await Captcha(cleanBase64, 5); // 5 minute timeout
        
        if (!captchaCode) {
            throw new Error('Captcha solving returned empty result');
        }

        console.log('Captcha solved successfully:', captchaCode);
        return captchaCode;
    } catch (error) {
        console.error('Error solving captcha:', error.message);
        console.error('Error stack:', error.stack);
        throw new Error('Failed to solve captcha: ' + error.message);
    }
};

/**
 * Login to CashApp gateway and get new auth token
 * @param {string} baseUrl - Base API URL
 * @param {string} username - Account username
 * @param {string} password - Hashed password
 * @returns {Promise<string>} - New auth token
 */
const loginToCashapp = async (baseUrl, username, password) => {
    try {
        console.log('🔐 Starting CashApp login process...');
        
        // Step 1: Get captcha
        console.log('📸 Fetching captcha...');
        const { captchaBase64, key } = await getCaptcha(baseUrl);
        console.log('✅ Captcha fetched, key:', key);

        // Step 2: Solve captcha
        console.log('🧩 Solving captcha...');
        const captchaCode = await solveCaptcha(captchaBase64);
        console.log('✅ Captcha solved:', captchaCode);

        // Step 3: Login with credentials and captcha
        console.log('🔑 Logging in with credentials...');
        const loginResponse = await axios.post(
            `${baseUrl}/login`,
            {
                type: "sys",
                account: username,
                pwd: password,
                key: key,
                code: captchaCode,
                googleAuth: ""
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        // Check response
        if (!loginResponse.data || loginResponse.data.code !== 200) {
            throw new Error(loginResponse.data?.message || 'Login failed');
        }

        const newToken = loginResponse.data.data?.token || loginResponse.data.token;

        if (!newToken) {
            throw new Error('No token received from login response');
        }

        console.log('✅ Login successful, new token obtained');

        // Step 4: Update token in database
        await PaymentMethod.updateCashappToken(newToken);
        console.log('✅ Token updated in database');

        return newToken;

    } catch (error) {
        console.error('❌ CashApp login failed:', error.message);
        
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }

        throw new Error('Failed to login to CashApp gateway: ' + error.message);
    }
};

/**
 * Check if token is expired based on response
 * @param {Object} responseData - Response data from API
 * @returns {boolean}
 */
const isTokenExpired = (responseData) => {
    if (!responseData) return false;
    
    // Check for Chinese error message
    const message = responseData.message || responseData.msg || '';
    if (message.includes('未登录') || message.includes('token过期') || message.includes('请登录')) {
        return true;
    }

    // Check for specific error codes that indicate token expiration
    const code = responseData.code;
    if (code === 401 || code === 403 || code === '401' || code === '403') {
        return true;
    }

    return false;
};

/**
 * Make authenticated request to CashApp gateway with auto token refresh
 * @param {string} endpoint - API endpoint (e.g., '/order/handOrder')
 * @param {Object} data - Request payload
 * @param {Object} cashappConfig - CashApp configuration
 * @returns {Promise<Object>} - API response
 */
const makeAuthenticatedRequest = async (endpoint, data, cashappConfig) => {
    try {
        const { apiUrl, authToken, username, password } = cashappConfig;

        // First attempt with existing token
        console.log(`📡 Making request to ${endpoint}...`);
        let response = await axios.post(
            `${apiUrl}${endpoint}`,
            data,
            {
                headers: {
                    'Authori-Zation': authToken,
                    'Content-Type': 'application/json'
                },
                timeout: 30000,
                validateStatus: (status) => status < 500 // Don't throw on 4xx
            }
        );

        // Check if token is expired
        if (isTokenExpired(response.data)) {
            console.log('⚠️  Token expired, attempting to refresh...');

            // Login and get new token
            const newToken = await loginToCashapp(apiUrl, username, password);

            // Retry request with new token
            console.log('🔄 Retrying request with new token...');
            response = await axios.post(
                `${apiUrl}${endpoint}`,
                data,
                {
                    headers: {
                        'Authori-Zation': newToken,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );
        }

        return response;

    } catch (error) {
        console.error('❌ Authenticated request failed:', error.message);
        throw error;
    }
};

module.exports = {
    getCaptcha,
    solveCaptcha,
    loginToCashapp,
    isTokenExpired,
    makeAuthenticatedRequest
};