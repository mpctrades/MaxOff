import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

/**
 * The one screen that is not inside the Shopify admin.
 *
 * A merchant reaches it by typing the app's own URL, and a Shopify reviewer
 * reaches it before they have installed anything — so it says what MaxOff is
 * and then gets out of the way of the log-in field. It is the only route with
 * no App Bridge and no Polaris, which is why it carries its own stylesheet.
 *
 * The copy is BUILD-SPEC §11's locked wording, not a second version of it:
 * "Percentage discounts that stop at a maximum amount", "Cap starts above",
 * and "MaxOff adds nothing to your theme".
 */
export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.brand}>
          <img
            className={styles.logo}
            src="/maxoff-logo.png"
            alt=""
            width={36}
            height={36}
          />
          <span className={styles.wordmark}>MaxOff</span>
        </div>

        <h1 className={styles.heading}>
          Percentage discounts that{" "}
          <span className={styles.accent}>stop at a maximum amount.</span>
        </h1>

        <p className={styles.tagline}>
          Run 15% off without handing 300.00 to the one customer who fills
          their basket. You set the percentage and the most you will ever give
          away.
        </p>

        <div className={styles.panels}>
          {showForm && (
            <Form className={styles.card} method="post" action="/auth/login">
              <label className={styles.label} htmlFor="shop">
                Shop domain
              </label>

              <div className={styles.field}>
                <input
                  id="shop"
                  className={styles.input}
                  type="text"
                  name="shop"
                  placeholder="my-shop-domain.myshopify.com"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button className={styles.button} type="submit">
                  Log in
                </button>
              </div>

              <span className={styles.hint}>
                e.g. my-shop-domain.myshopify.com
              </span>
            </Form>
          )}

          {/* The same figure the create screen puts in front of a merchant,
              with real numbers, so the product is legible before install. */}
          <div className={styles.example}>
            <p className={styles.exampleRule}>15% off, maximum 150.00 USD</p>
            <p className={styles.exampleLabel}>Cap starts above</p>
            <p className={styles.exampleValue}>1,000.00 USD</p>
            <p className={styles.exampleWorking}>
              <span aria-hidden="true">150.00 ÷ 15% = 1,000.00</span>
              <span className={styles.srOnly}>
                150.00 divided by 15 percent equals 1,000.00
              </span>
            </p>
          </div>
        </div>

        <ul className={styles.list}>
          <li className={styles.point}>
            <h2 className={styles.pointTitle}>One maximum, set by you</h2>
            <p className={styles.pointText}>
              Choose the percentage and the maximum discount. MaxOff shows you
              where the maximum starts working before you save.
            </p>
          </li>
          <li className={styles.point}>
            <h2 className={styles.pointTitle}>Applied in Shopify&rsquo;s checkout</h2>
            <p className={styles.pointText}>
              The maximum is worked out by Shopify&rsquo;s own discount engine,
              so the amount a buyer sees is the amount you set.
            </p>
          </li>
          <li className={styles.point}>
            <h2 className={styles.pointTitle}>Nothing in your storefront</h2>
            <p className={styles.pointText}>
              MaxOff adds nothing to your theme. There is no script to install
              and no snippet to remove.
            </p>
          </li>
        </ul>
      </div>
    </main>
  );
}
