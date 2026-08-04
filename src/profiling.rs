use serde::Serialize;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub(crate) const PROFILE_BATCH_STRIDE: u64 = 16;

#[inline]
pub(crate) fn sample_profile_batch(index: u64, phase: u64) -> bool {
    let mixed = (index as u32).wrapping_mul(0x9E37_79B1);
    u64::from(mixed >> 28) == phase % PROFILE_BATCH_STRIDE
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

pub(crate) struct ProfileClock {
    #[cfg(not(target_arch = "wasm32"))]
    origin: std::time::Instant,
}

impl ProfileClock {
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

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RankCounters {
    pub(crate) id_rank_lookups: u64,
    pub(crate) explicit_rank_lookups: u64,
    pub(crate) dense_lookups: u64,
    pub(crate) dense_hits: u64,
    pub(crate) sparse_lookups: u64,
    pub(crate) sparse_probe_steps: u64,
    pub(crate) sparse_probe_max: u64,
    pub(crate) id_hash_lookups: u64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ProfileAccumulator {
    pub(crate) reserved_scan_ms: f64,
    pub(crate) pretokenize_ms: f64,
    pub(crate) merge_ms: f64,
    pub(crate) output_assembly_ms: f64,
    pub(crate) pretoken_batches: u64,
    pub(crate) sampled_pretoken_batches: u64,
    pub(crate) batch_sampling_phase: u64,
    pub(crate) pretokens: u64,
    pub(crate) short_cache_misses: u64,
    pub(crate) long_cache_misses: u64,
    pub(crate) rank: RankCounters,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileSnapshot {
    pub(crate) schema_version: u32,
    pub(crate) profile_calls: u64,
    pub(crate) internal_ms: f64,
    pub(crate) observed_wall_ms: f64,
    pub(crate) reserved_scan_ms: f64,
    pub(crate) pretokenize_ms: f64,
    pub(crate) merge_ms: f64,
    pub(crate) output_assembly_ms: f64,
    pub(crate) pretoken_batches: u64,
    pub(crate) sampled_pretoken_batches: u64,
    pub(crate) batch_sampling_stride: u64,
    pub(crate) batch_sampling_phase: u64,
    pub(crate) pretokens: u64,
    pub(crate) short_cache_misses: u64,
    pub(crate) long_cache_misses: u64,
    pub(crate) rank: RankCounters,
}

impl ProfileAccumulator {
    pub(crate) fn finish(self, observed_wall_ms: f64) -> ProfileSnapshot {
        let batch_scale = if self.sampled_pretoken_batches == 0 {
            1.0
        } else {
            self.pretoken_batches as f64 / self.sampled_pretoken_batches as f64
        };
        let mut reserved_scan_ms = self.reserved_scan_ms;
        let mut pretokenize_ms = self.pretokenize_ms * batch_scale;
        let mut merge_ms = self.merge_ms * batch_scale;
        let mut output_assembly_ms = self.output_assembly_ms * batch_scale;
        let measured = reserved_scan_ms + pretokenize_ms + merge_ms + output_assembly_ms;
        if measured > 0.0 {
            let wall_scale = observed_wall_ms / measured;
            reserved_scan_ms *= wall_scale;
            pretokenize_ms *= wall_scale;
            merge_ms *= wall_scale;
            output_assembly_ms *= wall_scale;
        } else {
            reserved_scan_ms = observed_wall_ms;
        }
        ProfileSnapshot {
            schema_version: 1,
            profile_calls: 1,
            internal_ms: observed_wall_ms,
            observed_wall_ms,
            reserved_scan_ms,
            pretokenize_ms,
            merge_ms,
            output_assembly_ms,
            pretoken_batches: self.pretoken_batches,
            sampled_pretoken_batches: self.sampled_pretoken_batches,
            batch_sampling_stride: PROFILE_BATCH_STRIDE,
            batch_sampling_phase: self.batch_sampling_phase,
            pretokens: self.pretokens,
            short_cache_misses: self.short_cache_misses,
            long_cache_misses: self.long_cache_misses,
            rank: self.rank,
        }
    }
}

impl ProfileSnapshot {
    pub(crate) fn accumulate(&mut self, other: Self) {
        debug_assert_eq!(self.schema_version, other.schema_version);
        debug_assert_eq!(self.batch_sampling_stride, other.batch_sampling_stride);
        self.profile_calls += other.profile_calls;
        self.internal_ms += other.internal_ms;
        self.observed_wall_ms += other.observed_wall_ms;
        self.reserved_scan_ms += other.reserved_scan_ms;
        self.pretokenize_ms += other.pretokenize_ms;
        self.merge_ms += other.merge_ms;
        self.output_assembly_ms += other.output_assembly_ms;
        self.pretoken_batches += other.pretoken_batches;
        self.sampled_pretoken_batches += other.sampled_pretoken_batches;
        self.pretokens += other.pretokens;
        self.short_cache_misses += other.short_cache_misses;
        self.long_cache_misses += other.long_cache_misses;
        self.rank.id_rank_lookups += other.rank.id_rank_lookups;
        self.rank.explicit_rank_lookups += other.rank.explicit_rank_lookups;
        self.rank.dense_lookups += other.rank.dense_lookups;
        self.rank.dense_hits += other.rank.dense_hits;
        self.rank.sparse_lookups += other.rank.sparse_lookups;
        self.rank.sparse_probe_steps += other.rank.sparse_probe_steps;
        self.rank.sparse_probe_max = self.rank.sparse_probe_max.max(other.rank.sparse_probe_max);
        self.rank.id_hash_lookups += other.rank.id_hash_lookups;
    }

    pub(crate) fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}
