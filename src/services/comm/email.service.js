// src/services/comm/email.service.js
const nodemailer = require('nodemailer');

let transporter = null;

// Helper to ensure required environment variables exist
function required(name, val) {
    if (!val) {
        console.error(`[EMAIL ERROR] Missing ${name} in environment variables`);
        throw new Error(`[EMAIL] Missing ${name} in environment`);
    }
    return val;
}

// ================== INITIALIZE EMAIL TRANSPORTER ==================
async function initEmail() {
    console.log("\n================= INITIALIZING SMTP TRANSPORTER =================");

    const host = required('SMTP_HOST', process.env.SMTP_HOST);
    const port = required('SMTP_PORT', process.env.SMTP_PORT);
    const secure = process.env.SMTP_SECURE === 'ssl'; // true for 465 (SSL), false for 587 (TLS)
    const user = required('SMTP_USER', process.env.SMTP_USER);
    const pass = required('SMTP_PASS', process.env.SMTP_PASS);
    const from = required('MAIL_FROM', process.env.MAIL_FROM);
    const fromName = process.env.MAIL_FROM_NAME || 'WEGO';

    console.log(`[EMAIL DEBUG] SMTP Host: ${host}`);
    console.log(`[EMAIL DEBUG] SMTP Port: ${port}`);
    console.log(`[EMAIL DEBUG] SMTP Secure: ${secure ? 'SSL' : 'TLS'}`);
    console.log(`[EMAIL DEBUG] SMTP User: ${user}`);
    console.log(`[EMAIL DEBUG] Default "From": ${fromName} <${from}>`);

    // Create transporter
    transporter = nodemailer.createTransport({
        host: host,
        port: parseInt(port),
        secure: secure, // true for 465 (SSL), false for other ports (TLS)
        auth: {
            user: user,
            pass: pass
        },
        tls: {
            // Do not fail on invalid certs (for development)
            rejectUnauthorized: process.env.NODE_ENV === 'production'
        }
    });

    // Verify transporter configuration
    try {
        console.log("[EMAIL DEBUG] Verifying SMTP connection...");
        await transporter.verify();
        console.log(`[EMAIL DEBUG] ✅ SMTP connection verified successfully!`);
        console.log("=========================================================\n");
    } catch (err) {
        console.error("[EMAIL ERROR] ❌ SMTP connection verification failed:");
        console.error(err);
        throw err;
    }
}

// ================== SEND GENERIC EMAIL ==================
async function sendEmail(to, subject, text, html) {
    console.log("\n================= SENDING EMAIL =================");
    console.log(`[EMAIL DEBUG] Sending email to: ${to}`);
    console.log(`[EMAIL DEBUG] Subject: ${subject}`);

    // Initialize transporter if not already done
    if (!transporter) {
        console.log("[EMAIL DEBUG] Transporter not initialized, initializing now...");
        await initEmail();
    }

    const from = process.env.MAIL_FROM || 'no-reply@wego.app';
    const fromName = process.env.MAIL_FROM_NAME || 'WEGO';

    const mailOptions = {
        from: `"${fromName}" <${from}>`, // Sender name and address
        to: to, // Recipient
        subject: subject,
        text: text, // Plain text body
        html: html // HTML body
    };

    try {
        console.log("[EMAIL DEBUG] Sending email via SMTP...");
        const info = await transporter.sendMail(mailOptions);

        console.log("[EMAIL DEBUG] ✅ Email sent successfully!");
        console.log("[EMAIL DEBUG] Message ID:", info.messageId);
        console.log("[EMAIL DEBUG] Response:", info.response);
        console.log("=================================================\n");

        return info;
    } catch (err) {
        console.error("\n================= EMAIL ERROR =================");
        console.error("[EMAIL ERROR] ❌ Failed to send email");
        console.error("[EMAIL ERROR] To:", to);
        console.error("[EMAIL ERROR] Subject:", subject);
        console.error("[EMAIL ERROR] Error:", err.message);
        console.error("[EMAIL ERROR] Stack:", err.stack);
        console.error("================================================\n");
        throw err;
    }
}

