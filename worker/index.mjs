const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        app: "343SHOP",
        orderFlow: "whatsapp",
        note: "worker-amazon-skin-v2",
        skin: "amazon"
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({
        error: "temporarily_unavailable",
        message: "Full API restoring. Static storefront is available."
      }, 503);
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(key, value);
    }
    headers.set("X-Robots-Tag", "index, follow");
    headers.set("Cache-Control", "no-store");

    const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
    const path = url.pathname;
    const isHtml =
      contentType.includes("text/html") ||
      path === "/" ||
      path.endsWith(".html") ||
      path === "";

    if (isHtml && response.status === 200) {
      return new HTMLRewriter()
        .on("head", {
          element(element) {
            element.append(
              '<link rel="stylesheet" href="/amazon-skin.css?v=2">',
              { html: true }
            );
            element.append(
              '<meta name="theme-color" content="#131921">',
              { html: true }
            );
          }
        })
        .transform(
          new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers
          })
        );
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
