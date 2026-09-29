# Prompt: final polish before App Store submission

Run this in Claude Code on the Mac, opened in `~/Desktop/MaxOff/max-off`.

---

Read `CLAUDE.md` first. Its rules apply here, especially: Polaris web components only, check every tag against shopify-dev-mcp, no new scopes, don't touch `extensions/max-off-cap`, and never write "break-even" in merchant copy (say "Cap starts above").

Do the tasks in order. After each one, run `npm run typecheck`, `npm run lint` and `npm test`. Don't commit until I say so.

## Task 1: Don't swallow re-authentication in read helpers

Several read helpers in `app/models/` wrap `admin.graphql` in a bare `catch {}`, including `readCapConfigJson`, `isCodeTaken`, `readDiscountDetail`, `restampRounding`, and the reads in `plan.server.ts` and `settings.server.ts`. That also catches the `Response` App Bridge throws to re-authenticate, so an expired session shows "could not reach Shopify" instead of signing the merchant back in.

- Add one shared helper, `rethrowIfResponse(error)`, and call it first in every such catch.
- Keep the existing fallback for all other errors.
- Add tests showing that a read helper rethrows a `Response` and still returns its fallback for a normal `Error`.

## Task 2: Find the slow first load (6.2 seconds last measured)

Find the cause before changing anything. Report what you find before you fix it.

- Check the Dockerfile and `docker-start`. Does every container start run `prisma migrate deploy`? Does the container idle or restart?
- Time the loaders for `/app` (Home) and `app.tsx`. List every Admin API call and database query on first load, in order, and flag any that run one after another but could run in parallel (`Promise.all`).
- Check the size of the client bundle for the first screen (`npm run build`).
- Propose the smallest fixes, ranked by expected gain. Apply only the code-side ones that don't change behaviour. Say which ones need server or VPS changes, and don't make those.

## Task 3: Walk through the app as a reviewer would

Go through every screen as a reviewer would, with no data first and then with data: Home, Capped discounts, Create, Detail, Edit, Test a cart, Settings, Plans & billing. For each screen, check:

- It loads with no discounts (a fresh install) and shows a helpful empty state with a clear next step.
- No button goes nowhere, and no link points at a route that doesn't exist.
- No copy promises a feature that isn't built. Check `app/lib/plans.ts` for `built:false` features: nothing unbuilt may be sold as available on Plans & billing.
- Every form shows a field error for bad input (0%, over 100%, a negative cap, a duplicate code) instead of failing silently.
- Loading states exist for slow actions, and buttons can't be double-submitted.

Report the problems as a list. Fix the small ones. Show me any merchant-facing copy changes before applying them.

## Task 4: Write the submission text for me to review (don't submit anything)

Create `docs/SUBMISSION-KIT.md` with:

1. **Test instructions for reviewers:** the dev store (`maxoff-s7fqtwdd.myshopify.com`), how to create a capped discount (for example 15% off, cap 150), how to see it applied at checkout (a 1,400 cart gets 150 off, a 700 cart gets 105 off), and how to reach Plans & billing.
2. **Listing copy draft:** the app name, a tagline of up to 62 characters, an intro of up to 100 characters, a details paragraph, and 3 to 5 feature bullets. Only claim built features. The prices must match `app/lib/plans.ts` (Free, Growth $4.99, Pro $7.99, and 3 / 20 / unlimited active capped discounts).
3. **Screencast script:** what to show, in order, in under 3 minutes (install, create, checkout result, pause, billing page).
4. **Checklist of things only I can do:** create the three App Pricing plans in the Partner Dashboard, named exactly `Free`, `Growth` and `Pro`; confirm the distribution is Public; run the billing test (upgrade, downgrade, uninstall, reinstall); add the privacy policy URL and the support email `team@mpctrades.com`; add the app icon and screenshots; decide between the `dev.` domain and `app.maxoff.mpctrades.com`.

## Task 5: Marketing site prices (`../maxoff-website/`)

The site still shows old prices and plan limits. Update it to match `app/lib/plans.ts`: Pro is $7.99, and the plans allow 3 / 20 / unlimited active capped discounts, with Free capped at 15 days per discount. Also fix the compare row "Under 5 a month", which is true for Growth only. Show me the diff before saving.

## Out of scope

Don't do any of these:

- Change anything in the Partner Dashboard, the app distribution or billing plans.
- Add `read_orders` or the `orders/paid` subscription.
- Change `application_url` or `redirect_urls`.
- Deploy to the VPS.
- Submit the app.

## Report back with

- What each task changed, with the real output of typecheck, lint and test.
- The slow-first-load findings and which fixes still need server work.
- The walkthrough problems you didn't fix.
- Copy changes that are waiting for my sign-off.
