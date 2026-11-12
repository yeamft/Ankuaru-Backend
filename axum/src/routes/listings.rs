//! Listing handlers: list with filters, one listing, category counts, summary.

use axum::{
    extract::{Path, Query, State},
    Json,
};

use crate::{
    error::AppError,
    helpers::{
        filter::{filter_and_sort, ListingQuery},
        format::{category_label, to_view, CATEGORIES},
        pagination::{clamp_limit, decode_cursor, paginate, Page},
    },
    models::{CategoryCount, Intent, ListingView, Summary},
    AppState,
};

/// `GET /api/listings` — live listings by default; see `ListingQuery` for filters.
pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<ListingQuery>,
) -> Result<Json<Page<ListingView>>, AppError> {
    let limit = clamp_limit(query.limit);
    let offset = decode_cursor(query.cursor.as_deref())?;
    let rows = filter_and_sort(&state.listings, &query)?;
    let views = rows.into_iter().map(to_view).collect();
    Ok(Json(paginate(views, offset, limit)))
}

/// `GET /api/listings/:id` — matched by id or by reference (e.g. "LST-1001").
pub async fn detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ListingView>, AppError> {
    state
        .listings
        .iter()
        .find(|l| l.id == id || l.reference.eq_ignore_ascii_case(&id))
        .map(|l| Json(to_view(l)))
        .ok_or(AppError::NotFound("listing"))
}

/// `GET /api/categories` — every known category with its live listing count.
pub async fn categories(State(state): State<AppState>) -> Json<Vec<CategoryCount>> {
    let mut counts: Vec<CategoryCount> = CATEGORIES
        .iter()
        .map(|(slug, _, _)| CategoryCount {
            slug: (*slug).to_string(),
            label: category_label(slug),
            live: state
                .listings
                .iter()
                .filter(|l| l.status.is_live() && l.category == *slug)
                .count(),
        })
        .collect();
    counts.sort_by(|a, b| b.live.cmp(&a.live).then_with(|| a.label.cmp(&b.label)));
    Json(counts)
}

/// `GET /api/listings/summary` — headline numbers for the live market.
pub async fn summary(State(state): State<AppState>) -> Json<Summary> {
    let live: Vec<_> = state.listings.iter().filter(|l| l.status.is_live()).collect();
    Json(Summary {
        total: state.listings.len(),
        live: live.len(),
        buy_requests: live.iter().filter(|l| l.intent == Intent::Buy).count(),
        sell_offers: live.iter().filter(|l| l.intent == Intent::Sell).count(),
        verified_sellers: live.iter().filter(|l| l.owner_verified).count(),
    })
}
