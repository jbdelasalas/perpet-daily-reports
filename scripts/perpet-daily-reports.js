#!/usr/bin/env node

/**
 * Perpet Pilipinas Daily Sales & P&L Report Generator
 * GitHub Actions Automation
 * 
 * Runs daily at 8 AM (Asia/Manila)
 * Fetches sales and P&L data from Oracle NetSuite
 * Sends formatted HTML email with trend analysis
 */

const https = require('https');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// ===== CONFIGURATION FROM ENVIRONMENT VARIABLES =====
const CONFIG = {
  // NetSuite Credentials (from GitHub Secrets)
  accountId: process.env.NETSUITE_ACCOUNT_ID || '7344095',
  consumerKey: process.env.NETSUITE_CONSUMER_KEY,
  consumerSecret: process.env.NETSUITE_CONSUMER_SECRET,
  
  // Perpet Pilipinas Setup
  subsidiaryId: process.env.NETSUITE_SUBSIDIARY_ID || 1,
  
  // Email Configuration (from GitHub Secrets)
  emailTo: process.env.EMAIL_TO || 'jbdelasalas@artfreshchicken.ph',
  emailFrom: process.env.EMAIL_FROM || 'netsuite-reports@artfreshchicken.ph',
  smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: process.env.SMTP_PORT || 587,
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  
  // GL Account Numbers (customize based on your chart of accounts)
  glAccounts: {
    revenue: [4000, 4100, 4200],
    cogs: [5000, 5100],
    operatingExpenses: [6000, 6100, 6200, 6300],
  }
};

// Validate required secrets
function validateConfig() {
  const required = ['consumerKey', 'consumerSecret', 'smtpUser', 'smtpPass'];
  const missing = required.filter(key => !CONFIG[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required GitHub Secrets: ${missing.join(', ')}`);
  }
}

// ===== NETSUITE API AUTHENTICATION =====
class NetSuiteAuth {
  constructor(config) {
    this.config = config;
    this.baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1`;
  }

  /**
   * Generate OAuth 1.0a signature for NetSuite API
   */
  generateSignature(method, path, params = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString('hex');
    
    const oauthParams = {
      oauth_consumer_key: this.config.consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA256',
      oauth_timestamp: timestamp,
      oauth_version: '1.0'
    };

    const allParams = { ...oauthParams, ...params };
    const paramString = Object.keys(allParams)
      .sort()
      .map(key => `${key}=${allParams[key]}`)
      .join('&');

    const baseString = `${method}&${encodeURIComponent(this.baseUrl + path)}&${encodeURIComponent(paramString)}`;
    const signingKey = `${encodeURIComponent(this.config.consumerSecret)}&`;
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(baseString)
      .digest('base64');

    oauthParams.oauth_signature = signature;

    const authHeader = 'OAuth ' + Object.keys(oauthParams)
      .map(key => `${key}="${encodeURIComponent(oauthParams[key])}"`)
      .join(', ');

    return authHeader;
  }

  /**
   * Make authenticated API request to NetSuite
   */
  async request(method, path, params = {}) {
    return new Promise((resolve, reject) => {
      const authHeader = this.generateSignature(method, path, params);
      const queryString = Object.keys(params).length > 0 
        ? '?' + Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')
        : '';

      const options = {
        hostname: `${this.config.accountId}.suitetalk.api.netsuite.com`,
        path: `/services/rest/record/v1${path}${queryString}`,
        method: method,
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch {
            console.log(`[DEBUG] Response (non-JSON):`, data.substring(0, 200));
            resolve(data);
          }
        });
      });

      req.on('error', (error) => {
        console.error(`[ERROR] Request failed:`, error.message);
        reject(error);
      });

      req.setTimeout(30000, () => {
        req.abort();
        reject(new Error('NetSuite API request timeout'));
      });

      req.end();
    });
  }
}

// ===== DATA FETCHING =====
class NetSuiteDataFetcher {
  constructor(auth, config) {
    this.auth = auth;
    this.config = config;
  }

