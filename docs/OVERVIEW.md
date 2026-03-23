# Gmail Organizer MCP Connector — Project Overview

## Purpose

This project is a custom Gmail MCP (Model Context Protocol) connector designed to give Claude the ability to actively organize a user's email — applying and removing labels, working at the conversation (thread) level, and using mailbox history to sync efficiently. It is intended to be published to Anthropic's public Connectors Directory so that any Claude user can connect it to their Gmail account.

## Why This Is Necessary

Anthropic's official Gmail connector (hosted at `gmail.mcp.claude.com`) is intentionally limited to read-only operations plus draft creation. It can search messages, read threads, list labels, and compose drafts — but it cannot apply or remove labels, archive conversations, or take any action that changes the state of a user's inbox. This makes it unsuitable for email organization workflows.

For Claude to act as a useful email assistant — triaging an inbox, labeling messages by project or priority, archiving handled conversations, surfacing things that need attention — it needs write access to label state. That is precisely what this connector provides.

## What This Connector Adds

Compared to the official Gmail connector, this connector adds:

- **Applying and removing labels on messages and threads** — the core capability for any organization workflow
- **Batch label operations** — labeling or unlabeling up to 1,000 messages in a single operation, enabling efficient inbox cleanup
- **Mailbox history/change tracking** — the ability to ask "what has changed since the last time I checked?" rather than re-scanning the entire inbox, making background or repeated organization tasks far more efficient

Capabilities that are deliberately *excluded* despite being technically available under the same OAuth scope include: sending email, trashing or deleting messages, creating or modifying label definitions, and importing or injecting messages. This keeps the connector focused, minimizes risk, and presents a more straightforward case to Google during OAuth app review.

## Advantages Over the Existing Connector

The existing connector is appropriate for research and retrieval tasks — finding a message, summarizing a thread, or preparing a draft reply. This connector is designed for a different class of task: taking action on the inbox itself. A user can ask Claude to label all unread newsletters, archive everything from a particular sender that is older than 30 days, apply a "Needs Reply" label to any thread where they were directly addressed but have not responded, or reorganize their label structure by applying a new label across a large set of messages. None of these are possible with the existing connector.

## OAuth Scope

This connector uses the `https://www.googleapis.com/auth/gmail.modify` scope. This scope:

- Allows reading, composing, and label modification
- Explicitly **does not** allow permanent deletion of messages (that requires full `mail.google.com` access)
- Is classified by Google as a "restricted" scope, which has implications for the review process described below

## Path to Public Availability

Getting this connector usable by the general public requires completing two independent review processes after the code is written and deployed.

### 1. Google OAuth App Verification

Because `gmail.modify` is a restricted scope, Google requires any app that requests it for non-personal use to go through their OAuth verification and security assessment process. The steps are:

**Brand verification** (2–3 business days): Verify ownership of a domain associated with the application, configure an OAuth consent screen in Google Cloud Console with accurate application name, logo, and privacy policy URL.

**Restricted scope review**: Submit a justification for each restricted scope explaining why it is necessary. Google will review whether the use case qualifies. This review can take several weeks and may involve back-and-forth.

**CASA security assessment**: All apps requesting restricted scopes that can access data through a third-party server must complete a Cloud Application Security Assessment through one of Google's authorized assessment labs (e.g., TAC Security, Leviathan, DEKRA, Prescient Security). The assessment validates that the application handles user data securely and can delete user data on request. Cost ranges roughly from $500–$4,500 per year depending on the assessment tier assigned, with annual reassessment required to maintain verified status.

Until this process is complete, the connector can be used personally (by adding yourself as a test user in Google Cloud Console) and by up to 100 known test users, but any other user will see an "unverified app" warning screen from Google during the OAuth flow.

### 2. Anthropic Connectors Directory Submission

To have the connector listed in Claude's built-in connector browser (making it one-click installable for all Claude users), submit it through Anthropic's connector directory review form. Key requirements:

- The MCP server must be publicly hosted and reachable
- All tools must include either `readOnlyHint` or `destructiveHint` annotations (missing annotations are the most common reason for delays)
- The server must adhere to Anthropic's MCP Directory Policy on security, safety, and compatibility
- Anthropic reviews submissions but due to volume cannot guarantee acceptance or response timeline for every submission

The two review processes (Google and Anthropic) are independent and can be pursued in parallel once the server is deployed.

### Summary Timeline Estimate

| Phase | Estimated Duration |
|---|---|
| Development and initial deployment | Varies |
| Google brand verification | 2–3 business days |
| Google restricted scope review | 2–6 weeks |
| CASA security assessment | 2–4 weeks (after testing begins) |
| Anthropic directory review | Unknown; variable |

Total elapsed time from code-complete to public availability should be budgeted at **2–3 months minimum**, primarily driven by Google's review processes.
