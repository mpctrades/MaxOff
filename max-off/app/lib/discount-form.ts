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
  DEFAULT_CAP_SCOPE,
  DEFAULT_CHECKOUT_NOTE,
  isAppliesTo,
  isCapScope,
  normaliseCheckoutNote,
} from "./cap-config";
import type { AppliesTo, CapScope } from "./cap-config";
import { can, maxCampaignDays } from "./plans";
import type { CapabilityKey } from "./plans";
import { DEFAULT_TIME_ZONE, isoDateInZone, zonedTimeToUtc } from "./timezone";

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

/**
 * Which minimum a cart must meet, as one choice rather than two checkboxes.
 *
 * Shopify's own discount form offers exactly one of amount or quantity, and a
 * merchant who sets both has written a rule they cannot state in a sentence.
 */
export type MinimumKind = "none" | "subtotal" | "quantity";

export const MINIMUM_KINDS: readonly MinimumKind[] = ["none", "subtotal", "quantity"];

export function isMinimumKind(value: unknown): value is MinimumKind {
  return (MINIMUM_KINDS as readonly unknown[]).includes(value);
}

/** One row of "in this currency, the maximum is this instead". */
export interface CurrencyCap {
  /** ISO 4217, upper case. */
  currencyCode: string;
  /** As the merchant typed it, in major units. */
  amount: string;
}

