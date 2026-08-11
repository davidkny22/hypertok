#[cfg(feature = "opt-compact-ranks")]
mod compact_pair_ranks;
#[cfg(feature = "opt-force-split-bigram")]
mod force_split_bigrams;
#[cfg(all(test, feature = "opt-force-split-bigram"))]
mod force_split_bigrams_tests;
#[cfg(feature = "opt-miss-path-diet")]
mod long_pretoken_cache;
pub(crate) mod nfc;
pub(crate) mod pretoken_cache;
#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
pub mod sentencepiece;
pub(crate) mod source_map;
pub mod tiktoken;

use crate::token::TokenId;
use eyre::{Result, anyhow};
use std::collections::HashMap;

#[cfg(not(feature = "opt-resident-diet"))]
pub(crate) type TokenBytes = std::sync::Arc<[u8]>;

/// Immutable token bytes, either independently owned or a view into one
/// shared `.htk` arena.
#[cfg(feature = "opt-resident-diet")]
#[derive(Clone)]
pub(crate) struct TokenBytes {
    storage: std::sync::Arc<[u8]>,
    start: u32,
    end: u32,
}

#[cfg(feature = "opt-resident-diet")]
impl TokenBytes {
    pub(crate) fn shared(storage: std::sync::Arc<[u8]>, start: usize, end: usize) -> Option<Self> {
        if start > end || end > storage.len() {
            return None;
        }
        Some(Self {
            storage,
            start: u32::try_from(start).ok()?,
            end: u32::try_from(end).ok()?,
        })
    }
}

#[cfg(feature = "opt-resident-diet")]
impl From<Vec<u8>> for TokenBytes {
    fn from(bytes: Vec<u8>) -> Self {
        let end = u32::try_from(bytes.len()).expect("token bytes exceed u32");
        Self {
            storage: bytes.into(),
            start: 0,
            end,
        }
    }
}

#[cfg(feature = "opt-resident-diet")]
impl std::ops::Deref for TokenBytes {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.storage[self.start as usize..self.end as usize]
    }
}

#[cfg(feature = "opt-resident-diet")]
impl AsRef<[u8]> for TokenBytes {
    fn as_ref(&self) -> &[u8] {
        self
    }
}

#[cfg(feature = "opt-resident-diet")]
impl std::borrow::Borrow<[u8]> for TokenBytes {
    fn borrow(&self) -> &[u8] {
        self
    }
}

#[cfg(feature = "opt-resident-diet")]
impl PartialEq for TokenBytes {
    fn eq(&self, other: &Self) -> bool {
        self.as_ref() == other.as_ref()
    }
}

#[cfg(feature = "opt-resident-diet")]
impl Eq for TokenBytes {}

#[cfg(feature = "opt-resident-diet")]
impl std::hash::Hash for TokenBytes {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.as_ref().hash(state);
    }
}

// ---------------------------------------------------------------------------
// ByteRemapping , shared between tokenizer types
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ByteRemapping {
    /// Maps each byte value to the token ID of its single-byte vocab entry.
    /// The IDs need not be < 256 (e.g. DeepSeek puts its byte tokens at
    /// 3..=258, after the special tokens).
    mapping: Vec<TokenId>,
}

/// Whether `b` can appear anywhere in a valid UTF-8 byte stream. `0xC0`/`0xC1`
/// are overlong two-byte leads and `0xF5..=0xFF` encode code points beyond
/// U+10FFFF, so none of them ever occur in valid UTF-8.
fn is_valid_utf8_byte(b: u8) -> bool {
    !matches!(b, 0xC0 | 0xC1 | 0xF5..=0xFF)
}

impl ByteRemapping {
    /// Build the byte → token-ID table by scanning `vocab` for single-byte
    /// entries (lowest ID wins). Returns `None` when the mapping is the
    /// identity (token ID == byte value), and an error if some byte value
    /// that can appear in valid UTF-8 has no single-byte token.
    ///
    /// A vocab may legitimately omit single-byte tokens for the bytes that
    /// never occur in valid UTF-8 (`0xC0`, `0xC1`, and `0xF5..=0xFF` , overlong
    /// and out-of-range lead bytes). Byte-level vocabularies trained only on
    /// UTF-8 text , e.g. ModernBERT / GPT-NeoX , drop them. Since such a byte
    /// can never reach the merge loop from valid input, its absence is not an
    /// error; we fill it with a placeholder ID so the table can never yield an
    /// out-of-range `TokenId` even if fed malformed bytes.
    pub fn from_byte_vocab(vocab: &[impl AsRef<[u8]>]) -> Result<Option<Self>> {
        const UNSET: u32 = u32::MAX;
        let mut mapping = vec![TokenId::from(UNSET); 256];
        for (id, entry) in vocab.iter().enumerate() {
            if let &[b] = entry.as_ref()
                && mapping[b as usize].0 == UNSET
            {
                mapping[b as usize] = TokenId::from(id as u32);
            }
        }
        if let Some(missing) = mapping
            .iter()
            .enumerate()
            .position(|(b, t)| t.0 == UNSET && is_valid_utf8_byte(b as u8))
        {
            return Err(anyhow!(
                "Byte remapping failed: no single-byte vocab entry for byte {missing:#04x}"
            ));
        }
        // Fill the tolerated (never-in-UTF-8) gaps with a safe placeholder so
        // an unexpected malformed byte indexes a valid token instead of OOB.
        for t in mapping.iter_mut() {
            if t.0 == UNSET {
                *t = TokenId::from(0);
            }
        }
        Ok(mapping
            .iter()
            .enumerate()
            .any(|(b, t)| t.0 != b as u32)
            .then_some(ByteRemapping { mapping }))
    }
}

// ---------------------------------------------------------------------------
// PairRankTable , flat pair-rank lookups for the merge hot path
// ---------------------------------------------------------------------------

/// Merge-pair lookup structure replacing the hashbrown `merges` map on the
/// cache-miss merge path. Two levels, both immutable after construction (so
/// forks share one copy via `Arc` instead of cloning the map):
///
/// - a dense `byte × byte` grid covering every pair whose sides are both
///   below the initial-symbol range (256 for GPT-2, 512 for DeepSeek-style
///   layouts). All round-1 lookups , roughly half of all lookups per miss,
///   since initial symbols are byte tokens , become one shift-or index and
///   one L1/L2 load: no hash, no probe.
/// - a flat open-addressed table of all merges: power-of-two slots at
///   ≤ 1/2 load, linear probing, one `u64` slot packing key and value
///   (`(key << 21) | merged_id`; keys are 42 bits and merged IDs 21, so a
///   packed slot uses 63 bits and `u64::MAX` can never collide) so a probe
///   touches one 8-byte load per step , the hit's value rides on the same
///   line as its key. hashbrown pays a tuple hash, a ctrl-byte line, a
///   NEON group match, and a second line for the bucket per lookup; this
///   pays one multiply, one load, one compare , and the common mid-merge
///   *miss* usually terminates on the first empty slot.
///
/// Values are merged token IDs (`u32::MAX` = no merge), matching the
/// tiktoken-style convention that merged ID order == merge priority.
/// With `opt-compact-ranks`, the complete flat level remains and the dense
/// lookup accelerator is omitted.
/// [`Self::build`] returns `None` for vocabularies that violate its packing
/// invariants; callers then keep using the hashbrown map.
pub(crate) struct PairRankTable {
    /// `dense[(a << dense_log2) | b]` = merged ID for pairs with both sides
    /// `< 2^dense_log2`, `u32::MAX` when they do not merge.
    #[cfg(not(feature = "opt-compact-ranks"))]
    dense: Box<[u32]>,
    #[cfg(not(feature = "opt-compact-ranks"))]
    dense_log2: u32,
    /// Flat table slots, `((a << 21 | b) << 21) | merged_id` packed;
    /// `u64::MAX` = empty (real slots fit 63 bits, so the sentinel can
    /// never collide, and its key field `MAX >> 21` exceeds every real
    /// 42-bit key, so the hit compare rejects it for free).
    #[cfg(not(feature = "opt-compact-ranks"))]
    slots: Box<[u64]>,
    /// `slots.len() - 1` (length is a power of two).
    #[cfg(not(feature = "opt-compact-ranks"))]
    mask: usize,
    /// `64 - log2(slots.len())`: the hash keeps the top bits.
    #[cfg(not(feature = "opt-compact-ranks"))]
    shift: u32,
    #[cfg(feature = "opt-compact-ranks")]
    compact: compact_pair_ranks::CompactPairRankTable,
}

/// Every token ID must fit a 21-bit key lane (covers any vocab < 2M IDs).
pub(super) const PAIR_ID_BITS: u32 = 21;

