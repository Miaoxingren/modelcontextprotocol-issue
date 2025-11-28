# StreamableHTTPServerTransport: Zombie Task Collision Issue

> **Comprehensive Guide:** Diagnosis and Reproduction for MCP SDK Bug

## 📖 Table of Contents
1. [The Bug: Zombie Task Collision](#1-the-bug-zombie-task-collision)
2. [Quick Start (Reproduction)](#2-quick-start-reproduction)
3. [Detailed Diagnosis](#3-detailed-diagnosis)

---

## 1. The Bug: Zombie Task Collision

### Summary
The `StreamableHTTPServerTransport` in the MCP SDK suffers from a critical concurrency flaw where **Zombie Tasks** (long-running operations from disconnected sessions) collide with **New Tasks** that reuse the same Request ID.

### The Symptom
- Users experience random timeouts or "hangs".
- Typically happens after a page refresh or network reconnect.
- Commonly affects Request IDs 1-10.

### The Mechanism
1. **Timeout**: Client sends `ID: 1` -> Server starts **Task A**. Client disconnects.
2. **Retry**: Client reconnects, resets counter, sends `ID: 1` again -> Server starts **Task B**.
3. **Collision**: **Task A** (Zombie) finishes and overwrites the response for `ID: 1`.
4. **Deadlock**: **Task B** finishes later but finds its mapping deleted by Task A. The client hangs.

---

## 2. Quick Start (Reproduction)

We provide a complete environment to reproduce this bug locally.

### Files Overview
- `reproduce-server.ts`: MCP server with debugging enabled.
- `reproduce-test.ts`: Automated script to trigger the race condition.

### Step-by-Step
1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Run Server**
   ```bash
   npx tsx reproduce-server.ts
   ```
   *(Keep this running in one terminal)*

3. **Run Test**
   ```bash
   npx tsx reproduce-test.ts
   ```

### Expected Output
If the bug exists, you will see:
```
⚠️ Step 2: Stale mappings found
✗ Step 3: Request with id: 1 fails/times out
🐛 BUG CONFIRMED!
```

---

## 3. Detailed Diagnosis

### Root Cause: Shared Mutable State
The transport layer uses a global `_requestToStreamMapping` map. It assumes Request IDs are globally unique, but JSON-RPC clients reuse IDs (1, 2, 3...) per session.

### Why it happens
When a connection closes:
1. `StreamableHTTPServerTransport` removes the stream mapping.
2. **CRITICAL FAILURE**: It does *not* cancel running tasks.
3. **CRITICAL FAILURE**: It does *not* clean up request mappings for that stream immediately.

This leaves "landmines" (stale mappings) that explode when a new connection steps on the same ID.

---
*Document prepared for Shopee Internal PFC Team*
