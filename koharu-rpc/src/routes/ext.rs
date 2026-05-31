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
    let token = SecretStore::new(SECRET_SERVICE).get(TOKEN_KEY)?;
    Ok(Json(TokenResponse { token }))
}

#[utoipa::path(put, path = "/ext/token", request_body = SetTokenRequest, responses((status = 204)))]
async fn set_token(Json(req): Json<SetTokenRequest>) -> ApiResult<StatusCode> {
    SecretStore::new(SECRET_SERVICE).set(TOKEN_KEY, &req.token)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/ext/token", responses((status = 204)))]
async fn delete_token() -> ApiResult<StatusCode> {
    SecretStore::new(SECRET_SERVICE).delete(TOKEN_KEY)?;
    Ok(StatusCode::NO_CONTENT)
}
