<div align="center">

# Tuluminati VAPI

**Voice AI agent for luxury real estate in Tulum and the Riviera Maya**

[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)](https://tuluminati-vapi.pages.dev)
[![VAPI](https://img.shields.io/badge/VAPI-Voice_AI-7C3AED)](https://vapi.ai)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Live Demo](https://tuluminati-vapi.pages.dev)

</div>

---

## Overview

Luna is a bilingual (English/Spanish) voice AI concierge for Tuluminati Real Estate. Visitors to the landing page can tap a button and have a real-time voice conversation with Luna about luxury properties, investment opportunities, and living in the Riviera Maya.

Built with VAPI for real-time voice AI and deployed as a single-page static site on Cloudflare Pages, with a Cloudflare Worker backend for server-side function calls.

## Features

- **Real-time voice conversation** -- press to talk with Luna in English or Spanish
- **Property knowledge** -- trained on luxury Tulum/Playa del Carmen/Riviera Maya listings
- **Investment guidance** -- ROI projections, fideicomiso (trust) setup, legal considerations
- **Concierge services** -- relocation advice, visa info, neighborhood recommendations
- **Cloudflare Worker backend** -- handles VAPI server-side function calls
- **Responsive landing page** -- luxury aesthetic with gold/black color scheme
- **Zero build step** -- single HTML file with inline CSS and JavaScript

## Architecture

```
Visitor Browser
      |
      v
Landing Page (Cloudflare Pages)
      |
      v
VAPI Voice SDK (WebSocket)
      |
      +---> VAPI Cloud (speech-to-text, LLM, text-to-speech)
      |
      +---> Cloudflare Worker (server-side function calls)
```

## Quick Start

```bash
# Clone
git clone https://github.com/ExpertVagabond/tuluminati-vapi.git
cd tuluminati-vapi

# Deploy landing page
wrangler pages deploy . --project-name=tuluminati-vapi

# Deploy worker (server-side functions)
cd worker
npm install
wrangler deploy
```

## Project Structure

```
tuluminati-vapi/
  index.html              -- Landing page with VAPI voice widget
  images/                 -- Property and avatar images
  vapi/
    assistant-config.json -- VAPI assistant configuration
    system-prompt.md      -- Luna personality and knowledge base
  worker/
    index.js              -- Cloudflare Worker for server-side calls
    wrangler.toml         -- Worker deployment config
```

## Configuration

The VAPI assistant is configured with:

| Setting | Value |
|---------|-------|
| Voice | ElevenLabs bilingual (English/Spanish) |
| LLM | GPT-4 with custom system prompt |
| Personality | Warm, professional luxury real estate concierge |
| Languages | English, Spanish |
| Deployment | Cloudflare Pages + Workers |

## Links

- **Live site:** [tuluminati-vapi.pages.dev](https://tuluminati-vapi.pages.dev)
- **Client:** [tuluminatirealestate.com](https://tuluminatirealestate.com)
- **Voice AI:** [vapi.ai](https://vapi.ai)

## License

[MIT](LICENSE)
