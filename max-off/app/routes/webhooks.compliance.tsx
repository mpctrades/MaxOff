/**
 * Mandatory Shopify privacy webhooks.
 *
 * `authenticate.webhook` validates the X-Shopify-Hmac-Sha256 signature before
 * returning any of this context. An invalid or missing signature is rejected
 * by Shopify's React Router package before this handler touches the database.
 *
 * MaxOff currently stores no customer record, customer id, email, address, or
 * other customer-linked data. Its local data belongs to a shop, so the two
 * customer topics require no row-level action. `SHOP_REDACT`, sent after an
 * uninstall, removes every row owned by that shop and is deliberately
 * idempotent because Shopify can retry webhook deliveries.
 */

import type { ActionFunctionArgs } from "react-router";

import db from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // There is no customer-linked data in MaxOff to export or redact.
      break;

    case "SHOP_REDACT":
      // Delete children first instead of relying only on a database cascade.
      // This keeps the cleanup explicit and safe across database providers.
      await db.$transaction([
        db.capEvent.deleteMany({ where: { shop } }),
        db.cappedDiscount.deleteMany({ where: { shop } }),
        db.shopSettings.deleteMany({ where: { shop } }),
        db.session.deleteMany({ where: { shop } }),
      ]);
      break;

    default:
      // The URI is declared only for the three topics above. A 200 response
      // avoids pointless retries if Shopify ever delivers an unknown topic to
      // this endpoint, while still making no change.
      break;
  }

  return new Response(null, { status: 200 });
};
