const EMPTY_OFFSET: u32 = u32::MAX;
const MIN_SLOTS: usize = 64;
const MAX_SAMPLED_DISPLACEMENT: usize = 64;

#[derive(Clone, Copy)]
struct Entry {
    hash: u64,
    key_offset: u32,
    key_len: u32,
    value: (u32, u32),
}

impl Entry {
    const EMPTY: Self = Self {
        hash: 0,
        key_offset: EMPTY_OFFSET,
        key_len: 0,
        value: (0, 0),
    };

    #[inline(always)]
    fn occupied(self) -> bool {
        self.key_offset != EMPTY_OFFSET
    }
}

pub(super) struct LongPretokenCache {
    slots: Box<[Entry]>,
    key_arena: Vec<u8>,
    len: usize,
    full_hash: bool,
}

impl LongPretokenCache {
    pub(super) fn new() -> Self {
        Self {
            slots: Box::new([]),
            key_arena: Vec::new(),
            len: 0,
            full_hash: false,
        }
    }

    pub(super) fn with_capacity(capacity: usize) -> Self {
        let mut cache = Self::new();
        if capacity != 0 {
            cache.slots = vec![Entry::EMPTY; slots_for(capacity)].into_boxed_slice();
        }
        cache
    }

    #[inline]
    pub(super) fn get(&self, key: &[u8]) -> Option<&(u32, u32)> {
        if self.slots.is_empty() {
            return None;
        }
        let hash = self.hash(key);
        let mut slot = hash as usize & (self.slots.len() - 1);
        loop {
            let entry = &self.slots[slot];
            if !entry.occupied() {
                return None;
            }
            if entry.hash == hash && self.key(entry) == key {
                return Some(&entry.value);
            }
            slot = (slot + 1) & (self.slots.len() - 1);
        }
    }

    pub(super) fn insert(&mut self, key: &[u8], value: (u32, u32)) -> Option<(u32, u32)> {
        if self.slots.is_empty() || (self.len + 1) * 4 > self.slots.len() * 3 {
            self.grow();
        }
        let hash = self.hash(key);
        let mut slot = hash as usize & (self.slots.len() - 1);
        let mut displacement = 0;
        loop {
            let entry = self.slots[slot];
            if !entry.occupied() {
                let key_offset = u32::try_from(self.key_arena.len())
                    .expect("long-pretoken key arena exceeds u32 offsets");
                let key_len = u32::try_from(key.len()).expect("long pretoken exceeds u32 length");
                self.key_arena.extend_from_slice(key);
                self.slots[slot] = Entry {
                    hash,
                    key_offset,
                    key_len,
                    value,
                };
                self.len += 1;
                return None;
            }
            if entry.hash == hash && self.key(&entry) == key {
                let previous = entry.value;
                self.slots[slot].value = value;
                return Some(previous);
            }
            slot = (slot + 1) & (self.slots.len() - 1);
            displacement += 1;
            if !self.full_hash && displacement > MAX_SAMPLED_DISPLACEMENT {
                self.switch_to_full_hash();
                return self.insert(key, value);
            }
        }
    }

    #[cfg(test)]
    pub(super) fn contains_key(&self, key: &[u8]) -> bool {
        self.get(key).is_some()
    }

    pub(super) fn len(&self) -> usize {
        self.len
    }

    pub(super) fn capacity(&self) -> usize {
        self.slots.len() * 3 / 4
    }

    pub(super) fn key_bytes(&self) -> usize {
        self.key_arena.len()
    }

    #[inline(always)]
    fn key(&self, entry: &Entry) -> &[u8] {
        let start = entry.key_offset as usize;
        let end = start + entry.key_len as usize;
        // SAFETY: occupied entries are written only after their key bytes
        // are appended, and the append-only arena never shrinks.
        unsafe { self.key_arena.get_unchecked(start..end) }
    }

    fn grow(&mut self) {
        let new_slots = if self.slots.is_empty() {
            MIN_SLOTS
        } else {
            self.slots.len() * 2
        };
        let mut replacement = vec![Entry::EMPTY; new_slots].into_boxed_slice();
        let mask = new_slots - 1;
        for entry in self.slots.iter().copied().filter(|entry| entry.occupied()) {
            let mut slot = entry.hash as usize & mask;
            while replacement[slot].occupied() {
                slot = (slot + 1) & mask;
            }
            replacement[slot] = entry;
        }
        self.slots = replacement;
    }