impl PairRankTable {
    #[cfg(feature = "opt-prebuilt-pair-ranks")]
    pub(crate) fn from_packed_entries(
        entries: &[u64],
        byte_remapping: Option<&ByteRemapping>,
        vocab_len: usize,
    ) -> Result<Self, &'static str> {
        let mut table = crate::cold_construction::measure("pair-table-allocation", || {
            Self::with_capacity(byte_remapping, vocab_len, entries.len())
        })
        .ok_or("prebuilt pair entries exceed table capacity")?;
        crate::cold_construction::measure("pair-table-insertion", || {
            let id_mask = (1_u64 << PAIR_ID_BITS) - 1;
            for &packed in entries {
                if packed == u64::MAX {
                    return Err("prebuilt pair entries contain the empty sentinel");
                }
                let merged = TokenId((packed & id_mask) as u32);
                let key = packed >> PAIR_ID_BITS;
                let left = TokenId((key >> PAIR_ID_BITS) as u32);
                let right = TokenId((key & id_mask) as u32);
                if left.0 as usize >= vocab_len
                    || right.0 as usize >= vocab_len
                    || merged.0 as usize >= vocab_len
                    || !table.insert(left, right, merged)
                {
                    return Err("prebuilt pair entries contain an invalid pair");
                }
            }
            Ok(())
        })?;
        Ok(table)
    }

    #[cfg(feature = "opt-prebuilt-built-state")]
    pub(crate) fn from_prebuilt_slots(
        slot_count: usize,
        entries: &[(u32, u64)],
        byte_remapping: Option<&ByteRemapping>,
        vocab_len: usize,
    ) -> Result<Self, &'static str> {
        #[cfg(feature = "opt-compact-ranks")]
        {
            let _ = (slot_count, entries, byte_remapping, vocab_len);
            return Err("prebuilt pair slots require flat pair ranks");
        }

        #[cfg(not(feature = "opt-compact-ranks"))]
        {
            let mut table = crate::cold_construction::measure("pair-table-allocation", || {
                Self::with_capacity(byte_remapping, vocab_len, entries.len())
            })
            .ok_or("prebuilt pair slots exceed table capacity")?;
            if table.slots.len() != slot_count {
                return Err("prebuilt pair slot count is not canonical");
            }
            let id_mask = (1_u64 << PAIR_ID_BITS) - 1;
            crate::cold_construction::measure("pair-slot-import", || {
                for &(slot, packed) in entries {
                    let slot = slot as usize;
                    let target = table
                        .slots
                        .get_mut(slot)
                        .ok_or("prebuilt pair slot is out of bounds")?;
                    if *target != u64::MAX || packed == u64::MAX {
                        return Err("prebuilt pair slot is duplicated or empty");
                    }
                    let merged = (packed & id_mask) as u32;
                    let key = packed >> PAIR_ID_BITS;
                    let left = (key >> PAIR_ID_BITS) as u32;
                    let right = (key & id_mask) as u32;
                    if left as usize >= vocab_len
                        || right as usize >= vocab_len
                        || merged as usize >= vocab_len
                    {
                        return Err("prebuilt pair slot contains an invalid token id");
                    }
                    *target = packed;
                    if (left | right) >> table.dense_log2 == 0 {
                        table.dense[((left as usize) << table.dense_log2) | right as usize] =
                            merged;
                    }
                }
                Ok::<_, &'static str>(())
            })?;
            crate::cold_construction::measure("pair-slot-layout-validation", || {
                for &(slot, packed) in entries {
                    let key = packed >> PAIR_ID_BITS;
                    let mut index =
                        (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> table.shift) as usize;
                    let mut displacement = 0usize;
                    while index != slot as usize {
                        if table.slots[index] == u64::MAX || displacement >= 64 {
                            return Err("prebuilt pair slot is not reachable by linear probing");
                        }
                        index = (index + 1) & table.mask;
                        displacement += 1;
                    }
                }
                Ok::<_, &'static str>(())
            })?;
            Ok(table)
        }
    }

    #[cfg(feature = "opt-prebuilt-built-state")]
    pub(crate) fn prebuilt_slot_image(&self) -> Option<(usize, Vec<(u32, u64)>)> {
        #[cfg(feature = "opt-compact-ranks")]
        {
            None
        }
        #[cfg(not(feature = "opt-compact-ranks"))]
        {
            Some((
                self.slots.len(),
                self.slots
                    .iter()
                    .enumerate()
                    .filter_map(|(index, packed)| {
                        (*packed != u64::MAX).then_some((index as u32, *packed))
                    })
                    .collect(),
            ))
        }
    }

    /// Build the two-level table, or `None` when this vocabulary cannot use
    /// it (IDs too large for the packed key, or pathological clustering in
    /// the flat table) , the caller then falls back to the hashbrown map.
    pub(crate) fn build<S: std::hash::BuildHasher>(
        merges: &HashMap<(TokenId, TokenId), TokenId, S>,
        byte_remapping: Option<&ByteRemapping>,
        vocab_len: usize,
    ) -> Option<Self> {
        // Key packing needs every ID that can appear as a merge-loop symbol
        // (byte-token IDs and merged IDs are all vocab IDs) below 2^21. The
        // per-merge check is defensive: `merges` is caller-supplied and need
        // not be consistent with `vocab_len`.
        if vocab_len > 1 << PAIR_ID_BITS {
            return None;
        }
        let id_limit = 1u32 << PAIR_ID_BITS;
        if merges
            .iter()
            .any(|(&(a, b), &m)| a.0 >= id_limit || b.0 >= id_limit || m.0 >= id_limit)
        {
            return None;
        }

        #[cfg(feature = "opt-compact-ranks")]
        {
            let _ = byte_remapping;
            return compact_pair_ranks::CompactPairRankTable::build(merges)
                .map(|compact| PairRankTable { compact });
        }

        #[cfg(not(feature = "opt-compact-ranks"))]
        {
            // Dense level covering every pair with both sides < 2^11. This
            // includes the initial byte tokens and the earliest merged IDs,
            // which by merge order are the most frequent symbols in the loop.
            // Round-1 lookups plus the bulk of mid-merge lookups become one
            // shift-or index and one load into a 16 MiB, L3-resident,
            // Arc-shared grid. A vocabulary with byte tokens above the grid
            // keeps correctness because those lookups use the flat table.
            let max_initial =
                byte_remapping.map_or(255, |br| br.mapping.iter().map(|t| t.0).max().unwrap_or(0));
            let dense_log2 = (32 - max_initial.leading_zeros()).clamp(11, 11);
            let mut dense = vec![u32::MAX; 1usize << (2 * dense_log2)].into_boxed_slice();

            // Flat level holds all merges, including the dense subset, at no
            // more than one-half load. It is a complete map on its own.
            let n_slots = (merges.len().max(1) * 2).next_power_of_two().max(64);
            let shift = 64 - n_slots.trailing_zeros();
            let mask = n_slots - 1;
            let mut slots = vec![u64::MAX; n_slots].into_boxed_slice();
            for (&(a, b), &m) in merges {
                if (a.0 | b.0) >> dense_log2 == 0 {
                    dense[((a.0 as usize) << dense_log2) | b.0 as usize] = m.0;
                }
                let key = ((a.0 as u64) << PAIR_ID_BITS) | b.0 as u64;
                let mut idx = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> shift) as usize;
                let mut displacement = 0usize;
                while slots[idx] != u64::MAX {
                    idx = (idx + 1) & mask;
                    displacement += 1;
                    // Ugly clustering has not appeared on real vocabularies
                    // at this load factor. Fall back instead of degrading
                    // every miss lookup.
                    if displacement > 64 {
                        return None;
                    }
                }
                // Merged IDs are < 2^21 (checked above), so key and value pack
                // into 63 bits without overlap.
                slots[idx] = (key << PAIR_ID_BITS) | m.0 as u64;
            }

            Some(PairRankTable {
                dense,
                dense_log2,
                slots,
                mask,
                shift,
            })
        }
    }

    pub(crate) fn with_capacity(
        byte_remapping: Option<&ByteRemapping>,
        vocab_len: usize,
        merge_count: usize,
    ) -> Option<Self> {
        if vocab_len > 1 << PAIR_ID_BITS {
            return None;
        }

        #[cfg(feature = "opt-compact-ranks")]
        {
            let _ = byte_remapping;
            return Some(PairRankTable {
                compact: compact_pair_ranks::CompactPairRankTable::with_capacity(merge_count),
            });
        }

        #[cfg(not(feature = "opt-compact-ranks"))]
        {
            // Dense level covering every pair with both sides < 2^11. This
            // includes the initial byte tokens and the earliest merged IDs,
            // which by merge order are the most frequent symbols in the loop.
            // Round-1 lookups plus the bulk of mid-merge lookups become one
            // shift-or index and one load into a 16 MiB, L3-resident,
            // Arc-shared grid. A vocabulary with byte tokens above the grid
            // keeps correctness because those lookups use the flat table.
            let max_initial =
                byte_remapping.map_or(255, |br| br.mapping.iter().map(|t| t.0).max().unwrap_or(0));
            let dense_log2 = (32 - max_initial.leading_zeros()).clamp(11, 11);
            let dense = vec![u32::MAX; 1usize << (2 * dense_log2)].into_boxed_slice();

            // Flat level reserves all merges, including the dense subset, at no
            // more than one-half load. It is a complete map on its own.
            let n_slots = (merge_count.max(1) * 2).next_power_of_two().max(64);
            let shift = 64 - n_slots.trailing_zeros();
            let mask = n_slots - 1;
            let slots = vec![u64::MAX; n_slots].into_boxed_slice();

            Some(PairRankTable {
                dense,
                dense_log2,
                slots,
                mask,
                shift,
            })
        }
    }

    pub(crate) fn insert(&mut self, left: TokenId, right: TokenId, merged: TokenId) -> bool {
        let id_limit = 1u32 << PAIR_ID_BITS;
        if left.0 >= id_limit || right.0 >= id_limit || merged.0 >= id_limit {
            return false;
        }

        #[cfg(feature = "opt-compact-ranks")]
        {
            return self.compact.insert(left, right, merged);
        }

        #[cfg(not(feature = "opt-compact-ranks"))]
        {
            let key = ((left.0 as u64) << PAIR_ID_BITS) | right.0 as u64;
            let mut idx = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
            let mut displacement = 0usize;
            loop {
                let packed = self.slots[idx];
                if packed == u64::MAX {
                    self.slots[idx] = (key << PAIR_ID_BITS) | merged.0 as u64;
                    if (left.0 | right.0) >> self.dense_log2 == 0 {
                        self.dense[((left.0 as usize) << self.dense_log2) | right.0 as usize] =
                            merged.0;
                    }
                    return true;
                }
                if packed >> PAIR_ID_BITS == key {
                    return false;
                }
                idx = (idx + 1) & self.mask;
                displacement += 1;
                if displacement > 64 {
                    return false;
                }
            }
        }
    }

    /// Every merge stored in the complete flat level.
    ///
    /// The dense grid is only a lookup accelerator. The flat slots remain a
    /// complete representation, so model introspection does not need the
    /// construction-time hash map after this table is built.
    pub(crate) fn entries(&self) -> impl Iterator<Item = (TokenId, TokenId, TokenId)> + '_ {
        #[cfg(feature = "opt-compact-ranks")]
        {
            return self.compact.entries();
        }
        #[cfg(not(feature = "opt-compact-ranks"))]
        {
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
    }

    /// Merged token ID of the pair `(a, b)`, or `u32::MAX` when it does not
    /// merge , the same convention as probing the merges map.
    #[inline(always)]
    pub(crate) fn rank(&self, a: TokenId, b: TokenId) -> u32 {
        #[cfg(feature = "opt-compact-ranks")]
        {
            return self.compact.rank(a, b);
        }
        #[cfg(not(feature = "opt-compact-ranks"))]
        {
            if (a.0 | b.0) >> self.dense_log2 == 0 {
                let idx = ((a.0 as usize) << self.dense_log2) | b.0 as usize;
                // SAFETY: both IDs < 2^dense_log2, so idx < 2^(2*dense_log2)
                // == dense.len().
                return unsafe { *self.dense.get_unchecked(idx) };
            }
            let key = ((a.0 as u64) << PAIR_ID_BITS) | b.0 as u64;
            let mut idx = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
            loop {
                // SAFETY: idx starts < slots.len() (shift keeps log2(len) bits)
                // and stays masked.
                let slot = unsafe { *self.slots.get_unchecked(idx) };
                // One load answers both hit and value: the key rides in the
                // slot's top 43 bits, the merged ID in the low 21. The empty
                // sentinel's key field (u64::MAX >> 21) exceeds every real
                // 42-bit key, so it never false-hits.
                if slot >> PAIR_ID_BITS == key {
                    return (slot & ((1 << PAIR_ID_BITS) - 1)) as u32;
                }
                if slot == u64::MAX {
                    return u32::MAX;
                }
                idx = (idx + 1) & self.mask;
            }
        }
    }

    #[cfg(feature = "profiling")]
    #[inline(always)]
    pub(crate) fn rank_profiled(
        &self,
        a: TokenId,
        b: TokenId,
        counters: &mut crate::profiling::RankCounters,
    ) -> u32 {
        #[cfg(feature = "opt-compact-ranks")]
        {
            return self.compact.rank_profiled(a, b, counters);
        }
        #[cfg(not(feature = "opt-compact-ranks"))]
        {
            counters.id_rank_lookups += 1;
            if (a.0 | b.0) >> self.dense_log2 == 0 {
                counters.dense_lookups += 1;
                let idx = ((a.0 as usize) << self.dense_log2) | b.0 as usize;
                // SAFETY: both IDs are inside the dense grid, as checked above.
                let rank = unsafe { *self.dense.get_unchecked(idx) };
                counters.dense_hits += u64::from(rank != u32::MAX);
                return rank;
            }
            counters.sparse_lookups += 1;
            let key = ((a.0 as u64) << PAIR_ID_BITS) | b.0 as u64;
            let mut idx = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
            let mut steps = 0_u64;
            let rank = loop {
                steps += 1;
                // SAFETY: idx starts inside the table and remains masked.
                let slot = unsafe { *self.slots.get_unchecked(idx) };
                if slot >> PAIR_ID_BITS == key {
                    break (slot & ((1 << PAIR_ID_BITS) - 1)) as u32;
                }
                if slot == u64::MAX {
                    break u32::MAX;
                }
                idx = (idx + 1) & self.mask;
            };
            counters.sparse_probe_steps += steps;
            counters.sparse_probe_max = counters.sparse_probe_max.max(steps);
            rank
        }
    }

    /// `prefetcht0` the first line [`Self::rank`] would load for `(a, b)`:
    /// the dense cell when both sides sit in the grid, else the first
    /// sparse probe slot. The short-merge loop's refresh lookups sit on a
    /// serial dependency chain and their slot-load consumers are ~5-7% of
    /// cold cycles on Zen 5 (profiling/zen5_st_profile.md §4.3); both
    /// refresh pairs are known before the list surgery, so issuing their
    /// prefetches first overlaps the load latency with the surgery and
    /// with each other. Address math mirrors `rank` exactly (same bounds:
    /// dense idx < dense.len(), slot idx < slots.len() via `shift`), so
    /// every prefetched address lies within the table's allocations.
    /// x86_64 only; a no-op elsewhere (aarch64 uses the NEON merge core).
    #[inline(always)]
    pub(crate) fn prefetch_rank(&self, a: TokenId, b: TokenId) {
        #[cfg(all(feature = "opt-compact-ranks", target_arch = "x86_64"))]
        // SAFETY: `_mm_prefetch` does not dereference, and the helper returns
        // an address inside the live flat-slot allocation.
        unsafe {
            use core::arch::x86_64::{_MM_HINT_T0, _mm_prefetch};
            _mm_prefetch(self.compact.first_slot_address(a, b), _MM_HINT_T0);
        }
        #[cfg(all(feature = "opt-compact-ranks", not(target_arch = "x86_64")))]
        let _ = (a, b);
        #[cfg(not(feature = "opt-compact-ranks"))]
        {
            #[cfg(target_arch = "x86_64")]
            // SAFETY: `_mm_prefetch` does not dereference; both index
            // computations are the bounded ones from `rank` (see its SAFETY
            // comments), so the address stays inside the live allocation.
            unsafe {
                use core::arch::x86_64::{_MM_HINT_T0, _mm_prefetch};
                let addr = if (a.0 | b.0) >> self.dense_log2 == 0 {
                    let idx = ((a.0 as usize) << self.dense_log2) | b.0 as usize;
                    self.dense.as_ptr().add(idx) as *const i8
                } else {
                    let key = ((a.0 as u64) << PAIR_ID_BITS) | b.0 as u64;
                    let idx = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
                    self.slots.as_ptr().add(idx) as *const i8
                };
                _mm_prefetch(addr, _MM_HINT_T0);
            }
            #[cfg(not(target_arch = "x86_64"))]
            let _ = (a, b);
        }
    }

    #[cfg(all(test, feature = "opt-compact-ranks"))]
    fn resident_bytes(&self) -> usize {
        self.compact.resident_bytes()
    }
}

