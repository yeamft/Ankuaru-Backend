//! Query parameters, filtering and sorting for the listings endpoint.

use std::cmp::Ordering;

use serde::Deserialize;

use crate::{
    error::AppError,
    models::{Intent, Listing},
};

/// `GET /api/listings` query string. Unknown values are rejected with 400.
#[derive(Debug, Default, Deserialize)]
pub struct ListingQuery {
    /// "buy" or "sell".
    pub intent: Option<String>,
    /// Category slug.
    pub category: Option<String>,
    /// Free text over product, description, region, grade and owner.
    pub search: Option<String>,
    /// "newest" (default), "oldest", "price-asc", "price-desc", "popular".
    pub sort: Option<String>,
    /// Include closed listings too (default: live only).
    pub include_closed: Option<bool>,
    pub verified_only: Option<bool>,
    pub min_price: Option<f64>,
    pub max_price: Option<f64>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    Newest,
    Oldest,
    PriceAsc,
    PriceDesc,
    Popular,
}

pub fn parse_intent(value: Option<&str>) -> Result<Option<Intent>, AppError> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some("buy") => Ok(Some(Intent::Buy)),
        Some("sell") => Ok(Some(Intent::Sell)),
        Some(_) => Err(AppError::BadRequest("intent must be \"buy\" or \"sell\".".into())),
    }
}

pub fn parse_sort(value: Option<&str>) -> Result<Sort, AppError> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None | Some("newest") => Ok(Sort::Newest),
        Some("oldest") => Ok(Sort::Oldest),
        Some("price-asc") => Ok(Sort::PriceAsc),
        Some("price-desc") => Ok(Sort::PriceDesc),
        Some("popular") => Ok(Sort::Popular),
        Some(_) => Err(AppError::BadRequest(
            "sort must be newest, oldest, price-asc, price-desc or popular.".into(),
        )),
    }
}

/// Lower-cased, whitespace-collapsed text for matching.
pub fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn matches_search(listing: &Listing, term: &str) -> bool {
    let haystack = [
        Some(listing.product.as_str()),
        listing.description.as_deref(),
        listing.region.as_deref(),
        listing.grade.as_deref(),
        Some(listing.owner_name.as_str()),
        Some(listing.reference.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(normalize)
    .collect::<Vec<_>>()
    .join(" ");
    // Every word must appear somewhere.
    term.split(' ').all(|word| haystack.contains(word))
}

/// Applies every filter in `query` and returns matching listings, sorted.
pub fn filter_and_sort<'a>(
    listings: &'a [Listing],
    query: &ListingQuery,
) -> Result<Vec<&'a Listing>, AppError> {
    let intent = parse_intent(query.intent.as_deref())?;
    let sort = parse_sort(query.sort.as_deref())?;
    let category = query
        .category
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let term = query
        .search
        .as_deref()
        .map(normalize)
        .filter(|t| !t.is_empty());
    if let (Some(min), Some(max)) = (query.min_price, query.max_price) {
        if min > max {
            return Err(AppError::BadRequest("min_price must not exceed max_price.".into()));
        }
    }
    let include_closed = query.include_closed.unwrap_or(false);
    let verified_only = query.verified_only.unwrap_or(false);

    let mut rows: Vec<&Listing> = listings
        .iter()
        .filter(|l| include_closed || l.status.is_live())
        .filter(|l| intent.map_or(true, |i| l.intent == i))
        .filter(|l| category.map_or(true, |c| l.category == c))
        .filter(|l| !verified_only || l.owner_verified)
        .filter(|l| {
            if query.min_price.is_none() && query.max_price.is_none() {
                return true;
            }
            match l.price_amount {
                None => false,
                Some(price) => {
                    query.min_price.map_or(true, |min| price >= min)
                        && query.max_price.map_or(true, |max| price <= max)
                }
            }
        })
        .filter(|l| term.as_deref().map_or(true, |t| matches_search(l, t)))
        .collect();

    rows.sort_by(|a, b| compare(a, b, sort));
    Ok(rows)
}

/// Newest first breaks ties for every sort; unpriced listings go last on price sorts.
fn compare(a: &Listing, b: &Listing, sort: Sort) -> Ordering {
    let newest = b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id));
    match sort {
        Sort::Newest => newest,
        Sort::Oldest => newest.reverse(),
        Sort::Popular => b.views.cmp(&a.views).then(newest),
        Sort::PriceAsc | Sort::PriceDesc => match (a.price_amount, b.price_amount) {
            (None, None) => newest,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(x), Some(y)) => {
                let by_price = x.partial_cmp(&y).unwrap_or(Ordering::Equal);
                let by_price = if sort == Sort::PriceAsc {
                    by_price
                } else {
                    by_price.reverse()
                };
                by_price.then(newest)
            }
        },
    }
}
