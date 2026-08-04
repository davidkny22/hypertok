use serde::Serialize;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

pub(crate) struct DecodeProfileClock {
    #[cfg(not(target_arch = "wasm32"))]
    origin: std::time::Instant,
}

impl DecodeProfileClock {
    pub(crate) fn new() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            origin: std::time::Instant::now(),
        }
    }

    #[inline]
    pub(crate) fn now_ms(&self) -> f64 {
        #[cfg(target_arch = "wasm32")]
        {
            performance_now()
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.origin.elapsed().as_secs_f64() * 1_000.0
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecodeProfileSnapshot {
    schema_version: u32,
    profile_calls: u64,
    gather_ms: f64,
    input_ids: u64,
    output_bytes: u64,
}

impl DecodeProfileSnapshot {
    pub(crate) fn new(gather_ms: f64, input_ids: usize, output_bytes: usize) -> Self {
        Self {
            schema_version: 1,
            profile_calls: 1,
            gather_ms,
            input_ids: input_ids as u64,
            output_bytes: output_bytes as u64,
        }
    }

    pub(crate) fn accumulate(&mut self, other: Self) {
        debug_assert_eq!(self.schema_version, other.schema_version);
        self.profile_calls += other.profile_calls;
        self.gather_ms += other.gather_ms;
        self.input_ids += other.input_ids;
        self.output_bytes += other.output_bytes;
    }

    pub(crate) fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

#[cfg(test)]
mod tests {
    use super::DecodeProfileSnapshot;

    #[test]
    fn decode_profile_accumulates_counts_and_time() {
        let mut snapshot = DecodeProfileSnapshot::new(1.25, 3, 7);
        snapshot.accumulate(DecodeProfileSnapshot::new(0.75, 2, 5));
        let value: serde_json::Value = serde_json::from_str(&snapshot.to_json().unwrap()).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["profileCalls"], 2);
        assert_eq!(value["gatherMs"], 2.0);
        assert_eq!(value["inputIds"], 5);
        assert_eq!(value["outputBytes"], 12);
    }
}