// ---------------------------------------------------------------------------
// Shared BPE merge functions
// ---------------------------------------------------------------------------

/// Reusable scratch buffers for [`bpe_merge_symbols_with_scratch`]. Holding one
/// of these across calls means the hot encode loop performs no per-pretoken
/// allocations for the linked list or the merge heap.
#[derive(Default)]
pub struct MergeScratch {
    next: Vec<u32>,
    prev: Vec<u32>,
    heap: Vec<std::cmp::Reverse<u64>>,
}

/// Pack a heap entry as `(merged_token << 32) | position`. `u64` ordering then
/// matches the old `(TokenId, usize)` tuple ordering (token ID first, position
/// as tie-break) while halving the element size the heap has to shuffle.
#[inline(always)]
fn pack_merge_entry(merged: TokenId, pos: u32) -> u64 {
    ((merged.0 as u64) << 32) | pos as u64
}

/// Apply BPE merges to an already-initialized symbol sequence.
/// Priority is determined by the merged token's ID (lower = first).
/// This is correct for tiktoken-style tokenizers where vocab ID equals merge rank.
///
/// Uses a min-heap + doubly-linked list for O(n log n) performance.
pub fn bpe_merge_symbols<S: std::hash::BuildHasher>(
    merges: &HashMap<(TokenId, TokenId), TokenId, S>,
    symbols: &mut Vec<TokenId>,
) {
    bpe_merge_symbols_with_scratch(merges, symbols, &mut MergeScratch::default());
}

