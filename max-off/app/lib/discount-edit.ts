/**
 * Editing a discount that is already live.
 *
 * Only three fields are editable, and the line between them and the rest is
 * not a matter of effort — it is the only line that keeps this safe.
 *
 * A cart can be sitting in checkout right now with this discount applied. The
 * Function recomputes the amount from `cap_config` on every cart evaluation,
 * so changing the percentage or the maximum changes what that buyer is
 * charged, part-way through paying, with no notice and no record of what they
 * were quoted. MaxOff has no answer for that, so it does not offer it.
 *
 * Editable, because none of them can change the amount a cart in flight is
 * charged:
 *
 *   - **end date**     — moves when the discount stops applying, not what it
 *                        gives while it does.
 *   - **usage limit**  — Shopify decides redemption eligibility before our
 *                        Function is consulted, and code discounts only:
 *                        `usageLimit` is not a field on
 *                        `DiscountAutomaticAppInput` (checked against the
 *                        2026-10 schema, which rejects it outright).
 *   - **checkout note** — the wording shown when the maximum decided the
 *                        amount. Changes what a buyer reads, never what they
 *                        pay.
 *
 * Locked: percentage, maximum, scope, targeting, minimums, per-market
 * maximums. Duplicate is the path for those — a new discount, a new code,
 * nobody mid-checkout.
 */

import { CHECKOUT_NOTE_MAX_LENGTH, normaliseCheckoutNote } from "./cap-config";
import {
  campaignTooLongError,
  CHECKOUT_NOTE_NOT_ON_PLAN,
  CHECKOUT_NOTE_TOO_LONG,
  combineDateTime,
  END_BEFORE_START_ERROR,
  endDateRequiredError,
  USAGE_LIMIT_NOT_ON_PLAN,
} from "./discount-form";
import { hasNow, maxCampaignDays } from "./plans";

/** What the form holds. Strings, because that is what inputs give back. */
export interface EditFormState {
  endDate: string;
  endTime: string;
  /** "" means no limit. */
  usageLimit: string;
  checkoutNote: string;
}

export type EditField = keyof EditFormState;

export type EditFieldErrors = Partial<Record<EditField, string>>;

/** The validated result, in the shape the mutation wants. */
export interface EditFormValue {
  endsAt: Date | null;
  usageLimit: number | null;
  checkoutNote: string;
}

export type EditFormResult =
  | { ok: true; value: EditFormValue }
  | { ok: false; errors: EditFieldErrors };

export const USAGE_LIMIT_INVALID = "Enter a whole number of uses, or leave it blank.";

export const USAGE_LIMIT_BELOW_USED =
  "This discount has already been used more times than that. Raise the limit, or leave it blank.";

export interface EditFormContext {
  /** The discount's start, which the end must come after. */
  startsAt: Date;
  /** How many times Shopify says it has been used. Null when unknown. */
  timesUsed: number | null;
  method: "code" | "automatic";
  plan: string;
  timeZone: string;
}

/**
 * Validate an edit.
 *
 * The plan rules are checked here as well as on create, because a discount
 * created on Growth and then downgraded to Free must not be extendable past
 * the Free campaign limit by editing it — the limit would otherwise be a
 * create-time formality anyone could walk around.
 */
export function validateEdit(
  state: EditFormState,
  context: EditFormContext,
): EditFormResult {
  const errors: EditFieldErrors = {};

  /* -------------------------------------------------------------- end date */

  const days = maxCampaignDays(context.plan);
  let endsAt: Date | null = null;

  if (state.endDate.trim() === "") {
    // A plan with a campaign limit cannot have an open-ended discount at all.
    if (days !== null) {
      errors.endDate = endDateRequiredError(days);
    }
  } else {
    endsAt = combineDateTime(state.endDate, state.endTime, context.timeZone);

    if (endsAt === null) {
      errors.endDate = "Enter a valid date.";
    } else if (endsAt.getTime() <= context.startsAt.getTime()) {
      errors.endDate = END_BEFORE_START_ERROR;
    } else if (days !== null) {
      const span =
        (endsAt.getTime() - context.startsAt.getTime()) / (24 * 60 * 60 * 1000);
      if (span > days) {
        errors.endDate = campaignTooLongError(days);
      }
    }
  }

  /* ----------------------------------------------------------- usage limit */

  let usageLimit: number | null = null;
  const rawLimit = state.usageLimit.trim();

  if (rawLimit !== "") {
    // An automatic discount has no usage limit to set: `usageLimit` is not a
    // field on DiscountAutomaticAppInput. The form hides it; this refuses it,
    // so a hand-posted form cannot send one either.
    if (context.method === "automatic") {
      errors.usageLimit = "Automatic discounts do not take a limit on uses.";
    } else if (!hasNow(context.plan, "usageLimits")) {
      errors.usageLimit = USAGE_LIMIT_NOT_ON_PLAN;
    } else if (!/^\d+$/.test(rawLimit)) {
      errors.usageLimit = USAGE_LIMIT_INVALID;
    } else {
      usageLimit = Number(rawLimit);

      if (usageLimit < 1) {
        errors.usageLimit = USAGE_LIMIT_INVALID;
      } else if (context.timesUsed !== null && usageLimit < context.timesUsed) {
        // Shopify would accept this and the discount would stop working with
        // no explanation a merchant could find. Refusing is kinder than a
        // discount that silently dies.
        errors.usageLimit = USAGE_LIMIT_BELOW_USED;
      }
    }
  }

  /* ---------------------------------------------------------- checkout note */

  const checkoutNote = normaliseCheckoutNote(state.checkoutNote);

  if (state.checkoutNote.trim().length > CHECKOUT_NOTE_MAX_LENGTH) {
    errors.checkoutNote = CHECKOUT_NOTE_TOO_LONG;
  } else if (
    state.checkoutNote.trim() !== "" &&
    !hasNow(context.plan, "customCheckoutWording")
  ) {
    errors.checkoutNote = CHECKOUT_NOTE_NOT_ON_PLAN;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: { endsAt, usageLimit, checkoutNote } };
}
