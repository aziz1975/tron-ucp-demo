require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { TronWeb } = require('tronweb');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS || 'TWd4b1a2b3c4d5e6f7g8h9i0j1k2l3m4n5';

// Initialize TronWeb 
const tronWeb = new TronWeb({
    fullNode: 'https://nile.trongrid.io',
    solidityNode: 'https://nile.trongrid.io',
    eventServer: 'https://nile.trongrid.io',
});

// Initialize Telegram Bot 
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let bot = null;

if (TELEGRAM_TOKEN) {
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    console.log(`[Security] Telegram HITL 2FA Enabled.`);

    bot.onText(/\/start/, (msg) => {
        console.log(`\n========== TELEGRAM SETUP ==========`);
        console.log(`Your Chat ID is: ${msg.chat.id}`);
        console.log(`Please add TELEGRAM_CHAT_ID=${msg.chat.id} to your .env and restart the server!`);
        console.log(`====================================\n`);
        bot.sendMessage(msg.chat.id, `Welcome to Trongate! Your Chat ID is ${msg.chat.id}. Add this to your .env file as TELEGRAM_CHAT_ID.`);
    });
    
    bot.on('callback_query', (query) => {
        const action = query.data;
        const msg = query.message;
        
        if (action.startsWith('approve_')) {
            const orderId = action.split('approve_')[1];
            db.updateOrder(orderId, { status: 'PENDING', updatedAt: new Date().toISOString() });
            bot.editMessageText(`✅ Approved UCP Checkout: ${orderId}`, {
                chat_id: msg.chat.id,
                message_id: msg.message_id
            });
            console.log(`[Security] Order ${orderId} explicitly APPROVED via Telegram 2FA.`);
        } else if (action.startsWith('reject_')) {
            const orderId = action.split('reject_')[1];
            db.updateOrder(orderId, { status: 'REJECTED', updatedAt: new Date().toISOString() });
            bot.editMessageText(`❌ Rejected UCP Checkout: ${orderId}`, {
                chat_id: msg.chat.id,
                message_id: msg.message_id
            });
            console.log(`[Security] Order ${orderId} officially REJECTED via Telegram 2FA.`);
        }
    });
} else {
    console.warn(`[Security] No TELEGRAM_BOT_TOKEN found in .env. HITL 2FA will run in mock local mode.`);
}

/**
 * UCP Explorer — human-readable manifest viewer for demos
 */
app.get('/ucp-explorer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'ucp-explorer.html'));
});

/**
 * 1. UCP Discovery
 */
app.get('/.well-known/ucp', (req, res) => {
    res.json({
        name: "Trongate",
        description: "A demonstration of UCP on TRON Nile Testnet",
        capabilities: ["dev.ucp.checkout"],
        payment_handler: "TRC20_USDT",
        receiver_address: MERCHANT_ADDRESS,
        network: "TRON_NILE"
    });
});

/**
 * 2. UCP Checkout Create (Now Intercepted for 2FA)
 */
app.post('/api/ucp/checkout/create', (req, res) => {
    const { items, currency, total_amount } = req.body;

    if (currency !== 'USDT') return res.status(400).json({ error: "Only USDT is supported." });

    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const amountInSun = total_amount * 1_000_000;

    // Freeze request at AWAITING_2FA
    const newOrder = db.createOrder({
        id: orderId,
        items,
        total_amount: total_amount,
        amount_in_sun: amountInSun,
        currency,
        status: 'AWAITING_2FA',
        txHash: null,
        createdAt: new Date().toISOString()
    });

    const approveMsg = `🚨 *UCP Agent Checkout Request*\nAgent is requesting to spend *${total_amount} USDT* on TRON.\nOrder ID: \`${orderId}\``;
    
    if (bot && TELEGRAM_CHAT_ID) {
        bot.sendMessage(TELEGRAM_CHAT_ID, approveMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Approve', callback_data: `approve_${orderId}` }],
                    [{ text: '❌ Reject', callback_data: `reject_${orderId}` }]
                ]
            }
        });
    } else {
        console.log(`\n---------------------------------`);
        console.log(`[MOCK TELEGRAM 2FA APP]`);
        console.log(approveMsg);
        console.log(`To approve locally, run: curl -X POST http://localhost:${PORT}/api/demo/approve-2fa/${orderId}`);
        console.log(`---------------------------------\n`);
    }

    // Return 202 instead of 200, halting the agent pipeline until out-of-band approval
    return res.status(202).json({
        orderId: newOrder.id,
        status: "AWAITING_2FA",
        message: "Checkout suspended. Awaiting cryptographically signed human approval via Telegram.",
        poll_url: `/api/ucp/checkout/challenge/${orderId}`
    });
});

/**
 * 2.5 New Challenge Polling Endpoint
 * Agent loops here until 2FA completes.
 */
