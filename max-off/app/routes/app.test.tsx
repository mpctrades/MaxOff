import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function TestACartPage() {
  return (
    <s-page heading="Test a cart">
      <s-section heading="Test a cart">
        <s-paragraph>Enter a cart subtotal and see what the cap does to the discount. Built in week 5.</s-paragraph>
      </s-section>
    </s-page>
  );
}