/// Like [`bpe_merge_symbols`], but reuses caller-provided scratch buffers so
/// repeated calls (one per cache-missing pretoken) do not allocate. Merges
/// `symbols` in place.
pub fn bpe_merge_symbols_with_scratch<S: std::hash::BuildHasher>(
    merges: &HashMap<(TokenId, TokenId), TokenId, S>,
    symbols: &mut Vec<TokenId>,
    scratch: &mut MergeScratch,
) {
    bpe_merge_symbols_by_rank(
        &|a, b| merges.get(&(a, b)).map_or(u32::MAX, |m| m.0),
        symbols,
        scratch,
    );
}

/// Shared merge loop, generic over the pair-rank lookup: `get_rank` returns
/// the merged token's ID (== merge priority for tiktoken-style vocabs) or
/// `u32::MAX` when the pair does not merge.
// Out of line: this only runs on pretoken-cache misses (~0.7% of
// pretokens on OWT), and inlining its bulk into the encode loop costs
// more in I-cache and register pressure there than a call costs here.
#[inline(never)]
pub(crate) fn bpe_merge_symbols_by_rank(
    get_rank: &impl Fn(TokenId, TokenId) -> u32,
    symbols: &mut Vec<TokenId>,
    scratch: &mut MergeScratch,
) {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let n = symbols.len();
    if n < 2 {
        return;
    }

    // For short sequences (the overwhelming majority of pretokens), a linear
    // rank scan has far lower constants than heap + linked list.
    if n <= SMALL_MERGE_MAX {
        bpe_merge_symbols_small(get_rank, symbols);
        return;
    }

    // Doubly-linked list via u32 index arrays (pretokens are far shorter than
    // 2^32 symbols).
    const NONE: u32 = u32::MAX;
    let next = &mut scratch.next;
    let prev = &mut scratch.prev;
    next.clear();
    next.extend(1..n as u32);
    next.push(NONE);
    prev.clear();
    prev.push(NONE);
    prev.extend(0..n as u32 - 1);

    // Min-heap of packed (merged_token_id, position). Lower ID = higher
    // priority. Seed with all initial pairs, then heapify in O(n) instead of
    // pushing one at a time.
    let mut seeds = std::mem::take(&mut scratch.heap);
    seeds.clear();
    for i in 0..n - 1 {
        let m = get_rank(symbols[i], symbols[i + 1]);
        if m != u32::MAX {
            seeds.push(Reverse(pack_merge_entry(TokenId(m), i as u32)));
        }
    }
    let mut heap: BinaryHeap<Reverse<u64>> = BinaryHeap::from(seeds);

    while let Some(Reverse(entry)) = heap.pop() {
        let pos = (entry & u32::MAX as u64) as usize;
        let expected_merged = (entry >> 32) as u32;
        // Validate: pos must still be active and its right neighbor must exist
        let right = next[pos];
        if right == NONE {
            continue;
        }
        let right = right as usize;
        // Check the pair still matches (it may have been invalidated by an
        // earlier merge). A no-merge result (u32::MAX) never equals the
        // expected merged ID, since only real merges are pushed.
        let merged = get_rank(symbols[pos], symbols[right]);
        if merged == expected_merged {
            // Apply the merge
            symbols[pos] = TokenId(merged);
            let right_right = next[right];
            next[pos] = right_right;
            if right_right != NONE {
                prev[right_right as usize] = pos as u32;
            }
            // `next[right] = NONE` invalidates any stale heap entries at
            // `right`; nothing reads `prev[right]` once it is unlinked.
            next[right] = NONE;

            // Re-check pair with left neighbor
            let left = prev[pos];
            if left != NONE {
                let m = get_rank(symbols[left as usize], symbols[pos]);
                if m != u32::MAX {
                    heap.push(Reverse(pack_merge_entry(TokenId(m), left)));
                }
            }
            // Re-check pair with new right neighbor
            if next[pos] != NONE {
                let m = get_rank(symbols[pos], symbols[next[pos] as usize]);
                if m != u32::MAX {
                    heap.push(Reverse(pack_merge_entry(TokenId(m), pos as u32)));
                }
            }
        }
    }
    // The pop loop drained the heap; keep its capacity for the next call.
    scratch.heap = heap.into_vec();

    // Compact surviving symbols in place. Surviving indices are strictly
    // increasing and the k-th survivor has index >= k, so writes never
    // overtake reads.
    let mut write = 0;
    let mut i = 0;
    loop {
        symbols[write] = symbols[i];
        write += 1;
        if next[i] == NONE {
            break;
        }
        i = next[i] as usize;
    }
    symbols.truncate(write);
}

/// Sequences up to this length use the linear-scan merge instead of the heap.
const SMALL_MERGE_MAX: usize = 32;

/// BPE merge for short sequences (n <= SMALL_MERGE_MAX), in the style of
/// tiktoken's `byte_pair_merge`: keep a per-position rank (the merged token ID
/// of the pair starting there, or `u32::MAX`), find the minimum by linear scan,
/// merge, and recompute only the two affected neighbor ranks. The scan over a
/// few stack-resident `u32`s beats a `BinaryHeap`'s sift traffic at these
/// sizes, and merge priority (lowest merged ID, then lowest position) is
/// identical to the heap version's ordering.
///
/// One of three deliberately separate small-merge cores with disjoint
/// domains: this Vec-based one handles 16..=32 symbols via
/// `bpe_merge_symbols_by_rank` (the long-pretoken miss path); pretokens of
/// <= 15 symbols go straight to `bpe_merge_symbols_short_scalar` /
/// `bpe_merge_symbols_short_neon`. Unifying them was measured as a
/// regression risk to the tuned short-miss path.
fn bpe_merge_symbols_small(
    get_rank: &impl Fn(TokenId, TokenId) -> u32,
    symbols: &mut Vec<TokenId>,
) {
    let n = symbols.len();
    debug_assert!((2..=SMALL_MERGE_MAX).contains(&n));
    // Stack-resident doubly-linked list, so a merge is O(1) pointer updates
    // instead of shifting the tail (which lowers to a libc memmove call).
    // Sentinels: next[last] == n, prev[0] == u8::MAX; both fail `< n` checks.
    let mut next = [0u8; SMALL_MERGE_MAX];
    let mut prev = [0u8; SMALL_MERGE_MAX];
    for i in 0..n {
        next[i] = (i + 1) as u8;
        prev[i] = (i as u8).wrapping_sub(1);
    }
    // ranks[i] = priority of merging the pair starting at active position i;
    // MAX when there is no merge or the position was merged away.
    let mut ranks = [u32::MAX; SMALL_MERGE_MAX];
    for i in 0..n - 1 {
        ranks[i] = get_rank(symbols[i], symbols[i + 1]);
    }
    loop {
        let mut best = u32::MAX;
        let mut best_i = 0;
        for (i, &rank) in ranks[..n - 1].iter().enumerate() {
            if rank < best {
                best = rank;
                best_i = i;
            }
        }
        if best == u32::MAX {
            break;
        }
        let i = best_i;
        symbols[i] = TokenId::from(best);
        // Unlink the right element of the merged pair.
        let dead = next[i] as usize;
        let new_right = next[dead] as usize;
        next[i] = new_right as u8;
        ranks[dead] = u32::MAX;
        // Refresh the two pairs now touching the merged symbol.
        if new_right < n {
            prev[new_right] = i as u8;
            ranks[i] = get_rank(symbols[i], symbols[new_right]);
        } else {
            ranks[i] = u32::MAX;
        }
        let left = prev[i] as usize;
        if left < n {
            ranks[left] = get_rank(symbols[left], symbols[i]);
        }
    }
    // Compact survivors in place: list indices are strictly increasing, so
    // writes never overtake reads.
    let mut write = 0;
    let mut i = 0;
    while i < n {
        symbols[write] = symbols[i];
        write += 1;
        i = next[i] as usize;
    }
    symbols.truncate(write);
}

