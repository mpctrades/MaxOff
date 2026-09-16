import { redirect } from "react-router";

/**
 * `/auth/login` exists only to send people away from it.
 *
 * The template put a "Shop domain" form here. App Store requirement 2.3.1
 * forbids asking a merchant to type their myshopify.com address, so the form
 * and the `login` export behind it were removed on 16 Sep 2026.
 *
 * Without this file the path falls through to `auth.$.tsx`, whose loader calls
 * `authenticate.admin` — with no `shop` parameter that throws, and the route
 * answers a public GET with a 500. A redirect to the landing page is the quiet
 * answer: nothing to fill in, nothing broken, and no dead end for anyone who
 * still has the old URL in their history.
 *
 * This deliberately does not shadow `/auth/callback` or any other `/auth/*`
 * path — those still belong to `auth.$.tsx` and the OAuth flow.
 */
export const loader = async () => {
  throw redirect("/");
};
