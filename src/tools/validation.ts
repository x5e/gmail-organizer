/**
 * src/tools/validation.ts
 *
 * Shared validation utilities used by label-modification tool handlers.
 *
 * Server-side safety rules (from the technical specification):
 *   - TRASH and SPAM label IDs must never appear in addLabelIds or removeLabelIds.
 *   - Before submitting any write request, provided label IDs must exist in the
 *     user's label list (prevents silent failures from the Gmail API).
 *
 * These checks defend against both accidental misuse and prompt-injection scenarios
 * where malicious email content might attempt to instruct Claude to move messages
 * to trash via label manipulation.
 */

import { GmailApiError, listLabels } from "../gmail/client.js";

/** Label IDs that may never be added or removed by this connector. */
export const BLOCKED_LABEL_IDS = new Set(["TRASH", "SPAM"]);

/**
 * Throws a descriptive error if any blocked label ID (TRASH or SPAM) appears
 * in either the addLabelIds or removeLabelIds array.
 */
export function assertNoBlockedLabels(
  addLabelIds: string[] = [],
  removeLabelIds: string[] = []
): void {
  const all = [...addLabelIds, ...removeLabelIds];
  const blocked = all.filter((id) => BLOCKED_LABEL_IDS.has(id));
  if (blocked.length > 0) {
    throw new Error(
      `The following label IDs are not permitted: ${blocked.join(", ")}. ` +
        "This connector does not support trash or spam operations to prevent " +
        "accidental message deletion. Use Gmail directly for these actions."
    );
  }
}

/**
 * Validates that all provided label IDs exist in the user's Gmail account.
 * Throws a descriptive error if any unknown label ID is found.
 *
 * @param accessToken - Valid Google access token for the user.
 * @param labelIds - Combined list of addLabelIds + removeLabelIds to validate.
 */
export async function assertLabelsExist(
  accessToken: string,
  labelIds: string[]
): Promise<void> {
  if (labelIds.length === 0) return;

  let allLabels;
  try {
    allLabels = await listLabels(accessToken);
  } catch (err) {
    if (err instanceof GmailApiError) {
      // Let 401s propagate as GmailApiError so that the caller's retry logic
      // (withGmailRetry) can detect the status code and force-refresh the token.
      if (err.status === 401) throw err;
      throw new Error(
        `Failed to fetch label list for validation: ${err.message}`
      );
    }
    throw err;
  }

  const existingIds = new Set(allLabels.map((l) => l.id));
  const unknown = labelIds.filter((id) => !existingIds.has(id));

  if (unknown.length > 0) {
    throw new Error(
      `Unknown label ID(s): ${unknown.join(", ")}. ` +
        "Use the list_labels tool to retrieve valid label IDs for this account."
    );
  }
}
