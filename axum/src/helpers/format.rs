//! Display formatting: prices, category names, images, dates.

use crate::models::{Listing, ListingView};

/// Known categories: (slug, label, stand-in image).
pub const CATEGORIES: &[(&str, &str, &str)] = &[
    ("coffee", "Coffee", "/marketplace/sample-coffee.png"),
    ("oil-seeds", "Oil seeds", "/marketplace/sample-sesame.png"),
    ("spices-herbs", "Spices & herbs", "/marketplace/sample-spices.png"),
    ("pulses-legumes", "Pulses & legumes", "/marketplace/sample-chickpeas.png"),
    ("grains-cereals", "Grains & cereals", "/marketplace/sample-teff.png"),
    ("fruit-crops", "Fruit", "/fallback/listing.svg"),
    ("vegetables", "Vegetables", "/fallback/listing.svg"),
    ("root-crops", "Root crops", "/fallback/listing.svg"),
    ("building-materials", "Building materials", "/fallback/listing.svg"),
];

const GENERIC_IMAGE: &str = "/fallback/listing.svg";

pub fn category_label(slug: &str) -> String {
    CATEGORIES
        .iter()
        .find(|(known, _, _)| *known == slug)
        .map(|(_, label, _)| (*label).to_string())
        .unwrap_or_else(|| slug.replace('-', " "))
}

pub fn category_image(slug: &str) -> &'static str {
    CATEGORIES
        .iter()
        .find(|(known, _, _)| *known == slug)
        .map(|(_, _, image)| *image)
        .unwrap_or(GENERIC_IMAGE)
}

/// "USD 4,250.00"; negative amounts keep their sign.
pub fn format_money(amount: f64, currency: &str) -> String {
    let cents = (amount * 100.0).round() as i64;
    let sign = if cents < 0 { "-" } else { "" };
    let cents = cents.abs();
    let whole = (cents / 100).to_string();
    let fraction = cents % 100;

    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("{currency} {sign}{grouped}.{fraction:02}")
}

pub fn price_display(amount: Option<f64>, currency: &str) -> String {
    match amount {
        Some(value) if value.is_finite() => format_money(value, currency),
        _ => "Price on request".to_string(),
    }
}

/// "2026-11-02T08:30:00Z" -> "2026-11-02".
pub fn date_part(timestamp: &str) -> String {
    timestamp.split('T').next().unwrap_or(timestamp).to_string()
}

/// Builds the client-facing view of a listing.
pub fn to_view(listing: &Listing) -> ListingView {
    let own_image = listing
        .image_url
        .as_deref()
        .filter(|url| !url.trim().is_empty());
    let image = own_image
        .map(str::to_string)
        .unwrap_or_else(|| category_image(&listing.category).to_string());

    ListingView {
        category_label: category_label(&listing.category),
        price_display: price_display(listing.price_amount, &listing.price_currency),
        image_is_fallback: own_image.is_none(),
        image,
        posted_on: date_part(&listing.created_at),
        listing: listing.clone(),
    }
}
