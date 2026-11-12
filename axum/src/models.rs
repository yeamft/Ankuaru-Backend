//! Listing shapes: the stored record and the view returned to clients.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Intent {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ListingStatus {
    Active,
    #[serde(rename = "Closing Soon")]
    ClosingSoon,
    Closed,
}

impl ListingStatus {
    /// Live listings are the ones shown on the public market.
    pub fn is_live(self) -> bool {
        matches!(self, ListingStatus::Active | ListingStatus::ClosingSoon)
    }
}

/// One marketplace listing, as held in memory.
#[derive(Debug, Clone, Serialize)]
pub struct Listing {
    pub id: String,
    pub reference: String,
    pub intent: Intent,
    /// Category slug, e.g. "coffee" or "oil-seeds".
    pub category: String,
    pub product: String,
    pub status: ListingStatus,
    pub quantity: Option<String>,
    pub price_amount: Option<f64>,
    pub price_currency: String,
    pub region: Option<String>,
    pub grade: Option<String>,
    pub process: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub owner_name: String,
    pub owner_verified: bool,
    /// RFC 3339, always UTC ("...Z") so string order is time order.
    pub created_at: String,
    pub views: u32,
}

/// A listing plus display-ready fields computed by the helpers.
#[derive(Debug, Serialize)]
pub struct ListingView {
    #[serde(flatten)]
    pub listing: Listing,
    pub category_label: String,
    pub price_display: String,
    /// The listing's own image, or the category's stand-in image.
    pub image: String,
    pub image_is_fallback: bool,
    /// "YYYY-MM-DD" part of `created_at`.
    pub posted_on: String,
}

#[derive(Debug, Serialize)]
pub struct CategoryCount {
    pub slug: String,
    pub label: String,
    pub live: usize,
}

#[derive(Debug, Serialize)]
pub struct Summary {
    pub total: usize,
    pub live: usize,
    pub buy_requests: usize,
    pub sell_offers: usize,
    pub verified_sellers: usize,
}
