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
import {
  CHECKOUT_NOTE_MAX_LENGTH,
  DEFAULT_CHECKOUT_NOTE,
  isAppliesTo,
  normaliseCheckoutNote,
} from "./cap-config";
import type { AppliesTo } from "./cap-config";
import { can, maxCampaignDays } from "./plans";

/** How a buyer gets the discount. */
export type DiscountMethod = "code" | "automatic";

/**
 * One product or collection the merchant picked.
 *
 * The title rides along with the id purely so the form can show what was
 * chosen without a second round trip to Shopify. Only the id is written to
 * `cap_config`; a title that goes stale in our form is a cosmetic problem,
 * where a stale id in the Function would be a discount on the wrong products.
 */
export interface PickedResource {
  id: string;
  title: string;
}

export interface DiscountFormState {
  method: DiscountMethod;
  code: string;
  /** The merchant-facing name of an automatic discount, which has no code. */
  title: string;
  appliesTo: AppliesTo;
  collections: PickedResource[];
  products: PickedResource[];
  checkoutNote: string;
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
  method: DiscountMethod;
  /** Empty for an automatic discount. */
  code: string;
  /** What the merchant sees in their own discount list. */
  title: string;
  appliesTo: AppliesTo;
  collectionIds: string[];
  productIds: string[];
  checkoutNote: string;
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
    method: "code",
    code: "",
    title: "",
    appliesTo: "all",
    collections: [],
    products: [],
    checkoutNote: DEFAULT_CHECKOUT_NOTE,
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

export const CHECKOUT_NOTE_NOT_ON_PLAN =
  "Your own checkout wording is part of the Growth plan.";

export const CHECKOUT_NOTE_TOO_LONG = `Keep the note to ${CHECKOUT_NOTE_MAX_LENGTH} characters or fewer.`;

/**
 * A discount that targets a set and names nothing in it would take its
 * percentage on a subtotal of zero — no discount at all, and no clue why. The
 * Function refuses that config, so the form has to refuse it first, where the
 * merchant can still fix it.
 */
export const NO_COLLECTIONS_CHOSEN = "Choose at least one collection.";
export const NO_PRODUCTS_CHOSEN = "Choose at least one product.";

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

  // An automatic discount has no code to enter — Shopify identifies it by
  // title — so the two fields are required in the alternative, never together.
  const method: DiscountMethod = state.method === "automatic" ? "automatic" : "code";

  const code = method === "code" ? state.code.trim().toUpperCase() : "";
  if (method === "code" && code === "") {
    errors.code = "Enter a discount code.";
  }

  const typedTitle = state.title.trim();
  if (method === "automatic" && typedTitle === "") {
    errors.title = "Enter a name for this discount.";
  }

  const appliesTo: AppliesTo = isAppliesTo(state.appliesTo) ? state.appliesTo : "all";
  const collectionIds = appliesTo === "collections" ? idsOf(state.collections) : [];
  const productIds = appliesTo === "products" ? idsOf(state.products) : [];

  if (appliesTo === "collections" && collectionIds.length === 0) {
    errors.collections = NO_COLLECTIONS_CHOSEN;
  }
  if (appliesTo === "products" && productIds.length === 0) {
    errors.products = NO_PRODUCTS_CHOSEN;
  }

  // The note is only checked against the plan when the merchant actually
  // changed it: a Free merchant submitting the default wording is submitting
  // what we put there, and refusing that would be refusing our own form.
  const checkoutNote = normaliseCheckoutNote(state.checkoutNote);
  const noteChanged = checkoutNote !== DEFAULT_CHECKOUT_NOTE;
  if (noteChanged && !can(plan, "customCheckoutWording")) {
    errors.checkoutNote = CHECKOUT_NOTE_NOT_ON_PLAN;
  } else if (state.checkoutNote.trim().length > CHECKOUT_NOTE_MAX_LENGTH) {
    errors.checkoutNote = CHECKOUT_NOTE_TOO_LONG;
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

  // Shopify's automatic discount input has no usageLimit and no
  // appliesOncePerCustomer: there is no code to ration. The form hides both
  // for an automatic discount; this makes a stray submission harmless.
  let usageLimit: number | null = null;
  if (state.usageLimitOn && method === "code") {
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
      method,
      code,
      title: typedTitle,
      appliesTo,
      collectionIds,
      productIds,
      checkoutNote,
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
    method: text("method") === "automatic" ? "automatic" : "code",
    code: text("code"),
    title: text("title"),
    appliesTo: isAppliesTo(form.get("appliesTo")) ? (form.get("appliesTo") as AppliesTo) : "all",
    collections: resources(form.get("collections")),
    products: resources(form.get("products")),
    checkoutNote: text("checkoutNote"),
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

/** Unique, non-empty ids, in the order the merchant picked them. */
function idsOf(picked: PickedResource[]): string[] {
  return [
    ...new Set(
      (picked ?? [])
        .map((resource) => resource?.id?.trim() ?? "")
        .filter((id) => id !== ""),
    ),
  ];
}

/**
 * The picked products or collections, as the form posts them.
 *
 * They travel as one JSON field rather than repeated inputs because they are
 * one value the merchant set in one gesture, and because `FormData` has no way
 * to carry the title alongside the id without inventing a delimiter that some
 * product name will eventually contain. Anything unparseable is an empty list,
 * which validation then rejects for a targeted discount — never a silent
 * fallback to the whole catalogue.
 */
function resources(value: FormDataEntryValue | null): PickedResource[] {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry): PickedResource[] => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const { id, title } = entry as { id?: unknown; title?: unknown };
      return typeof id === "string" && id.trim() !== ""
        ? [{ id: id.trim(), title: typeof title === "string" ? title : id.trim() }]
        : [];
    });
  } catch {
    return [];
  }
}
