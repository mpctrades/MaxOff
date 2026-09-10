import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function CappedDiscountDetailPage() {
  return (
    <s-page heading="Capped discount">
      <s-section heading="Capped discount">
        <s-paragraph>Detail for one capped discount, reached from a row in the list. Built in week 4.</s-paragraph>
      </s-section>
    </s-page>
  );
}
