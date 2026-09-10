import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function AnalyticsPage() {
  return (
    <s-page heading="Analytics">
      <s-section heading="Analytics">
        <s-paragraph>Money kept, orders capped and the biggest single save. Built in week 5.</s-paragraph>
      </s-section>
    </s-page>
  );
}
