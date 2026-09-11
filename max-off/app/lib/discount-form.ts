/**
 * The create form's shape and its validation — one implementation, used by
 * both sides.
 *
 * The component calls `validateDiscountForm` for immediacy; the action rebuilds
 * the same shape from the submitted `FormData` and calls the identical
 * function. That is what BUILD-SPEC §6 means by revalidating everything: a
 * client that skipped its checks cannot write a `cap_config` the Function
 * would refuse, because the server runs the same rules rather than a
 * lookalike set that can drift.
 */

import { parseDecimalToMinor } from "./cap";
import { can, maxCampaignDays } from "./plans";

export interface DiscountFormState {
  code: string;
  percentage: string;
  capAmount: string;
  usageLimitOn: boolean;
  usageLimit: string;
  oncePerCustomer: boolean;
  combinesProduct: boolean;
  combinesOrder: boolean;
  combinesShipping: boolean;
  startDate: string;
  startTime: string;
  endDateOn: boolean;
  endDate: string;
  endTime: string;
}

export type DiscountFieldErrors = Partial<
  Record<keyof DiscountFormState, string>
>;

/** What a valid form becomes: the arguments `createCappedDiscount` takes. */
export interface DiscountFormValue {
  code: string;
  percentage: number;
  capMinor: number;
  startsAt: Date;
  endsAt: Date | null;
  usageLimit: number | null;
  oncePerCustomer: boolean;
  combinesProduct: boolean;
  combinesOrder: boolean;
  combinesShipping: boolean;
}

export type DiscountFormResult =
  | { value: DiscountFormValue }
  | { errors: DiscountFieldErrors };

/**
 * The form as it opens.
 *
 * `maxDays` is the plan's run-length ceiling. A plan that has one opens with
 * the end date already on and filled to that ceiling — the date is not
 * optional on those plans, and a checkbox the merchant must tick before the
 * form can be saved is a puzzle, not a choice.
 */
export function initialDiscountFormState(
  today = new Date(),
  maxDays: number | null = null,
): DiscountFormState {
  const startDate = today.toISOString().slice(0, 10);

  return {
    code: "",
    percentage: "15",
    capAmount: "",
    usageLimitOn: false,
    usageLimit: "",
    oncePerCustomer: true,
    combinesProduct: false,
    combinesOrder: false,
    combinesShipping: true,
    startDate,
    startTime: "00:00",
    endDateOn: maxDays !== null,
    endDate: maxDays === null ? "" : defaultEndDate(startDate, maxDays),
    endTime: "23:59",
  };
}

