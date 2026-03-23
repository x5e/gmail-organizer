# Gmail Organizer MCP Connector — Technical Specification

## What This Document Covers

This document describes the requirements for building a remote MCP server that provides Gmail read and label-management capabilities to Claude. It is designed to be a fully standalone connector — a user should not need any other Gmail connector alongside it. It covers the MCP protocol requirements, the Google API endpoints to expose and exclude, the OAuth flow, and deployment requirements. Implementation choices that are reasonably left to the developer (language, framework, hosting provider, etc.) are not prescribed here.

---

## MCP Protocol Requirements

The server must implement the Model Context Protocol using the **Streamable HTTP** transport (this is the current standard for remote/hosted MCP servers; SSE transport is legacy and should be avoided for new implementations). The server exposes a single HTTP endpoint (conventionally `/mcp`) that accepts POST requests from Claude's infrastructure.

Each tool exposed by the server must include the appropriate hint annotation in its tool definition:

- `readOnlyHint: true` for any tool that only reads data without modifying it
- `destructiveHint: false` for label-modification tools (they are write operations but not destructive/irreversible in the dangerous sense)

These annotations are required for Anthropic's directory submission review.

The MCP SDK is available in multiple languages via Anthropic's open-source repositories and is the recommended way to implement the protocol rather than building from scratch.

---

## OAuth 2.0 Integration

### Scope

The connector must request exactly one Google OAuth scope:

```
https://www.googleapis.com/auth/gmail.modify
```

No additional scopes should be requested. Specifically, do **not** request `https://mail.google.com/` (full access) or `https://www.googleapis.com/auth/gmail.send`.

### OAuth Flow

The server must implement the **Authorization Code flow with PKCE** for user-facing OAuth. The flow is:

1. When a user adds the connector in Claude's settings, Claude initiates an OAuth authorization redirect to the server's authorization endpoint
2. The server redirects the user to Google's OAuth consent screen with the `gmail.modify` scope
3. Google redirects back to the server's callback URL with an authorization code
4. The server exchanges the code for an access token and refresh token
5. The server stores the refresh token securely associated with the user's session
6. On each API request, the server uses the stored refresh token to obtain a fresh access token as needed

The Google OAuth client credentials (client ID and client secret) come from a Google Cloud project registered for this application. These are server-side secrets and must never be exposed to clients.

Token storage must be encrypted at rest. Refresh tokens are long-lived credentials that grant ongoing access to a user's Gmail and must be treated accordingly.

### Per-User Token Isolation

Each user who connects the connector will have their own independent OAuth token. The server must ensure strict per-user isolation — no user's token may ever be used to access another user's data.

---

## Google API Base URL

All Gmail API calls are made to:

```
https://gmail.googleapis.com/gmail/v1/users/me/
```

All requests must include an `Authorization: Bearer <access_token>` header with a valid, non-expired access token for the authenticated user.

---

## Tools to Implement

### 1. `list_labels`

**Purpose:** Returns all labels in the user's Gmail account, both system labels (INBOX, SENT, SPAM, etc.) and user-created labels. This is a prerequisite for any labeling operation — callers need label IDs, not just names.

**Google API call:**
```
GET /labels
```

**Response fields to surface:** label `id`, `name`, `type` (system vs. user), `messagesTotal`, `messagesUnread`.

**Tool annotation:** `readOnlyHint: true`

---

### 2. `search_messages`

**Purpose:** Search for messages matching a Gmail query string. Returns message IDs and thread IDs that can be passed to other tools.

**Google API call:**
```
GET /messages?q={query}&maxResults={n}&pageToken={token}
```

The `q` parameter accepts Gmail's full search syntax (e.g., `from:someone@example.com is:unread label:inbox`).

**Pagination:** The API returns a `nextPageToken` when there are more results. The tool should accept an optional `pageToken` parameter and return the `nextPageToken` in its response so that callers can paginate through large result sets.

**Tool annotation:** `readOnlyHint: true`

---

### 3. `list_threads`

**Purpose:** List conversation threads in the user's mailbox, optionally filtered by label or search query. Returns thread IDs and basic metadata. Unlike `search_messages` — which returns individual message results — this endpoint operates natively at the conversation level, making it more natural for inbox-browsing workflows where you want to work through conversations rather than individual messages.

**Google API call:**
```
GET /threads?q={query}&labelIds[]={labelId}&maxResults={n}&pageToken={token}
```

The `q` parameter accepts the same Gmail search syntax as `search_messages`. The `labelIds` parameter filters to threads carrying a specific label (e.g., `INBOX`, or a user-created label ID) and can be combined with `q`. Both are optional — omitting them returns all threads.

Note that the response contains thread metadata only (thread ID, snippet, history ID), not full message content. Follow-up calls to `get_thread` are needed to retrieve message bodies.

**Pagination:** Returns `nextPageToken` when more results exist. Maximum 500 threads per request.

**Tool annotation:** `readOnlyHint: true`