/// Symbol capacity of the stack-array short merges: short pretokens are
/// ≤ 15 bytes, so at most 15 initial symbols.
pub(crate) const SHORT_MERGE_MAX: usize = 16;

/// [`bpe_merge_symbols_small`] over a caller-owned stack array instead of
/// the `Vec` scratch (no bounds/capacity code, no extend memmove) , the
/// short-pretoken miss path's merge. Returns the merged length.
///
/// The non-aarch64 core of the short-miss domain (<= 15 symbols, called
/// from the tiktoken encode loop); aarch64 uses
/// [`bpe_merge_symbols_short_neon`] when a [`PairRankTable`] is available.
/// Kept separate from the Vec-based [`bpe_merge_symbols_small`] (16..=32
/// symbols): the domains are disjoint and unification was measured as a
/// regression risk to this tuned miss path.
///
/// `prefetch_rank` is [`PairRankTable::prefetch_rank`] when a table backs
/// `get_rank`, and a no-op closure for the HashMap fallback , the merge
/// scan itself stays identical either way (restructuring it was measured
/// negative; the prefetch only reorders when the refresh loads issue).
pub(crate) fn bpe_merge_symbols_short_scalar(
    get_rank: impl Fn(TokenId, TokenId) -> u32,
    prefetch_rank: impl Fn(TokenId, TokenId),
    symbols: &mut [TokenId; SHORT_MERGE_MAX],
    n: usize,
) -> usize {
    debug_assert!((2..=SHORT_MERGE_MAX - 1).contains(&n));
    // Stack-resident doubly-linked list; see `bpe_merge_symbols_small`.
    let mut next = [0u8; SHORT_MERGE_MAX];
    let mut prev = [0u8; SHORT_MERGE_MAX];
    for i in 0..n {
        next[i] = (i + 1) as u8;
        prev[i] = (i as u8).wrapping_sub(1);
    }
    // ranks[i] = priority of merging the pair starting at active position i;
    // MAX when there is no merge or the position was merged away.
    let mut ranks = [u32::MAX; SHORT_MERGE_MAX];
    for i in 0..n - 1 {
        ranks[i] = get_rank(symbols[i], symbols[i + 1]);
    }
    loop {
        let mut best = u32::MAX;
        let mut best_i = 0;
        for (i, &rank) in ranks[..n - 1].iter().enumerate() {
            if rank < best {
                best = rank;
                best_i = i;
            }
        }
        if best == u32::MAX {
            break;
        }
        let i = best_i;
        // Both refresh pairs are fixed the moment `best` is chosen:
        // (best, symbols[new_right]) and (symbols[left], best). Their rank
        // lines are the serial chain's next loads (their consumers are
        // ~5-7% of cold cycles, profiling/zen5_st_profile.md §4.3), so
        // request both before the list surgery. List indices are strictly
        // increasing, so new_right > i and the surgery's `prev[new_right]`
        // store cannot alias `prev[i]` , reading `left` early is safe.
        // `symbols[new_right]` / `symbols[left]` are read only behind the
        // same `< n` guards the refresh uses: active positions holding
        // live tokens, never garbage lanes.
        let dead = next[i] as usize;
        let new_right = next[dead] as usize;
        let left = prev[i] as usize;
        if new_right < n {
            prefetch_rank(TokenId(best), symbols[new_right]);
        }
        if left < n {
            prefetch_rank(symbols[left], TokenId(best));
        }
        symbols[i] = TokenId(best);
        // Unlink the right element of the merged pair.
        next[i] = new_right as u8;
        ranks[dead] = u32::MAX;
        // Refresh the two pairs now touching the merged symbol.
        if new_right < n {
            prev[new_right] = i as u8;
            ranks[i] = get_rank(symbols[i], symbols[new_right]);
        } else {
            ranks[i] = u32::MAX;
        }
        if left < n {
            ranks[left] = get_rank(symbols[left], symbols[i]);
        }
    }
    // Compact survivors in place: list indices are strictly increasing, so
    // writes never overtake reads.
    let mut write = 0;
    let mut i = 0;
    while i < n {
        symbols[write] = symbols[i];
        write += 1;
        i = next[i] as usize;
    }
    write
}

/// [`bpe_merge_symbols_short_scalar`] with a branchless NEON min-rank scan.
/// Rank and position share one lane, `pr[i] = (rank << 8) | i`, so the
/// vector minimum selects the lowest rank with ties broken by the lowest
/// position , exactly the scalar scan's order. Real ranks are < 2^21 (a
/// [`PairRankTable`] build invariant, which is why this variant requires
/// one), so packed lanes are < 2^29 and "no merge" (`u32::MAX << 8`, from
/// the wrapping shift of the MAX sentinel) sorts above every real lane.
/// The scan covers 16 lanes with inactive lanes parked at `u32::MAX` ,
/// four loads, three `vmin`s, one `vminv`, zero data-dependent branches on
/// a core where the scalar scan's `rank < best` mispredicts freely. Every
/// live lane index is `< n` (pairs start below `n` and merges only clear
/// lanes), so when `n <= 8` the scan reads just the first two vectors ,
/// the width branch is hoisted out of the loop and fixed per call.
///
/// The aarch64 core of the short-miss domain (<= 15 symbols, called from
/// the tiktoken encode loop); other arches use
/// [`bpe_merge_symbols_short_scalar`], and 16..=32-symbol sequences take
/// the Vec-based [`bpe_merge_symbols_small`] , the three are deliberately
/// not unified (disjoint domains; see `bpe_merge_symbols_short_scalar`).
#[cfg(target_arch = "aarch64")]
pub(crate) fn bpe_merge_symbols_short_neon(
    table: &PairRankTable,
    symbols: &mut [TokenId; SHORT_MERGE_MAX],
    n: usize,
) -> usize {
    use core::arch::aarch64::{vld1q_u32, vminq_u32, vminvq_u32};
    debug_assert!((2..=SHORT_MERGE_MAX - 1).contains(&n));
    /// Every packed value at or above this has rank u32::MAX (no merge).
    const NO_MERGE_FLOOR: u32 = u32::MAX << 8;
    let pack = |rank: u32, i: usize| (rank << 8) | i as u32;
    // Stack-resident doubly-linked list; see `bpe_merge_symbols_small`.
    let mut next = [0u8; SHORT_MERGE_MAX];
    let mut prev = [0u8; SHORT_MERGE_MAX];
    for i in 0..n {
        next[i] = (i + 1) as u8;
        prev[i] = (i as u8).wrapping_sub(1);
    }
    // pr[i] = packed (rank, position) of the pair starting at active
    // position i; the only array the scan reads.
    let mut pr = [u32::MAX; SHORT_MERGE_MAX];
    for i in 0..n - 1 {
        pr[i] = pack(table.rank(symbols[i], symbols[i + 1]), i);
    }
    // Lanes at index >= n stay u32::MAX forever (initial pairs sit below
    // n - 1; the loop below only writes lanes < n), so short pretokens
    // need only the first half of the scan.
    let narrow = n <= 8;
    loop {
        // SAFETY: pr is 16 contiguous u32s; vld1q_u32 has no alignment
        // requirement beyond u32's.
        let best = unsafe {
            let p = pr.as_ptr();
            let m01 = vminq_u32(vld1q_u32(p), vld1q_u32(p.add(4)));
            let m = if narrow {
                m01
            } else {
                let m23 = vminq_u32(vld1q_u32(p.add(8)), vld1q_u32(p.add(12)));
                vminq_u32(m01, m23)
            };
            vminvq_u32(m)
        };
        if best >= NO_MERGE_FLOOR {
            break;
        }
        let i = (best & 0xFF) as usize;
        symbols[i] = TokenId(best >> 8);
        // Unlink the right element of the merged pair.
        let dead = next[i] as usize;
        let new_right = next[dead] as usize;
        next[i] = new_right as u8;
        pr[dead] = u32::MAX;
        // Refresh the two pairs now touching the merged symbol.
        if new_right < n {
            prev[new_right] = i as u8;
            pr[i] = pack(table.rank(symbols[i], symbols[new_right]), i);
        } else {
            pr[i] = u32::MAX;
        }
        let left = prev[i] as usize;
        if left < n {
            pr[left] = pack(table.rank(symbols[left], symbols[i]), left);
        }
    }
    // Compact survivors in place.
    let mut write = 0;
    let mut i = 0;
    while i < n {
        symbols[write] = symbols[i];
        write += 1;
        i = next[i] as usize;
    }
    write
}

