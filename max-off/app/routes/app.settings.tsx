import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function SettingsPage() {
  return (
    <s-page heading="Settings">
      <s-section heading="Settings">
        <s-paragraph>Store-wide MaxOff settings. Built in week 6.</s-paragraph>
      </s-section>
    </s-page>
  );
}
