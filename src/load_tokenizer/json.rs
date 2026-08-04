use serde::de::DeserializeOwned;

pub(crate) fn from_slice<T: DeserializeOwned>(data: &[u8]) -> eyre::Result<T> {
    serde_json::from_slice(data).map_err(Into::into)
}