---

### 4. `get_message`

**Purpose:** Retrieve the full content of a single message by ID, including headers, body, attachments metadata, and current label state. This is the primary tool for reading an individual email — for example after obtaining an ID from `search_messages`.

**Google API call:**
```
GET /messages/{messageId}?format={format}
```

The `format` parameter controls how much of the message is returned and should be exposed as an optional input:

- `full` (default) — returns the complete parsed message including all body parts. Appropriate for reading the message content.
- `metadata` — returns only headers and label IDs, no body. Useful when only label state or headers (subject, from, date) are needed without fetching the full body.
- `minimal` — returns only message IDs, label IDs, and size estimate. Rarely needed but useful for lightweight label checks.

The response body is encoded as a MIME message tree. For messages with a plain-text or HTML body, the content is base64url-encoded in the `payload.body.data` field (for simple messages) or in `payload.parts` (for multipart messages). The implementation should decode these for the caller rather than returning raw base64.

**Tool annotation:** `readOnlyHint: true`

---

### 5. `get_attachment`

**Purpose:** Retrieve the content of a specific message attachment by its attachment ID. This is necessary because the Gmail API does not include the body data of large attachments (roughly above 2MB) in the `get_message` response — instead it omits the data and provides an `attachmentId` that must be fetched separately. Small attachments may be inlined in the message response, but this tool is needed for the rest.

**Google API call:**
```
GET /messages/{messageId}/attachments/{attachmentId}
```

Both IDs are available from the `get_message` response: the `messageId` is the message being read, and the `attachmentId` appears in the relevant part of the MIME payload tree (`payload.parts[n].body.attachmentId`) when body data has been omitted.

**Response:** Returns a `MessagePartBody` object containing `size` and `data` (the attachment content as a base64url-encoded string). As with message bodies, the implementation should surface the decoded content and the attachment's MIME type (available from the message's MIME part metadata) so the caller receives usable output rather than raw encoded data.

**Note on large attachments:** Attachment content can be arbitrarily large. The implementation should be mindful of response size limits and may want to truncate or summarize attachment content for very large files rather than passing the entire payload to the model.

**Tool annotation:** `readOnlyHint: true`

---

### 6. `get_thread`

**Purpose:** Retrieve the full content of a thread (all messages in a conversation), including current label state of each message.

**Google API call:**
```
GET /threads/{threadId}
```

**Tool annotation:** `readOnlyHint: true`

---

### 7. `modify_message_labels`

**Purpose:** Add and/or remove labels on a single message.

**Google API call:**
```
POST /messages/{messageId}/modify
```

**Request body:**
```json
{
  "addLabelIds": ["<labelId>", ...],
  "removeLabelIds": ["<labelId>", ...]
}
```

**Label ID restrictions (enforced server-side):** The server must reject any request that includes `TRASH` or `SPAM` in either `addLabelIds` or `removeLabelIds`. This prevents soft-deletion via label manipulation. Return a clear error message explaining that trash and spam operations are not supported by this connector.

**Tool annotation:** `destructiveHint: false`

---

### 8. `modify_thread_labels`

**Purpose:** Add and/or remove labels on all messages in a thread simultaneously. This is the primary tool for conversation-level organization — equivalent to how Gmail's own UI operates.

**Google API call:**
```
POST /threads/{threadId}/modify
```

**Request body:**
```json
{
  "addLabelIds": ["<labelId>", ...],
  "removeLabelIds": ["<labelId>", ...]
}
```

**Label ID restrictions:** Same enforcement as `modify_message_labels` — reject requests involving `TRASH` or `SPAM`.

**Tool annotation:** `destructiveHint: false`

---

### 9. `batch_modify_message_labels`

**Purpose:** Add and/or remove labels on up to 1,000 messages in a single operation. Essential for bulk organization tasks (e.g., "label all messages matching this search as 'Archived'").

**Google API call:**
```
POST /messages/batchModify
```

**Request body:**
```json
{
  "ids": ["<messageId>", ...],
  "addLabelIds": ["<labelId>", ...],
  "removeLabelIds": ["<labelId>", ...]
}
```

**Limits:** Google enforces a maximum of 1,000 message IDs per request. If a caller provides more, the server should either return an error or automatically split the operation into sequential batches.

**Label ID restrictions:** Same enforcement as above — reject `TRASH` and `SPAM`.

**Tool annotation:** `destructiveHint: false`

---

### 10. `get_history`

**Purpose:** Return a list of changes to the mailbox (messages added, labels changed, messages deleted) since a given history ID. This enables efficient incremental sync — rather than re-scanning the whole inbox, a caller can ask "what changed since last time?" and receive only the delta.

**Google API call:**
```
GET /history?startHistoryId={id}&historyTypes=labelAdded,labelRemoved,messageAdded&maxResults={n}&pageToken={token}
```

The `startHistoryId` is an opaque token returned by previous API calls (present on message and thread objects). The tool should accept it as a required parameter and return the new `historyId` that should be used on the next call.

