import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Shopify deletes an app's discounts when the app is uninstalled — its own
  // uninstall dialog says so, and on 29 Sep 2026 a test store's capped
  // discount was gone from the Discounts page seconds later. Our mirror rows
  // described discounts that no longer exist, and a reinstall inside the
  // 48 hours before `shop/redact` showed them as live, counted against the
  // plan's limit. They go now. Run regardless of the session check above:
  // it is idempotent, so a retried webhook deletes nothing twice. Their
  // CapEvents go with them (onDelete: Cascade). ShopSettings stays until
  // `shop/redact`, so a quick reinstall keeps the merchant's preferences.
  await db.cappedDiscount.deleteMany({ where: { shop } });

  return new Response();
};