  /**
   * Query GL transactions for a specific date range
   */
  async getGLData(startDate, endDate) {
    try {
      console.log(`[INFO] Fetching GL data from ${startDate} to ${endDate}`);
      
      // Use SuiteQL (recommended over saved search)
      const glQuery = `/query?q=select id, account, debit, credit, transactionDate from GeneralLedger where subsidiary = ${this.config.subsidiaryId} and transactionDate between '${startDate}' and '${endDate}'`;
      
      const result = await this.auth.request('GET', glQuery);
      
      if (result.items) {
        console.log(`[INFO] Retrieved ${result.items.length} GL entries`);
        return result.items;
      }
      
      return [];
    } catch (error) {
      console.error('[ERROR] Error fetching GL data:', error.message);
      return [];
    }
  }

  /**
   * Calculate P&L metrics from GL data
   */
  calculatePnL(glData, accountMap) {
    const pnl = {
      revenue: 0,
      cogs: 0,
      operatingExpenses: 0,
      grossProfit: 0,
      netIncome: 0
    };

    if (!glData || glData.length === 0) {
      console.warn('[WARN] No GL data available for P&L calculation');
      return pnl;
    }

    glData.forEach(entry => {
      const accountId = entry.account?.id || entry.account;
      const debit = entry.debit || 0;
      const credit = entry.credit || 0;
      const amount = debit - credit;

      if (accountMap.revenue.includes(accountId)) {
        pnl.revenue += amount;
      } else if (accountMap.cogs.includes(accountId)) {
        pnl.cogs += amount;
      } else if (accountMap.operatingExpenses.includes(accountId)) {
        pnl.operatingExpenses += amount;
      }
    });

    pnl.grossProfit = pnl.revenue - pnl.cogs;
    pnl.netIncome = pnl.grossProfit - pnl.operatingExpenses;

    console.log('[INFO] P&L Calculated:', JSON.stringify(pnl, null, 2));
    return pnl;
  }

  /**
   * Get daily sales summary
   */
  async getDailySalesData(date) {
    try {
      console.log(`[INFO] Fetching sales data for ${date}`);
      
      const salesQuery = `/query?q=select id, amount, transactionDate from SalesOrder where subsidiary = ${this.config.subsidiaryId} and transactionDate = '${date}'`;
      
      const result = await this.auth.request('GET', salesQuery);
      const items = result.items || [];

      const totalSales = items.reduce((sum, item) => sum + (item.amount || 0), 0);
      const avgTransactionValue = items.length > 0 ? totalSales / items.length : 0;

      const salesData = {
        totalSales,
        transactionCount: items.length,
        avgTransactionValue
      };

      console.log('[INFO] Sales Data:', JSON.stringify(salesData, null, 2));
      return salesData;
    } catch (error) {
      console.error('[ERROR] Error fetching sales data:', error.message);
      return { totalSales: 0, transactionCount: 0, avgTransactionValue: 0 };
    }
  }
}

// ===== REPORT GENERATION =====
class ReportGenerator {
  /**
   * Generate HTML email report with trend analysis
   */
  static generateHTMLReport(today, yesterday, lastWeek, mtd) {
    const formatCurrency = (value) => `₱${parseFloat(value).toFixed(2)}`;
    const calculateChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return (((current - previous) / Math.abs(previous)) * 100).toFixed(2);
    };

