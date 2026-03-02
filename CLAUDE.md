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
- Public Key: 6be78882-1a54-4682-902f-2990ad69b5ed
- Assistant ID: 9459ad7b-286c-446e-bb4a-70032f5e6d93
- Private Key: vaulted at $VS/configs/credentials/vapi/private-key
- Never commit the VAPI private/secret key
