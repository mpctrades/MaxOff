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

export function initialDiscountFormState(today = new Date()): DiscountFormState {
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
    startDate: today.toISOString().slice(0, 10),
    startTime: "00:00",
    endDateOn: false,
    endDate: "",
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

/**
 * The rules from §4.3: percentage a whole 1-100, maximum above zero, end after
 * start, code present. Field-level messages, because §4.3 wants the error on
 * the field and not in a banner.
 */
export function validateDiscountForm(
  state: DiscountFormState,
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

  let endsAt: Date | null = null;
  if (state.endDateOn) {
    endsAt = combineDateTime(state.endDate, state.endTime);
    if (endsAt === null) {
      errors.endDate = "Enter an end date, or turn the end date off.";
    } else if (startsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
      errors.endDate = "The end date must be after the start date.";
    }
  }

  let usageLimit: number | null = null;
  if (state.usageLimitOn) {
    const raw = state.usageLimit.trim();
    const parsed = Number(raw);
    if (raw === "" || !/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1) {
      errors.usageLimit = "Enter a whole number of uses, or turn the limit off.";
    } else {
      usageLimit = parsed;
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
