# UCP + TRON Detailed Guide for This Repository

This document explains how the current codebase implements a UCP-style checkout flow on top of the TRON blockchain.

It is written for readers who want to understand:

- what UCP is
- what `/.well-known/ucp` and discovery mean
- what checkout creation, payment challenge, challenge polling, and receipt exchange mean
- how HTTP `402 Payment Required` is used here
- how the TRON transaction is created and verified
- what the UCP endpoints are in this repo
- how TRON fees apply to this flow

Important: this repository is a demo-oriented, simplified UCP implementation. It follows the main UCP ideas, but it does not fully implement the latest official UCP REST binding shape.

## 1. What UCP Is

UCP stands for Universal Commerce Protocol. It is an open protocol for letting platforms, agents, and merchants communicate about commerce in a standard way.

At a high level, UCP gives an agent a common language to:

- discover what a merchant supports
- create a checkout
- understand what payment is required
- complete the checkout
- continue into post-purchase flows

In other words:

- UCP is the protocol and negotiation layer
- TRON is the settlement layer in this repo

UCP itself does not move money on-chain. Instead, UCP tells the agent what needs to be paid, how the merchant expects the payment flow to work, and what proof is needed afterward.

## 2. How UCP and TRON Are Connected Here

In this repo, the connection between UCP and TRON is simple:

1. The merchant exposes a manifest at `/.well-known/ucp`
2. That manifest tells the agent that payment is done with `TRC20_USDT` on `TRON_NILE`
3. The merchant later returns a payment challenge containing the destination address and amount
4. The agent uses `TronWeb` to call `transfer(address,uint256)` on the TRC20 USDT contract
5. The agent sends the resulting `transactionHash` back to the merchant
6. The merchant verifies the transaction on TRON and unlocks the protected resource

So the mapping is:

- UCP says what to pay and how to continue
- TRON is where the actual token transfer happens

## 3. Important Note: Official UCP vs This Repo

The official UCP docs describe a richer and more formal discovery profile and REST binding. For example, the current official docs describe:

- a business profile at `/.well-known/ucp`
- service and capability negotiation
- official REST operations like `/checkout-sessions`, `GET /checkout-sessions/{id}`, and `POST /checkout-sessions/{id}/complete`
- capability names such as `dev.ucp.shopping.checkout`

This repo uses a simplified, custom shape:

- the manifest is a small JSON document instead of the fuller official profile structure
- the capability is `dev.ucp.checkout` instead of the current official `dev.ucp.shopping.checkout`
- the checkout endpoints are custom:
  - `POST /api/ucp/checkout/create`
  - `GET /api/ucp/checkout/challenge/:orderId`
  - `POST /api/ucp/checkout/complete`

That means this code is best understood as:

- UCP-inspired
- UCP-concept aligned
- not a full implementation of the latest official UCP REST binding

This distinction matters when comparing this project to the official spec.

## 4. Core Terms Used in This Repo

### 4.1 `/.well-known/ucp`

This is the discovery document endpoint.

In internet protocols, `/.well-known/...` is a standard place to publish machine-readable metadata. In UCP, that is where a merchant publishes its profile.

In this codebase, the server exposes:

```js
app.get('/.well-known/ucp', (req, res) => {
  res.json({
    name: "TRON-UCP-Demo",
    description: "A demonstration of UCP on TRON Nile Testnet",
    capabilities: ["dev.ucp.checkout"],
    payment_handler: "TRC20_USDT",
    receiver_address: MERCHANT_ADDRESS,
    network: "TRON_NILE"
  });
});
```

Meaning of the fields here:

- `capabilities`: what the merchant says it supports
- `payment_handler`: which payment instrument/rail is expected
- `receiver_address`: merchant wallet address to receive funds
- `network`: which TRON network to use

This endpoint is implemented in `server.js`.

### 4.2 Discovery

Discovery is the step where an agent learns how to interact with the merchant.

In this repo, discovery works like this:

1. The agent calls the premium endpoint without payment
2. The server returns HTTP `402`
3. The response includes a `WWW-Authenticate` header pointing to `/.well-known/ucp`
4. The agent fetches that URL and reads the manifest

So discovery here is not an abstract idea. It is the concrete process of:

- receiving the manifest URL
- loading the manifest
- deciding how to continue

### 4.3 UCP Manifest

The UCP manifest is the JSON document returned by `GET /.well-known/ucp`.

In this repo, it is the merchant's published payment profile.

The agent reads it to answer:

- Does this merchant support checkout?
- What network should I use?
- What token should I use?
- Which address should receive the payment?