/// AVX-512 port of [`bpe_merge_symbols_short_neon`]: the whole 4-load,
/// 3-`vmin`, 1-`vminv` scan collapses to one 64-byte `pr` load and one
/// `vpminud` reduction tree , all 16 lanes in a single zmm, so there is no
/// narrow/wide split to hoist (lanes at index >= n are parked at
/// `u32::MAX` and never win). Packing, list surgery, and tie-break order
/// are identical to the NEON and scalar variants (see
/// [`bpe_merge_symbols_short_neon`] for the lane-packing invariants).
///
/// NOT dispatched by the miss path: measured ~1% slower than the scalar
/// scan on cold encode_st (Zen 5 / 9800X3D, gpt2, 100 MB and 1 GB OWT,
/// interleaved min-of-5, runtime-dispatched baseline build). The x86
/// horizontal reduce is a 4-dependent-op chain plus a vector→GPR `vmovd`
/// on the merge loop's serial chain, the `target_feature` boundary costs
/// a real call per short merge (NEON needs no gate and inlines), and the
/// scalar scan's `rank < best` branch predicts well on Zen 5 at typical
/// n ≈ 4-6 , the mispredict pressure that made the NEON scan win on M4
/// is absent. Kept, with the AVX2 tier below, as a tested reference
/// (differential-covered by `short_merges_match_vec_merge_loop`); see
/// profiling/x86_port_plan.md §6.
#[cfg(target_arch = "x86_64")]
#[cfg_attr(not(test), allow(dead_code))]
#[target_feature(enable = "avx512f")]
fn bpe_merge_symbols_short_avx512(
    table: &PairRankTable,
    symbols: &mut [TokenId; SHORT_MERGE_MAX],
    n: usize,
) -> usize {
    use core::arch::x86_64::{_mm512_loadu_si512, _mm512_reduce_min_epu32};
    debug_assert!((2..=SHORT_MERGE_MAX - 1).contains(&n));
    /// Every packed value at or above this has rank u32::MAX (no merge).
    const NO_MERGE_FLOOR: u32 = u32::MAX << 8;
    let pack = |rank: u32, i: usize| (rank << 8) | i as u32;
    // Stack-resident doubly-linked list; see `bpe_merge_symbols_small`.
    let mut next = [0u8; SHORT_MERGE_MAX];
    let mut prev = [0u8; SHORT_MERGE_MAX];
    for i in 0..n {
        next[i] = (i + 1) as u8;
        prev[i] = (i as u8).wrapping_sub(1);
    }
    // pr[i] = packed (rank, position) of the pair starting at active
    // position i; the only array the scan reads.
    let mut pr = [u32::MAX; SHORT_MERGE_MAX];
    for i in 0..n - 1 {
        pr[i] = pack(table.rank(symbols[i], symbols[i + 1]), i);
    }
    loop {
        // SAFETY: pr is 16 contiguous u32s (64 bytes); the unaligned-load
        // intrinsic has no alignment requirement.
        let best = unsafe { _mm512_reduce_min_epu32(_mm512_loadu_si512(pr.as_ptr() as *const _)) };
        if best >= NO_MERGE_FLOOR {
            break;
        }
        let i = (best & 0xFF) as usize;
        symbols[i] = TokenId(best >> 8);
        // Unlink the right element of the merged pair.
        let dead = next[i] as usize;
        let new_right = next[dead] as usize;
        next[i] = new_right as u8;
        pr[dead] = u32::MAX;
        // Refresh the two pairs now touching the merged symbol.
        if new_right < n {
            prev[new_right] = i as u8;
            pr[i] = pack(table.rank(symbols[i], symbols[new_right]), i);
        } else {
            pr[i] = u32::MAX;
        }
        let left = prev[i] as usize;
        if left < n {
            pr[left] = pack(table.rank(symbols[left], symbols[i]), left);
        }
    }
    // Compact survivors in place.
    let mut write = 0;
    let mut i = 0;
    while i < n {
        symbols[write] = symbols[i];
        write += 1;
        i = next[i] as usize;
    }
    write
}

/// AVX2 tier of the short merge (Haswell+, Zen 1-3): two 32-byte `pr`
/// loads and one `vpminud`, then a 4-step horizontal min (extract + 3
/// shuffled mins) in place of NEON's `vminv`. The NEON narrow split is
/// kept: `n <= 8` reads one ymm and skips the cross-vector min. Packing,
/// list surgery, and tie-break order are identical to the other variants.
///
/// NOT dispatched , same measured-slower verdict as the AVX-512 tier
/// above (whose doc has the numbers and the why).
#[cfg(target_arch = "x86_64")]
#[cfg_attr(not(test), allow(dead_code))]
#[target_feature(enable = "avx2")]
fn bpe_merge_symbols_short_avx2(
    table: &PairRankTable,
    symbols: &mut [TokenId; SHORT_MERGE_MAX],
    n: usize,
) -> usize {
    use core::arch::x86_64::*;
    debug_assert!((2..=SHORT_MERGE_MAX - 1).contains(&n));
    /// Every packed value at or above this has rank u32::MAX (no merge).
    const NO_MERGE_FLOOR: u32 = u32::MAX << 8;
    let pack = |rank: u32, i: usize| (rank << 8) | i as u32;
    // Stack-resident doubly-linked list; see `bpe_merge_symbols_small`.
    let mut next = [0u8; SHORT_MERGE_MAX];
    let mut prev = [0u8; SHORT_MERGE_MAX];
    for i in 0..n {
        next[i] = (i + 1) as u8;
        prev[i] = (i as u8).wrapping_sub(1);
    }
    // pr[i] = packed (rank, position) of the pair starting at active
    // position i; the only array the scan reads.
    let mut pr = [u32::MAX; SHORT_MERGE_MAX];
    for i in 0..n - 1 {
        pr[i] = pack(table.rank(symbols[i], symbols[i + 1]), i);
    }
    // Lanes at index >= n stay u32::MAX forever, so short pretokens need
    // only the first ymm of the scan; the width branch is hoisted out of
    // the loop and fixed per call.
    let narrow = n <= 8;
    loop {
        // SAFETY: pr is 16 contiguous u32s; unaligned loads.
        let best = unsafe {
            let p = pr.as_ptr() as *const __m256i;
            let m = if narrow {
                _mm256_loadu_si256(p)
            } else {
                _mm256_min_epu32(_mm256_loadu_si256(p), _mm256_loadu_si256(p.add(1)))
            };
            // Horizontal min of 8 u32 lanes: fold 256 -> 128, then two
            // shuffled mins; lane 0 holds the minimum.
            let m128 = _mm_min_epu32(_mm256_castsi256_si128(m), _mm256_extracti128_si256::<1>(m));
            let m128 = _mm_min_epu32(m128, _mm_shuffle_epi32::<0b01_00_11_10>(m128));
            let m128 = _mm_min_epu32(m128, _mm_shuffle_epi32::<0b00_00_00_01>(m128));
            _mm_cvtsi128_si32(m128) as u32
        };
        if best >= NO_MERGE_FLOOR {
            break;
        }
        let i = (best & 0xFF) as usize;
        symbols[i] = TokenId(best >> 8);
        // Unlink the right element of the merged pair.
        let dead = next[i] as usize;
        let new_right = next[dead] as usize;
        next[i] = new_right as u8;
        pr[dead] = u32::MAX;
        // Refresh the two pairs now touching the merged symbol.
        if new_right < n {
            prev[new_right] = i as u8;
            pr[i] = pack(table.rank(symbols[i], symbols[new_right]), i);
        } else {
            pr[i] = u32::MAX;
        }
        let left = prev[i] as usize;
        if left < n {
            pr[left] = pack(table.rank(symbols[left], symbols[i]), left);
        }
    }
    // Compact survivors in place.
    let mut write = 0;
    let mut i = 0;
    while i < n {
        symbols[write] = symbols[i];
        write += 1;
        i = next[i] as usize;
    }
    write
}

/// Vocabulary entries as `(id, bytes)` pairs in ID order, skipping IDs with
/// no assigned content. Shared by both tokenizer types' `vocab_entries`.
pub(crate) fn vocab_entries<T: AsRef<[u8]>>(vocab: &[T]) -> impl Iterator<Item = (u32, &[u8])> {
    vocab
        .iter()
        .enumerate()
        .filter(|(_, bytes)| !bytes.as_ref().is_empty())
        .map(|(id, bytes)| (id as u32, bytes.as_ref()))
}

/// Pack a ranked-merge pair key into one `u64`: hashing it is a single
/// multiply instead of a two-round tuple hash, and the merge loop probes this
/// map ~2x per symbol.
#[inline(always)]
pub fn ranked_merge_key(a: TokenId, b: TokenId) -> u64 {
    ((a.0 as u64) << 32) | b.0 as u64
}

