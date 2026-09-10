import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function CreateCappedDiscountPage() {
  return (
    <s-page heading="Create capped discount">
      <s-section heading="Create capped discount">
        <s-paragraph>The create form writes the cap to the discount Function. Built in week 3.</s-paragraph>
      </s-section>
    </s-page>
  );
}
