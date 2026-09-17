/**
 * Liveness for the container, and nothing else.
 *
 * Docker's healthcheck needs a URL it can reach with no Shopify session, so
 * this route deliberately never calls `authenticate.admin`. It is also the one
 * route that must stay cheap: it runs every few seconds for the life of the
 * container, so it touches no database and reads nothing from the request.
 *
 * It answers "is this process accepting HTTP" — which is exactly the question
 * nginx is asking when it returns 502 during a deploy. It is not a readiness
 * check for the database; Postgres has its own `pg_isready` healthcheck and
 * the app already waits on it through `depends_on: service_healthy`.
 *
 * Nothing about the shop, the session or the build is disclosed. A public
 * endpoint on a Shopify app should give an unauthenticated caller no facts,
 * and "ok" is the whole of it.
 */
export const loader = async () => {
  return new Response("ok", {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Never let a proxy or a browser answer this from cache — a cached 200
      // would report a container healthy after it had stopped being so.
      "cache-control": "no-store",
    },
  });
};
