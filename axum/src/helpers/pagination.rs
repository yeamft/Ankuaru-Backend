//! Offset pagination with an opaque string cursor.

use serde::Serialize;

use crate::error::AppError;

pub const DEFAULT_LIMIT: usize = 12;
pub const MAX_LIMIT: usize = 50;

#[derive(Debug, Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    /// Pass back as `cursor` to get the next page; absent on the last page.
    pub next_cursor: Option<String>,
    /// Matching items across all pages.
    pub total: usize,
}

/// Clamps a requested page size to 1..=MAX_LIMIT.
pub fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

/// The cursor is the offset of the next item, as a decimal string.
pub fn decode_cursor(cursor: Option<&str>) -> Result<usize, AppError> {
    match cursor {
        None | Some("") => Ok(0),
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| AppError::BadRequest("The cursor is not valid.".into())),
    }
}

/// Cuts one page out of `items`.
pub fn paginate<T>(items: Vec<T>, offset: usize, limit: usize) -> Page<T> {
    let total = items.len();
    let end = offset.saturating_add(limit).min(total);
    let next_cursor = (end < total).then(|| end.to_string());
    let items = if offset >= total {
        Vec::new()
    } else {
        items.into_iter().skip(offset).take(limit).collect()
    };
    Page {
        items,
        next_cursor,
        total,
    }
}
