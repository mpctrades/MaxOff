import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function CappedDiscountsPage() {
  return (
    <s-page heading="Capped discounts">
      <s-section heading="Capped discounts">
        <s-paragraph>Your capped discounts will be listed here. Built in week 3.</s-paragraph>
      </s-section>
    </s-page>
  );
}