export interface DiscountFormState {
  method: DiscountMethod;
  code: string;
  /** The merchant-facing name of an automatic discount, which has no code. */
  title: string;
  /** Whether the maximum is one per order, per line, or per collection. */
  scope: CapScope;
  appliesTo: AppliesTo;
  collections: PickedResource[];
  products: PickedResource[];
  checkoutNote: string;
  percentage: string;
  capAmount: string;
  /** "none", "subtotal" or "quantity" — the minimum a cart must meet. */
  minimumKind: MinimumKind;
  minSubtotal: string;
  minQuantity: string;
  /** A maximum per market currency. The store's own currency is not in here. */
  currencyCaps: CurrencyCap[];
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
  scope: CapScope;
  appliesTo: AppliesTo;
  collectionIds: string[];
  productIds: string[];
  checkoutNote: string;
  percentage: number;
  capMinor: number;
  /** Null when there is no minimum. Only one of the two is ever set. */
  minSubtotalMinor: number | null;
  minQuantity: number | null;
  /** Minor units per ISO code. Empty when the merchant set none. */
  capsByCurrency: Record<string, number>;
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
 * The shop's own starting point for a new discount, from Settings.
 *
 * Every field here is a *prefill*. Nothing in this object reaches a discount
 * that already exists, and anything the merchant changes on a single discount
 * wins — which is the whole difference between these and `rounding`.
 *
 * Every property is optional and every fallback is the value the form used
 * before Settings could set it, so a shop that never opens Settings gets the
 * form it always had.
 */
export interface DiscountDefaults {
  scope?: CapScope;
  checkoutNote?: string;
  oncePerCustomer?: boolean;
  combinesProduct?: boolean;
  combinesOrder?: boolean;
  combinesShipping?: boolean;
  /** The shop's IANA zone, so "today" is the merchant's today. */
  timeZone?: string;
}

/**
 * The form as it opens.
 *
 * `maxDays` is the plan's run-length ceiling. A plan that has one opens with
 * the end date already on and filled to that ceiling — the date is not
 * optional on those plans, and a checkbox the merchant must tick before the
 * form can be saved is a puzzle, not a choice.
 *
 * `defaults` is the shop's Settings block. The start date is the merchant's
 * own today rather than UTC's: a shop in Phnom Penh opening this form at 9am
 * on the 11th used to be handed the 10th, because UTC had not caught up yet.
 */
export function initialDiscountFormState(
  today = new Date(),
  maxDays: number | null = null,
  defaults: DiscountDefaults = {},
): DiscountFormState {
  const timeZone = defaults.timeZone ?? DEFAULT_TIME_ZONE;
  const startDate = isoDateInZone(today, timeZone);

  return {
    method: "code",
    code: "",
    title: "",
    scope: defaults.scope ?? DEFAULT_CAP_SCOPE,
    appliesTo: "all",
    collections: [],
    products: [],
    checkoutNote: defaults.checkoutNote ?? DEFAULT_CHECKOUT_NOTE,
    percentage: "15",
    capAmount: "",
    minimumKind: "none",
    minSubtotal: "",
    minQuantity: "",
    currencyCaps: [],
    usageLimitOn: false,
    usageLimit: "",
    oncePerCustomer: defaults.oncePerCustomer ?? true,
    combinesProduct: defaults.combinesProduct ?? false,
    combinesOrder: defaults.combinesOrder ?? false,
    combinesShipping: defaults.combinesShipping ?? true,
    startDate,
    startTime: "00:00",
    endDateOn: maxDays !== null,
    endDate: maxDays === null ? "" : defaultEndDate(startDate, maxDays),
    endTime: "23:59",
  };
}

/**
 * `2026-09-10` + `09:00`, **as the merchant's own clock reads it** → the UTC
 * instant Shopify stores. Null when either half is unusable.
 *
 * `timeZone` is the shop's, from `ShopSettings`. This is the function the
 * timezone fix of 15 Sep 2026 was really about: it used to append a literal
 * `Z`, so a merchant in Phnom Penh who set a discount to start on 10 Sep at
 * 00:00 got a discount that went live at 07:00 local — seven hours into the
 * day they picked — and an end date of 30 Sep 23:59 that expired at 06:59 on
 * 1 October. Nothing was malformed; the instant was simply not the one the
 * merchant meant.
 *
 * Defaults to UTC, which is exactly what it did before, so a caller that has
 * not been given a zone behaves as it always did rather than picking up the
 * server's.
 */
export function combineDateTime(
  date: string,
  time: string,
  timeZone = DEFAULT_TIME_ZONE,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  if (time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return null;
  }

  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = (time === "" ? "00:00" : time).split(":").map(Number);

  // The regex above admits 2026-02-31. `Date.UTC` rolls it into 3 March rather
  // than refusing, and a start date the merchant never typed is worse than a
  // field error, so the roll-over is detected and refused here.
  const civil = new Date(Date.UTC(year, month - 1, day));
  if (
    civil.getUTCFullYear() !== year ||
    civil.getUTCMonth() !== month - 1 ||
    civil.getUTCDate() !== day
  ) {
    return null;
  }

  const at = zonedTimeToUtc({ year, month, day, hour, minute }, timeZone);

  return Number.isNaN(at.getTime()) ? null : at;
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
export const MIN_SUBTOTAL_INVALID =
  "Enter a minimum amount greater than zero, or choose no minimum.";

export const MIN_QUANTITY_INVALID =
  "Enter a whole number of items greater than zero, or choose no minimum.";

export const PER_MARKET_NOT_ON_PLAN =
  "A different maximum per market currency is part of the Pro plan.";

export const CURRENCY_CAP_INVALID =
  "Give every market a three-letter currency code and an amount greater than zero.";

export const CURRENCY_CAP_DUPLICATE =
  "Each currency can have only one maximum.";

export function currencyCapIsStoreCurrency(code: string): string {
  return `${code} is your store currency, so its maximum is the one above.`;
}

export const NO_COLLECTIONS_CHOSEN = "Choose at least one collection.";
export const NO_PRODUCTS_CHOSEN = "Choose at least one product.";

/**
 * Which entitlement each maximum needs. `order` needs none — it is the
 * maximum every plan is sold on — so it is absent rather than mapped to
 * something permissive.
 */
const SCOPE_CAPABILITY: Record<Exclude<CapScope, "order">, CapabilityKey> = {
  item: "itemMaximums",
  collection: "collectionMaximums",
};

export const SCOPE_NOT_ON_PLAN: Record<Exclude<CapScope, "order">, string> = {
  item: "A separate maximum on each item is part of the Pro plan.",
  collection: "A separate maximum per collection is part of the Pro plan.",
};

/**
 * A maximum per collection with no collections to divide the cart into has no
 * honest reading, and the Function refuses the pairing outright. Said here, on
 * the field the merchant would change, rather than as a saved discount that
 * quietly never discounts.
 */
export const COLLECTION_SCOPE_NEEDS_COLLECTIONS =
  "A maximum per collection needs a discount that applies to chosen collections.";

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
  /**
   * The store's own currency. A per-market row naming it is refused rather
   * than silently dropped: the maximum for that currency is the one the
   * merchant already typed above, and two fields for one number is how they
   * end up disagreeing.
   */
  storeCurrency = "",
  /**
   * The shop's IANA zone. Every date on this form is a wall-clock reading in
   * the merchant's own day, so the validator has to convert with the same zone
   * the form displayed — otherwise "ends before it starts" is decided against
   * an instant the merchant never chose.
   */
  timeZone = DEFAULT_TIME_ZONE,
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

  // The Pro maximums, checked here and nowhere else. The form renders these
  // choices disabled off-plan, so a submission that reaches this branch either
  // came from a stale tab whose plan has since changed or from something that
  // skipped the form altogether — §6 says both are the server's problem.
  const scope: CapScope = isCapScope(state.scope) ? state.scope : DEFAULT_CAP_SCOPE;
  if (scope !== "order") {
    if (!can(plan, SCOPE_CAPABILITY[scope])) {
      errors.scope = SCOPE_NOT_ON_PLAN[scope];
    } else if (scope === "collection" && appliesTo !== "collections") {
      errors.scope = COLLECTION_SCOPE_NEEDS_COLLECTIONS;
    }
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

  // One minimum or none, never both: the merchant picked which kind, and the
  // other field is not read at all rather than quietly carried along.
  const minimumKind: MinimumKind = isMinimumKind(state.minimumKind)
    ? state.minimumKind
    : "none";

  let minSubtotalMinor: number | null = null;
  if (minimumKind === "subtotal") {
    minSubtotalMinor = parseDecimalToMinor(state.minSubtotal);
    if (minSubtotalMinor === null || minSubtotalMinor < 1) {
      errors.minSubtotal = MIN_SUBTOTAL_INVALID;
      minSubtotalMinor = null;
    }
  }

  let minQuantity: number | null = null;
  if (minimumKind === "quantity") {
    const raw = state.minQuantity.trim();
    const parsed = Number(raw);
    if (raw === "" || !/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1) {
      errors.minQuantity = MIN_QUANTITY_INVALID;
    } else {
      minQuantity = parsed;
    }
  }

  const capsByCurrency = readCurrencyCaps(state, plan, storeCurrency, errors);

  const startsAt = combineDateTime(state.startDate, state.startTime, timeZone);
  if (startsAt === null) {
    errors.startDate = "Enter a start date and a time as HH:MM.";
  }

  const maxDays = maxCampaignDays(plan);

  let endsAt: Date | null = null;
  if (state.endDateOn) {
    endsAt = combineDateTime(state.endDate, state.endTime, timeZone);
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
      scope,
      appliesTo,
      collectionIds,
      productIds,
      checkoutNote,
      percentage,
      capMinor: capMinor as number,
      minSubtotalMinor,
      minQuantity,
      capsByCurrency,
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
    scope: isCapScope(form.get("scope")) ? (form.get("scope") as CapScope) : DEFAULT_CAP_SCOPE,
    appliesTo: isAppliesTo(form.get("appliesTo")) ? (form.get("appliesTo") as AppliesTo) : "all",
    collections: resources(form.get("collections")),
    products: resources(form.get("products")),
    checkoutNote: text("checkoutNote"),
    percentage: text("percentage"),
    capAmount: text("capAmount"),
    minimumKind: isMinimumKind(form.get("minimumKind"))
      ? (form.get("minimumKind") as MinimumKind)
      : "none",
    minSubtotal: text("minSubtotal"),
    minQuantity: text("minQuantity"),
    currencyCaps: currencyCaps(form.get("currencyCaps")),
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

/**
 * The per-market maximums, checked against the plan and against each other.
 *
 * Pro-only, and enforced here rather than in the form: §6 says the server
 * revalidates instead of trusting that the UI disabled anything.
 */
function readCurrencyCaps(
  state: DiscountFormState,
  plan: string,
  storeCurrency: string,
  errors: DiscountFieldErrors,
): Record<string, number> {
  const rows = (state.currencyCaps ?? []).filter(
    (row) => (row?.currencyCode ?? "").trim() !== "" || (row?.amount ?? "").trim() !== "",
  );

  if (rows.length === 0) {
    return {};
  }

  if (!can(plan, "perMarketCurrency")) {
    errors.currencyCaps = PER_MARKET_NOT_ON_PLAN;
    return {};
  }

  const caps: Record<string, number> = {};
  const store = storeCurrency.trim().toUpperCase();

  for (const row of rows) {
    const code = (row.currencyCode ?? "").trim().toUpperCase();
    const minor = parseDecimalToMinor(row.amount ?? "");

    if (!/^[A-Z]{3}$/.test(code) || minor === null || minor < 1) {
      errors.currencyCaps = CURRENCY_CAP_INVALID;
      return {};
    }

    if (store !== "" && code === store) {
      errors.currencyCaps = currencyCapIsStoreCurrency(code);
      return {};
    }

    if (caps[code] !== undefined) {
      errors.currencyCaps = CURRENCY_CAP_DUPLICATE;
      return {};
    }

    caps[code] = minor;
  }

  return caps;
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
 * The per-market maximums, as the form posts them: one JSON field, for the
 * same reason the picked resources are one — a row is a pair, and FormData
 * has no way to keep a pair together without inventing a delimiter.
 */
function currencyCaps(value: FormDataEntryValue | null): CurrencyCap[] {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry): CurrencyCap[] => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const { currencyCode, amount } = entry as {
        currencyCode?: unknown;
        amount?: unknown;
      };

      return [
        {
          currencyCode: typeof currencyCode === "string" ? currencyCode : "",
          amount: typeof amount === "string" ? amount : "",
        },
      ];
    });
  } catch {
    return [];
  }
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
