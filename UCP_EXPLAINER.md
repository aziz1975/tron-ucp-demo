# Anatomy of the Universal Commerce Protocol (UCP) on TRON

This document explains exactly how the UCP-to-TRON Gateway we built maps to the Universal Commerce Protocol standard. The UCP is designed to allow AI agents to organically discover merchants, negotiate checkouts, and execute payments via standard endpoints, without ever looking at a human UI.

Here is the step-by-step breakdown:

---

## 1. Discovery (`GET /.well-known/ucp`)
**The Goal:** The AI agent needs to know "What can this merchant do?" and "How can I pay them?"
**The Implementation:** 
The merchant exposes a standard JSON manifest file at the root of their domain.
```json
{
  "capabilities": ["dev.ucp.checkout"],
  "payment_handler": "TRC20_USDT",
  "receiver_address": "TK5qfoga...13obLEM"
}
```
Through this, the agent instantly knows that this backend supports checkouts (`dev.ucp.checkout`) and accepts TRON-based USDT (`TRC20_USDT`).

---

## 2. Intent & Checkout (`POST /api/ucp/checkout/create`)
**The Goal:** The agent wants to buy a product and get a specific invoice.
**The Implementation:** 
The agent sends an array of `items` and a desired `currency`. The merchant's backend receives this intent and generates a unique **Order ID**.

The response is a UCP `payment_challenge`. This exactly defines what the agent must do to satisfy the order:
```json
"payment_challenge": {
  "receiver_address": "TK5qfoga...",
  "amount": 15000000, 
  "currency": "TRC20_USDT",
  "network": "TRON_NILE"
}
```
*Note: In TRON, 1 USDT is usually physically represented as `1,000,000` base units (Sun), which is why the amount is so large!*

---

## 3. Execution (The Agent's Wallet)
**The Goal:** The agent must safely fulfill the payment challenge using its own keys.
**The Implementation:**
Using `tronWeb`, the AI agent acts totally on its own. It targets the UCP-approved `USDT_CONTRACT_ADDRESS` on the Nile network, and triggers a `transfer()` Smart Contract call. 

The agent signs this natively and pushes it directly to the Nile Blockchain nodes, which returns a `transactionHash`.

---

## 4. Verification (`POST /api/ucp/checkout/complete`)
**The Goal:** The agent provides proof of payment, and the merchant independently verifies it.
**The Implementation:**
The agent calls the UCP `complete` endpoint, providing the `orderId` and the `transactionHash`. 

The merchant does **not** blindly trust the agent. Instead, the merchant's backend uses its own connection to the blockchain to query `transactionHash`. It verifies:
1. Is the transaction confirmed?
2. Is it a TRC-20 TriggerSmartContract?
3. Did the funds actually reach the exact `receiver_address` from the UCP manifest?

If everything is valid, the order is marked `PAID`.
