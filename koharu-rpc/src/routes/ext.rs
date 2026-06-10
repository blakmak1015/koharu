//! Website-integration token storage (this fork's addition; kept isolated for
//! easy rebasing onto upstream koharu). Persists the translator's website
//! access token in the platform keyring so the UI can stay logged in across
//! restarts. Reuses koharu's existing `SecretStore` (same keyring service).

use axum::Json;
use axum::http::StatusCode;
use koharu_runtime::SecretStore;
use serde::{Deserialize, Serialize};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::AppState;
use crate::error::ApiResult;

const SECRET_SERVICE: &str = "koharu";
const TOKEN_KEY: &str = "website_access_token";

/// Per-instance keyring key. The platform keyring is machine-wide, so running
/// several koharu instances (e.g. a pool of editors on different ports) would
/// otherwise share ONE login — logging out of one logs out all of them. Set
/// `KOHARU_INSTANCE_ID` (unique per instance) to give each its own token entry.
fn token_key() -> String {
    match std::env::var("KOHARU_INSTANCE_ID") {
        Ok(id) if !id.trim().is_empty() => format!("{TOKEN_KEY}:{}", id.trim()),
        _ => TOKEN_KEY.to_string(),
    }
}

#[derive(Serialize, utoipa::ToSchema)]
struct TokenResponse {
    token: Option<String>,
}

#[derive(Deserialize, utoipa::ToSchema)]
struct SetTokenRequest {
    token: String,
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::default()
        .routes(routes!(get_token))
        .routes(routes!(set_token))
        .routes(routes!(delete_token))
}

#[utoipa::path(get, path = "/ext/token", responses((status = 200, body = TokenResponse)))]
async fn get_token() -> ApiResult<Json<TokenResponse>> {
    let token = SecretStore::new(SECRET_SERVICE).get(&token_key())?;
    Ok(Json(TokenResponse { token }))
}

#[utoipa::path(put, path = "/ext/token", request_body = SetTokenRequest, responses((status = 204)))]
async fn set_token(Json(req): Json<SetTokenRequest>) -> ApiResult<StatusCode> {
    SecretStore::new(SECRET_SERVICE).set(&token_key(), &req.token)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/ext/token", responses((status = 204)))]
async fn delete_token() -> ApiResult<StatusCode> {
    SecretStore::new(SECRET_SERVICE).delete(&token_key())?;
    Ok(StatusCode::NO_CONTENT)
}