### 4.4 `ucpManifestUrl`

In the agent code, `ucpManifestUrl` is just the variable that stores the manifest URL discovered from the `402` response.

Relevant code:

```js
const wwwAuth = error.response.headers['www-authenticate'];

if (wwwAuth && wwwAuth.includes('UCP url=')) {
  ucpManifestUrl = wwwAuth.split('url="')[1].split('"')[0];
} else {
  ucpManifestUrl = error.response.data.ucp_manifest;
}
```

This lives in `test-agent.js`.

Its purpose is simple:

- extract the merchant's UCP manifest location
- fetch it
- continue with checkout

### 4.5 Checkout Creation

Checkout creation is the step where the agent tells the merchant what it wants to buy and asks the merchant to open a payment session.

In this repo:

- endpoint: `POST /api/ucp/checkout/create`
- role: create an order record and prepare the payment flow

The agent sends:

```js
createRes = await axios.post(checkoutUrl, {
  items,
  total_amount: 15.00,
  chain: 'TRON_NILE',
  currency: 'USDT',
  customer_hash: AGENT_ID
});
```

The server:

- validates the request
- creates an order ID
- converts the requested amount into TRC20 base units
- stores order state in `orders.json`
- suspends the flow until 2FA approval is complete

### 4.6 Challenge

A challenge is the merchant telling the agent: "Here is exactly what you must do next."

In this repo, there are two challenge stages:

- the initial "waiting for human approval" state
- the released payment challenge after approval

### 4.7 Payment Challenge

The payment challenge is the concrete instruction set the agent uses to build the blockchain transaction.

In this repo it looks like:

```json
{
  "orderId": "ORD-...",
  "status": "PENDING",
  "payment_challenge": {
    "receiver_address": "T...",
    "amount": "15000000",
    "currency": "TRC20_USDT",
    "network": "TRON_NILE"
  }
}
```

Meaning:

- `receiver_address`: where the agent must send funds
- `amount`: base units for the token transfer
- `currency`: expected asset format
- `network`: which network the agent must use

This is what links UCP to TRON in the current implementation.

### 4.8 Receipt Exchange

Receipt exchange is the step where the agent proves to the merchant that payment happened.

In this repo, the receipt is the TRON transaction hash:

- the agent broadcasts a TRON transaction
- the agent gets `txHash`
- the agent sends `orderId + txHash` to the backend
- the backend verifies the transaction independently

After successful verification, the agent uses the same `txHash` as an authorization receipt:

```js
const premiumRes = await axios.get(`${MERCHAT_BASE_URL}/api/premium-data`, {
  headers: {
    'Authorization': `UCP ${txHash}`
  }
});
```

This "use the transaction hash as the receipt token" design is custom to this repo.

## 5. UCP Endpoints in This Repository

This repo has both:

- UCP-related endpoints
- non-UCP helper/demo endpoints

### 5.1 `GET /.well-known/ucp`

Role:

- merchant discovery
- tells the agent what the merchant supports

Returns:

- capability
- payment handler
- receiver address
- network

### 5.2 `POST /api/ucp/checkout/create`

Role:

- starts a checkout
- creates the order
- stores initial order state
- triggers Telegram approval or mock approval flow

Possible result:

- `202 AWAITING_2FA`

### 5.3 `GET /api/ucp/checkout/challenge/:orderId`

Role:

- polling endpoint
- used by the agent to check whether human approval has happened yet

Possible outcomes:

- `202 AWAITING_2FA`
- `403 REJECTED`
- `200` with a payment challenge

This endpoint is not part of the current official UCP REST binding. It is a custom endpoint in this repo to support the Telegram human-in-the-loop approval model.

### 5.4 `POST /api/ucp/checkout/complete`

Role:

- accepts the order ID and transaction hash
- verifies the transaction on TRON
- marks the order as `PAID` or `FAILED`

This endpoint is the bridge between:

- off-chain commerce orchestration
- on-chain settlement proof

### 5.5 `GET /api/premium-data`

Role:

- protected resource
- acts as the paywalled API

Not a UCP endpoint itself, but it is the endpoint that triggers the UCP flow through an HTTP `402`.

### 5.6 Demo/Helper Endpoints

These are not UCP endpoints:

- `POST /api/demo/approve-2fa/:orderId`
  - local approval shortcut when Telegram is not used
- `POST /api/demo/run-agent`
  - launches the demo agent script
- `GET /api/orders`
  - dashboard data for the UI

