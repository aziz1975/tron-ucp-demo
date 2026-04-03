require('dotenv').config();
const { TronWeb } = require('tronweb');
const axios = require('axios');

const MERCHAT_BASE_URL = 'http://localhost:8000';
const AGENT_ID = `agent-${Math.random().toString(36).substring(7)}`;

const tronWeb = new TronWeb({
    fullHost: 'https://nile.trongrid.io',
    privateKey: process.env.TRON_PRIVATE_KEY
});

// Sleep helper function
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runMockAgent() {
    console.log(`\n[AGENT ${AGENT_ID}] Booting up autonomous VM...\n`);

    try {
        // Step 1: Attempt to access a premium resource WITHOUT paying.
        console.log(`[AGENT] Attempting to fetch premium AI API data at GET /api/premium-data...`);
        let ucpManifestUrl = null;
        try {
            await axios.get(`${MERCHAT_BASE_URL}/api/premium-data`);
        } catch (error) {
            if (error.response && error.response.status === 402) {
                console.log(`[AGENT] Received HTTP 402 Payment Required!`);
                console.log(`[AGENT] The server requires a UCP payment receipt. Extracting WWW-Authenticate header...`);
                
                const wwwAuth = error.response.headers['www-authenticate'];
                // Clean the WWW-Authenticate header to extract the UCP URL
                if (wwwAuth && wwwAuth.includes('UCP url=')) {
                    ucpManifestUrl = wwwAuth.split('url="')[1].split('"')[0];
                    console.log(`[AGENT] Discovered UCP Manifest URL: ${ucpManifestUrl}\n`);
                } else {
                    ucpManifestUrl = error.response.data.ucp_manifest;
                }
            } else {
                console.error(`[AGENT] Unexpected Error:`, error.message);
                return;
            }
        }

        if (!ucpManifestUrl) {
            console.error(`[AGENT] Could not discover UCP Manifest. Aborting payment.`);
            return;
        }

        // Step 2: Fetch the Manifest
        console.log(`[AGENT] Fetching Universal Commerce Protocol Manifest...`);
        const manifestRes = await axios.get(ucpManifestUrl);
        const manifest = manifestRes.data;
        if (!manifest.capabilities.includes('dev.ucp.checkout')) {
            console.log(`[AGENT] Merchant does not support checkout. Aborting.`);
            return;
        }
        
        console.log(`[AGENT] Manifest received. Proceeding to UCP Checkout Creation.\n`);
        const checkoutUrl = `${MERCHAT_BASE_URL}/api/ucp/checkout/create`;
        
        const items = [{ id: 'premium_data_access', quantity: 1, price: 15.00 }];
        console.log(`[AGENT] Requesting checkout for 15.00 USDT...`);
        
        let createRes;
        try {
            createRes = await axios.post(checkoutUrl, {
                items,
                total_amount: 15.00,
                chain: 'TRON_NILE',
                currency: 'USDT',
                customer_hash: AGENT_ID
            });
        } catch (e) {}

        const initialChallenge = createRes ? createRes.data : null;
        let challenge = null;

        if (createRes.status === 202 && initialChallenge.status === 'AWAITING_2FA') {
            console.log(`[AGENT] 🔒 Checkout suspended by Merchant: ${initialChallenge.message}`);
            console.log(`[AGENT] Awaiting out-of-band Human 2FA Appoval to release payload...`);
            
            const pollUrl = `${MERCHAT_BASE_URL}${initialChallenge.poll_url}`;

            let approved = false;
            while (!approved) {
                await sleep(2000);
                const pollRes = await axios.get(pollUrl);
                if (pollRes.status === 200) {
                    challenge = pollRes.data;
                    approved = true;
                    console.log(`\n[AGENT] 🔓 2FA Hit Received! Human approved the transaction.\n`);
                } else if (pollRes.status === 202) {
                    process.stdout.write('.');
                }
            }
        } else {
            challenge = initialChallenge;
        }

        console.log(`[AGENT] Received UCP Checkout Challenge!`);
        console.log(`    Order ID: ${challenge.orderId}`);
        console.log(`    Pay To:   ${challenge.payment_challenge.receiver_address}`);
        console.log(`    Amount:   ${challenge.payment_challenge.amount} SUN (15 USDT)\n`);

        // Step 4: Autonomous Crypto Wallet Interaction (TRC-20 Transfer)
        const trc20ContractAddress = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'; // User's Funded Nile USDT
        const destinationAddress = challenge.payment_challenge.receiver_address;
        const amountSun = parseInt(challenge.payment_challenge.amount);

        console.log(`[AGENT] Requesting enclave permission to sign TRC-20 Transaction...`);
        await sleep(1000); // Simulate enclave UX
        
        const parameter = [
            { type: 'address', value: destinationAddress },
            { type: 'uint256', value: amountSun }
        ];
        
        console.log(`[AGENT] Building TRC-20 triggerSmartContract payload...`);
        const ownerAddress = tronWeb.defaultAddress.base58;
        
        const transaction = await tronWeb.transactionBuilder.triggerSmartContract(
            trc20ContractAddress,
            'transfer(address,uint256)',
            {},
            parameter,
            ownerAddress
        );

        console.log(`[AGENT] Cryptographically signing raw transaction...`);
        const signedTx = await tronWeb.trx.sign(transaction.transaction);
        
        console.log(`[AGENT] Broadcasting payload to the TRON Nile Testnet...\n`);
        const receipt = await tronWeb.trx.sendRawTransaction(signedTx);
        const txHash = signedTx.txID;
        console.log(`[AGENT] => Broadcast Successful! Transaction Hash: ${txHash}`);
        console.log(`[AGENT] Waiting 10 seconds for block propagation...\n`);
        await sleep(10000); 

        // Step 5: Notify Merchant Backend to verify txHash
        console.log(`[AGENT] Pinging UCP checkout/complete endpoint to verify Payment Challenge...`);
        const completeUrl = `${MERCHAT_BASE_URL}/api/ucp/checkout/complete`;
        
        const completeRes = await axios.post(completeUrl, {
            orderId: challenge.orderId,
            transactionHash: txHash
        });

        console.log(`[AGENT] Verification successful! Order Status: ${completeRes.data.status}\n`);

        // Step 6: Use the Receipt on the Premium Web API!
        console.log(`[AGENT] Exchanging cryptographic verification receipt (txHash) for raw AI Payload...`);
        
        const premiumRes = await axios.get(`${MERCHAT_BASE_URL}/api/premium-data`, {
            headers: {
                'Authorization': `UCP ${txHash}`
            }
        });

        console.log(`[AGENT] SUCCESS! HTTP 200 OK.`);
        console.log(`[AGENT] Payload Data Received:`);
        console.log(JSON.stringify(premiumRes.data.data, null, 2));
        console.log(`\n[AGENT ${AGENT_ID}] Flow Completed Succesfully. Terminating VM.\n`);

    } catch (e) {
        if (e.response) {
            console.error(`[AGENT] Execution Error: ${e.response.status} - ${JSON.stringify(e.response.data)}`);
        } else {
            console.error(`[AGENT] Execution Error: ${e.message}`);
        }
    }
}

runMockAgent();
