// Vercel Edge Middleware -- gates /full/* behind HTTP Basic Auth.
//
// Set PREVIEW_USER and PREVIEW_PASS in Vercel: Project Settings →
// Environment Variables. Until they are set this middleware returns 503
// for /full/*, so content cannot leak even on a fresh deploy.
//
// Defense in depth (so a single failure doesn't expose anything):
//   1. middleware (this file) -- 401 challenge on every /full/* request
//   2. vercel.json headers    -- X-Robots-Tag noindex on every /full/* response
//   3. robots.txt              -- Disallow: /full/
//   4. per-page <meta robots>  -- already on every generated HTML

export const config = {
  matcher: '/full/:path*',
};

export default function middleware(request) {
  const user = process.env.PREVIEW_USER;
  const pass = process.env.PREVIEW_PASS;

  // Fail closed -- if env vars aren't set, return 503 with no content.
  if (!user || !pass) {
    return new Response('Auth not configured', {
      status: 503,
      headers: {
        'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain',
      },
    });
  }

  const auth = request.headers.get('authorization') || '';
  const expected = 'Basic ' + btoa(`${user}:${pass}`);

  if (auth !== expected) {
    return new Response('Authentication required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Hidden Gems", charset="UTF-8"',
        'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain',
      },
    });
  }
  // Auth OK -- fall through to the static file handler. Response
  // headers are added at the platform level via vercel.json.
}