/** `2026-09-10` + `09:00` → a Date in UTC. Null when either half is unusable. */
export function combineDateTime(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  if (time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return null;
  }

  const parsed = new Date(`${date}T${time === "" ? "00:00" : time}:00Z`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** How far out an end date is prefilled when a merchant switches one on. */
const DEFAULT_END_DATE_DAYS = 30;

/**
 * The end date to prefill when a merchant ticks "Set an end date", so the field
 * is never empty and failing validation before it has been touched.
 *
 * Thirty days rather than "one month", because adding a calendar month to
 * 31 January rolls over to 3 March in JavaScript, and a default nobody can
 * predict is worse than one that is slightly arbitrary. A plan with a shorter
 * ceiling gets its own ceiling instead — prefilling a date the same form is
 * about to reject is the one default worse than an empty field.
 */
export function defaultEndDate(
  startDate: string,
  maxDays: number | null = null,
): string {
  const parsed = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  // `maxDays - 1`, because the end time defaults to 23:59: the fifteenth day
  // is the last day the discount runs, not the day after it stops. A prefill
  // of start + 15 days at 23:59 is 15 days and 23 hours, which the ceiling
  // then rejects — a default that fails its own form.
  const days =
    maxDays === null
      ? DEFAULT_END_DATE_DAYS
      : Math.max(Math.min(DEFAULT_END_DATE_DAYS, maxDays - 1), 0);

  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/**
 * The rules from §4.3: percentage a whole 1-100, maximum above zero, end after
 * start, code present. Field-level messages, because §4.3 wants the error on
 * the field and not in a banner.
 */
/**
 * Shown both live, under the End date field as the merchant picks, and again
 * on save. One constant so the two can never drift into two different
 * sentences for the same problem.
 */
export const END_BEFORE_START_ERROR =
  "The end date must be after the start date.";

/**
 * The two plan rules the date and usage sections carry, as one sentence each.
 *
 * Functions rather than constants because the number comes from
 * `PLAN_MAX_CAMPAIGN_DAYS` — a hard-coded "15" here is a second definition of
 * the Free limit, which is the drift `plans.ts` exists to prevent.
 */
export function endDateRequiredError(days: number): string {
  return `Your plan runs a discount for up to ${days} days, so it needs an end date.`;
}

export function campaignTooLongError(days: number): string {
  return `Your plan runs a discount for up to ${days} days. Move the end date in, or choose a plan.`;
}

export const USAGE_LIMIT_NOT_ON_PLAN =
  "A limit on the total number of uses is part of the Growth plan.";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The rules, for one plan.
 *
 * The plan is a required argument rather than an option with a permissive
 * default: a call site that forgets it should fail to compile, not quietly
 * hand a Free merchant a Growth form. Anything unreadable is treated as Free
 * by `toPlanKey`, so the fallback is the strictest plan, never the loosest.
 */
export function validateDiscountForm(
  state: DiscountFormState,
  plan: string,
): DiscountFormResult {
  const errors: DiscountFieldErrors = {};

  const code = state.code.trim().toUpperCase();
  if (code === "") {
    errors.code = "Enter a discount code.";
  }

  const percentageRaw = state.percentage.trim();
  const percentage = Number(percentageRaw);
  if (
    percentageRaw === "" ||
    !/^\d+$/.test(percentageRaw) ||
    !Number.isInteger(percentage) ||
    percentage < 1 ||
    percentage > 100
  ) {
    errors.percentage = "Enter a whole number between 1 and 100.";
  }

  const capMinor = parseDecimalToMinor(state.capAmount);
  if (capMinor === null || capMinor < 1) {
    errors.capAmount = "Enter a maximum greater than zero.";
  }

  const startsAt = combineDateTime(state.startDate, state.startTime);
  if (startsAt === null) {
    errors.startDate = "Enter a start date and a time as HH:MM.";
  }

  const maxDays = maxCampaignDays(plan);

  let endsAt: Date | null = null;
  if (state.endDateOn) {
    endsAt = combineDateTime(state.endDate, state.endTime);
    if (endsAt === null) {
      errors.endDate = "Enter an end date, or turn the end date off.";
    } else if (startsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
      errors.endDate = END_BEFORE_START_ERROR;
    } else if (
      maxDays !== null &&
      startsAt !== null &&
      endsAt.getTime() - startsAt.getTime() > maxDays * DAY_MS
    ) {
      errors.endDate = campaignTooLongError(maxDays);
    }
  } else if (maxDays !== null) {
    // A plan with a ceiling cannot run an open-ended code: with no end date
    // there is nothing for the ceiling to bound. The form checks the box and
    // disables it, so this is the backstop for a submission that did not.
    errors.endDate = endDateRequiredError(maxDays);
  }

  let usageLimit: number | null = null;
  if (state.usageLimitOn) {
    if (!can(plan, "usageLimits")) {
      errors.usageLimit = USAGE_LIMIT_NOT_ON_PLAN;
    } else {
      const raw = state.usageLimit.trim();
      const parsed = Number(raw);
      if (raw === "" || !/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1) {
        errors.usageLimit = "Enter a whole number of uses, or turn the limit off.";
      } else {
        usageLimit = parsed;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    value: {
      code,
      percentage,
      capMinor: capMinor as number,
      startsAt: startsAt as Date,
      endsAt,
      usageLimit,
      oncePerCustomer: state.oncePerCustomer,
      combinesProduct: state.combinesProduct,
      combinesOrder: state.combinesOrder,
      combinesShipping: state.combinesShipping,
    },
  };
}

/**
 * Rebuild the form state from a submission. Every field is read as a string
 * and nothing is trusted: an absent checkbox is false, an unexpected value is
 * a validation failure rather than a coercion.
 */
export function discountFormStateFrom(form: FormData): DiscountFormState {
  const text = (name: string) => String(form.get(name) ?? "");
  const flag = (name: string) => form.get(name) === "true";

  return {
    code: text("code"),
    percentage: text("percentage"),
    capAmount: text("capAmount"),
    usageLimitOn: flag("usageLimitOn"),
    usageLimit: text("usageLimit"),
    oncePerCustomer: flag("oncePerCustomer"),
    combinesProduct: flag("combinesProduct"),
    combinesOrder: flag("combinesOrder"),
    combinesShipping: flag("combinesShipping"),
    startDate: text("startDate"),
    startTime: text("startTime"),
    endDateOn: flag("endDateOn"),
    endDate: text("endDate"),
    endTime: text("endTime"),
  };
}
