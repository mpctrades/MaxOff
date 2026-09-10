import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function PlansAndBillingPage() {
  return (
    <s-page heading="Plans & billing">
      <s-section heading="Plans & billing">
        <s-paragraph>Free, Growth and Pro plans. Built in week 7.</s-paragraph>
      </s-section>
    </s-page>
  );
}