// ================== SEND OTP EMAIL ==================
async function sendEmailOtp(to, code) {
    console.log("\n================= SENDING OTP EMAIL =================");
    console.log(`[EMAIL DEBUG] 📧 Recipient: ${to}`);
    console.log(`[EMAIL DEBUG] 🔐 OTP Code: ${code}`);
    console.log(`[EMAIL DEBUG] ⏰ Expires in: 10 minutes`);

    const subject = '🔐 Your WEGO Verification Code';

    // Plain text version
    const text = `
Your WEGO verification code is: ${code}

This code will expire in 10 minutes.

If you didn't request this code, please ignore this email.

---
WEGO Team
    `.trim();

    // HTML version with better styling
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WEGO - Verification Code</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
    <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
            <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; max-width: 100%; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <!-- Header -->
                    <tr>
                        <td style="background: linear-gradient(135deg, #FFDC71 0%, #F5C844 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                            <h1 style="margin: 0; color: #2D3748; font-size: 28px; font-weight: 800; letter-spacing: 2px;">
                                WEGO
                            </h1>
                        </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding: 40px 30px;">
                            <h2 style="margin: 0 0 20px 0; color: #2D3748; font-size: 24px; font-weight: 600;">
                                Your Verification Code
                            </h2>
                            
                            <p style="margin: 0 0 30px 0; color: #4A5568; font-size: 16px; line-height: 1.6;">
                                Use the code below to verify your WEGO account:
                            </p>
                            
                            <!-- OTP Code -->
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td align="center" style="padding: 20px 0;">
                                        <div style="display: inline-block; background: linear-gradient(135deg, #FFDC71 0%, #F5C844 100%); padding: 20px 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(245, 200, 68, 0.4);">
                                            <span style="font-size: 36px; font-weight: 800; color: #2D3748; letter-spacing: 8px;">
                                                ${code}
                                            </span>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                            
                            <p style="margin: 30px 0 0 0; color: #718096; font-size: 14px; line-height: 1.6;">
                                ⏰ This code will expire in <strong>10 minutes</strong>.
                            </p>
                            
                            <p style="margin: 20px 0 0 0; color: #718096; font-size: 14px; line-height: 1.6;">
                                If you didn't request this code, please ignore this email.
                            </p>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #F7FAFC; padding: 30px; text-align: center; border-radius: 0 0 12px 12px;">
                            <p style="margin: 0; color: #A0AEC0; font-size: 14px;">
                                © ${new Date().getFullYear()} WEGO. All rights reserved.
                            </p>
                            <p style="margin: 10px 0 0 0; color: #A0AEC0; font-size: 12px;">
                                This is an automated message, please do not reply.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `.trim();

    try {
        const response = await sendEmail(to, subject, text, html);
        console.log("[EMAIL DEBUG] ✅ OTP email sent successfully!");
        console.log("====================================================\n");
        return response;
    } catch (err) {
        console.error("[EMAIL ERROR] ❌ Failed to send OTP email:", err.message);
        console.error("====================================================\n");
        throw err;
    }
}

// ================== SEND WELCOME EMAIL ==================
async function sendWelcomeEmail(to, firstName) {
    console.log("\n================= SENDING WELCOME EMAIL =================");
    console.log(`[EMAIL DEBUG] Recipient: ${to}`);
    console.log(`[EMAIL DEBUG] Name: ${firstName}`);

    const subject = '🎉 Welcome to WEGO!';

    const text = `
Hi ${firstName},

Welcome to WEGO! We're excited to have you on board.

Your account has been successfully created. You can now start booking rides or, if you're a driver, start accepting ride requests.

If you have any questions, feel free to reach out to our support team.

Best regards,
The WEGO Team
    `.trim();

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
    <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
            <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; max-width: 100%; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <tr>
                        <td style="background: linear-gradient(135deg, #FFDC71 0%, #F5C844 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                            <h1 style="margin: 0; color: #2D3748; font-size: 28px; font-weight: 800; letter-spacing: 2px;">
                                WEGO
                            </h1>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px 30px;">
                            <h2 style="margin: 0 0 20px 0; color: #2D3748; font-size: 24px; font-weight: 600;">
                                Welcome, ${firstName}! 🎉
                            </h2>
                            <p style="margin: 0 0 20px 0; color: #4A5568; font-size: 16px; line-height: 1.6;">
                                We're thrilled to have you join the WEGO community!
                            </p>
                            <p style="margin: 0 0 20px 0; color: #4A5568; font-size: 16px; line-height: 1.6;">
                                Your account has been successfully created. You can now start enjoying our services.
                            </p>
                            <p style="margin: 0; color: #4A5568; font-size: 16px; line-height: 1.6;">
                                If you have any questions, our support team is here to help.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="background-color: #F7FAFC; padding: 30px; text-align: center; border-radius: 0 0 12px 12px;">
                            <p style="margin: 0; color: #A0AEC0; font-size: 14px;">
                                © ${new Date().getFullYear()} WEGO. All rights reserved.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `.trim();

    try {
        const response = await sendEmail(to, subject, text, html);
        console.log("[EMAIL DEBUG] ✅ Welcome email sent successfully!");
        console.log("====================================================\n");
        return response;
    } catch (err) {
        console.error("[EMAIL ERROR] ❌ Failed to send welcome email:", err.message);
        throw err;
    }
}

