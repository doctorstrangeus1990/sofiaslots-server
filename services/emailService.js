const nodemailer = require('nodemailer');
const mailtrap = require('mailtrap');

class EmailService {
  constructor() {
    this.transporter = null;
    this.initialized = false;
    this.websiteUrl = process.env.CLIENT_URL || 'https://sofiaslots.com';
    
    // Remove trailing slash if exists
    this.websiteUrl = this.websiteUrl.replace(/\/$/, '');
  }

  init() {
    if (this.initialized) return;

    console.log('🔧 Initializing Mailtrap with API token...');
    
    const transport = mailtrap.MailtrapTransport({
      token: process.env.MAILTRAP_API_TOKEN,
    });
    
    this.transporter = nodemailer.createTransport(transport);

    this.initialized = true;

    // Verify email service
    this.transporter.verify((error, success) => {
      if (error) {
        console.error('❌ Email service configuration error:', error);
      } else {
        console.log('✅ Email service is ready to send emails');
      }
    });
  }

  // Get sender info
  getSender() {
    return {
      address: 'support@sofiaslots.com',
      name: 'Sofia Slots Support'
    };
  }

  // Add user to Mailtrap contact list for bulk campaigns
  async addToMailtrapContactList(email, username) {
    try {
      const accountId = process.env.MAILTRAP_ACCOUNT_ID;
      const listId = process.env.MAILTRAP_LIST_ID || '1';
      
      if (!accountId) {
        console.log('⚠️ MAILTRAP_ACCOUNT_ID not set, skipping contact list addition');
        return { success: false, error: 'MAILTRAP_ACCOUNT_ID not configured' };
      }

      const response = await fetch(`https://mailtrap.io/api/accounts/${accountId}/contacts`, {
        method: 'POST',
        headers: {
          'Api-Token': process.env.MAILTRAP_API_TOKEN,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          contact: {
            email: email,
            fields: {
              name: username
            },
            list_ids: [parseInt(listId)]
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Mailtrap API error:', response.status, errorText);
        return { success: false, error: errorText };
      }

      const data = await response.json();
      console.log('✅ Contact added to Mailtrap list:', email);
      return { success: true, data };
    } catch (error) {
      console.error('❌ Error adding contact to Mailtrap:', error);
      return { success: false, error: error.message };
    }
  }

  // Remove user from Mailtrap contact list when they unsubscribe
  async removeFromMailtrapContactList(email) {
    try {
      const accountId = process.env.MAILTRAP_ACCOUNT_ID;
      
      if (!accountId) {
        console.log('⚠️ MAILTRAP_ACCOUNT_ID not set, skipping contact removal');
        return { success: false, error: 'MAILTRAP_ACCOUNT_ID not configured' };
      }

      const response = await fetch(`https://mailtrap.io/api/accounts/${accountId}/contacts/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: {
          'Api-Token': process.env.MAILTRAP_API_TOKEN,
          'Content-Type': 'application/json',
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Mailtrap API error:', response.status, errorText);
        return { success: false, error: errorText };
      }

      console.log('✅ Contact removed from Mailtrap list:', email);
      return { success: true };
    } catch (error) {
      console.error('❌ Error removing contact from Mailtrap:', error);
      return { success: false, error: error.message };
    }
  }

  // Send OTP email
  async sendOTP(email, otp, purpose = 'registration') {
    this.init();

    const config = {
      registration: {
        subject: 'Verify Your Sofia Slots Account',
        title: 'Email Verification',
        message: 'Enter this code to verify your account and claim your welcome bonus.'
      },
      password_reset: {
        subject: 'Reset Your Password',
        title: 'Password Reset',
        message: 'Enter this code to reset your password.'
      },
      email_verification: {
        subject: 'Verify Your Email',
        title: 'Email Verification',
        message: 'Enter this code to verify your email address.'
      },
      withdrawal: {
        subject: 'Confirm Your Withdrawal',
        title: 'Withdrawal Verification',
        message: 'Enter this code to confirm your withdrawal request.'
      }
    };

    const { subject, title, message } = config[purpose];

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
<div style="background-color: #f5f5f5; padding: 40px 20px;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); padding: 30px; text-align: center;">
      <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: 1px;">Sofia Slots</h1>
    </div>
    <div style="padding: 40px 30px; background-color: #ffffff;">
      <h2 style="margin: 0 0 15px 0; color: #111827; font-size: 28px; font-weight: 700; text-align: center;">${title}</h2>
      <p style="margin: 0 0 30px 0; color: #6b7280; font-size: 15px; text-align: center; line-height: 1.6;">${message}</p>
      <div style="background: linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 100%); border: 2px solid #a855f7; border-radius: 16px; padding: 30px 20px; margin: 0 auto 30px; max-width: 400px; text-align: center;">
        <p style="margin: 0 0 10px 0; color: #7c3aed; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 2px;">VERIFICATION CODE</p>
        <div style="margin: 0; font-size: 42px; font-weight: bold; color: #7c3aed; letter-spacing: 10px; font-family: 'Courier New', monospace;">${otp}</div>
        <p style="margin: 10px 0 0 0; color: #7c3aed; font-size: 13px; font-weight: 500;">Valid for 10 minutes</p>
      </div>
      <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px 20px; border-radius: 8px; margin: 0 auto; max-width: 500px;">
        <p style="margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;"><strong>Security Notice:</strong> Never share this code with anyone. Sofia Slots will never ask for your verification code.</p>
      </div>
    </div>
    <div style="background-color: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb;">
      <p style="margin: 0 0 15px 0; color: #6b7280; font-size: 14px;">Need help? Visit <a href="https://sofiaslots.com" style="color: #7c3aed; text-decoration: none; font-weight: 500;">sofiaslots.com</a> or contact us on <a href="https://www.facebook.com/sofiaslots.com" style="color: #7c3aed; text-decoration: none; font-weight: 500;">Facebook</a></p>
      <p style="margin: 15px 0 10px 0; color: #9ca3af; font-size: 12px;">© ${new Date().getFullYear()} sofiaslots.com - All rights reserved</p>
      <a href="${this.websiteUrl}/api/api/unsubscribe?email=${encodeURIComponent(email)}" style="color: #9ca3af; font-size: 11px; text-decoration: none;">Unsubscribe</a>
    </div>
  </div>
</div>
</body>
</html>
    `;

    const sender = this.getSender();

    const mailOptions = {
      from: sender,
      to: email,
      subject: subject,
      html: htmlContent,
      text: `Your ${purpose} verification code is: ${otp}. Valid for 10 minutes. Never share this code. - sofiaslots.com`,
      category: 'OTP Verification'
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ OTP email sent successfully:', info.messageId || info.response || 'Email sent');
      return { success: true, messageId: info.messageId || info.response };
    } catch (error) {
      console.error('❌ Error sending OTP email:', error);
      throw error;
    }
  }

  // Send password reset email
  async sendPasswordResetEmail(email, resetLink) {
    this.init();

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #f5f5f5; }
.wrapper { background: #f5f5f5; padding: 40px 20px; }
.container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
.header { background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); padding: 30px; text-align: center; }
.brand-name { margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: 1px; }
.content { padding: 40px 30px; background: #ffffff; text-align: center; }
.title { margin: 0 0 15px 0; color: #111827; font-size: 28px; font-weight: 700; }
.message { margin: 0 0 35px 0; color: #6b7280; font-size: 15px; line-height: 1.6; }
.reset-button { display: inline-block; background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-weight: 600; font-size: 16px; margin-bottom: 20px; }
.sub-message { margin: 0; color: #9ca3af; font-size: 13px; }
.footer { background: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb; }
.footer-text { margin: 0 0 15px 0; color: #6b7280; font-size: 14px; }
.footer-link { color: #7c3aed; text-decoration: none; font-weight: 500; }
.footer-link:hover { text-decoration: underline; }
.footer-copy { margin: 15px 0 10px 0; color: #9ca3af; font-size: 12px; }
.unsubscribe { color: #9ca3af; font-size: 11px; text-decoration: none; }
.unsubscribe:hover { text-decoration: underline; }
@media only screen and (max-width: 600px) {
  .wrapper { padding: 20px 10px; }
  .container { border-radius: 10px; }
  .header { padding: 20px; }
  .brand-name { font-size: 26px; }
  .content { padding: 30px 20px; }
  .title { font-size: 22px; }
  .message { font-size: 14px; }
  .reset-button { padding: 14px 32px; font-size: 15px; }
  .footer { padding: 20px 15px; }
}
</style>
</head>
<body>
<div class="wrapper">
  <div class="container">
    <div class="header">
      <h1 class="brand-name">Sofia Slots</h1>
    </div>
    <div class="content">
      <h2 class="title">Reset Your Password</h2>
      <p class="message">Click the button below to reset your password.<br>This link expires in 1 hour.</p>
      <a href="${resetLink}" class="reset-button">Reset Password</a>
      <p class="sub-message">If you didn't request this, please ignore this email<br>or contact support if you have concerns.</p>
    </div>
    <div class="footer">
      <p class="footer-text">Need help? Visit <a href="https://sofiaslots.com" class="footer-link">sofiaslots.com</a> or contact us on <a href="https://www.facebook.com/sofiaslots.com" class="footer-link">Facebook</a></p>
      <p class="footer-copy">© ${new Date().getFullYear()} sofiaslots.com - All rights reserved</p>
      <a href="${this.websiteUrl}/unsubscribe?email=${encodeURIComponent(email)}" class="unsubscribe">Unsubscribe</a>
    </div>
  </div>
</div>
</body>
</html>
    `;

    const sender = this.getSender();

    const mailOptions = {
      from: sender,
      to: email,
      subject: 'Reset Your Sofia Slots Password',
      html: htmlContent,
      category: 'Password Reset'
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log('✅ Password reset email sent successfully to:', email);
      return { success: true };
    } catch (error) {
      console.error('❌ Error sending password reset email:', error);
      throw error;
    }
  }

  // Send promotional/marketing email
  async sendPromotionalEmail(email, subject, title, message, buttonText, buttonLink) {
    this.init();

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #f5f5f5; }
.wrapper { background: #f5f5f5; padding: 40px 20px; }
.container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
.header { background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); padding: 30px; text-align: center; }
.brand-name { margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: 1px; }
.content { padding: 40px 30px; background: #ffffff; text-align: center; }
.title { margin: 0 0 15px 0; color: #111827; font-size: 28px; font-weight: 700; }
.message { margin: 0 0 35px 0; color: #6b7280; font-size: 15px; line-height: 1.6; }
.promo-button { display: inline-block; background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-weight: 600; font-size: 16px; }
.footer { background: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb; }
.footer-text { margin: 0 0 15px 0; color: #6b7280; font-size: 14px; }
.footer-link { color: #3b82f6; text-decoration: none; font-weight: 500; }
.footer-link:hover { text-decoration: underline; }
.footer-copy { margin: 15px 0 10px 0; color: #9ca3af; font-size: 12px; }
.unsubscribe { color: #9ca3af; font-size: 11px; text-decoration: none; }
.unsubscribe:hover { text-decoration: underline; }
@media only screen and (max-width: 600px) {
  .wrapper { padding: 20px 10px; }
  .container { border-radius: 10px; }
  .header { padding: 20px; }
  .brand-name { font-size: 26px; }
  .content { padding: 30px 20px; }
  .title { font-size: 22px; }
  .message { font-size: 14px; }
  .promo-button { padding: 14px 32px; font-size: 15px; }
  .footer { padding: 20px 15px; }
}
</style>
</head>
<body>
<div class="wrapper">
  <div class="container">
    <div class="header">
      <h1 class="brand-name">Sofia Slots</h1>
    </div>
    <div class="content">
      <h2 class="title">${title}</h2>
      <p class="message">${message}</p>
      <a href="${buttonLink}" class="promo-button">${buttonText}</a>
    </div>
    <div class="footer">
      <p class="footer-text">Need help? Visit <a href="https://sofiaslots.com" class="footer-link">sofiaslots.com</a> or contact us on <a href="https://www.facebook.com/sofiaslots.com" class="footer-link">Facebook</a></p>
      <p class="footer-copy">© ${new Date().getFullYear()} sofiaslots.com - All rights reserved</p>
      <a href="${this.websiteUrl}/unsubscribe?email=${encodeURIComponent(email)}" class="unsubscribe">Unsubscribe</a>
    </div>
  </div>
</div>
</body>
</html>
    `;

    const sender = this.getSender();

    const mailOptions = {
      from: sender,
      to: email,
      subject: subject,
      html: htmlContent,
      category: 'Promotional'
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log('✅ Promotional email sent successfully to:', email);
      return { success: true };
    } catch (error) {
      console.error('❌ Error sending promotional email:', error);
      throw error;
    }
  }
}

// Export singleton instance
module.exports = new EmailService();