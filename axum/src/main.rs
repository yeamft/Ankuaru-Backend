//! Read-only listings service (view only).
//!
//! Serves a fixed set of sample listings over HTTP. It does not touch the
//! database, the Node API, or any other part of the backend.

mod data;
mod error;
mod helpers;
mod models;
mod routes;

use std::{net::SocketAddr, sync::Arc};

use axum::Router;
use tower_http::cors::{Any, CorsLayer};

/// Shared, immutable state: the sample listings.
#[derive(Clone)]
pub struct AppState {
    pub listings: Arc<Vec<models::Listing>>,
}

pub fn app(state: AppState) -> Router {
    // Read-only service: any origin may GET.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([axum::http::Method::GET]);

    routes::router().with_state(state).layer(cors)
}

#[tokio::main]
async fn main() {
    let state = AppState {
        listings: Arc::new(data::sample_listings()),
    };

    let port: u16 = std::env::var("AXUM_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4100);
    let address = SocketAddr::from(([127, 0, 0, 1], port));

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("could not bind the listen address");
    println!("Listings view service on http://{address}");

    axum::serve(listener, app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