// ================== SEND PASSWORD RESET EMAIL ==================
async function sendPasswordResetEmail(to, resetCode) {
    console.log("\n================= SENDING PASSWORD RESET EMAIL =================");
    console.log(`[EMAIL DEBUG] Recipient: ${to}`);
    console.log(`[EMAIL DEBUG] Reset Code: ${resetCode}`);

    const subject = '🔒 Reset Your WEGO Password';

    const text = `
Your password reset code is: ${resetCode}

This code will expire in 10 minutes.

If you didn't request a password reset, please ignore this email.

---
WEGO Team
    `.trim();

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
    <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
            <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; max-width: 100%; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <tr>
                        <td style="background: linear-gradient(135deg, #FFDC71 0%, #F5C844 100%); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                            <h1 style="margin: 0; color: #2D3748; font-size: 28px; font-weight: 800; letter-spacing: 2px;">
                                WEGO
                            </h1>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px 30px;">
                            <h2 style="margin: 0 0 20px 0; color: #2D3748; font-size: 24px; font-weight: 600;">
                                Reset Your Password
                            </h2>
                            <p style="margin: 0 0 30px 0; color: #4A5568; font-size: 16px; line-height: 1.6;">
                                Use the code below to reset your WEGO password:
                            </p>
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td align="center" style="padding: 20px 0;">
                                        <div style="display: inline-block; background: linear-gradient(135deg, #FFDC71 0%, #F5C844 100%); padding: 20px 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(245, 200, 68, 0.4);">
                                            <span style="font-size: 36px; font-weight: 800; color: #2D3748; letter-spacing: 8px;">
                                                ${resetCode}
                                            </span>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                            <p style="margin: 30px 0 0 0; color: #718096; font-size: 14px; line-height: 1.6;">
                                ⏰ This code will expire in <strong>10 minutes</strong>.
                            </p>
                            <p style="margin: 20px 0 0 0; color: #718096; font-size: 14px; line-height: 1.6;">
                                If you didn't request a password reset, please ignore this email.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="background-color: #F7FAFC; padding: 30px; text-align: center; border-radius: 0 0 12px 12px;">
                            <p style="margin: 0; color: #A0AEC0; font-size: 14px;">
                                © ${new Date().getFullYear()} WEGO. All rights reserved.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `.trim();

    try {
        const response = await sendEmail(to, subject, text, html);
        console.log("[EMAIL DEBUG] ✅ Password reset email sent successfully!");
        return response;
    } catch (err) {
        console.error("[EMAIL ERROR] ❌ Failed to send password reset email:", err.message);
        throw err;
    }
}

module.exports = {
    initEmail,
    sendEmail,
    sendEmailOtp,
    sendWelcomeEmail,
    sendPasswordResetEmail
};