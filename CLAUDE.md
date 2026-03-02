# Tuluminati VAPI Voice Agent

## Project
- Client: Tuluminati Real Estate (tuluminatirealestate.com)
- Type: VAPI voice agent + landing page
- Deploy: Cloudflare Pages → tuluminati-vapi.pages.dev
- Pattern: Single-file HTML, no build step

## Deploy
```bash
wrangler pages deploy . --project-name=tuluminati-vapi
```

## VAPI
- Public Key: REPLACE_WITH_VAPI_PUBLIC_KEY
- Assistant ID: REPLACE_WITH_ASSISTANT_ID
- Never commit the VAPI private/secret key