## 6. Full End-to-End Flow in This Repo

### Step 1. Agent hits the paywalled API

The agent first tries to access:

- `GET /api/premium-data`

Because it has not paid yet, the server returns:

- HTTP `402 Payment Required`
- `WWW-Authenticate: UCP url="http://localhost:8000/.well-known/ucp"`

Server code:

```js
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
```

### Step 2. Agent performs discovery

The agent sees the `402`, parses the header, extracts `ucpManifestUrl`, and fetches the manifest:

```js
await axios.get(`${MERCHAT_BASE_URL}/api/premium-data`);

const wwwAuth = error.response.headers['www-authenticate'];
if (wwwAuth && wwwAuth.includes('UCP url=')) {
  ucpManifestUrl = wwwAuth.split('url="')[1].split('"')[0];
}

const manifestRes = await axios.get(ucpManifestUrl);
const manifest = manifestRes.data;
```

Now the agent knows:

- checkout is supported
- payment uses TRC20 USDT
- network is TRON Nile
- merchant wallet address

### Step 3. Agent creates checkout

The agent asks the merchant to open a checkout session:

```js
createRes = await axios.post(checkoutUrl, {
  items,
  total_amount: 15.00,
  chain: 'TRON_NILE',
  currency: 'USDT',
  customer_hash: AGENT_ID
});
```

The server:

- creates `orderId`
- converts `15.00` USDT into `15_000_000` token base units
- stores the order in `orders.json`
- marks it `AWAITING_2FA`

### Step 4. Human approval gates the flow

The server does not immediately release the payment challenge.

Instead it:

- sends a Telegram approval message, or
- prints a local mock approval command

Server response:

```js
return res.status(202).json({
  orderId: newOrder.id,
  status: "AWAITING_2FA",
  message: "Checkout suspended. Awaiting cryptographically signed human approval via Telegram.",
  poll_url: `/api/ucp/checkout/challenge/${orderId}`
});
```

This is the human-in-the-loop control layer.

### Step 5. Agent polls for the challenge

The agent repeatedly calls:

- `GET /api/ucp/checkout/challenge/:orderId`

Until the backend returns the actual payment challenge.

Relevant agent logic:

```js
const pollUrl = `${MERCHAT_BASE_URL}${initialChallenge.poll_url}`;

let approved = false;
while (!approved) {
  await sleep(2000);
  const pollRes = await axios.get(pollUrl);
  if (pollRes.status === 200) {
    challenge = pollRes.data;
    approved = true;
  }
}
```

### Step 6. Agent receives payment challenge

Once the order is approved, the backend returns:

```js
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
```

This is the point where UCP hands off to TRON.

### Step 7. Agent builds the TRON transaction

The agent uses `TronWeb` to trigger the TRC20 token contract:

```js
const trc20ContractAddress = TRC20_USDT_CONTRACT;
const destinationAddress = challenge.payment_challenge.receiver_address;
const amountSun = parseInt(challenge.payment_challenge.amount);

const parameter = [
  { type: 'address', value: destinationAddress },
  { type: 'uint256', value: amountSun }
];

const ownerAddress = tronWeb.defaultAddress.base58;

const transaction = await tronWeb.transactionBuilder.triggerSmartContract(
  trc20ContractAddress,
  'transfer(address,uint256)',
  {},
  parameter,
  ownerAddress
);
```

What this does:

- chooses the TRC20 USDT contract
- prepares the `transfer(address,uint256)` call
- inserts the merchant address and required amount
- creates an unsigned smart-contract transaction for TRON

### Step 8. Agent signs and broadcasts

Then the agent signs the transaction with its own private key and broadcasts it:

```js
const signedTx = await tronWeb.trx.sign(transaction.transaction);
await tronWeb.trx.sendRawTransaction(signedTx);
const txHash = signedTx.txID;
```

This is the actual blockchain payment step.

Key point:

- the private key stays on the agent side
- the merchant never signs on behalf of the agent
- the merchant only receives the transaction hash later

### Step 9. Agent submits proof to merchant

After broadcasting, the agent sends:

```js
const completeRes = await axios.post(completeUrl, {
  orderId: challenge.orderId,
  transactionHash: txHash
});
```

Now the merchant can independently verify the on-chain transaction.

### Step 10. Merchant verifies transaction on TRON

The backend uses `TronWeb` to fetch the transaction:

```js
transaction = await tronWeb.trx.getTransaction(transactionHash);
```

The backend then checks:

