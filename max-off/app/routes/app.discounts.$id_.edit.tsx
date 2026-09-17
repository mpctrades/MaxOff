import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { editCappedDiscount, readDiscountDetail } from "../models/discounts.server";
import { ensureShopSettings } from "../models/settings.server";
import { getPlanSummary } from "../models/plan.server";
import { BrandButton } from "../components/BrandButton";
import {
  capAmountToMinor,
  CHECKOUT_NOTE_MAX_LENGTH,
  DEFAULT_CHECKOUT_NOTE,
  parseCapConfig,
} from "../lib/cap-config";
import { validateEdit } from "../lib/discount-edit";
import type { EditFieldErrors, EditFormState } from "../lib/discount-edit";
import { hasNow, maxCampaignDays, PLAN_LABELS } from "../lib/plans";
import { toTimeZone } from "../lib/timezone";
import { formatMoney, formatPercent } from "../lib/format";

/**
 * Editing a live discount — the three fields that cannot change what a cart
 * already in checkout is charged.
 *
 * Which three, and why the rest are locked, is argued in
 * `app/lib/discount-edit.ts`. The screen states the locked rule back to the
 * merchant rather than hiding it, because "why can I not change the maximum"
 * is the first question this page invites.
 */
export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const found = await readDiscountDetail({
    shop: session.shop,
    id: params.id ?? "",
    admin,
  });

  if (found === null) {
    throw new Response("Not found", { status: 404 });
  }

  const read = parseCapConfig(found.config);

  // Same rule as the detail screen: without a config we can read, this page
  // would be editing something it cannot describe. Send them back rather than
  // show a form over an unknown discount.
  if (!read.ok) {
    throw new Response("Cannot read this discount's settings", { status: 409 });
  }

  const { row, live } = found;
  const settings = await ensureShopSettings(session.shop);
  const plan = await getPlanSummary({ shop: session.shop, admin });
  const timeZone = toTimeZone(settings.timezone);

  const endsAt = live?.endsAt ?? row.endsAt?.toISOString() ?? null;
  const parts = endsAt === null ? null : splitInZone(new Date(endsAt), timeZone);

  return {
    id: row.id,
    name: row.code ?? row.title ?? "Capped discount",
    method: row.method === "automatic" ? ("automatic" as const) : ("code" as const),
    percentage: read.config.percentage,
    capMinor: capAmountToMinor(read.config.capAmount) as number,
    currencyCode: read.config.currencyCode,
    startsAt: (live?.startsAt ?? row.startsAt.toISOString()) as string,
    timeZone,
    timesUsed: live?.asyncUsageCount ?? null,
    plan: plan.plan,
    planLabel: plan.plan === null ? null : PLAN_LABELS[plan.plan],
    maxCampaignDays: plan.plan === null ? null : maxCampaignDays(plan.plan),
    canSetUsageLimit: plan.plan !== null && hasNow(plan.plan, "usageLimits"),
    canSetCheckoutNote: plan.plan !== null && hasNow(plan.plan, "customCheckoutWording"),
    state: {
      endDate: parts?.date ?? "",
      endTime: parts?.time ?? "",
      usageLimit:
        live?.usageLimit != null
          ? String(live.usageLimit)
          : row.usageLimit != null
            ? String(row.usageLimit)
            : "",
      checkoutNote:
        read.config.checkoutNote === DEFAULT_CHECKOUT_NOTE
          ? ""
          : read.config.checkoutNote,
    } satisfies EditFormState,
  };
};

/** A date and a time as the form's two fields see them, on the shop's clock. */
function splitInZone(date: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
  };
}

interface EditActionData {
  ok: boolean;
  errors: EditFieldErrors;
  message: string | null;
}

export const action = async ({ params, request }: ActionFunctionArgs): Promise<EditActionData> => {
  const { admin, session } = await authenticate.admin(request);

  const found = await readDiscountDetail({
    shop: session.shop,
    id: params.id ?? "",
    admin,
  });

  if (found === null) {
    return { ok: false, errors: {}, message: "That discount is no longer in MaxOff." };
  }

  const form = await request.formData();
  const settings = await ensureShopSettings(session.shop);
  const plan = await getPlanSummary({ shop: session.shop, admin });

  if (plan.plan === null) {
    // The gate direction the rest of the app uses: we could not read the plan,
    // so we do not guess at what it entitles.
    return {
      ok: false,
      errors: {},
      message:
        "We could not read your plan just now, so nothing was changed. Try again in a moment.",
    };
  }

  const state: EditFormState = {
    endDate: String(form.get("endDate") ?? ""),
    endTime: String(form.get("endTime") ?? ""),
    usageLimit: String(form.get("usageLimit") ?? ""),
    checkoutNote: String(form.get("checkoutNote") ?? ""),
  };

  const result = validateEdit(state, {
    startsAt: new Date(found.live?.startsAt ?? found.row.startsAt),
    timesUsed: found.live?.asyncUsageCount ?? null,
    method: found.row.method === "automatic" ? "automatic" : "code",
    plan: plan.plan,
    timeZone: toTimeZone(settings.timezone),
  });

  if (!result.ok) {
    return { ok: false, errors: result.errors, message: null };
  }

  const saved = await editCappedDiscount({
    shop: session.shop,
    id: params.id ?? "",
    endsAt: result.value.endsAt,
    usageLimit: result.value.usageLimit,
    checkoutNote: result.value.checkoutNote,
    admin,
  });

  if (!saved.ok) {
    return { ok: false, errors: {}, message: saved.message };
  }

  /* Back to the discount, not back to the form. A merchant who has saved is
     done with the form, and leaving them on it invites a second save of the
     same thing. `?updated=1` is what tells the detail page to say so —
     `throw`, not `return`, because a redirect is not this action's data.

     Only on success: a validation failure returns above, so the form keeps
     its errors and the values that caused them. */
  throw redirect(`/app/discounts/${params.id}?updated=1`);
};

