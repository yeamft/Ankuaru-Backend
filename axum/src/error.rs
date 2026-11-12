//! JSON error responses: `{ "error": "...", "message": "..." }`.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    NotFound(&'static str),
    BadRequest(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            AppError::NotFound(what) => (
                StatusCode::NOT_FOUND,
                "not_found",
                format!("The requested {what} was not found."),
            ),
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
        };
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}