/// Ranked-merge variant of [`bpe_merge_symbols_small`]: allocation-free BPE
/// for short symbol sequences (the overwhelming majority of cache-missing
/// units), with priority taken from the merge table's explicit rank. Also
/// the stack-buffer miss path of the ByteLevel tokenizer for rank-mapped
/// vocabularies (see `ranked_merges` there). Merges `symbols` in place and
/// returns the surviving count; the caller truncates or slices to it.
pub(crate) fn bpe_merge_symbols_ranked_slice<S: std::hash::BuildHasher>(
    merges: &HashMap<u64, (TokenId, u32), S>,
    symbols: &mut [TokenId],
) -> usize {
    let get = |a: TokenId, b: TokenId| -> (TokenId, u32) {
        merges
            .get(&ranked_merge_key(a, b))
            .map_or((TokenId::from(0u32), u32::MAX), |&m| m)
    };
    let n = symbols.len();
    debug_assert!((2..=SMALL_MERGE_MAX).contains(&n));
    // Stack-resident doubly-linked list; see `bpe_merge_symbols_small`.
    let mut next = [0u8; SMALL_MERGE_MAX];
    let mut prev = [0u8; SMALL_MERGE_MAX];
    for i in 0..n {
        next[i] = (i + 1) as u8;
        prev[i] = (i as u8).wrapping_sub(1);
    }
    // For the pair starting at active position i: its merge priority and
    // merged token. Rank u32::MAX = no merge (or merged away).
    let mut ranks = [u32::MAX; SMALL_MERGE_MAX];
    let mut merged = [TokenId::from(0u32); SMALL_MERGE_MAX];
    for i in 0..n - 1 {
        (merged[i], ranks[i]) = get(symbols[i], symbols[i + 1]);
    }
    loop {
        let mut best = u32::MAX;
        let mut best_i = 0;
        for (i, &rank) in ranks[..n - 1].iter().enumerate() {
            if rank < best {
                best = rank;
                best_i = i;
            }
        }
        if best == u32::MAX {
            break;
        }
        let i = best_i;
        symbols[i] = merged[i];
        // Unlink the right element of the merged pair.
        let dead = next[i] as usize;
        let new_right = next[dead] as usize;
        next[i] = new_right as u8;
        ranks[dead] = u32::MAX;
        // Refresh the two pairs now touching the merged symbol.
        if new_right < n {
            prev[new_right] = i as u8;
            (merged[i], ranks[i]) = get(symbols[i], symbols[new_right]);
        } else {
            ranks[i] = u32::MAX;
        }
        let left = prev[i] as usize;
        if left < n {
            (merged[left], ranks[left]) = get(symbols[left], symbols[i]);
        }
    }
    // Compact survivors in place.
    let mut write = 0;
    let mut i = 0;
    while i < n {
        symbols[write] = symbols[i];
        write += 1;
        i = next[i] as usize;
    }
    write
}

#[cfg(feature = "profiling")]
pub(crate) fn bpe_merge_symbols_ranked_slice_by(
    get: &mut impl FnMut(TokenId, TokenId) -> Option<(TokenId, u32)>,
    symbols: &mut [TokenId],
) -> usize {
    let n = symbols.len();
    debug_assert!((2..=SMALL_MERGE_MAX).contains(&n));
    let mut next = [0u8; SMALL_MERGE_MAX];
    let mut prev = [0u8; SMALL_MERGE_MAX];
    for i in 0..n {
        next[i] = (i + 1) as u8;
        prev[i] = (i as u8).wrapping_sub(1);
    }
    let mut ranks = [u32::MAX; SMALL_MERGE_MAX];
    let mut merged = [TokenId::from(0u32); SMALL_MERGE_MAX];
    for i in 0..n - 1 {
        if let Some((token, rank)) = get(symbols[i], symbols[i + 1]) {
            merged[i] = token;
            ranks[i] = rank;
        }
    }
    loop {
        let mut best = u32::MAX;
        let mut best_i = 0;
        for (i, &rank) in ranks[..n - 1].iter().enumerate() {
            if rank < best {
                best = rank;
                best_i = i;
            }
        }
        if best == u32::MAX {
            break;
        }
        let i = best_i;
        symbols[i] = merged[i];
        let dead = next[i] as usize;
        let new_right = next[dead] as usize;
        next[i] = new_right as u8;
        ranks[dead] = u32::MAX;
        if new_right < n {
            prev[new_right] = i as u8;
            if let Some((token, rank)) = get(symbols[i], symbols[new_right]) {
                merged[i] = token;
                ranks[i] = rank;
            } else {
                ranks[i] = u32::MAX;
            }
        } else {
            ranks[i] = u32::MAX;
        }
        let left = prev[i] as usize;
        if left < n {
            if let Some((token, rank)) = get(symbols[left], symbols[i]) {
                merged[left] = token;
                ranks[left] = rank;
            } else {
                ranks[left] = u32::MAX;
            }
        }
    }
    let mut write = 0;
    let mut i = 0;
    while i < n {
        symbols[write] = symbols[i];
        write += 1;
        i = next[i] as usize;
    }
    write
}

/// Apply BPE merges using explicit merge ranks for priority (lower rank = first).
/// The merge table maps `(token_a, token_b) → (merged_token, rank)`.
///
/// Uses a min-heap + doubly-linked list for O(n log n) performance instead of
/// the naive O(n × merges) scan.
/// This is only needed by SentencePiece-style tokenizers.
pub fn bpe_merge_symbols_ranked<S: std::hash::BuildHasher>(
    merges: &HashMap<u64, (TokenId, u32), S>,
    symbols: &mut Vec<TokenId>,
) {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let n = symbols.len();
    if n < 2 {
        return;
    }

    // Short sequences (the overwhelming majority of word units) skip the
    // heap and its allocations entirely.
    if n <= SMALL_MERGE_MAX {
        let new_len = bpe_merge_symbols_ranked_slice(merges, symbols);
        symbols.truncate(new_len);
        return;
    }

    // Doubly-linked list via index arrays. NONE = no neighbor.
    const NONE: usize = usize::MAX;
    let mut next: Vec<usize> = (1..n).chain(std::iter::once(NONE)).collect();
    let mut prev: Vec<usize> = std::iter::once(NONE).chain(0..n - 1).collect();
    let mut token = symbols.clone();

    // Min-heap of (rank, position). Position refers to the left symbol of the pair.
    let mut heap: BinaryHeap<Reverse<(u32, usize)>> = BinaryHeap::new();

    // Seed with all initial pairs
    let mut i = 0;
    while i < n {
        let j = next[i];
        if j == NONE {
            break;
        }
        if let Some(&(_, rank)) = merges.get(&ranked_merge_key(token[i], token[j])) {
            heap.push(Reverse((rank, i)));
        }
        i = j;
    }

    while let Some(Reverse((rank, pos))) = heap.pop() {
        // Validate: pos must still be active and its right neighbor must exist
        let right = next[pos];
        if right == NONE {
            continue;
        }
        // Check the pair still matches (it may have been invalidated by an earlier merge)
        let pair = ranked_merge_key(token[pos], token[right]);
        match merges.get(&pair) {
            Some(&(merged_token, r)) if r == rank => {
                // Apply the merge: replace token[pos], remove right
                token[pos] = merged_token;
                let right_right = next[right];
                next[pos] = right_right;
                if right_right != NONE {
                    prev[right_right] = pos;
                }
                // Mark right as deleted
                next[right] = NONE;
                prev[right] = NONE;

                // Re-check pair with left neighbor
                let left = prev[pos];
                if left != NONE
                    && let Some(&(_, rank)) = merges.get(&ranked_merge_key(token[left], token[pos]))
                {
                    heap.push(Reverse((rank, left)));
                }
                // Re-check pair with new right neighbor
                if next[pos] != NONE
                    && let Some(&(_, rank)) =
                        merges.get(&ranked_merge_key(token[pos], token[next[pos]]))
                {
                    heap.push(Reverse((rank, pos)));
                }
            }
            _ => continue, // Stale entry, skip
        }
    }

    // Collect surviving symbols via linked list traversal
    symbols.clear();
    let mut i = 0;
    // Find the head (first element with prev == NONE that's still in the list)
    // Since we never remove index 0's prev link, index 0 is always the head
    loop {
        symbols.push(token[i]);
        if next[i] == NONE {
            break;
        }
        i = next[i];
    }
}

