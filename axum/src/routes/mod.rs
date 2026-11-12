//! Read-only routes. Everything is GET.

mod listings;

use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/api/listings", get(listings::list))
        .route("/api/listings/summary", get(listings::summary))
        .route("/api/listings/:id", get(listings::detail))
        .route("/api/categories", get(listings::categories))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "mode": "view-only" }))
}