export default function EditCappedDiscountPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<EditFormState>(data.state);

  const saving = navigation.state !== "idle";
  const errors = actionData?.errors ?? {};

  useEffect(() => {
    if (!actionData || saving) {
      return;
    }

    if (actionData.message === null) {
      return;
    }

    shopify.toast.show(actionData.message, { isError: !actionData.ok });
  }, [actionData, saving, shopify]);

  const money = (minor: number) => formatMoney(minor, data.currencyCode);
  const set = (field: keyof EditFormState) => (value: string) =>
    setState((current) => ({ ...current, [field]: value }));

  return (
    <s-page heading={`Edit ${data.name}`}>
      <s-link slot="breadcrumb-actions" href={`/app/discounts/${data.id}`}>
        {data.name}
      </s-link>

      {/* `s-page` spaces the `s-section`s it owns, but these are inside the
          form, so they are grandchildren and that spacing never reached them —
          the cards sat flush against each other. The form does the spacing
          itself instead. */}
      <Form method="post" className="maxoff-edit-form">
        {/* The locked rule, said once and up front. A merchant who came here
            to change the maximum needs to know that in the first sentence,
            not after filling the form in. */}
        <s-banner tone="info" heading="The rule itself cannot be changed">
          {formatPercent(data.percentage)} off, never more than{" "}
          {money(data.capMinor)}. A cart may be in checkout with this discount
          on it right now, so changing the percentage or the maximum would
          change what that customer pays part-way through paying. Duplicate it
          to run a different rule.
        </s-banner>

        <s-section heading="Active dates">
          <s-stack direction="block" gap="base">
            <s-grid
              gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr 1fr"
              gap="base"
            >
              <s-date-field
                label="End date"
                name="endDate"
                value={state.endDate}
                error={errors.endDate}
                onChange={(event) => set("endDate")(event.currentTarget.value)}
              ></s-date-field>
              <s-text-field
                label="End time"
                name="endTime"
                placeholder="23:59"
                value={state.endTime}
                onChange={(event) => set("endTime")(event.currentTarget.value)}
              ></s-text-field>
            </s-grid>

            <s-text color="subdued">
              Times are on your store&rsquo;s clock ({data.timeZone}).
              {data.maxCampaignDays !== null && data.planLabel !== null
                ? ` The ${data.planLabel} plan runs one discount for up to ${data.maxCampaignDays} days.`
                : " Leave the date blank to run it until you stop it."}
            </s-text>
          </s-stack>
        </s-section>

        {/* Automatic discounts have no usage limit to set — `usageLimit` is
            not a field on DiscountAutomaticAppInput, and the 2026-10 schema
            rejects it. Hidden rather than disabled: there is nothing to
            upgrade to that would make it appear. */}
        {data.method === "code" && (
          <s-section heading="Usage">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Total uses allowed"
                name="usageLimit"
                placeholder="No limit"
                value={state.usageLimit}
                error={errors.usageLimit}
                disabled={!data.canSetUsageLimit}
                onChange={(event) => set("usageLimit")(event.currentTarget.value)}
              ></s-text-field>

              <s-text color="subdued">
                {data.timesUsed === null
                  ? "Leave blank for no limit."
                  : `Used ${data.timesUsed} ${data.timesUsed === 1 ? "time" : "times"} so far. Leave blank for no limit.`}
              </s-text>
            </s-stack>
          </s-section>
        )}

        <s-section heading="What the customer sees">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Checkout wording"
              name="checkoutNote"
              placeholder={DEFAULT_CHECKOUT_NOTE}
              value={state.checkoutNote}
              error={errors.checkoutNote}
              disabled={!data.canSetCheckoutNote}
              maxLength={CHECKOUT_NOTE_MAX_LENGTH}
              onChange={(event) => set("checkoutNote")(event.currentTarget.value)}
            ></s-text-field>

            <s-text color="subdued">
              Shown at checkout only when the maximum is what decided the
              amount. Leave blank to use &ldquo;{DEFAULT_CHECKOUT_NOTE}&rdquo;.
            </s-text>
          </s-stack>
        </s-section>

        <s-section>
          <s-stack direction="inline" gap="base" alignItems="center">
            {/* The MaxOff button, so Save wears the same orange as every
                other primary action in the app rather than Polaris' bevelled
                near-black. `BrandButton` has no loading state, so the label
                carries it and the button refuses a second submit. Cancel
                matches it in shape and size for the same reason the two
                always travel together. */}
            <BrandButton type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </BrandButton>
            <BrandButton
              variant="secondary"
              href={`/app/discounts/${data.id}`}
            >
              Cancel
            </BrandButton>
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
