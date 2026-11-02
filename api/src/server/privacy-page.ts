/**
 * Static privacy statement served at GET /privacy. It is public: no shared-key auth, no client or daily model limits.
 * The text is fixed content with no request-derived values.
 */
export const PRIVACY_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TrueBuild Privacy</title>
</head>
<body>
<main>
<h1>TrueBuild Privacy</h1>
<p>Dated 2 November 2026.</p>
<ul>
<li>Manual pages and photos from the app are sent to our server.</li>
<li>Meta's AI models process them to create guides and checks.</li>
<li>Meta's own terms govern how Meta processes and retains them. TrueBuild cannot control how long Meta keeps them.</li>
<li>TrueBuild holds manual pages and photos in server memory only for session processing. Uploads are not saved to server disk.</li>
<li>Temporary session data can remain in server memory after requests finish and is removed as caches are cleared or replaced, or when the server restarts. Closing the app does not immediately clear server caches.</li>
<li>TrueBuild does not sell this data or use it for ads.</li>
<li>No accounts and no advertising or analytics tracking. Temporary IP-based usage counters help prevent abuse.</li>
</ul>
<p>Contact: pmusole2@gmail.com</p>
</main>
</body>
</html>
`
