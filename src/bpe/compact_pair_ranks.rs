use super::{PAIR_ID_BITS, TokenId};
use std::collections::HashMap;

pub(super) struct CompactPairRankTable {
    slots: Box<[u64]>,
    mask: usize,
    shift: u32,
}

impl CompactPairRankTable {
    pub(super) fn build<S: std::hash::BuildHasher>(
        merges: &HashMap<(TokenId, TokenId), TokenId, S>,
    ) -> Option<Self> {
        let slot_count = (merges.len().max(1) * 2).next_power_of_two().max(64);
        let shift = 64 - slot_count.trailing_zeros();
        let mask = slot_count - 1;
        let mut slots = vec![u64::MAX; slot_count].into_boxed_slice();
        for (&(left, right), &merged) in merges {
            let key = ((left.0 as u64) << PAIR_ID_BITS) | right.0 as u64;
            let mut slot = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> shift) as usize;
            let mut displacement = 0usize;
            while slots[slot] != u64::MAX {
                slot = (slot + 1) & mask;
                displacement += 1;
                if displacement > 64 {
                    return None;
                }
            }
            slots[slot] = (key << PAIR_ID_BITS) | merged.0 as u64;
        }
        Some(Self { slots, mask, shift })
    }

    pub(super) fn with_capacity(merge_count: usize) -> Self {
        let slot_count = (merge_count.max(1) * 2).next_power_of_two().max(64);
        let shift = 64 - slot_count.trailing_zeros();
        let mask = slot_count - 1;
        let slots = vec![u64::MAX; slot_count].into_boxed_slice();
        Self { slots, mask, shift }
    }

    pub(super) fn insert(&mut self, left: TokenId, right: TokenId, merged: TokenId) -> bool {
        let key = ((left.0 as u64) << PAIR_ID_BITS) | right.0 as u64;
        let mut slot = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
        let mut displacement = 0usize;
        loop {
            let packed = self.slots[slot];
            if packed == u64::MAX {
                self.slots[slot] = (key << PAIR_ID_BITS) | merged.0 as u64;
                return true;
            }
            if packed >> PAIR_ID_BITS == key {
                return false;
            }
            slot = (slot + 1) & self.mask;
            displacement += 1;
            if displacement > 64 {
                return false;
            }
        }
    }

    #[inline(always)]
    pub(super) fn rank(&self, left: TokenId, right: TokenId) -> u32 {
        let key = ((left.0 as u64) << PAIR_ID_BITS) | right.0 as u64;
        let mut slot = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
        loop {
            // SAFETY: the initial hash is below slots.len(), and every
            // subsequent slot is masked by slots.len() - 1.
            let packed = unsafe { *self.slots.get_unchecked(slot) };
            if packed >> PAIR_ID_BITS == key {
                return (packed & ((1 << PAIR_ID_BITS) - 1)) as u32;
            }
            if packed == u64::MAX {
                return u32::MAX;
            }
            slot = (slot + 1) & self.mask;
        }
    }

    pub(super) fn entries(&self) -> impl Iterator<Item = (TokenId, TokenId, TokenId)> + '_ {
        self.slots.iter().copied().filter_map(|packed| {
            if packed == u64::MAX {
                return None;
            }
            let id_mask = (1_u64 << PAIR_ID_BITS) - 1;
            let merged = TokenId((packed & id_mask) as u32);
            let key = packed >> PAIR_ID_BITS;
            let left = TokenId((key >> PAIR_ID_BITS) as u32);
            let right = TokenId((key & id_mask) as u32);
            Some((left, right, merged))
        })
    }

    #[cfg(feature = "profiling")]
    #[inline(always)]
    pub(super) fn rank_profiled(
        &self,
        left: TokenId,
        right: TokenId,
        counters: &mut crate::profiling::RankCounters,
    ) -> u32 {
        counters.id_rank_lookups += 1;
        counters.sparse_lookups += 1;
        let key = ((left.0 as u64) << PAIR_ID_BITS) | right.0 as u64;
        let mut slot = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
        let mut steps = 0_u64;
        let rank = loop {
            steps += 1;
            // SAFETY: the initial hash is below slots.len(), and every
            // subsequent slot is masked by slots.len() - 1.
            let packed = unsafe { *self.slots.get_unchecked(slot) };
            if packed >> PAIR_ID_BITS == key {
                break (packed & ((1 << PAIR_ID_BITS) - 1)) as u32;
            }
            if packed == u64::MAX {
                break u32::MAX;
            }
            slot = (slot + 1) & self.mask;
        };
        counters.sparse_probe_steps += steps;
        counters.sparse_probe_max = counters.sparse_probe_max.max(steps);
        rank
    }

    #[cfg(target_arch = "x86_64")]
    #[inline(always)]
    pub(super) fn first_slot_address(&self, left: TokenId, right: TokenId) -> *const i8 {
        let key = ((left.0 as u64) << PAIR_ID_BITS) | right.0 as u64;
        let slot = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
        // SAFETY: the multiplicative hash keeps exactly log2(slots.len())
        // high bits, so slot is below slots.len().
        unsafe { self.slots.as_ptr().add(slot) as *const i8 }
    }

    #[cfg(test)]
    pub(super) fn resident_bytes(&self) -> usize {
        self.slots.len() * std::mem::size_of::<u64>()
    }
}