- transaction exists
- transaction result is `SUCCESS`
- transaction type is `TriggerSmartContract`
- calldata starts with TRC20 `transfer(address,uint256)` selector
- token contract matches expected USDT contract
- recipient matches `MERCHANT_ADDRESS`
- amount matches `order.amount_in_sun`

Current verification logic:

```js
const parameter = contractData.parameter.value;
const decodedTransfer = decodeTrc20TransferData(parameter.data);

const paidTokenContract = normalizeAddress(parameter.contract_address);
if (paidTokenContract !== EXPECTED_USDT_CONTRACT) {
  return failOrder(400, "Transaction targets an unexpected token contract.");
}

if (decodedTransfer.recipient !== MERCHANT_ADDRESS) {
  return failOrder(400, "Transaction recipient does not match the merchant address.");
}

if (decodedTransfer.amount !== String(order.amount_in_sun)) {
  return failOrder(400, "Transaction amount does not match the checkout amount.");
}
```

If verification passes, the order becomes `PAID`.

### Step 11. Agent exchanges receipt for protected data

Finally, the agent uses the transaction hash as a receipt:

```js
const premiumRes = await axios.get(`${MERCHAT_BASE_URL}/api/premium-data`, {
  headers: {
    'Authorization': `UCP ${txHash}`
  }
});
```

The backend checks whether:

- there is an order with that `txHash`
- the order status is `PAID`

If yes, the premium payload is returned.

## 7. How HTTP 402 Is Implemented Here

This repo implements HTTP `402 Payment Required` directly in Express.

Important distinction:

- `402` itself is a standard HTTP status code
- this repo uses it as a custom UCP-oriented paywall signal
- this specific `WWW-Authenticate: UCP url="..."` pattern is application-specific

So in this repo, `402` is:

- not generated by a UCP SDK
- not generated by a TRON library
- not a separate "Bank of AI" protocol layer
- simply returned by the app code in `server.js`

The implementation is:

```js
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
```

What this means in practice:

- the resource is not available yet
- the response tells the agent where to fetch the merchant's UCP metadata
- the agent can continue the flow without human HTML forms

Official UCP note:

The current official UCP REST binding documents standard checkout operations and standard HTTP status usage, but this exact `402 + WWW-Authenticate: UCP url=...` pattern is a design choice in this repo rather than a required official UCP REST operation.

## 8. How the TRON Transaction Happens in Code

The actual payment transaction is a TRC20 smart contract call on TRON Nile.

The agent targets the TRC20 USDT contract and invokes:

- `transfer(address,uint256)`

The core code is:

```js
const transaction = await tronWeb.transactionBuilder.triggerSmartContract(
  trc20ContractAddress,
  'transfer(address,uint256)',
  {},
  parameter,
  ownerAddress
);

const signedTx = await tronWeb.trx.sign(transaction.transaction);
await tronWeb.trx.sendRawTransaction(signedTx);
const txHash = signedTx.txID;
```

Breaking this down:

- `triggerSmartContract(...)`
  - constructs the TRON transaction for a smart contract call
- `transfer(address,uint256)`
  - the standard TRC20 token transfer method
- `parameter`
  - includes destination address and amount
- `sign(...)`
  - signs the transaction with the agent's private key
- `sendRawTransaction(...)`
  - broadcasts the signed transaction to the network
- `txID`
  - becomes the receipt reference used later in the UCP flow

This means the merchant does not receive custody of the agent's funds or private key.

## 9. How the Backend Decodes the TRON Transfer

The backend checks that the transaction is really the expected token transfer.

It decodes TRC20 calldata from the `TriggerSmartContract` transaction:

```js
const decodeTrc20TransferData = (data) => {
  if (!data || typeof data !== 'string') return null;

  const normalizedData = data.replace(/^0x/, '');
  if (!normalizedData.startsWith(TRC20_TRANSFER_SELECTOR)) return null;
  if (normalizedData.length < 136) return null;

  const encodedRecipient = normalizedData.slice(8, 72);
  const encodedAmount = normalizedData.slice(72, 136);
  const recipientHex = `41${encodedRecipient.slice(-40)}`.toLowerCase();

  return {
    recipient: tronWeb.address.fromHex(recipientHex),
    amount: BigInt(`0x${encodedAmount}`).toString(),
  };
};
```

Why this matters:

- `a9059cbb` is the function selector for `transfer(address,uint256)`
- the next 32 bytes encode the recipient
- the next 32 bytes encode the amount

That lets the backend verify the transfer details against the checkout order.

## 10. How Fees Work at the TRON Level Here

This repo uses TRON smart contract execution, not a native TRX transfer.

