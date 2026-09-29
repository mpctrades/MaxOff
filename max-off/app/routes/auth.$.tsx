import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { rethrowIfResponse } from "../lib/rethrow-if-response";

/**
 * Shopify's OAuth and App Bridge paths. `authenticate.admin` answers all of
 * them by throwing a `Response`, which goes straight back out.
 *
 * `/auth/exit-iframe` with no `exitIframe` target is the one exception: the
 * library throws "Invalid URL. Refusing to redirect". This route has no
 * component, so React Router treats it as a resource route and no error
 * boundary can catch that — it would be a bare "Unexpected Server Error" 500.
 * Shopify never sends that request itself, so the landing page is the quiet
 * answer. Every other path keeps the library's own behaviour.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    await authenticate.admin(request);
  } catch (error) {
    rethrowIfResponse(error);

    if (new URL(request.url).pathname === "/auth/exit-iframe") {
      throw redirect("/");
    }

    throw error;
  }

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