app.get('/api/ucp/checkout/challenge/:orderId', (req, res) => {
    const order = db.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (order.status === 'AWAITING_2FA') {
        return res.status(202).json({ status: "AWAITING_2FA" });
    }
    
    if (order.status === 'REJECTED') {
        return res.status(403).json({ error: "Checkout was permanently rejected by human intervention." });
    }

    // If PENDING (approved by human on Telegram), release the TRC-20 challenge
    res.json({
        orderId: order.id,
        status: order.status,
        payment_challenge: {
            receiver_address: MERCHANT_ADDRESS,
            amount: order.amount_in_sun.toString(),
            currency: "TRC20_USDT",
            network: "TRON_NILE"
        }
    });
});

/**
 * Helper to delay execution (retry loop)
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 3. UCP Checkout Complete
 */
app.post('/api/ucp/checkout/complete', async (req, res) => {
    const { orderId, transactionHash } = req.body;

    if (!orderId || !transactionHash) return res.status(400).json({ error: "Missing orderId or transactionHash." });

    const order = db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.status === 'PAID') return res.json({ status: "Success", message: "Order is already paid." });

    // Optimistically update DB to display the txHash on the frontend instantly
    db.updateOrder(orderId, {
        status: 'VERIFYING',
        txHash: transactionHash,
        updatedAt: new Date().toISOString()
    });

    try {
        let transaction = null;
        let retries = 20;
        
        while (retries > 0) {
            try {
                transaction = await tronWeb.trx.getTransaction(transactionHash);
                if (transaction && transaction.ret && transaction.ret[0].contractRet === 'SUCCESS') {
                    break;
                }
            } catch (err) {}
            console.log(`Waiting for transaction ${transactionHash} to be confirmed... (${retries} retries left)`);
            await delay(3000);
            retries--;
        }

        if (!transaction || !transaction.ret || transaction.ret[0].contractRet !== 'SUCCESS') {
            db.updateOrder(orderId, { status: 'FAILED', updatedAt: new Date().toISOString() });
            return res.status(400).json({ error: "Transaction not successful yet." });
        }

        const contractData = transaction.raw_data.contract[0];
        if (contractData.type !== 'TriggerSmartContract') {
            db.updateOrder(orderId, { status: 'FAILED', updatedAt: new Date().toISOString() });
            return res.status(400).json({ error: "Invalid transaction type for TRC20 transfer." });
        }

        const parameter = contractData.parameter.value;
        const data = parameter.data;
        if (!data || !data.startsWith('a9059cbb')) {
            return res.status(400).json({ error: "Not a valid token transfer transaction." });
        }

        db.updateOrder(orderId, {
            status: 'PAID',
            txHash: transactionHash,
            updatedAt: new Date().toISOString()
        });

        return res.json({ status: "Success", message: "Payment verified successfully!" });

    } catch (error) {
        console.error("Verification error:", error);
        return res.status(500).json({ error: "Server error during verification." });
    }
});

/**
 * 4. Dashboard Endpoint
 */
app.get('/api/orders', (req, res) => {
    const orders = db.getOrders();
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(orders);
});

/**
 * 5. Premium API Gate (HTTP 402 Payment Required)
 */
app.get('/api/premium-data', (req, res) => {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader || !authHeader.startsWith('UCP ')) {
        res.setHeader('WWW-Authenticate', `UCP url="http://localhost:${PORT}/.well-known/ucp"`);
        return res.status(402).json({
            error: "Payment Required",
            message: "Premium AI Endpoint. Complete UCP checkout.",
            cost: "15 USDT",
            currency: "TRX_USDT",
            ucp_manifest: `http://localhost:${PORT}/.well-known/ucp`
        });
    }

    const receiptTxHash = authHeader.split(' ')[1];
    const orders = db.getOrders();
    const validOrder = orders.find(o => o.txHash === receiptTxHash && o.status === 'PAID');
    
    if (!validOrder) return res.status(403).json({ error: "Forbidden", message: "Invalid payment receipt." });

    return res.status(200).json({
        success: true,
        data: { confidential_ai_model_weights: "0x8fa9b2...34df", weather_forecast: "72°F and sunny in Silicon Valley", alpha_signals: ["LONG $TRX", "SHORT $FIAT"] },
        receipt_used: receiptTxHash
    });
});

/**
 * 6. Demo Approval Endpoint (In absence of Telegram API)
 */
app.post('/api/demo/approve-2fa/:orderId', (req, res) => {
    db.updateOrder(req.params.orderId, { status: 'PENDING', updatedAt: new Date().toISOString() });
    res.json({ success: true, message: `Order ${req.params.orderId} approved locally.` });
});

/**
 * 7. Demo Endpoint for Visual UI
 */
app.post('/api/demo/run-agent', (req, res) => {
    exec('node test-agent.js'); // Fire and forget so we don't hang the modal 
    res.json({ success: true, message: "Agent spawned in background" });
});

app.listen(PORT, () => {
    console.log(`Sever running on port ${PORT}`);
    console.log(`Manifest available at: http://localhost:${PORT}/.well-known/ucp`);
    console.log(`UCP Explorer at: http://localhost:${PORT}/ucp-explorer`);
});