    const revenueChangeVsYday = calculateChange(today.revenue, yesterday.revenue);
    const revenueChangeVsWeek = calculateChange(today.revenue, lastWeek.revenue / 7);
    const netIncomeChangeMtd = calculateChange(mtd.netIncome, (mtd.netIncome - today.netIncome) || 1);

    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #333; background: #f5f5f5; }
        .container { max-width: 900px; margin: 0 auto; padding: 20px; background: white; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 8px; margin-bottom: 30px; }
        .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
        .header p { margin: 8px 0 0 0; opacity: 0.95; font-size: 14px; }
        .timestamp { opacity: 0.8; font-size: 12px; margin-top: 10px; }
        .section { margin: 30px 0; }
        .section-title { background: #f0f0f0; padding: 12px 15px; font-weight: 600; border-left: 4px solid #667eea; margin: 15px 0 15px 0; font-size: 14px; text-transform: uppercase; color: #666; }
        .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 15px; }
        .metric { background: #f9f9f9; padding: 15px; border-radius: 6px; border: 1px solid #e0e0e0; }
        .metric-label { font-size: 11px; color: #999; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
        .metric-value { font-size: 26px; font-weight: 700; color: #333; }
        .metric-change { font-size: 12px; margin-top: 8px; }
        .positive { color: #4caf50; font-weight: 600; }
        .negative { color: #f44336; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; }
        th { background: #f5f5f5; padding: 12px; text-align: left; font-weight: 600; color: #666; border-bottom: 2px solid #e0e0e0; }
        td { padding: 12px; border-bottom: 1px solid #e0e0e0; text-align: right; }
        td:first-child { text-align: left; color: #666; }
        tr:hover { background: #fafafa; }
        .value-strong { font-weight: 600; color: #333; }
        .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e0e0e0; font-size: 11px; color: #999; text-align: center; line-height: 1.6; }
        .note { background: #e3f2fd; padding: 12px; border-radius: 4px; margin-top: 15px; font-size: 12px; color: #1976d2; border-left: 3px solid #1976d2; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📊 Perpet Pilipinas Daily Report</h1>
          <p>${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
          <div class="timestamp">Generated: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })} (Asia/Manila)</div>
        </div>

        <div class="section">
          <div class="section-title">💼 Daily Sales Summary</div>
          <div class="metrics">
            <div class="metric">
              <div class="metric-label">Today's Revenue</div>
              <div class="metric-value">${formatCurrency(today.revenue)}</div>
              <div class="metric-change">
                <span class="${revenueChangeVsYday >= 0 ? 'positive' : 'negative'}">
                  vs Yesterday: ${revenueChangeVsYday >= 0 ? '+' : ''}${revenueChangeVsYday}%
                </span>
              </div>
            </div>
            <div class="metric">
              <div class="metric-label">Transaction Value</div>
              <div class="metric-value">${formatCurrency(today.avgTransactionValue || 0)}</div>
              <div class="metric-change">
                <strong>${today.transactionCount || 0}</strong> transactions today
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">💰 P&L Statement (Today)</div>
          <table>
            <tr>
              <th>Metric</th>
              <th>Amount (₱)</th>
              <th>% of Revenue</th>
            </tr>
            <tr>
              <td><span class="value-strong">REVENUE</span></td>
              <td><span class="value-strong">${formatCurrency(today.revenue)}</span></td>
              <td>100.0%</td>
            </tr>
            <tr>
              <td>Cost of Goods Sold</td>
              <td>${formatCurrency(today.cogs)}</td>
              <td>${today.revenue > 0 ? ((today.cogs / today.revenue) * 100).toFixed(1) : '0'}%</td>
            </tr>
            <tr>
              <td><span class="value-strong">GROSS PROFIT</span></td>
              <td><span class="value-strong">${formatCurrency(today.grossProfit)}</span></td>
              <td><span class="value-strong">${today.revenue > 0 ? ((today.grossProfit / today.revenue) * 100).toFixed(1) : '0'}%</span></td>
            </tr>
            <tr>
              <td>Operating Expenses</td>
              <td>${formatCurrency(today.operatingExpenses)}</td>
              <td>${today.revenue > 0 ? ((today.operatingExpenses / today.revenue) * 100).toFixed(1) : '0'}%</td>
            </tr>
            <tr>
              <td><span class="value-strong">NET INCOME</span></td>
              <td><span class="value-strong">${formatCurrency(today.netIncome)}</span></td>
              <td><span class="value-strong">${today.revenue > 0 ? ((today.netIncome / today.revenue) * 100).toFixed(1) : '0'}%</span></td>
            </tr>
          </table>
        </div>

        <div class="section">
          <div class="section-title">📈 Trend Analysis (Comparison)</div>
          <table>
            <tr>
              <th>Period</th>
              <th>Revenue</th>
              <th>Gross Profit</th>
              <th>Net Income</th>
            </tr>
            <tr>
              <td><span class="value-strong">TODAY</span></td>
              <td><span class="value-strong">${formatCurrency(today.revenue)}</span></td>
              <td><span class="value-strong">${formatCurrency(today.grossProfit)}</span></td>
              <td><span class="value-strong">${formatCurrency(today.netIncome)}</span></td>
            </tr>
            <tr>
              <td>Yesterday</td>
              <td>${formatCurrency(yesterday.revenue)}</td>
              <td>${formatCurrency(yesterday.grossProfit)}</td>
              <td>${formatCurrency(yesterday.netIncome)}</td>
            </tr>
            <tr>
              <td>7-Day Average</td>
              <td>${formatCurrency(lastWeek.revenue / 7)}</td>
              <td>${formatCurrency(lastWeek.grossProfit / 7)}</td>
              <td>${formatCurrency(lastWeek.netIncome / 7)}</td>
            </tr>
            <tr>
              <td>Month-to-Date</td>
              <td>${formatCurrency(mtd.revenue)}</td>
              <td>${formatCurrency(mtd.grossProfit)}</td>
              <td>${formatCurrency(mtd.netIncome)}</td>
            </tr>
          </table>
        </div>

        <div class="note">
          ℹ️ This report is automatically generated daily at 8:00 AM (Asia/Manila). 
          Data is pulled from Oracle NetSuite GL and reflects transactions posted through yesterday end-of-day.
        </div>

        <div class="footer">
          <p>Perpet Pilipinas Corp. | NetSuite Account: 7344095<br>
          Automated Report | Do not reply to this email</p>
        </div>
      </div>
    </body>
    </html>
    `;
  }
}

// ===== MAIN EXECUTION =====
async function generateAndEmailReport() {
  try {
    console.log('[INFO] ========================================');
    console.log('[INFO] Starting daily report generation...');
    console.log('[INFO] ========================================');
    
    // Validate configuration
    validateConfig();
    console.log('[INFO] Configuration validated ✓');
    
    const auth = new NetSuiteAuth(CONFIG);
    const fetcher = new NetSuiteDataFetcher(auth, CONFIG);

    // Get dates for comparison
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    const lastWeekStart = new Date(today.getTime() - (7 * 86400000));
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const formatDate = (date) => date.toISOString().split('T')[0];

    // Fetch GL data for different periods
    console.log('[INFO] Fetching NetSuite data...');
    const todayGL = await fetcher.getGLData(formatDate(today), formatDate(today));
    const yesterdayGL = await fetcher.getGLData(formatDate(yesterday), formatDate(yesterday));
    const lastWeekGL = await fetcher.getGLData(formatDate(lastWeekStart), formatDate(today));
    const mtdGL = await fetcher.getGLData(formatDate(monthStart), formatDate(today));

    // Calculate P&L metrics
    const todayPnL = fetcher.calculatePnL(todayGL, CONFIG.glAccounts);
    const yesterdayPnL = fetcher.calculatePnL(yesterdayGL, CONFIG.glAccounts);
    const lastWeekPnL = fetcher.calculatePnL(lastWeekGL, CONFIG.glAccounts);
    const mtdPnL = fetcher.calculatePnL(mtdGL, CONFIG.glAccounts);

    // Fetch sales data
    const todaySales = await fetcher.getDailySalesData(formatDate(today));
    todayPnL.transactionCount = todaySales.transactionCount;
    todayPnL.avgTransactionValue = todaySales.avgTransactionValue;

    // Generate HTML report
    console.log('[INFO] Generating HTML report...');
    const htmlReport = ReportGenerator.generateHTMLReport(todayPnL, yesterdayPnL, lastWeekPnL, mtdPnL);

    // Send email
    console.log('[INFO] Configuring email transport...');
    const transporter = nodemailer.createTransport({
      host: CONFIG.smtpHost,
      port: CONFIG.smtpPort,
      secure: CONFIG.smtpPort === 465,
      auth: {
        user: CONFIG.smtpUser,
        pass: CONFIG.smtpPass
      }
    });

    // Verify connection
    await transporter.verify();
    console.log('[INFO] Email transport verified ✓');

    const mailOptions = {
      from: CONFIG.emailFrom,
      to: CONFIG.emailTo,
      subject: `Perpet Pilipinas Daily Report - ${new Date().toLocaleDateString('en-PH')}`,
      html: htmlReport,
      headers: {
        'X-Priority': '3',
        'Importance': 'normal'
      }
    };

    console.log(`[INFO] Sending report to: ${CONFIG.emailTo}`);
    const result = await transporter.sendMail(mailOptions);
    
    console.log('[INFO] ========================================');
    console.log('[SUCCESS] ✓ Daily report sent successfully!');
    console.log(`[SUCCESS] Message ID: ${result.messageId}`);
    console.log('[INFO] ========================================');

  } catch (error) {
    console.error('[INFO] ========================================');
    console.error('[ERROR] ✗ Report generation failed');
    console.error('[ERROR]', error.message);
    console.error('[INFO] ========================================');
    process.exit(1);
  }
}

// Execute
if (require.main === module) {
  generateAndEmailReport();
}

module.exports = { generateAndEmailReport };