#[cfg(feature = "profiling")]
pub(crate) fn bpe_merge_symbols_ranked_by(
    get: &mut impl FnMut(TokenId, TokenId) -> Option<(TokenId, u32)>,
    symbols: &mut Vec<TokenId>,
) {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let n = symbols.len();
    if n < 2 {
        return;
    }
    if n <= SMALL_MERGE_MAX {
        let new_len = bpe_merge_symbols_ranked_slice_by(get, symbols);
        symbols.truncate(new_len);
        return;
    }

    const NONE: usize = usize::MAX;
    let mut next: Vec<usize> = (1..n).chain(std::iter::once(NONE)).collect();
    let mut prev: Vec<usize> = std::iter::once(NONE).chain(0..n - 1).collect();
    let mut token = symbols.clone();
    let mut heap: BinaryHeap<Reverse<(u32, usize)>> = BinaryHeap::new();
    let mut i = 0;
    while i < n {
        let j = next[i];
        if j == NONE {
            break;
        }
        if let Some((_, rank)) = get(token[i], token[j]) {
            heap.push(Reverse((rank, i)));
        }
        i = j;
    }

    while let Some(Reverse((rank, pos))) = heap.pop() {
        let right = next[pos];
        if right == NONE {
            continue;
        }
        match get(token[pos], token[right]) {
            Some((merged_token, current_rank)) if current_rank == rank => {
                token[pos] = merged_token;
                let right_right = next[right];
                next[pos] = right_right;
                if right_right != NONE {
                    prev[right_right] = pos;
                }
                next[right] = NONE;
                prev[right] = NONE;
                let left = prev[pos];
                if left != NONE
                    && let Some((_, next_rank)) = get(token[left], token[pos])
                {
                    heap.push(Reverse((next_rank, left)));
                }
                if next[pos] != NONE
                    && let Some((_, next_rank)) = get(token[pos], token[next[pos]])
                {
                    heap.push(Reverse((next_rank, pos)));
                }
            }
            _ => continue,
        }
    }

    symbols.clear();
    let mut i = 0;
    loop {
        symbols.push(token[i]);
        if next[i] == NONE {
            break;
        }
        i = next[i];
    }
}

/// Tokenize a single pretoken by mapping each byte to TokenId(byte_value)
/// then applying BPE merges (priority by merged token ID).
pub fn simple_bpe_merge<S: std::hash::BuildHasher>(
    merges: &HashMap<(TokenId, TokenId), TokenId, S>,
    pre_token: &[u8],
) -> Vec<TokenId> {
    let mut symbols: Vec<TokenId> = pre_token.iter().map(|&b| TokenId::from(b as u32)).collect();
    bpe_merge_symbols(merges, &mut symbols);
    symbols
}

// Re-export the main types so existing `use crate::bpe::Tokenizer` still works.
#[cfg(any(feature = "sentencepiece", feature = "sentencepiece-core"))]
pub use sentencepiece::SentencePieceBPE;
pub use tiktoken::Tokenizer;

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal deterministic RNG (xorshift64*) so the differential tests
    /// need no dev-dependency.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn random_merges(
        rng: &mut Rng,
        n_merges: usize,
        id_range: u32,
    ) -> HashMap<(TokenId, TokenId), TokenId, rustc_hash::FxBuildHasher> {
        let mut merges = HashMap::with_hasher(rustc_hash::FxBuildHasher {});
        for i in 0..n_merges {
            let a = TokenId(rng.below(id_range as u64) as u32);
            let b = TokenId(rng.below(id_range as u64) as u32);
            merges.entry((a, b)).or_insert(TokenId(256 + i as u32));
        }
        merges
    }

    /// The flat table must agree with the hashbrown map on every merge pair
    /// and return the no-merge sentinel everywhere else.
    #[test]
    fn pair_rank_table_matches_map() {
        let mut rng = Rng(0x1234_5678_9ABC_DEF0);
        let id_range = 4096u32;
        let merges = random_merges(&mut rng, 3000, id_range);
        let table = PairRankTable::build(&merges, None, id_range as usize).expect("build");
        for (&(a, b), &m) in &merges {
            assert_eq!(table.rank(a, b), m.0, "pair ({}, {})", a.0, b.0);
        }
        let reconstructed: HashMap<_, _, rustc_hash::FxBuildHasher> = table
            .entries()
            .map(|(a, b, merged)| ((a, b), merged))
            .collect();
        assert_eq!(
            reconstructed, merges,
            "flat slots must reconstruct every merge"
        );
        for _ in 0..100_000 {
            let a = TokenId(rng.below(id_range as u64) as u32);
            let b = TokenId(rng.below(id_range as u64) as u32);
            let expected = merges.get(&(a, b)).map_or(u32::MAX, |m| m.0);
            assert_eq!(table.rank(a, b), expected, "pair ({}, {})", a.0, b.0);
        }
        // Oversized IDs must refuse the table, not corrupt it.
        assert!(PairRankTable::build(&merges, None, (1 << PAIR_ID_BITS) + 1).is_none());
        let mut big = merges.clone();
        big.insert((TokenId(1 << PAIR_ID_BITS), TokenId(0)), TokenId(300));
        assert!(PairRankTable::build(&big, None, id_range as usize).is_none());
    }

    #[test]
    fn incremental_pair_rank_table_matches_map() {
        let mut rng = Rng(0xA11C_E55D_1EEC_7001);
        let id_range = 4096u32;
        let merges = random_merges(&mut rng, 3000, id_range);
        let mut table =
            PairRankTable::with_capacity(None, id_range as usize, merges.len()).expect("capacity");
        for (&(left, right), &merged) in &merges {
            assert!(table.insert(left, right, merged));
        }
        for (&(left, right), &merged) in &merges {
            assert_eq!(table.rank(left, right), merged.0);
        }
        let (&(left, right), &merged) = merges.iter().next().expect("merge");
        assert!(!table.insert(left, right, merged));
        let reconstructed: HashMap<_, _, rustc_hash::FxBuildHasher> = table
            .entries()
            .map(|(a, b, merged)| ((a, b), merged))
            .collect();
        assert_eq!(reconstructed, merges);
    }

    #[cfg(feature = "opt-compact-ranks")]
    #[test]
    fn compact_pair_rank_table_uses_only_flat_slots() {
        let mut rng = Rng(0xC0DE_CAFE_1234_5678);
        let merges = random_merges(&mut rng, 100_000, 200_000);
        let table = PairRankTable::build(&merges, None, 200_000).expect("build");
        let expected_slots = (merges.len().max(1) * 2).next_power_of_two().max(64);
        assert_eq!(
            table.resident_bytes(),
            expected_slots * std::mem::size_of::<u64>()
        );
        assert!(table.resident_bytes() <= 4 * 1024 * 1024);
    }

    /// The stack-array short merges (scalar and NEON) must produce exactly
    /// the sequence of the Vec-based merge loop , same merges, same order,
    /// same tie-breaks , across random symbol sequences and merge tables.
    #[test]
    fn short_merges_match_vec_merge_loop() {
        let mut rng = Rng(0xDEAD_BEEF_0BAD_F00D);
        for trial in 0..2000 {
            let id_range = 300 + (trial % 7) as u32 * 500;
            let merges = random_merges(&mut rng, 200 + trial % 800, id_range);
            let table =
                PairRankTable::build(&merges, None, id_range as usize + 1024).expect("build");
            let n = 2 + rng.below(14) as usize; // 2..=15
            let init: Vec<TokenId> = (0..n)
                .map(|_| TokenId(rng.below(id_range as u64) as u32))
                .collect();

            let mut reference = init.clone();
            bpe_merge_symbols_with_scratch(&merges, &mut reference, &mut MergeScratch::default());

            let mut scalar = [TokenId(0); SHORT_MERGE_MAX];
            scalar[..n].copy_from_slice(&init);
            let len = bpe_merge_symbols_short_scalar(
                |a, b| table.rank(a, b),
                |a, b| table.prefetch_rank(a, b),
                &mut scalar,
                n,
            );
            assert_eq!(&scalar[..len], &reference[..], "scalar diverged: {init:?}");

            #[cfg(target_arch = "aarch64")]
            {
                let mut neon = [TokenId(0); SHORT_MERGE_MAX];
                neon[..n].copy_from_slice(&init);
                let len = bpe_merge_symbols_short_neon(&table, &mut neon, n);
                assert_eq!(&neon[..len], &reference[..], "neon diverged: {init:?}");
            }

            // Exercise both x86 tiers explicitly (not just the dispatcher's
            // pick) so an AVX-512 box still validates the AVX2 arm.
            #[cfg(target_arch = "x86_64")]
            {
                if std::arch::is_x86_feature_detected!("avx512f") {
                    let mut v = [TokenId(0); SHORT_MERGE_MAX];
                    v[..n].copy_from_slice(&init);
                    // SAFETY: runtime AVX-512F detection right above.
                    let len = unsafe { bpe_merge_symbols_short_avx512(&table, &mut v, n) };
                    assert_eq!(&v[..len], &reference[..], "avx512 diverged: {init:?}");
                }
                if std::arch::is_x86_feature_detected!("avx2") {
                    let mut v = [TokenId(0); SHORT_MERGE_MAX];
                    v[..n].copy_from_slice(&init);
                    // SAFETY: runtime AVX2 detection right above.
                    let len = unsafe { bpe_merge_symbols_short_avx2(&table, &mut v, n) };
                    assert_eq!(&v[..len], &reference[..], "avx2 diverged: {init:?}");
                }
            }
        }
    }
}