**Tool annotation:** `readOnlyHint: true`

---

### 11. `get_profile`

**Purpose:** Returns basic account information (email address, total message count, history ID). The returned `historyId` is useful as a starting point for change tracking.

**Google API call:**
```
GET /profile
```

**Tool annotation:** `readOnlyHint: true`

---

## Endpoints to Explicitly Not Implement

The following Google Gmail API endpoints are available under `gmail.modify` but must **not** be exposed as tools in this connector:

| Endpoint | Reason for exclusion |
|---|---|
| `POST /messages/{id}/trash` | Soft-deletes message; starts 30-day auto-deletion clock |
| `POST /messages/{id}/untrash` | Excluded for consistency with trash exclusion |
| `POST /threads/{id}/trash` | Same as message trash, thread-level |
| `POST /threads/{id}/untrash` | Same as above |
| `DELETE /messages/{id}` | Permanent deletion (requires full scope anyway, but document explicitly) |
| `DELETE /threads/{id}` | Same |
| `POST /messages/batchDelete` | Batch permanent deletion |
| `POST /messages/send` | Sends email on user's behalf |
| `POST /drafts/{id}/send` | Sends a draft |
| `POST /messages/import` | Imports external email into mailbox |
| `POST /messages/insert` | Injects message directly, bypassing spam scanning |
| `POST /labels` (create) | Creates new label definitions |
| `PUT /labels/{id}` (update) | Renames/modifies label definitions |
| `DELETE /labels/{id}` | Deletes a label and removes it from all messages |

---

## Server-Side Safety Enforcement

Beyond simply not implementing the above endpoints, the server should enforce the following rules on all label modification requests regardless of how they are formed:

- **Block TRASH label ID** (`TRASH`): Reject any `addLabelIds` or `removeLabelIds` array that contains this value
- **Block SPAM label ID** (`SPAM`): Same rejection
- **Validate label IDs on write operations**: Before submitting a modify request to Google, validate that all provided label IDs exist in the user's label list. This prevents silent failures and confusing error messages from the Google API.

These checks protect against both accidental misuse and against prompt injection scenarios where malicious content in an email might attempt to instruct Claude to move messages to trash.

---

## Deployment Requirements

### Hosting

The server must be publicly reachable over HTTPS at a stable URL. The URL becomes the "Connector URL" entered in Claude's settings (and later in the Anthropic directory listing). There is no prescribed hosting platform — any environment capable of running a persistent HTTPS server is acceptable.

### HTTPS / TLS

All traffic must be served over HTTPS with a valid TLS certificate. HTTP is not acceptable for production deployment. Most modern hosting platforms handle TLS automatically.

### OAuth Callback URL

The server needs a stable, publicly reachable callback URL for Google's OAuth redirect (e.g., `https://your-domain.com/oauth/callback`). This URL must be registered in the Google Cloud Console under the OAuth client's authorized redirect URIs. It must match exactly — including trailing slashes — or Google will reject the callback.

### Google Cloud Project Setup

Before deploying:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable the Gmail API for the project
3. Configure the OAuth consent screen:
   - Set application name and logo
   - Add a privacy policy URL (required for restricted scopes)
   - Add the `gmail.modify` scope
4. Create an OAuth 2.0 Client ID of type "Web application"
5. Add the server's callback URL to the list of authorized redirect URIs
6. Store the resulting client ID and client secret as environment variables in the server environment (never commit these to source control)

During development and testing, set the OAuth consent screen publishing status to **Testing** and add your own Google account as a test user. The connector will work fully in this mode without any Google review.

### Environment Variables

At minimum, the server will need the following secrets provided as environment variables (exact names are left to the implementer):

- Google OAuth client ID
- Google OAuth client secret
- A secret key for encrypting stored tokens (or equivalent, depending on the storage approach chosen)

### Statelessness vs. State

The server must persist OAuth refresh tokens across restarts. The choice of persistence mechanism (database, encrypted file store, secrets manager, etc.) is left to the implementer, but it must survive a server restart. Losing refresh tokens forces all users to re-authenticate.

---

## Tool Input/Output Conventions

For consistency and to make tools easy for Claude to use correctly:

- Label IDs and message IDs should always be strings
- All list-returning tools should support a `maxResults` parameter with a sensible default (e.g., 20 or 50) and return a `nextPageToken` when pagination is available
- Tools that modify state should return a confirmation indicating what was changed (e.g., the updated message or thread object from Google's response)
- Error responses should be human-readable and actionable — not raw Google API error objects

---

## Reference Documentation

- [Gmail API Reference](https://developers.google.com/workspace/gmail/api/reference/rest)
- [Gmail API OAuth Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [MCP Specification](https://spec.modelcontextprotocol.io)
- [Building Custom Connectors — Anthropic Help Center](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers)
- [Anthropic Connectors Directory FAQ](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq)
- [Google Restricted Scope Verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