    #[inline(always)]
    fn hash(&self, key: &[u8]) -> u64 {
        if self.full_hash {
            full_long_key_hash(key)
        } else {
            sampled_long_key_hash(key)
        }
    }

    fn switch_to_full_hash(&mut self) {
        let mut replacement = vec![Entry::EMPTY; self.slots.len()].into_boxed_slice();
        let mask = replacement.len() - 1;
        for mut entry in self.slots.iter().copied().filter(|entry| entry.occupied()) {
            entry.hash = full_long_key_hash(self.key(&entry));
            let mut slot = entry.hash as usize & mask;
            while replacement[slot].occupied() {
                slot = (slot + 1) & mask;
            }
            replacement[slot] = entry;
        }
        self.slots = replacement;
        self.full_hash = true;
    }
}

fn slots_for(capacity: usize) -> usize {
    capacity
        .saturating_mul(4)
        .div_ceil(3)
        .next_power_of_two()
        .max(MIN_SLOTS)
}

#[inline(always)]
fn sampled_long_key_hash(key: &[u8]) -> u64 {
    let len = key.len() as u64;
    if key.len() < 16 {
        let mut hash = len.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        for &byte in key {
            hash = hash.rotate_left(5) ^ u64::from(byte);
        }
        return finish_hash(hash);
    }
    // SAFETY: this arm requires at least 16 bytes. The first, centered, and
    // final unaligned eight-byte reads all stay inside the slice.
    let (first, middle, last) = unsafe {
        (
            (key.as_ptr() as *const u64).read_unaligned(),
            (key.as_ptr().add((key.len() - 8) / 2) as *const u64).read_unaligned(),
            (key.as_ptr().add(key.len() - 8) as *const u64).read_unaligned(),
        )
    };
    finish_hash(
        first
            ^ middle.rotate_left(17)
            ^ last.rotate_left(37)
            ^ len.wrapping_mul(0x9E37_79B9_7F4A_7C15),
    )
}

#[inline]
fn full_long_key_hash(key: &[u8]) -> u64 {
    let mut hash = (key.len() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut chunks = key.chunks_exact(16);
    for chunk in &mut chunks {
        // SAFETY: each exact chunk contains 16 bytes, so both unaligned
        // eight-byte reads stay inside it.
        let (first, second) = unsafe {
            (
                (chunk.as_ptr() as *const u64).read_unaligned(),
                (chunk.as_ptr().add(8) as *const u64).read_unaligned(),
            )
        };
        hash = (hash ^ first)
            .rotate_left(27)
            .wrapping_mul(0xD6E8_FEB8_6659_FD93);
        hash ^= second.rotate_left(31);
    }
    let remainder = chunks.remainder();
    if !remainder.is_empty() {
        let mut tail = [0_u8; 16];
        tail[..remainder.len()].copy_from_slice(remainder);
        let first = u64::from_le_bytes(tail[..8].try_into().expect("fixed slice"));
        let second = u64::from_le_bytes(tail[8..].try_into().expect("fixed slice"));
        hash = (hash ^ first)
            .rotate_left(27)
            .wrapping_mul(0xD6E8_FEB8_6659_FD93);
        hash ^= second.rotate_left(31);
    }
    finish_hash(hash)
}

#[inline(always)]
fn finish_hash(mut hash: u64) -> u64 {
    hash ^= hash >> 32;
    hash = hash.wrapping_mul(0xD6E8_FEB8_6659_FD93);
    hash ^ (hash >> 29)
}

#[cfg(test)]
mod tests {
    use super::LongPretokenCache;

    #[test]
    fn preserves_empty_and_similar_long_keys_across_growth() {
        let mut cache = LongPretokenCache::new();
        assert_eq!(cache.insert(b"", (1, 2)), None);
        for index in 0..1_000_u32 {
            let mut key = vec![b'x'; 40];
            key[8..12].copy_from_slice(&index.to_le_bytes());
            assert_eq!(cache.insert(&key, (index, index + 1)), None);
        }
        assert_eq!(cache.get(b""), Some(&(1, 2)));
        for index in 0..1_000_u32 {
            let mut key = vec![b'x'; 40];
            key[8..12].copy_from_slice(&index.to_le_bytes());
            assert_eq!(cache.get(&key), Some(&(index, index + 1)));
        }
        assert_eq!(cache.len(), 1_001);
        assert_eq!(cache.key_bytes(), 40_000);
        assert!(cache.full_hash);
    }
}
