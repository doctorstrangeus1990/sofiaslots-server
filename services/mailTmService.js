// services/mailTmService.js
const axios = require('axios');

class MailTmService {
    constructor() {
        this.baseUrl = 'https://api.mail.tm';
        this.token = null;
    }

    // Login to Mail.tm
    async login(username, password) {
        try {
            const response = await axios.post(`${this.baseUrl}/token`, {
                address: username,
                password: password
            });
            
            this.token = response.data.token;
            console.log('✅ Mail.tm login successful');
            return { success: true, token: this.token };
        } catch (error) {
            console.error('❌ Mail.tm login error:', error.response?.data || error.message);
            throw new Error('Failed to login to Mail.tm');
        }
    }

    // Get all messages
    async getMessages() {
        try {
            if (!this.token) {
                throw new Error('Not authenticated. Please login first.');
            }

            const response = await axios.get(`${this.baseUrl}/messages`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            const messages = response.data['hydra:member'] || [];
            console.log(`📧 Found ${messages.length} total messages`);
            return messages;
        } catch (error) {
            console.error('❌ Error fetching messages:', error.response?.data || error.message);
            throw new Error('Failed to fetch messages');
        }
    }

    // Get a specific message by ID
    async getMessage(messageId) {
        try {
            if (!this.token) {
                throw new Error('Not authenticated. Please login first.');
            }

            const response = await axios.get(`${this.baseUrl}/messages/${messageId}`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            return response.data;
        } catch (error) {
            console.error('❌ Error fetching message:', error.response?.data || error.message);
            throw new Error('Failed to fetch message');
        }
    }

    // Search for Chime payment emails
    async searchChimePayments(afterDate = null) {
        try {
            const messages = await this.getMessages();
            
            console.log('🔍 Filtering for payment emails...');
            
            // Filter for payment-related emails
            const chimeMessages = messages.filter(msg => {
                const subject = msg.subject?.toLowerCase() || '';
                
                // Look for payment-related keywords in subject
                const hasPaymentSubject = subject.includes('sent you') ||
                                         subject.includes('received') ||
                                         subject.includes('payment') ||
                                         subject.includes('$');
                
                // Filter by date if provided
                if (afterDate) {
                    const messageDate = new Date(msg.createdAt);
                    const isAfterDate = messageDate > afterDate;
                    
                    if (hasPaymentSubject && isAfterDate) {
                        console.log(`✅ Found matching message: "${msg.subject}" from ${msg.from?.address} at ${messageDate}`);
                    }
                    
                    return hasPaymentSubject && isAfterDate;
                }
                
                return hasPaymentSubject;
            });
            
            console.log(`💰 Found ${chimeMessages.length} payment-related emails`);
            return chimeMessages;
        } catch (error) {
            console.error('❌ Error searching Chime payments:', error);
            throw error;
        }
    }

    // Parse Chime payment email content
    async parseChimePayment(messageId) {
        try {
            const message = await this.getMessage(messageId);
            
            // Extract text and subject
            const text = message.text || message.html || '';
            const subject = message.subject || '';
            
            console.log('═══════════════════════════════════════');
            console.log('📨 PARSING EMAIL MESSAGE');
            console.log('Subject:', subject);
            console.log('From:', message.from?.address, message.from?.name);
            console.log('Date:', message.createdAt);
            console.log('───────────────────────────────────────');
            console.log('Email Text Content:');
            // console.log(text);
            console.log('═══════════════════════════════════════');

            // Extract sender name from subject line
            // Format examples:
            // "John Doe sent you $25.00"
            // "Jane Smith sent you $100"
            let senderName = null;
            
            // Remove "Fwd: " or "Re: " prefixes first
let cleanSubject = subject.replace(/^(Fwd|Re):\s*/i, '');

// Then extract the name
const senderNameMatch = cleanSubject.match(/^(.+?)\s+(?:sent you|just sent you)/i);
            if (senderNameMatch) {
                senderName = senderNameMatch[1].trim();
            }
            
            // If not found in subject, try to extract from email body
            if (!senderName) {
                // Look for patterns like "From: John Doe" or "Sender: John Doe"
                const bodyNameMatch = text.match(/(?:From|Sender|Name):\s*([^\n\r]+)/i);
                if (bodyNameMatch) {
                    senderName = bodyNameMatch[1].trim();
                }
            }
            
            console.log('👤 Extracted sender name:', senderName);

            // Extract amount from subject first (most reliable)
            // Format: $25.00 or $100 or $1,234.56
            let amount = null;
            
            // Try subject first
            const subjectAmountMatch = subject.match(/\$[\d,]+\.?\d{0,2}/);
            if (subjectAmountMatch) {
                amount = parseFloat(subjectAmountMatch[0].replace(/[$,]/g, ''));
            }
            
            // If not in subject, try email body
            if (!amount) {
                const bodyAmountMatch = text.match(/\$[\d,]+\.?\d{0,2}/);
                if (bodyAmountMatch) {
                    amount = parseFloat(bodyAmountMatch[0].replace(/[$,]/g, ''));
                }
            }
            
            console.log('💵 Extracted amount:', amount);
            
            // Extract date
            const messageDate = new Date(message.createdAt);
            
            // Extract Chime tag if present in body (format: $ChimeSign)
            const chimeTagMatch = text.match(/\$[a-zA-Z0-9_-]+/);
            const chimeTag = chimeTagMatch ? chimeTagMatch[0] : null;
            
            console.log('🏷️  Extracted Chime tag:', chimeTag);
            console.log('📅 Message date:', messageDate.toISOString());

            const result = {
                messageId: message.id,
                senderName,
                amount,
                date: messageDate,
                chimeTag,
                subject: message.subject,
                rawText: text,
                createdAt: message.createdAt,
                from: message.from
            };
            
            console.log('✅ Parsed result:', result);
            console.log('═══════════════════════════════════════\n');

            return result;
        } catch (error) {
            console.error('❌ Error parsing Chime payment:', error);
            throw error;
        }
    }
}

module.exports = new MailTmService();