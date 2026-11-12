# Listings view service (Axum)

A small, **standalone, read-only** Rust/Axum service that serves sample
marketplace listings. It is **not integrated** with the main Node backend, the
database, the frontend or the mobile app: nothing calls it and it calls nothing.
All data is the fixed sample set in `src/data.rs`.

## Run

```sh
cd backend/axum
cargo run            # listens on http://127.0.0.1:4100
AXUM_PORT=5000 cargo run
```

## Endpoints (GET only)

| Path | What it returns |
| --- | --- |
| `/health` | `{ "status": "ok", "mode": "view-only" }` |
| `/api/listings` | A page of live listings: `{ items, next_cursor, total }` |
| `/api/listings/summary` | Live totals: buy requests, sell offers, verified sellers |
| `/api/listings/:id` | One listing by id or reference (e.g. `LST-1001`) |
| `/api/categories` | Each category with its live listing count |

`/api/listings` query parameters:

- `intent` — `buy` or `sell`
- `category` — category slug, e.g. `coffee`, `oil-seeds`
- `search` — words matched against product, description, region, grade, owner and reference
- `sort` — `newest` (default), `oldest`, `price-asc`, `price-desc`, `popular`
- `include_closed` — `true` to include closed listings (live only by default)
- `verified_only`, `min_price`, `max_price`
- `limit` (1–50, default 12) and `cursor` (from `next_cursor`)

Each listing also carries display fields: `category_label`, `price_display`
(e.g. `USD 4,250.00` or `Price on request`), `image` (its own image or the
category's stand-in) with `image_is_fallback`, and `posted_on`.

Errors are JSON: `{ "error": "not_found" | "bad_request", "message": "..." }`.

## Layout

```
src/
  main.rs            server setup and shared state
  data.rs            sample listings
  models.rs          Listing, ListingView, summary types
  error.rs           JSON error responses
  routes/            GET handlers
  helpers/
    filter.rs        query parsing, filtering, sorting
    format.rs        price, category, image and date formatting
    pagination.rs    limit/cursor handling and paging
```
