# Architecture Decision Records (ADRs)

This document tracks all significant architectural, design, and technical decisions for **Chat Bridge**.

| ID | Title | Status | Date | Summary |
| :--- | :--- | :--- | :--- | :--- |
| [ADR 0001](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0001-desktop-shell-architecture.md) | Desktop Shell Architecture & Runtime Selection | Accepted | 2026-11-04 | Electron for Desktop (macOS/Win) with shared engine for standalone Node CLI |
| [ADR 0002](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0002-outbox-storage-envelope-encryption.md) | Outbox Storage & Encryption — Standard SQLite with Envelope Encryption | Accepted | 2026-11-04 | Standard SQLite (`better-sqlite3` WAL) with AES-256-GCM envelope encryption for sensitive payload |
| [ADR 0003](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0003-google-sheets-oauth-rest.md) | Google Sheets Sink — Native Desktop OAuth 2.0 & REST API v4 | Accepted | 2026-11-04 | Desktop OAuth 2.0 loopback with PKCE directly calling Google Sheets REST API v4 |