That means the sender is paying for a contract call, which on TRON uses resources such as:

- Bandwidth
- Energy

### 10.1 Who pays the fee

The sender account pays the chain-level execution cost.

In this repo, that is the agent wallet configured by:

- `TRON_PRIVATE_KEY`

The merchant does not pay the blockchain execution fee for the agent's outgoing transfer in this flow.

### 10.2 Why TRC20 transfers cost more than simple TRX transfers

A TRC20 transfer is a smart contract call:

- it executes token contract logic
- that consumes Energy
- if the sender does not have enough available resources, TRX may be burned to cover it

### 10.3 How this repo handles fees

This repo does not explicitly estimate or surface fees to the user.

In the agent transaction builder call:

```js
const transaction = await tronWeb.transactionBuilder.triggerSmartContract(
  trc20ContractAddress,
  'transfer(address,uint256)',
  {},
  parameter,
  ownerAddress
);
```

Notice that the options object is just `{}`.

So this project currently does not:

- set an explicit `feeLimit`
- estimate Energy before sending
- show expected TRX cost in the UI

For a demo on Nile, that may be acceptable if the sender account has enough test resources.
For production, you would typically want to:

- estimate Energy usage
- set `feeLimit`
- ensure the sender wallet has enough TRX or staked resources
- handle `OUT_OF_ENERGY` and other resource failures explicitly

### 10.4 What can fail at the fee/resource layer

Even if the UCP flow is correct, the TRON transaction can still fail if:

- the sender has insufficient TRX
- the sender has insufficient Energy/Bandwidth
- `feeLimit` is too low
- the contract call reverts or runs out of Energy

So UCP and TRON are separate concerns:

- UCP can correctly describe the payment
- TRON execution can still fail due to chain-level resource constraints

## 11. Orders and State Storage

The order state is stored in `orders.json` through `db.js`.

Typical statuses in this flow:

- `AWAITING_2FA`
- `PENDING`
- `VERIFYING`
- `PAID`
- `FAILED`
- `REJECTED`

This state machine is what lets the backend coordinate:

- agent progress
- human approval
- blockchain verification
- receipt redemption

## 12. Official UCP Endpoints vs This Repo's Endpoints

To avoid confusion, here is the difference.

### Official UCP REST binding shape

The official UCP REST binding documents operations such as:

- `POST /checkout-sessions`
- `GET /checkout-sessions/{id}`
- `PUT /checkout-sessions/{id}`
- `POST /checkout-sessions/{id}/complete`
- `POST /checkout-sessions/{id}/cancel`

These are discovered from the UCP business profile.

### This repo's custom UCP-style endpoints

This repo instead uses:

- `GET /.well-known/ucp`
- `POST /api/ucp/checkout/create`
- `GET /api/ucp/checkout/challenge/:orderId`
- `POST /api/ucp/checkout/complete`

This means:

- the repo is implementing the checkout idea in a simpler, demo-specific way
- it is not a drop-in implementation of the full current UCP REST binding

## 13. Complete One-Sentence Summary

In this repository, UCP is used as the machine-readable commerce handshake that tells the agent what to pay and how to proceed, while TRON is the settlement rail that actually moves the USDT on-chain, and the transaction hash becomes the receipt used to unlock the protected API.

## 14. Official Source Links

### UCP

- UCP home: https://ucp.dev/2026-01-23/
- UCP official overview: https://ucp.dev/latest/specification/overview/
- UCP core concepts: https://ucp.dev/2026-01-23/documentation/core-concepts/
- UCP checkout capability overview: https://ucp.dev/latest/specification/checkout/
- UCP checkout REST binding: https://ucp.dev/latest/specification/checkout-rest/
- UCP schema reference: https://ucp.dev/2026-01-23/specification/reference/
- UCP GitHub repository: https://github.com/Universal-Commerce-Protocol/ucp

### TRON

- TRON resource model, Energy, and Bandwidth: https://developers.tron.network/docs/resource-model
- TronWeb `triggerSmartContract` reference: https://developers.tron.network/v4.4.0/reference/tronweb-triggersmartcontract
- TRON `fee_limit` FAQ: https://developers.tron.network/docs/faq

## 15. Recommended Reading Order

If you are new to this topic, read in this order:

1. Section 1 and Section 2 for the basic idea
2. Section 4 for the terminology
3. Section 6 for the full request-by-request flow
4. Section 7 and Section 8 for the concrete code behavior
5. Section 10 for the TRON fee model
6. Section 14 for the official docs
