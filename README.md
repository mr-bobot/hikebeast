# Swiss Hidden Gems — Landing Page

Single-page mobile landing page for the Swiss Hidden Gems guide by Hikebeast.

Two CTAs:
- **Full guide** ($49) — links to [Whop product page](https://whop.com/gorped/hidden-gems-switzerland-e8/)
- **Free sample** — email signup (two-step reveal)

## Run locally

Open `index.html` directly, or serve it:

```bash
python3 -m http.server 8000
```

## Email form

The free-sample form POSTs to a placeholder Formspree endpoint. Replace
`REPLACE_ME` in `index.html` with your own Formspree form ID (or swap the
`action` URL for ConvertKit / Mailchimp / Resend / your own endpoint).

## Files

- `index.html` — the entire page (HTML + CSS + JS inline)
- `images/1.jpg` – `images/6.jpg` — product carousel images
