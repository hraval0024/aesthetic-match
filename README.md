# APPROACH

## Why this problem?

I enjoy discovering fashion from independent brands, but my shopping process is fragmented and time consuming. My inspiration lives across Instagram, Pinterest, screenshots, and product pages, while my purchases happen across dozens of individual stores. There is no declarative way for me to discover new brands either. 

Today's recommendation systems are largely retailer-specific. They either recommend products from a single catalog or rely on collaborative filtering ("people also bought..."), without understanding my personal aesthetic or the context of what I'm shopping for. I end up scrolling endlessly across multiple brands to find products suiting my style/archetype.

I wanted to build an AI shopping assistant that understands a user's StyleDNA and recommends, a well-curated catalog of products from across brands, personalized both to their style and the occasion they're shopping for.

Rather than replacing existing commerce platforms, I see this as a discovery layer on top of the Shopify ecosystem; helping users discover brands, find the right products across brands while continuing to leverage the existing SHopify features: purchase and track orders under one roof.

---

## What I built

**Live:** https://aesthetic-match-production.up.railway.app

Aesthetic Match builds a persistent StyleDNA from inspiration images and combines it with a temporary shopping intent such as "Summer trip to Italy" or "Beach wedding."

The system classifies both visual and textual inputs into a closed taxonomy, then recommends products from a normalized Shopify catalog using deterministic ranking rather than opaque embedding-based similarity.

The final experience includes:

- Persistent Style DNA
- Natural-language shopping intent
- Occasion-aware recommendations
- Multi-brand Shopify catalog
- Explainable recommendation rationale
- Saved items, category, price and sorting controls
- Session persistence across visits

---

## Key decisions and tradeoffs

### i. Closed taxonomy over free-form tags

Instead of allowing AI to generate arbitrary labels, every product and user profile is normalized into a fixed taxonomy.

This makes recommendations deterministic, explainable, and easier to evolve without taxonomy drift.

### ii. AI for perception, deterministic logic for ranking

LLMs are excellent at understanding images and natural language, but recommendation quality should remain predictable.

AI is responsible for extracting structured attributes from images and shopping intent. Ranking, filtering, diversification, and graceful fallback are all deterministic to ensure real shoppign experience.

### iii. Offline catalog enrichment

Product ingestion and tagging happen offline.

Runtime requests never invoke expensive vision models against the catalog, resulting in significantly lower latency and inference cost.

### iv. No accounts; state lives entirely in the browser

Style DNA and saved items persist via localStorage/IndexedDB, not behind a login.

This was a deliberate choice, not a scoping cut: zero friction to start using the app, at the cost of no cross-device sync. Given this is a discovery layer rather than the system of record for purchases or payment, that tradeoff favors instant usability over account plumbing.

### v. Deployment: a persistent process over serverless

The app runs as a single long-running process on a mounted volume (Railway) rather than as serverless functions.

This was a direct response to a real constraint, not a default: the app has genuine state; a SQLite catalog and an in-memory rate limiter; that serverless's stateless, ephemeral filesystem model doesn't durably support. A persistent process with a real volume lets both work as designed instead of needing workarounds.

### vi. Recommendation composition

A recommendation feed should feel like shopping for outfits primarily.

The recommender balances apparel with complementary products while maintaining StyleDNA relevance and brand diversity across all pages. 

### vii. Graceful fallback

When exact contextual matches are limited, the system relaxes only the temporary shopping context while preserving the user's StyleDNA, ensuring recommendations remain relevant instead of arbitrary at the same time doesn't let user leave empty-handed.

---

## What I intentionally left out

Given the one-day constraint, I deliberately prioritized recommendation quality over platform features.

I chose not to implement:

- User authentication
- Shopping cart
- Checkout
- Social features
- Collaborative recommendations
- Real-time catalog synchronization
- An automated test suite (verification was manual and live — a curated test matrix plus direct API/DB checks — rather than an automated regression suite)

These features improve product completeness but do not improve recommendation quality, which I considered the core differentiator.

---

## What breaks first under pressure

**Single-instance assumptions.** The rate limiter is in-memory and the catalog database is a SQLite file on a mounted volume. Both correct today, both built assuming exactly one running process. Horizontally scaling the service would break both at once: each replica would get its own rate-limit counters (silently under-enforcing the limit), and only one replica could safely own the writable database file.

**Rationale generation latency.** Confirmed under live testing, not hypothetical: generating Claude-written rationale for a 25-item recommendations page routinely takes 3–7 seconds, already exceeding the app's own 3-second internal target. This is the actual bottleneck in the request path today, not the ranking logic itself, which resolves in single-digit milliseconds.

**Catalog freshness.** Because the catalog is enriched offline, inventory changes, new arrivals, and price updates require periodic ingestion and re-tagging rather than happening automatically.

**Scale beyond the current catalog.** As the catalog grows significantly larger, retrieval should move from an in-memory ranking pipeline to indexed retrieval followed by deterministic re-ranking.

**No automated regression coverage.** Because verification is manual, the honest answer to "how do you know it still works after the next change" is "someone re-ran the test matrix" — that doesn't scale past one contributor.

---

## What I'd build next

I would focus on making the assistant more personalized over time rather than simply adding more features.

Specifically:

- Learn from purchases, saves and dismissals to continuously refine StyleDNA progressively.
- Support wardrobes and owned items to recommend complete outfits instead of individual products. 
- Introduce creator- and moodboard-based profile generation from Pinterest, Instagram and TikTok.
- Continuously refresh the Shopify catalog and monitor taxonomy coverage through automated health reports.
- Move off SQLite-on-a-volume to a hosted database (e.g. Postgres) and a shared rate-limit store (e.g. Redis) to remove the single-instance ceiling and support real horizontal scaling.
- Experiment with learning-to-rank models while preserving deterministic business rules and explainability.
- Extend the MIME-spoofing and rate-limiting hardening with a cheap Haiku-based content-relevance check, rejecting non-fashion images/text before they reach the Opus vision call; the next layer of the same cost-abuse surface.

My goal would remain the same: build a shopping assistant that understands a person's style once and helps them confidently discover products across brands for every future shopping occasion.
